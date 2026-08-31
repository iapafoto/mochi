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

/**
 * Durée MAXIMALE d'un portillon micro, quel que soit le son joué.
 *
 * ⚠️ LE PORTILLON FABRIQUE DU SILENCE, ET LE SILENCE EST CE QUI TERMINE TON TOUR.
 * Le serveur commite après VAD_SILENCE_MS de calme : un blip long (la tristesse
 * fait 700 ms) qui tombe après une petite pause dans ta phrase produit assez de
 * silence CONTINU pour que ta phrase soit coupée en deux — et Gemini répond alors
 * à une demi-phrase. On plafonne donc bien en dessous du seuil, et la soupape
 * `ungateMic` fait le reste dès que tu reparles.
 */
const MAX_GATE_MS = 220;

export type LiveStatus = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';

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
  /** Chemin de sortie audio retenu (cf. VoicePlayer) — diagnostic du volume Android. */
  onRoute?(viaElement: boolean, detail: string): void;
  /** Niveau crête du micro (0..1) et si le paquet part vraiment (cf. MicCapture). */
  onMicLevel?(peak: number, sending: boolean): void;
  /** Niveau crête de chaque paquet (~40 ms), non lissé — pour la détection de parole. */
  onMicFrame?(peak: number): void;
  /** Réglages RÉELLEMENT appliqués au micro par le navigateur (cf. MicCapture). */
  onMicApplied?(summary: string): void;
  /**
   * Un function call de Mochi → intention (visage/moteur).
   *
   * Le retour repart vers le MODÈLE comme réponse d'outil : c'est le seul chemin
   * par lequel le monde réel peut le contredire. `ok: false` lui dit que son ordre
   * n'a rien fait, et `detail` pourquoi — « pas connecté à mon corps », « je suis
   * couché ». Rendre `void` (ou toujours « ok ») le laisse raconter des figures
   * qu'il n'exécute pas.
   */
  dispatch(call: IntentCall): { ok: boolean; detail: string } | void;
}

export class LiveConversation {
  private readonly tools = toGeminiTools();
  private readonly mic: MicCapture;
  private readonly player: VoicePlayer;
  private session: Session | null = null;
  private stopping = false;
  private voice = DEFAULT_VOICE;
  private systemInstruction = ''; // mémorisé pour relancer sur changement de voix
  /** Mochi parle-t-il ? (miroir de VoicePlayer, pour le portillon des blips.) */
  private speaking = false;
  /** Échéance du portillon micro (cf. gateMicFor). */
  private gateTimer: number | null = null;

  // Accumulateurs de transcription (vidés à chaque fin de tour).
  private inBuf = '';
  private outBuf = '';
  private userFlushed = false;

  constructor(
    /** Clé Gemini de cet appareil (cf. agent/apiKey.ts) — le seul accès possible. */
    private readonly apiKey: string,
    private readonly cb: LiveConversationCallbacks,
  ) {
    this.player = new VoicePlayer({
      onSpeaking: (sp) => {
        this.speaking = sp;
        this.mic.setSending(!sp); // ne pas s'écouter parler
        this.cb.onSpeakingChange?.(sp);
        if (this.session) this.cb.onStatus(sp ? 'speaking' : 'listening');
      },
      onLevel: (lvl) => this.cb.onLevel?.(lvl),
      onRoute: (viaElement, detail) => this.cb.onRoute?.(viaElement, detail),
    });
    this.mic = new MicCapture({
      onChunk: (b64) =>
        this.session?.sendRealtimeInput({ audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } }),
      onError: (m) => this.fail(m),
      onLevel: (peak, sending) => this.cb.onMicLevel?.(peak, sending),
      onFrame: (peak) => this.cb.onMicFrame?.(peak),
      onApplied: (summary) => this.cb.onMicApplied?.(summary),
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

  /**
   * Active/coupe le traitement téléphonie du micro (cf. MicCapture.setProcessing).
   * Comme la voix, il est figé à l'ouverture du flux : on relance la conversation
   * pour que le changement s'entende TOUT DE SUITE — sans ça, comparer les deux
   * réglages demanderait d'arrêter et relancer à la main entre chaque essai, et
   * personne ne compare vraiment dans ces conditions.
   */
  async setMicProcessing(on: boolean): Promise<void> {
    this.mic.setProcessing(on);
    if (this.session) {
      const sys = this.systemInstruction;
      await this.stop();
      await this.start(sys);
    }
  }

  /** Gain micro (1..8). Effet immédiat, sans relancer la session. */
  setMicGain(g: number): void {
    this.mic.setGain(g);
  }

  /** Hauteur de la voix (1 = naturelle, >1 = plus aiguë/bébé). Effet immédiat. */
  setPitch(factor: number): void {
    this.player.setPitch(factor);
  }

  /**
   * Rend le micro sourd pendant `ms` — le temps d'un blip kawaii, pour qu'il ne
   * revienne pas dans la session (la VAD est en sensibilité haute : un « pouet »
   * suffirait à ouvrir un tour).
   *
   * Sans effet quand Mochi parle : l'envoi est déjà coupé par l'anti-larsen, et
   * lever le portillon derrière lui rouvrirait le micro trop tôt. Les appels
   * s'écrasent (le dernier gagne) plutôt que de s'empiler : deux blips qui se
   * chevauchent ne demandent qu'une seule fenêtre, la plus tardive.
   */
  gateMicFor(ms: number): void {
    if (!this.session || this.speaking) return;
    this.mic.setSilenced(true);
    if (this.gateTimer !== null) window.clearTimeout(this.gateTimer);
    this.gateTimer = window.setTimeout(() => {
      this.gateTimer = null;
      this.mic.setSilenced(false);
    }, Math.min(ms, MAX_GATE_MS));
  }

  /**
   * Rouvre le micro TOUT DE SUITE. C'est la soupape : dès que la détection locale
   * entend quelqu'un, on arrête de fabriquer du silence, quel que soit le blip en
   * cours. Un son de Mochi ne doit jamais avoir la priorité sur ta voix.
   */
  ungateMic(): void {
    if (this.gateTimer !== null) {
      window.clearTimeout(this.gateTimer);
      this.gateTimer = null;
    }
    this.mic.setSilenced(false);
  }

  /** Construit un client Gemini : clé saisie sur l'appareil, ou jeton éphémère. */
  /** Ouvre la session et lance le micro. `systemInstruction` = persona courant. */
  async start(systemInstruction: string): Promise<void> {
    if (this.session) return;
    this.stopping = false;
    this.systemInstruction = systemInstruction;
    this.cb.onStatus('connecting');
    await this.player.resume(); // dans le geste utilisateur (clic « démarrer »)

    try {
      const ai = new GoogleGenAI({ apiKey: this.apiKey });
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
    this.speaking = false;
    // ⚠️ ROUVRIR LE MICRO, PAS SEULEMENT ANNULER LE MINUTEUR. `MicCapture` est la
    // MÊME instance d'une session à l'autre : un portillon encore fermé quand la
    // session tombe (changement de voix, réglage micro, erreur réseau — tous
    // passent par ici) laissait le micro envoyer du silence POUR TOUJOURS. Aucun
    // symptôme sauf un Mochi devenu subitement sourd, et la jauge d'entrée
    // continuait de bouger, puisqu'elle mesure avant le portillon.
    this.ungateMic();
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
      // ⚠️ ON REND LE VRAI RÉSULTAT, PAS UN « ok » DE PRINCIPE. C'était écrit en
      // dur ici, et c'est ce qui rendait Mochi menteur sans qu'il le sache : quand
      // le lien BLE tombait, ou qu'il était désarmé, ou couché, l'ordre n'avait
      // aucun effet — mais le modèle recevait « ok » et continuait de raconter la
      // figure qu'il croyait exécuter, corps inerte. Aucun signal ne remontait
      // jamais du monde réel vers lui ; il ne pouvait PAS savoir.
      const results = fcs.map((fc) => ({
        fc,
        outcome: this.cb.dispatch({
          name: fc.name ?? '',
          args: (fc.args ?? {}) as Record<string, unknown>,
        }),
      }));
      this.session?.sendToolResponse({
        functionResponses: results.map(({ fc, outcome }) => ({
          id: fc.id,
          name: fc.name,
          response: outcome?.ok === false
            ? { result: 'sans effet', raison: outcome.detail }
            : { result: 'ok', ...(outcome?.detail ? { detail: outcome.detail } : {}) },
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
