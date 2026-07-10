// Test isolé du function calling Gemini via generateContent (hors navigateur).
// Valide l'API, le format, le modèle et le free tier.
// Lance : node scripts/test-gemini.mjs
import { readFileSync } from 'node:fs';
import { GoogleGenAI, Type } from '@google/genai';

// Force notre clé .env.local (ignore GOOGLE_API_KEY/GEMINI_API_KEY d'environnement).
delete process.env.GOOGLE_API_KEY;
delete process.env.GEMINI_API_KEY;
const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const apiKey = env.match(/^VITE_GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!apiKey) throw new Error('VITE_GEMINI_API_KEY absent de .env.local');

const ai = new GoogleGenAI({ apiKey });

const tools = [
  {
    functionDeclarations: [
      {
        name: 'express',
        description: 'Affiche une émotion sur le visage de Mochi.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            emotion: {
              type: Type.STRING,
              enum: ['joy', 'sadness', 'surprise', 'curiosity', 'anger', 'neutral'],
            },
            intensity: { type: Type.NUMBER },
          },
          required: ['emotion'],
        },
      },
      { name: 'wink', description: "Clin d'œil.", parameters: { type: Type.OBJECT, properties: { side: { type: Type.STRING, enum: ['left', 'right'] } }, required: ['side'] } },
    ],
  },
];

const MODELS = ['gemini-3-flash', 'gemini-3.1-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];

for (const model of MODELS) {
  try {
    const res = await ai.models.generateContent({
      model,
      contents: 'Fais un clin d\'œil et montre que tu es super content !',
      config: {
        systemInstruction:
          'Tu es Mochi, petit robot kawaii. Réponds en une phrase ET appelle des fonctions pour exprimer émotions/gestes.',
        tools,
      },
    });
    const calls = res.functionCalls ?? [];
    console.log(`\n=== ${model} : OK ===`);
    console.log('text:', JSON.stringify(res.text));
    console.log('functionCalls:', JSON.stringify(calls, null, 2));
  } catch (e) {
    console.log(`\n=== ${model} : ERREUR ===`);
    console.log(String(e.message ?? e).slice(0, 200));
  }
}
