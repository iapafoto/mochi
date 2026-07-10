// Prototype isolé de la session Gemini Live AUDIO (hors navigateur).
// Valide : cycle de vie de la session, function calling en modalité AUDIO,
// décodage de l'audio de sortie (→ .wav), transcription, tours de parole.
//
// Entrée = un tour texte (pas besoin de micro ici) ; sortie = voix de Mochi.
// Lance : node scripts/test-live.mjs   →  écrit scripts/out/mochi-voice.wav
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { GoogleGenAI, Modality, Type } from '@google/genai';

delete process.env.GOOGLE_API_KEY;
delete process.env.GEMINI_API_KEY;
const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const apiKey = env.match(/^VITE_GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!apiKey) throw new Error('VITE_GEMINI_API_KEY absent de .env.local');

const MODEL = 'gemini-3.1-flash-live-preview';

const SYSTEM = `Tu es Mochi, un petit robot équilibriste kawaii : curieux, joueur, attachant,
avec une voix mignonne et enjouée de petit personnage. Réponds en français, TRÈS brièvement.
À chaque réponse, appelle aussi des fonctions pour exprimer ton émotion et bouger.`;

const tools = [
  {
    functionDeclarations: [
      {
        name: 'express',
        description: 'Affiche une émotion sur le visage.',
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
      { name: 'wiggle', description: 'Se dandine de façon rigolote.' },
    ],
  },
];

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

const ai = new GoogleGenAI({ apiKey });

// Accumulateurs.
const audioChunks = [];
let audioRate = 24000;
let outText = '';
const calls = [];
let done;
const finished = new Promise((r) => (done = r));

const session = await ai.live.connect({
  model: MODEL,
  callbacks: {
    onopen: () => log('OPEN'),
    onmessage: (m) => handle(m),
    onerror: (e) => log('ERROR', e.message),
    onclose: (e) => log('CLOSE', e.reason || '(ok)'),
  },
  config: {
    responseModalities: [Modality.AUDIO],
    systemInstruction: SYSTEM,
    tools,
    outputAudioTranscription: {}, // demande la transcription de ce que Mochi dit
  },
});

function handle(m) {
  if (m.setupComplete) log('SETUP COMPLETE');

  const fcs = m.toolCall?.functionCalls;
  if (fcs?.length) {
    for (const fc of fcs) {
      calls.push({ name: fc.name, args: fc.args });
      log('FUNCTION CALL →', fc.name, JSON.stringify(fc.args ?? {}));
    }
    session.sendToolResponse({
      functionResponses: fcs.map((fc) => ({ id: fc.id, name: fc.name, response: { result: 'ok' } })),
    });
  }

  // Audio : m.data est le raccourci SDK (= concat des parts inlineData du message).
  if (typeof m.data === 'string' && m.data.length) {
    audioChunks.push(Buffer.from(m.data, 'base64'));
  }
  // Détecte juste le taux d'échantillonnage depuis le mime des parts.
  for (const p of m.serverContent?.modelTurn?.parts ?? []) {
    const r = /rate=(\d+)/.exec(p.inlineData?.mimeType ?? '');
    if (r) audioRate = parseInt(r[1], 10);
    if (p.text) outText += p.text;
  }

  const ot = m.serverContent?.outputTranscription?.text;
  if (ot) outText += ot;

  if (m.serverContent?.interrupted) log('INTERRUPTED');
  if (m.serverContent?.generationComplete) log('GENERATION COMPLETE');
  if (m.serverContent?.turnComplete || m.serverContent?.generationComplete) done();
}

log('sending text turn…');
session.sendClientContent({
  turns: [{ role: 'user', parts: [{ text: 'Coucou Mochi ! Tu es content de me voir ?' }] }],
  turnComplete: true,
});

await Promise.race([finished, new Promise((r) => setTimeout(r, 15000))]);

// Finalise.
session.close();
const pcm = Buffer.concat(audioChunks);
log(`\n--- RÉSUMÉ ---`);
log('function calls :', JSON.stringify(calls));
log('transcription  :', JSON.stringify(outText.trim()));
log('audio reçu     :', pcm.length, 'octets @', audioRate, 'Hz',
  `(~${(pcm.length / 2 / audioRate).toFixed(1)}s)`);

if (pcm.length) {
  mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
  const wav = pcmToWav(pcm, audioRate);
  const path = new URL('./out/mochi-voice.wav', import.meta.url);
  writeFileSync(path, wav);
  log('→ écrit', path.pathname);
}
process.exit(0);

function pcmToWav(pcm, sampleRate, channels = 1, bits = 16) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const buf = Buffer.alloc(44 + pcm.length);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + pcm.length, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(pcm.length, 40);
  pcm.copy(buf, 44);
  return buf;
}
