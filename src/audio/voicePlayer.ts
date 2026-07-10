// Lecture en flux de la voix de Mochi.
//
// Gemini Live renvoie la voix en morceaux base64 (PCM 16 bits mono @ 24 kHz). On
// les joue sans trou en chaînant des AudioBufferSourceNode sur une horloge
// (`nextTime`). Sait tout couper net (barge-in du modèle ou réflexe « stop »
// local) et signale quand Mochi parle — pour animer la bouche et couper le micro.

const OUTPUT_RATE = 24000;
const OFF_HANGOVER_MS = 140; // évite le clignotement parle/écoute entre 2 morceaux, sans trop retarder la reprise du micro

export interface VoicePlayerCallbacks {
  /** true dès qu'un morceau est planifié, false quand la file se vide (après hangover). */
  onSpeaking(speaking: boolean): void;
  /** Amplitude crête 0..1 du dernier morceau (anime la bouche). */
  onLevel?(level: number): void;
}

export class VoicePlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private nextTime = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private speaking = false;
  private offTimer: number | null = null;
  private pitch = 1; // >1 = voix plus aiguë (et un peu plus rapide) → effet « bébé »

  constructor(private readonly cb: VoicePlayerCallbacks) {}

  /** Décale la hauteur de la voix (1 = naturelle, 1.1–1.3 = plus aiguë/bébé). */
  setPitch(factor: number): void {
    this.pitch = Math.max(0.5, Math.min(2, factor));
  }

  /** À appeler dans un geste utilisateur pour autoriser l'audio. */
  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (ctx && ctx.state === 'suspended') await ctx.resume();
  }

  enqueue(base64Pcm24: string): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const pcm = base64ToInt16(base64Pcm24);
    if (pcm.length === 0) return;

    const buf = ctx.createBuffer(1, pcm.length, OUTPUT_RATE);
    const ch = buf.getChannelData(0);
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] / 32768;
      ch[i] = v;
      const av = v < 0 ? -v : v;
      if (av > peak) peak = av;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = this.pitch; // aigu = lecture plus rapide
    src.connect(this.gain!);
    const start = Math.max(ctx.currentTime, this.nextTime);
    src.start(start);
    this.nextTime = start + buf.duration / this.pitch; // durée réelle = durée / vitesse

    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) this.markSpeaking(false);
    };

    this.markSpeaking(true);
    this.cb.onLevel?.(peak);
  }

  /** Coupe tout immédiatement (barge-in ou réflexe « stop »). */
  clear(): void {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* déjà stoppé */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
    if (this.offTimer !== null) {
      clearTimeout(this.offTimer);
      this.offTimer = null;
    }
    if (this.speaking) {
      this.speaking = false;
      this.cb.onSpeaking(false);
      this.cb.onLevel?.(0);
    }
  }

  async close(): Promise<void> {
    this.clear();
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* déjà fermé */
      }
    }
    this.ctx = null;
    this.gain = null;
  }

  private markSpeaking(on: boolean): void {
    if (on) {
      if (this.offTimer !== null) {
        clearTimeout(this.offTimer);
        this.offTimer = null;
      }
      if (!this.speaking) {
        this.speaking = true;
        this.cb.onSpeaking(true);
      }
      return;
    }
    // Passage à « ne parle plus » différé : un nouveau morceau peut arriver.
    if (this.offTimer !== null) return;
    this.offTimer = window.setTimeout(() => {
      this.offTimer = null;
      if (this.sources.size === 0 && this.speaking) {
        this.speaking = false;
        this.cb.onSpeaking(false);
        this.cb.onLevel?.(0);
      }
    }, OFF_HANGOVER_MS);
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(this.ctx.destination);
    return this.ctx;
  }
}

/** base64 → Int16Array (little-endian), sur un buffer propre et aligné. */
function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const n = bin.length;
  const bytes = new Uint8Array(n);
  for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
  const len = n >> 1; // 2 octets par échantillon
  const out = new Int16Array(len);
  const dv = new DataView(bytes.buffer);
  for (let i = 0; i < len; i++) out[i] = dv.getInt16(i * 2, true);
  return out;
}
