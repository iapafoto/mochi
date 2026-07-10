// Conversation vocale Live — le mode « on entend vraiment Mochi ».
//
// Session Gemini Live en modalité AUDIO (`gemini-3.1-flash-live-preview`) :
//   micro streamé (PCM 16 kHz)  →  session  →  voix de Mochi (PCM 24 kHz) jouée
//   en flux, + function calls dispatchés vers le visage/moteur en parallèle.
//
// C'est le SEUL point réseau du mode Live (cf. gemini.ts pour le texte). Le
// prototype `scripts/test-live.mjs` a validé la faisabilité ; ici on branche
// l'entrée micro et la sortie voix du navigateur.
//
// Coordination des tours (points signalés au prototype) :
//  - function calls : dispatchés tout de suite, on répond `ok` à la volée.
//  - ordre audio/toolCall non déterministe : sans importance, chaque canal est
//    traité indépendamment.
//  - `interrupted` (barge-in du modèle) → on vide la file de lecture.
//  - on NE s'écoute PAS parler : l'envoi micro est coupé tant que Mochi parle
//    (anti-larsen ; `echoCancellation` en complément).

import {
  GoogleGenAI,
  Modality,
  StartSensitivity,
  EndSensitivity,
  type Session,
  type LiveServerMessage,
} from '@google/genai';
import { toGeminiTools } from './gemini';
import type { IntentCall } from './intents';
import { MicCapture } from '../audio/mic';
import { VoicePlayer } from '../audio/voicePlayer';

const MODEL = 'gemini-3.1-flash-live-preview';

/** Voix préfabriquées du modèle Live (nom API + libellé FR). Les 4 premières
 * sont féminines / plus jeunes ; Puck & Fenrir sont masculines (pour comparer). */
export const LIVE_VOICES: ReadonlyArray<{ name: string; label: string }> = [
  { name: 'Leda', label: 'Leda — jeune 👧' },
  { name: 'Aoede', label: 'Aoede — douce 👧' },
  { name: 'Zephyr', label: 'Zephyr — claire 👧' },
  { name: 'Kore', label: 'Kore — posée 👧' },
  { name: 'Puck', label: 'Puck — enjoué 👦' },
  { name: 'Fenrir', label: 'Fenrir — excité 👦' },
];

/** Voix par défaut : Zephyr (claire) — retenue aux tests utilisateur. */
export const DEFAULT_VOICE = 'Zephyr';

/** Pitch par défaut : 1.3× (aigu « bébé/animal ») — retenu aux tests. */
export const DEFAULT_PITCH = 1.3;

// Réactivité (détection de fin de parole). Plus `silenceDurationMs` est court,
// plus Mochi rebondit vite quand tu t'arrêtes (spontanéité), au risque de te
// couper si tu marques une pause. 350 ms = vif mais tolère les petites pauses.
const VAD_SILENCE_MS = 350;
const VAD_PREFIX_MS = 50; // durée de parole avant de committer le début de tour

export type LiveStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';

/**
 * Comment atteindre Gemini pour le Live :
 *  - `apiKey` : clé brute (DEV local uniquement — jamais dans un build public).
 *  - `tokenEndpoint` : URL qui renvoie un jeton éphémère (PROD). La vraie clé
 *    reste côté serveur ; le navigateur n'obtient qu'un jeton court.
 */
export interface LiveAccess {
  apiKey?: string;
  tokenEndpoint?: string;
}

export interface LiveConversationCallbacks {
  onStatus(status: LiveStatus, detail?: string): void;
  /** Transcription de ce que dit l'utilisateur (micro). */
  onUserText(text: string): void;
  /** Transcription de ce que dit Mochi (voix). */
  onMochiText(text: string): void;
  /** Mochi commence/arrête de parler (bouche + gating micro). */
  onSpeakingChange?(speaking: boolean): void;
  /** Amplitude 0..1 de la voix (anime la bouche). */
  onLevel?(level: number): void;
  /** Un function call de Mochi → intention (visage/moteur). */
  dispatch(call: IntentCall): void;
}

export class LiveConversation {
  private readonly tools = toGeminiTools();
  private readonly mic: MicCapture;
  private readonly player: VoicePlayer;
  private session: Session | null = null;
  private stopping = false;
  private voice = DEFAULT_VOICE;
  private systemInstruction = ''; // mémorisé pour relancer sur changement de voix

  // Accumulateurs de transcription (vidés à chaque fin de tour).
  private inBuf = '';
  private outBuf = '';
  private userFlushed = false;

  constructor(
    private readonly access: LiveAccess,
    private readonly cb: LiveConversationCallbacks,
  ) {
    this.player = new VoicePlayer({
      onSpeaking: (sp) => {
        this.mic.setSending(!sp); // ne pas s'écouter parler
        this.cb.onSpeakingChange?.(sp);
        if (this.session) this.cb.onStatus(sp ? 'speaking' : 'listening');
      },
      onLevel: (lvl) => this.cb.onLevel?.(lvl),
    });
    this.mic = new MicCapture({
      onChunk: (b64) =>
        this.session?.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } }),
      onError: (m) => this.fail(m),
    });
    this.player.setPitch(DEFAULT_PITCH);
  }

  get active(): boolean {
    return this.session !== null;
  }

  /** Change la voix. Une session Live fige sa voix à la connexion : si une
   * conversation tourne, on la relance avec la nouvelle voix. */
  async setVoice(name: string): Promise<void> {
    if (name === this.voice) return;
    this.voice = name;
    if (this.session) {
      const sys = this.systemInstruction;
      await this.stop();
      await this.start(sys);
    }
  }

  /** Hauteur de la voix (1 = naturelle, >1 = plus aiguë/bébé). Effet immédiat. */
  setPitch(factor: number): void {
    this.player.setPitch(factor);
  }

  /** Construit un client Gemini : clé brute (dev) ou jeton éphémère frais (prod). */
  private async resolveClient(): Promise<GoogleGenAI> {
    if (this.access.apiKey) {
      return new GoogleGenAI({ apiKey: this.access.apiKey });
    }
    if (this.access.tokenEndpoint) {
      const res = await fetch(this.access.tokenEndpoint, { cache: 'no-store' });
      if (!res.ok) throw new Error(`jeton indisponible (${res.status})`);
      const token = (await res.text()).trim();
      if (!token) throw new Error('jeton vide renvoyé par le serveur');
      // Les jetons éphémères passent par l'API v1alpha.
      return new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
    }
    throw new Error('aucun accès Gemini configuré (ni clé ni endpoint)');
  }

  /** Ouvre la session et lance le micro. `systemInstruction` = persona courant. */
  async start(systemInstruction: string): Promise<void> {
    if (this.session) return;
    this.stopping = false;
    this.systemInstruction = systemInstruction;
    this.cb.onStatus('connecting');
    await this.player.resume(); // dans le geste utilisateur (clic « démarrer »)

    try {
      const ai = await this.resolveClient(); // clé brute (dev) ou jeton éphémère (prod)
      this.session = await ai.live.connect({
        model: MODEL,
        callbacks: {
          onmessage: (m) => this.handle(m),
          onerror: (e) => this.fail(e.message || 'erreur de session'),
          onclose: () => {
            if (!this.stopping && this.session) void this.teardown('idle');
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction,
          tools: this.tools,
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } } },
          // VAD réactif : Mochi répond dès que tu marques un court silence.
          realtimeInputConfig: {
            automaticActivityDetection: {
              startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
              endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
              prefixPaddingMs: VAD_PREFIX_MS,
              silenceDurationMs: VAD_SILENCE_MS,
            },
          },
        },
      });
    } catch (err) {
      this.fail(`connexion Live échouée : ${(err as Error).message}`);
      return;
    }

    const micOk = await this.mic.start();
    if (!micOk) {
      await this.stop();
      return;
    }
    if (this.session) this.cb.onStatus('listening');
  }

  /** Ferme proprement (arrêt volontaire). */
  async stop(): Promise<void> {
    this.stopping = true;
    await this.teardown('idle');
  }

  /** Réflexe local « stop » : coupe la voix immédiatement, sans passer par le cloud. */
  stopReflex(): void {
    this.player.clear();
  }

  private async teardown(status: LiveStatus, detail?: string): Promise<void> {
    const s = this.session;
    this.session = null;
    this.inBuf = this.outBuf = '';
    this.userFlushed = false;
    await this.mic.stop();
    await this.player.close();
    try {
      s?.close();
    } catch {
      /* déjà fermée */
    }
    this.cb.onStatus(status, detail);
  }

  private handle(m: LiveServerMessage): void {
    // 1) Function calls → intentions (visage/moteur) + réponse d'outil à la volée.
    const fcs = m.toolCall?.functionCalls;
    if (fcs?.length) {
      for (const fc of fcs) {
        this.cb.dispatch({ name: fc.name ?? '', args: (fc.args ?? {}) as Record<string, unknown> });
      }
      this.session?.sendToolResponse({
        functionResponses: fcs.map((fc) => ({
          id: fc.id,
          name: fc.name,
          response: { result: 'ok' },
        })),
      });
    }

    // 2) Voix de Mochi (m.data = concat des inlineData audio du message).
    if (typeof m.data === 'string' && m.data.length) this.player.enqueue(m.data);

    // 3) Transcriptions (entrée = utilisateur, sortie = Mochi).
    const sc = m.serverContent;
    const it = sc?.inputTranscription?.text;
    if (it) this.inBuf += it;
    const ot = sc?.outputTranscription?.text;
    if (ot) {
      // Dès que Mochi répond, on affiche d'abord ce que l'utilisateur a dit.
      if (this.inBuf && !this.userFlushed) {
        this.cb.onUserText(this.inBuf.trim());
        this.userFlushed = true;
      }
      this.outBuf += ot;
    }

    if (sc?.interrupted) this.player.clear(); // barge-in : Mochi se tait
    if (sc?.turnComplete) this.flushTurn();
  }

  private flushTurn(): void {
    if (this.inBuf && !this.userFlushed) this.cb.onUserText(this.inBuf.trim());
    if (this.outBuf.trim()) this.cb.onMochiText(this.outBuf.trim());
    this.inBuf = this.outBuf = '';
    this.userFlushed = false;
  }

  private fail(msg: string): void {
    if (this.stopping) return;
    this.stopping = true;
    void this.teardown('error', msg);
  }
}
