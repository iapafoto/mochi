// Moteur de sons kawaii — synthèse procédurale WebAudio, zéro fichier.
//
// Esthétique « petit animal » : notes courtes, aiguës, légèrement détunées,
// vibrato, gammes pentatoniques. Un AudioContext est créé paresseusement et
// doit être « débloqué » par un premier geste utilisateur (voir unlock()).

export type SoundName =
  | 'joy'
  | 'sadness'
  | 'surprise'
  | 'curiosity'
  | 'anger'
  | 'neutral'
  | 'blink'
  | 'wink'
  | 'greeting'
  | 'move'
  | 'error'
  // --- Sons de CONVERSATION (joués pendant une session Live, cf. setVoiceMode) ---
  | 'thinking' // « mmh ? » — dès que tu te tais, AVANT que le modèle réponde
  | 'fall' // il vient de tomber
  | 'recover'; // on vient de le relever

interface Blip {
  f0: number; // fréquence de départ (Hz)
  f1?: number; // fréquence d'arrivée (glide), défaut = f0
  dur: number; // durée (s)
  type?: OscillatorType;
  gain?: number; // 0..1
  vibrato?: number; // profondeur du vibrato (Hz), 0 = aucun
  delay?: number; // décalage avant lecture (s)
}

// Gamme pentatonique majeure (C) sur deux octaves — sonorités « mignonnes ».
const PENTA = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5, 1174.66, 1318.51];

/**
 * Rallonge du portillon micro après le dernier échantillon d'un son. Le
 * haut-parleur du téléphone continue de sonner un peu, et la pièce répond : sans
 * cette queue, c'est la réverbération du blip qui rentre dans le micro.
 */
const BLIP_TAIL_MS = 70;

// Motifs par son : suite de blips.
const PATTERNS: Record<SoundName, Blip[]> = {
  joy: [
    { f0: PENTA[2], dur: 0.09, gain: 0.5 },
    { f0: PENTA[4], dur: 0.09, gain: 0.5, delay: 0.08 },
    { f0: PENTA[5], f1: PENTA[6], dur: 0.14, gain: 0.55, delay: 0.16, vibrato: 8 },
  ],
  sadness: [
    { f0: PENTA[3], f1: PENTA[1], dur: 0.35, gain: 0.4, type: 'sine', vibrato: 5 },
    { f0: PENTA[1], f1: 440, dur: 0.4, gain: 0.35, type: 'sine', delay: 0.3 },
  ],
  surprise: [
    { f0: PENTA[1], f1: PENTA[7], dur: 0.12, gain: 0.55, type: 'triangle' },
    { f0: PENTA[7], dur: 0.06, gain: 0.4, delay: 0.11 },
  ],
  curiosity: [
    { f0: PENTA[2], dur: 0.1, gain: 0.45 },
    { f0: PENTA[4], f1: PENTA[6], dur: 0.18, gain: 0.5, delay: 0.09, vibrato: 6 }, // montée = question
  ],
  anger: [
    { f0: 180, f1: 120, dur: 0.22, gain: 0.5, type: 'sawtooth', vibrato: 18 },
    { f0: 150, dur: 0.14, gain: 0.4, type: 'square', delay: 0.18 },
  ],
  neutral: [{ f0: PENTA[3], dur: 0.08, gain: 0.3, type: 'sine' }],
  blink: [{ f0: PENTA[5], dur: 0.03, gain: 0.12, type: 'sine' }],
  wink: [
    { f0: PENTA[4], dur: 0.07, gain: 0.4 },
    { f0: PENTA[6], dur: 0.09, gain: 0.45, delay: 0.07, vibrato: 10 },
  ],
  greeting: [
    { f0: PENTA[2], dur: 0.1, gain: 0.45 },
    { f0: PENTA[4], dur: 0.1, gain: 0.45, delay: 0.09 },
    { f0: PENTA[3], f1: PENTA[5], dur: 0.16, gain: 0.5, delay: 0.18, vibrato: 7 },
  ],
  move: [{ f0: PENTA[0], f1: PENTA[2], dur: 0.12, gain: 0.35, type: 'triangle', vibrato: 4 }],
  error: [
    { f0: PENTA[1], dur: 0.1, gain: 0.4, type: 'square' },
    { f0: 392, dur: 0.16, gain: 0.4, type: 'square', delay: 0.1 },
  ],
  // Court et MONTANT = une question, « mmh ? ». C'est le son qui comble le trou
  // entre la fin de ta phrase et le premier mot du modèle : il doit être bref
  // (il sera recouvert par la voix) et interrogatif (il annonce une réponse).
  thinking: [{ f0: PENTA[2], f1: PENTA[4], dur: 0.13, gain: 0.3, type: 'sine', vibrato: 6 }],
  // Descente longue = la chute. Deux voix qui glissent vers le grave.
  fall: [
    { f0: PENTA[4], f1: 220, dur: 0.5, gain: 0.45, type: 'triangle', vibrato: 9 },
    { f0: 330, f1: 165, dur: 0.45, gain: 0.3, type: 'sine', delay: 0.12 },
  ],
  // Remontée franche = on l'a relevé. Le symétrique exact de `fall`.
  recover: [
    { f0: 330, f1: PENTA[3], dur: 0.18, gain: 0.4, type: 'triangle' },
    { f0: PENTA[4], f1: PENTA[6], dur: 0.2, gain: 0.5, delay: 0.16, vibrato: 8 },
  ],
};

export class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private _muted = false;
  private _voiceMode = false;
  /** Prévenu AVANT chaque son, avec sa durée : cf. onWillPlay. */
  private willPlay: ((durationMs: number, soundMs: number) => void) | null = null;

  get muted(): boolean {
    return this._muted;
  }

  setMuted(v: boolean): void {
    this._muted = v;
    this.applyGain();
  }

  /**
   * Mode « Mochi a une vraie voix » (session Live ouverte).
   *
   * ⚠️ CE MODE COUPAIT TOUT, ET C'ÉTAIT TROP LARGE. Les blips d'émotion et le
   * `move` du dispatcher ne sortaient donc JAMAIS en usage réel — tout ce moteur
   * de sons ne servait qu'au mode texte. Ce qu'il fallait vraiment empêcher, c'est
   * deux choses précises :
   *   • le BABIL, qui est une fausse voix : elle n'a plus lieu d'être quand la
   *     vraie parle, et se superposerait à elle. Lui reste coupé.
   *   • le RETOUR DANS LE MICRO : un blip capté relance un tour (la VAD est en
   *     sensibilité haute). C'est le rôle de `onWillPlay`, qui fait taire l'envoi
   *     micro pendant la durée exacte du son — le même mécanisme que l'anti-larsen.
   * Le niveau baisse un peu : les blips PONCTUENT la voix, ils ne la couvrent pas.
   */
  setVoiceMode(v: boolean): void {
    this._voiceMode = v;
    this.applyGain();
  }

  /**
   * Branche le portillon micro. Appelé juste AVANT de programmer un son, avec sa
   * durée totale — à charge de l'appelant de faire taire l'entrée pendant ce
   * temps-là (cf. LiveConversation.gateMicFor).
   */
  onWillPlay(cb: (durationMs: number, soundMs: number) => void): void {
    this.willPlay = cb;
  }

  private applyGain(): void {
    if (this.master) this.master.gain.value = this._muted ? 0 : this._voiceMode ? 0.5 : 0.9;
  }

  /** Durée totale d'un motif (dernier blip programmé), en ms. */
  durationOf(name: SoundName): number {
    let end = 0;
    for (const b of PATTERNS[name]) end = Math.max(end, (b.delay ?? 0) + b.dur);
    return Math.round(end * 1000);
  }

  /** À appeler sur un geste utilisateur (clic) pour autoriser l'audio. */
  async unlock(): Promise<void> {
    this.ensure();
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
  }

  play(name: SoundName): void {
    if (this._muted) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running') return; // pas encore débloqué
    // Le portillon d'abord : la queue couvre la réverbération du haut-parleur,
    // qui arrive APRÈS le dernier échantillon et se ferait entendre sans elle.
    const sonne = this.durationOf(name);
    this.willPlay?.(sonne + BLIP_TAIL_MS, sonne);
    const t0 = ctx.currentTime;
    // Micro-désaccord à chaque lecture : deux `blink` d'affilée rigoureusement
    // identiques s'entendent comme un bip de machine. ±3 %, c'est inaudible comme
    // écart et parfaitement audible comme absence.
    const detune = 1 + (Math.random() - 0.5) * 0.06;
    for (const b of PATTERNS[name]) this.blip(ctx, b, t0, detune);
  }

  /** Babil « façon petit animal » pendant que Mochi « parle ». */
  babble(durationMs: number, mood: 'up' | 'down' | 'flat' = 'up'): void {
    // Coupé en mode voix : c'est une FAUSSE voix, et la vraie parle (cf. setVoiceMode).
    if (this._muted || this._voiceMode) return;
    const ctx = this.ensure();
    if (!ctx || ctx.state !== 'running') return;
    const t0 = ctx.currentTime;
    const step = 0.11;
    const count = Math.max(1, Math.min(24, Math.floor(durationMs / 1000 / step)));
    for (let i = 0; i < count; i++) {
      // Marche aléatoire sur la gamme, biaisée par l'humeur.
      const bias = mood === 'up' ? 0.6 : mood === 'down' ? -0.6 : 0;
      const idx = Math.max(
        0,
        Math.min(PENTA.length - 1, Math.round(2 + i * 0.15 * bias + Math.random() * 3)),
      );
      this.blip(
        ctx,
        { f0: PENTA[idx], dur: 0.07, gain: 0.28, type: 'triangle', vibrato: 5, delay: i * step },
        t0,
      );
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = this._muted ? 0 : 0.9;
    this.master.connect(this.ctx.destination);
    return this.ctx;
  }

  private blip(ctx: AudioContext, b: Blip, t0: number, detune = 1): void {
    if (!this.master) return;
    const start = t0 + (b.delay ?? 0);
    const end = start + b.dur;

    const osc = ctx.createOscillator();
    osc.type = b.type ?? 'triangle';
    osc.frequency.setValueAtTime(b.f0 * detune, start);
    if (b.f1 && b.f1 !== b.f0) osc.frequency.exponentialRampToValueAtTime(b.f1 * detune, end);

    // Enveloppe d'amplitude (attaque courte, chute douce) → sonorité « pouet ».
    const g = ctx.createGain();
    const peak = b.gain ?? 0.4;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.02, b.dur * 0.3));
    g.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(g);
    g.connect(this.master);
    osc.start(start);
    osc.stop(end + 0.02);

    // Vibrato optionnel (LFO sur la fréquence).
    if (b.vibrato) {
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      lfo.frequency.value = 11;
      lfoGain.gain.value = b.vibrato;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      lfo.start(start);
      lfo.stop(end + 0.02);
    }
  }
}
