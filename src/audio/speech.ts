// Entrée vocale — reconnaissance vocale du navigateur (Web Speech API).
//
// Choix : on transcrit la voix en texte côté navigateur, puis on réutilise la
// boucle Gemini existante (`generateContent`). C'est bien plus léger que le Live
// API audio (pas d'AudioWorklet ni de PCM), et Mochi garde ses sons kawaii en
// sortie (pas de TTS). Le Live API audio reste une option future (v1b).
//
// Web Speech API : Chrome/Edge (webkit). Pas de support Firefox. Nécessite un
// contexte sécurisé (localhost OK) et l'autorisation micro.

// Types minimaux (la lib DOM ne fournit pas toujours SpeechRecognition).
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type Ctor = new () => SpeechRecognitionLike;

function getCtor(): Ctor | null {
  const w = window as any;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechSupported(): boolean {
  return getCtor() !== null;
}

export interface SpeechCallbacks {
  onState(listening: boolean): void;
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
}

/**
 * Micro « maintenir pour parler » : start() sur pression, stop() au relâchement.
 * Émet la transcription finale via onFinal.
 */
export class SpeechInput {
  private recog: SpeechRecognitionLike | null = null;
  private listening = false;
  private transcript = '';

  constructor(
    private readonly cb: SpeechCallbacks,
    private readonly lang = 'fr-FR',
  ) {}

  get supported(): boolean {
    return isSpeechSupported();
  }

  start(): void {
    if (this.listening) return;
    const Ctor = getCtor();
    if (!Ctor) {
      this.cb.onError('reconnaissance vocale non supportée par ce navigateur');
      return;
    }
    const r = new Ctor();
    r.lang = this.lang;
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;
    this.transcript = '';

    r.onstart = () => {
      this.listening = true;
      this.cb.onState(true);
    };
    r.onresult = (e: any) => {
      let text = '';
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript;
      }
      this.transcript = text.trim();
      this.cb.onPartial(this.transcript);
    };
    r.onerror = (e: any) => {
      const err = String(e?.error ?? 'inconnue');
      if (err === 'not-allowed' || err === 'service-not-allowed') {
        this.cb.onError('micro refusé — autorise le micro dans le navigateur');
      } else if (err !== 'no-speech' && err !== 'aborted') {
        this.cb.onError(`micro : ${err}`);
      }
    };
    r.onend = () => {
      this.listening = false;
      this.cb.onState(false);
      const t = this.transcript.trim();
      if (t) this.cb.onFinal(t);
      this.recog = null;
    };

    this.recog = r;
    try {
      r.start();
    } catch (err) {
      this.cb.onError(`micro : ${(err as Error).message}`);
    }
  }

  /** Arrête l'écoute et finalise (déclenche onend → onFinal). */
  stop(): void {
    this.recog?.stop();
  }
}
