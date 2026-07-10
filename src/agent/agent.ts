import type { IntentCall } from './intents';
import { createGeminiAgent } from './gemini';

/** Effets que l'agent peut déclencher (fournis par main.ts). */
export interface AgentHooks {
  dispatch(call: IntentCall): void;
  babble(ms: number, mood: 'up' | 'down' | 'flat'): void;
  log(line: string): void;
}

export interface Agent {
  /** Traite une phrase utilisateur → intentions + babil. */
  send(text: string): Promise<void>;
  readonly info: string;
  /** Caractère courant (system prompt éditable) — seulement pour l'agent Gemini. */
  getPersona?(): string;
  /** Remplace le caractère à chaud et repart sur une conversation fraîche. */
  setPersona?(text: string): void;
}

/** Choisit l'agent Gemini si une clé est présente, sinon le fallback local. */
export function createAgent(hooks: AgentHooks): Agent {
  const key = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
  if (key && key.trim()) {
    return createGeminiAgent(key.trim(), hooks);
  }
  hooks.log('ℹ pas de clé Gemini — agent local (mots-clés). Voir .env.local.example');
  return createLocalAgent(hooks);
}

/**
 * Agent local de secours : règles par mots-clés (français). Permet de tester
 * toute la chaîne texte → intention → visage/son SANS clé API.
 */
export function createLocalAgent(hooks: AgentHooks): Agent {
  const send = async (raw: string): Promise<void> => {
    const t = raw.toLowerCase();
    const calls: IntentCall[] = [];
    let mood: 'up' | 'down' | 'flat' = 'up';

    const num = () => {
      const m = t.match(/-?\d+/);
      return m ? parseInt(m[0], 10) : 20;
    };
    const dir = (): 'left' | 'right' =>
      /droite|droit/.test(t) ? 'right' : 'left';

    if (/clin/.test(t)) calls.push({ name: 'wink', args: { side: dir() } });
    if (/cligne/.test(t)) calls.push({ name: 'blink', args: {} });

    if (/regarde|regard/.test(t)) {
      let d: string = 'center';
      if (/gauche/.test(t)) d = 'left';
      else if (/droite|droit/.test(t)) d = 'right';
      else if (/haut|ciel/.test(t)) d = 'up';
      else if (/bas|sol/.test(t)) d = 'down';
      calls.push({ name: 'look', args: { dir: d } });
    }

    if (/avance/.test(t)) calls.push({ name: 'forward', args: { cm: Math.abs(num()) } });
    if (/recule/.test(t)) calls.push({ name: 'backward', args: { cm: Math.abs(num()) } });
    if (/tourne|pivote/.test(t)) {
      const deg = Math.abs(num()) * (/gauche/.test(t) ? -1 : 1);
      calls.push({ name: 'turn', args: { deg } });
    }
    if (/hoche|oui\b|acquiesce/.test(t)) calls.push({ name: 'nod', args: {} });
    if (/révérence|reverence|salue/.test(t)) calls.push({ name: 'bow', args: {} });
    if (/danse|frétille|fretille|dandine|remue/.test(t))
      calls.push({ name: 'wiggle', args: {} });

    // Émotions.
    let emotion: string | null = null;
    if (/content|joie|heureux|super|génial|genial|youpi/.test(t)) emotion = 'joy';
    else if (/triste|déçu|decu|pleure/.test(t)) (emotion = 'sadness'), (mood = 'down');
    else if (/surpris|étonn|etonn|wow|oh\b/.test(t)) emotion = 'surprise';
    else if (/curieux|curiosité|curiosite|hmm|intéress|interess/.test(t)) emotion = 'curiosity';
    else if (/colère|colere|fâché|fache|énervé|enerve|grr/.test(t))
      (emotion = 'anger'), (mood = 'flat');
    if (emotion) calls.unshift({ name: 'express', args: { emotion, intensity: 0.9 } });

    // Rien reconnu : petite réaction curieuse par défaut.
    if (calls.length === 0) {
      calls.push({ name: 'express', args: { emotion: 'curiosity', intensity: 0.6 } });
      hooks.log('🤖 (local) je ne comprends pas encore — essaie « fais un clin d\'œil »');
    }

    for (const c of calls) hooks.dispatch(c);
    hooks.babble(700 + calls.length * 200, mood);
  };

  return { send, info: 'agent local (mots-clés, sans clé)' };
}
