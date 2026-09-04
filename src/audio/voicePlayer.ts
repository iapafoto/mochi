// Lecture en flux de la voix de Mochi.
//
// Gemini Live renvoie la voix en morceaux base64 (PCM 16 bits mono @ 24 kHz). On
// les joue sans trou en chaînant des AudioBufferSourceNode sur une horloge
// (`nextTime`). Sait tout couper net (barge-in du modèle ou réflexe « stop »
// local) et signale quand Mochi parle — pour animer la bouche et couper le micro.

const OUTPUT_RATE = 24000;
/**
 * Marge du chien de garde apres la fin THEORIQUE de l'audio programme (cf.
 * armWatchdog). Large : on ne veut surtout pas couper une voix qui parle encore,
 * seulement rattraper un evenement de fin qui ne viendra jamais.
 */
const WATCHDOG_MARGIN_MS = 700;

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
  /**
   * Le chien de garde a dû forcer le retour à l'écoute (cf. armWatchdog). À
   * journaliser : c'est le seul témoin d'un blocage qui, sans lui, rendait Mochi
   * sourd sans laisser la moindre trace.
   */
  onStalled?(reason: string): void;
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
  private watchdog: number | null = null;
  private pitch = 1; // >1 = voix plus aiguë (et un peu plus rapide) → effet « bébé »
  private analyser: AnalyserNode | null = null; // tap non destructif de la sortie
  private envBuf: Float32Array<ArrayBuffer> | null = null; // scratch pour getFloatTimeDomainData
  private env = 0; // enveloppe RMS lissée courante (0..1), pilote l'ouverture de bouche

  constructor(private readonly cb: VoicePlayerCallbacks) {}

  /** Décale la hauteur de la voix (1 = naturelle, 1.1–1.3 = plus aiguë/bébé). */
  setPitch(factor: number): void {
    this.pitch = Math.max(0.5, Math.min(2, factor));
  }

  /**
   * Enveloppe RMS 0..1 de la voix qui sort À CET INSTANT — à lire une fois par
   * frame pour caler l'ouverture de la bouche dessus. Contrairement à `onLevel`
   * (le pic d'un morceau AU MOMENT OÙ IL EST PROGRAMMÉ, parfois une seconde à
   * l'avance), ceci mesure ce que le haut-parleur émet vraiment maintenant : c'est
   * ce qui rend les mouvements labiaux synchrones. Attaque rapide / relâche lente
   * pour une bouche franche mais sans tremblotement ; décroît vers 0 au silence.
   */
  readMouthEnvelope(): number {
    const a = this.analyser;
    const buf = this.envBuf;
    if (!a || !buf) return 0;
    if (!this.speaking) {
      this.env *= 0.6; // relâche douce vers bouche fermée entre deux prises de parole
      return this.env;
    }
    a.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    // attaque (rms monte) rapide, relâche (rms baisse) lente.
    this.env = rms > this.env ? rms * 0.5 + this.env * 0.5 : rms * 0.15 + this.env * 0.85;
    return this.env;
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
    this.armWatchdog(ctx);
    this.cb.onLevel?.(peak);
  }

  /**
   * Chien de garde de la parole. Sans lui, « Mochi parle » pouvait rester vrai
   * POUR TOUJOURS, et comme l'envoi micro est coupé pendant qu'il parle, il
   * devenait complètement sourd — jusqu'à ce qu'un barge-in ou le bouton STOP
   * appelle `clear()`. Symptôme vécu : « il ne m'entend plus du tout pendant une
   * à deux minutes », avec l'impression que ce sont les actions qui le coupent
   * (elles arrivent au moment où il parle, d'où la confusion).
   *
   * ⚠️ LA CAUSE EST QUE `speaking` NE RETOMBAIT QUE PAR `src.onended`. Cet
   * événement ne se produit pas si le contexte audio se suspend — écran éteint,
   * appli passée en arrière-plan, bridage du navigateur : les sources programmées
   * ne se terminent jamais, l'ensemble ne se vide pas, et plus rien ne remet le
   * micro en marche. Un seul événement manquant suffisait à le rendre muet aux
   * autres, définitivement.
   *
   * On sait pourtant exactement quand l'audio DOIT être fini : `nextTime`. Passé
   * ce moment plus une marge, si on se croit encore en train de parler, c'est que
   * l'événement s'est perdu — on force le retour à l'écoute.
   */
  private armWatchdog(ctx: AudioContext): void {
    if (this.watchdog !== null) clearTimeout(this.watchdog);
    const remainingMs = Math.max(0, (this.nextTime - ctx.currentTime) * 1000);
    this.watchdog = window.setTimeout(() => {
      this.watchdog = null;
      if (!this.speaking) return;
      // Le contexte suspendu est LE cas pathologique : le temps audio ne s'écoule
      // plus, donc `nextTime` ne sera jamais atteint et aucune source ne finira.
      const stalled = ctx.state !== 'running';
      if (!stalled && ctx.currentTime < this.nextTime - 0.05) {
        this.armWatchdog(ctx); // encore de l'audio devant : on repousse
        return;
      }
      for (const s of this.sources) {
        try {
          s.onended = null;
          s.stop();
        } catch {
          /* déjà terminée */
        }
      }
      this.sources.clear();
      this.nextTime = 0;
      this.speaking = false;
      this.cb.onSpeaking(false);
      this.cb.onLevel?.(0);
      this.cb.onStalled?.(stalled ? `moteur audio « ${ctx.state} »` : 'fin de parole perdue');
    }, remainingMs + WATCHDOG_MARGIN_MS);
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
    if (this.watchdog !== null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
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
    this.analyser = null;
    this.envBuf = null;
    this.env = 0;
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

    // Analyseur en sortie : tap NON destructif du signal final (post-limiteur =
    // exactement ce qu'on entend). Lu par frame via readMouthEnvelope() pour
    // caler l'ouverture de la bouche sur l'enveloppe RÉELLE de la voix, au lieu
    // d'un flap aléatoire sur le pic d'un morceau. C'est un nœud pass-through :
    // il ne modifie pas le son, donc on branche les sorties DERRIÈRE lui.
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024; // ~20 ms de fenêtre : assez court pour suivre les syllabes
    limiter.connect(analyser);
    this.analyser = analyser;
    this.envBuf = new Float32Array(analyser.fftSize);
    this.tail = analyser;

    // Chemin direct (repli, actif par défaut). resume() bascule vers le <audio>
    // element s'il parvient à jouer (haut-parleur mobile au lieu de l'écouteur).
    // Les deux sorties partent de `tail` (l'analyseur) : resume() disconnecte
    // `tail` de ctx.destination, il faut donc que ce soit le nœud branché dessus.
    this.tail.connect(this.ctx.destination);
    try {
      this.streamDest = this.ctx.createMediaStreamDestination();
      this.tail.connect(this.streamDest);
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
