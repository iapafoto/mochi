// SEUL point réseau Gemini. Isole tous les détails d'API pour qu'ils ne fuient
// nulle part ailleurs (cf. PLAN §3).
//
// Choix (vérifié doc + tests réels, 2026) :
//   - On utilise `ai.models.generateContent` (texte → function calls), et NON le
//     Live API. Raison : le modèle Live `gemini-3.1-flash-live-preview` ne
//     supporte PAS la modalité TEXT (il rejette la connexion) ; il est fait pour
//     l'audio streaming. Or ici on fait texte-en-entrée + sons kawaii locaux,
//     sans micro ni voix. Le Live API reviendra au jalon micro (v1b) en AUDIO.
//   - Modèle : gemini-3.1-flash-lite (free tier, rapide, function calling OK).
//   - SDK : @google/genai, `new GoogleGenAI({ apiKey })`.
//
// Le function calling renvoie `response.functionCalls` (name/args). On ne renvoie
// pas de functionResponse : nos fonctions n'ont pas de valeur de retour utile au
// modèle (l'effet est visuel/sonore, côté client).

import { GoogleGenAI, Type, type Content } from '@google/genai';
import type { AgentHooks, Agent } from './agent';
import { INTENT_DECLARATIONS, type ParamSchema } from './intents';
import { DEFAULT_PERSONA, buildSystemInstruction } from './persona';

// gemini-2.5-flash renvoie texte + function calls ENSEMBLE (nécessaire pour que
// Mochi parle *et* réagisse). Les gemini-3.1-flash-lite / 3-flash-preview sont
// « function-only » avec des tools (aucun texte), donc inadaptés ici.
const MODEL = 'gemini-2.5-flash';

const TYPE_MAP: Record<ParamSchema['type'], Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
};

/** Adapte nos déclarations neutres au schéma attendu par le SDK. Réutilisé par
 * la session Live (live.ts) pour exposer exactement le même vocabulaire. */
export function toGeminiTools() {
  const functionDeclarations = INTENT_DECLARATIONS.map((d) => ({
    name: d.name,
    description: d.description,
    parameters: d.parameters
      ? {
          type: Type.OBJECT,
          properties: Object.fromEntries(
            Object.entries(d.parameters.properties).map(([k, p]) => [
              k,
              { type: TYPE_MAP[p.type], description: p.description, enum: p.enum },
            ]),
          ),
          required: d.parameters.required ?? [],
        }
      : undefined,
  }));
  return [{ functionDeclarations }];
}

export function createGeminiAgent(apiKey: string, hooks: AgentHooks): Agent {
  const ai = new GoogleGenAI({ apiKey });
  const tools = toGeminiTools();

  // Caractère éditable à chaud (via le panneau debug). Relu à chaque requête.
  let persona = DEFAULT_PERSONA;

  // Petite mémoire conversationnelle (texte seulement) pour donner du contexte.
  const history: Content[] = [];
  const MAX_TURNS = 12;

  const send = async (text: string): Promise<void> => {
    const contents: Content[] = [...history, { role: 'user', parts: [{ text }] }];
    const config = { systemInstruction: buildSystemInstruction(persona), tools };
    let res;
    try {
      res = await ai.models.generateContent({ model: MODEL, contents, config });
    } catch (err) {
      hooks.log(`⚠ Gemini indisponible : ${(err as Error).message}`);
      return;
    }

    // 1) Function calls → intentions.
    const calls = res.functionCalls ?? [];
    let mood: 'up' | 'down' | 'flat' = 'up';
    for (const fc of calls) {
      const name = fc.name ?? '';
      const args = (fc.args ?? {}) as Record<string, unknown>;
      hooks.dispatch({ name, args });
      if (name === 'express') mood = moodFor(String(args.emotion));
    }

    // 2) Texte éventuel → log + babil.
    const reply = (res.text ?? '').trim();
    if (reply) hooks.log(`💬 Mochi : ${reply}`);
    const ms = Math.max(500, Math.min(3000, (reply.length || calls.length * 8 || 12) * 45));
    hooks.babble(ms, mood);

    // 3) Historique (texte) pour le prochain tour.
    history.push({ role: 'user', parts: [{ text }] });
    history.push({ role: 'model', parts: [{ text: reply || '(réagit)' }] });
    if (history.length > MAX_TURNS) history.splice(0, history.length - MAX_TURNS);
  };

  return {
    send,
    info: `agent Gemini (${MODEL}, generateContent)`,
    getPersona: () => persona,
    setPersona: (t: string) => {
      persona = t.trim() || DEFAULT_PERSONA;
      history.length = 0; // repart sur une conversation fraîche avec le nouveau caractère
    },
  };
}

function moodFor(emotion: string): 'up' | 'down' | 'flat' {
  if (emotion === 'sadness') return 'down';
  if (emotion === 'anger' || emotion === 'neutral') return 'flat';
  return 'up';
}
