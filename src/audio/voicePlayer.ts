// Lecture en flux de la voix de Mochi.
//
// Gemini Live renvoie la voix en morceaux base64 (PCM 16 bits mono @ 24 kHz). On
// les joue sans trou en chaînant des AudioBufferSourceNode sur une horloge
// (`nextTime`). Sait tout couper net (barge-in du modèle ou réflexe « stop »
// local) et signale quand Mochi parle — pour animer la bouche et couper le micro.

const OUTPUT_RATE = 24000;
const OFF_HANGOVER_MS = 140; // évite le clignotement parle/écoute entre 2 morceaux, sans trop retarder la reprise du micro
const MAKEUP_GAIN = 3.0; // le PCM de Gemini n'est pas à pleine échelle → on remonte (limiteur derrière)

export interface VoicePlayerCallbacks {
  /** true dès qu'un morceau est planifié, false quand la file se vide (après hangover). */
  onSpeaking(speaking: boolean): void;
  /** Amplitude crête 0..1 du dernier morceau (anime la bouche). */
  onLevel?(level: number): void;
  /**
   * Par où sort la voix, une fois `resume()` tranché. `viaElement = false` sur
   * Android veut dire volume d'appel : c'est la cause n°1 de « Mochi ne parle pas
   * fort », et sans ce rapport elle est INVISIBLE — le son sort quand même.
   */
  onRoute?(viaElement: boolean, detail: string): void;
}

export class VoicePlayer {
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private tail: AudioNode | null = null; // dernier nœud avant la sortie (gain → limiteur)
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private sinkEl: HTMLAudioElement | null = null;
  private routedToElement = false; // true si la sortie passe par le <audio> (haut-parleur mobile)
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
    if (!ctx) return;

    // IMPORTANT : démarrer le <audio> element AVANT tout `await`, pendant qu'on
    // est encore dans la fenêtre synchrone du geste utilisateur. Une capture
    // micro (getUserMedia) active fait basculer Android sur le flux « voice
    // communication » (volume d'appel, faible) pour l'AudioContext. Jouer via un
    // HTMLAudioElement le remet sur le flux « média » (STREAM_MUSIC), fort, comme
    // une vidéo. On garde ctx.destination en repli tant que l'élément ne joue pas.
    if (this.sinkEl && !this.routedToElement) {
      const play = this.sinkEl.play();
      if (play) {
        play
          .then(() => {
            this.tail?.disconnect(ctx.destination); // évite le double son
            this.routedToElement = true;
            this.cb.onRoute?.(true, 'sortie via <audio> (flux média)');
          })
          .catch((e: Error) => {
            // Repli sur ctx.destination. ⚠️ CE REPLI EST SILENCIEUX ET C'EST SON
            // DÉFAUT : le son sort quand même, simplement sur le flux communication
            // d'Android — volume d'appel, donc faible. Rien ne casse, rien ne
            // s'affiche, et on cherche du côté du micro ou du modèle. D'où ce
            // rapport : c'est la seule façon de savoir, depuis le téléphone, quel
            // chemin a gagné.
            this.cb.onRoute?.(false, `<audio> refusé (${e.name}) — repli AudioContext`);
          });
      } else {
        this.cb.onRoute?.(false, 'play() sans promesse — repli AudioContext');
      }
    } else if (!this.sinkEl) {
      this.cb.onRoute?.(false, 'pas de MediaStreamDestination — repli AudioContext');
    }

    if (ctx.state === 'suspended') await ctx.resume();
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
    if (this.sinkEl) {
      try {
        this.sinkEl.pause();
        this.sinkEl.srcObject = null;
        this.sinkEl.remove();
      } catch {
        /* déjà libéré */
      }
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* déjà fermé */
      }
    }
    this.ctx = null;
    this.gain = null;
    this.tail = null;
    this.streamDest = null;
    this.sinkEl = null;
    this.routedToElement = false;
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
    this.gain.gain.value = MAKEUP_GAIN;

    // Limiteur : empêche la saturation quand on pousse le gain de compensation.
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -1.5;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.1;
    this.gain.connect(limiter);
    this.tail = limiter;

    // Chemin direct (repli, actif par défaut). resume() bascule vers le <audio>
    // element s'il parvient à jouer (haut-parleur mobile au lieu de l'écouteur).
    limiter.connect(this.ctx.destination);
    try {
      this.streamDest = this.ctx.createMediaStreamDestination();
      limiter.connect(this.streamDest);
      const el = new Audio();
      el.autoplay = true;
      el.volume = 1;
      (el as HTMLAudioElement & { playsInline: boolean }).playsInline = true;
      el.srcObject = this.streamDest.stream;
      // Attaché au DOM (invisible) : certains Android ne routent l'élément vers
      // le flux « média » que s'il fait partie du document.
      el.style.display = 'none';
      document.body.appendChild(el);
      this.sinkEl = el;
    } catch {
      /* MediaStreamDestination indisponible : on reste sur ctx.destination */
    }
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
