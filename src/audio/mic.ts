// Capture micro → PCM 16 kHz mono (Int16), poussé par paquets ~100 ms en base64.
//
// getUserMedia (avec annulation d'écho) → AudioContext 16 kHz → AudioWorklet
// (pcm-recorder). AUCUNE dépendance à Gemini : ce module ne sait qu'émettre des
// chunks. C'est LiveConversation qui les envoie à la session.
//
// `echoCancellation` retire une partie de la voix de Mochi captée par le micro ;
// en complément, LiveConversation coupe l'envoi pendant que Mochi parle
// (anti-larsen : voix + moteurs dans le micro, cf. PLAN M5).

const WORKLET_URL = new URL('./pcm-recorder.worklet.js', import.meta.url);

/** Période de remontée du niveau micro — assez lent pour l'œil, assez vif pour parler. */
const LEVEL_PERIOD_MS = 150;

export interface MicCallbacks {
  /** Un paquet PCM 16 bits @ 16 kHz, encodé base64, prêt à envoyer. */
  onChunk(base64Pcm16: string): void;
  onError(message: string): void;
  /**
   * Niveau crête (0..1) du dernier paquet, ÉMIS MÊME QUAND L'ENVOI EST COUPÉ —
   * `sending` dit lequel des deux cas on est en train de regarder.
   *
   * ⚠️ C'est toute la valeur de cette mesure : « le micro ne t'entend pas » et
   * « le micro t'entend très bien mais on jette, parce que Mochi parle » se
   * ressemblent trait pour trait vu du fauteuil, et appellent des correctifs
   * opposés. Sans ce chiffre on règle la sensibilité d'un micro qui marche.
   */
  onLevel?(peak: number, sending: boolean): void;
  /**
   * Niveau crête de CHAQUE paquet (~40 ms), sans lissage ni throttle.
   *
   * Séparé de `onLevel` exprès : celui-là alimente une jauge qu'un œil humain
   * doit pouvoir lire (150 ms), celui-ci alimente une détection de parole, où
   * 150 ms de retard sur la fin d'une phrase est précisément ce qu'on cherche à
   * ne pas avoir. Deux consommateurs, deux cadences.
   */
  onFrame?(peak: number): void;
  /**
   * Ce que le navigateur a RÉELLEMENT appliqué au flux, une fois ouvert.
   *
   * ⚠️ Les contraintes passées à `getUserMedia` sont un SOUHAIT, pas un fait : sur
   * Android le pilote accorde ou refuse ce qu'il veut, en silence. Or c'est
   * précisément `echoCancellation` qui décide si Mochi entend à 50 cm ou seulement
   * à 5 (cf. setProcessing). Deviner ce réglage depuis l'état d'une case à cocher
   * — qui vit dans le localStorage et survit à tout — c'est diagnostiquer à
   * l'aveugle une panne dont c'est la cause n°1.
   */
  onApplied?(summary: string): void;
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private _active = false;
  private _sending = true;
  private _silenced = false; // cf. setSilenced : on envoie, mais du vide
  private zeros: Int16Array | null = null;
  private _processing = false; // cf. setProcessing : mesuré au banc le 23/08
  private _gain = 1;
  private boost: GainNode | null = null;
  private lastLevelMs = 0;
  private peakAcc = 0;

  constructor(private readonly cb: MicCallbacks) {}

  /**
   * Traitement « téléphonie » du navigateur (annulation d'écho + réduction de
   * bruit). Pris en compte au prochain `start()`.
   *
   * ⚠️ DÉSACTIVÉ PAR DÉFAUT, ET C'EST UNE MESURE, PAS UNE PRÉFÉRENCE (23/08).
   * Avec, sur Android : à ~5 cm ça marche à tous les coups, à 50 cm ça ne marche
   * JAMAIS — une falaise, pas une dégradation. Sans, « il entend beaucoup mieux ».
   * `echoCancellation` fait basculer la capture sur la source VOICE_COMMUNICATION,
   * réglée pour un téléphone tenu CONTRE LA BOUCHE ; sur une voix lointaine et
   * réverbérée son traitement retire du contenu de PAROLE en même temps que le
   * bruit. L'AGC rattrape ensuite le niveau — donc la jauge reste belle — pendant
   * que la structure fine qui porte l'intelligibilité est déjà partie. C'est ce
   * qui rend la panne si trompeuse : tous les voyants sont au vert.
   *
   * ⚠️ LES DEUX SONT LIÉS À UN SEUL INTERRUPTEUR EXPRÈS : sur Android ils ne sont
   * pas indépendants. C'est `echoCancellation` qui CHOISIT la source de capture,
   * et le reste de la chaîne de traitement vient avec, quoi que dise le drapeau
   * `noiseSuppression`. Les exposer séparément promettrait un réglage qui n'existe
   * pas.
   *
   * L'anti-larsen ne repose pas sur ce traitement ici : LiveConversation coupe
   * déjà l'envoi pendant que Mochi parle. À surveiller quand même — sans AEC, la
   * queue de réverbération de sa voix peut passer dans les 140 ms de rémanence.
   * Si Mochi finit par se répondre à lui-même, c'est là qu'il faut regarder.
   */
  setProcessing(on: boolean): void {
    this._processing = on;
  }

  /**
   * Gain logiciel appliqué AVANT la conversion en Int16. Effet immédiat, sans
   * rouvrir le flux — contrairement au traitement, qui est figé à l'ouverture.
   *
   * ⚠️ CE QU'IL PEUT ET CE QU'IL NE PEUT PAS. Il rattrape une ATTÉNUATION (à 50 cm
   * contre 5, la voix arrive ~10× plus petite : de la physique, 20 dB, rien de
   * cassé). Il ne rattrape RIEN d'une porte de bruit : ce que le suppresseur a
   * effacé n'existe plus dans l'échantillon, et l'amplifier ne remonte que le
   * souffle. D'où l'ordre des essais — décocher le traitement D'ABORD, monter le
   * gain ensuite. Si le gain seul rendait la parole, on aurait la réponse.
   */
  setGain(g: number): void {
    this._gain = Math.max(1, Math.min(8, g));
    if (this.boost) this.boost.gain.value = this._gain;
  }

  get active(): boolean {
    return this._active;
  }

  /** Coupe/rétablit l'envoi des paquets (le micro tourne, on jette juste). */
  setSending(on: boolean): void {
    this._sending = on;
  }

  /**
   * Rend le micro SOURD sans rien interrompre : les paquets continuent de partir,
   * remplis de zéros. Sert à jouer un blip sans qu'il rentre dans le micro.
   *
   * ⚠️ POURQUOI PAS `setSending(false)`, QUI EXISTE DÉJÀ. La VAD de la session vit
   * sur le flux qu'on lui envoie : c'est en voyant passer du silence qu'elle
   * décide que ton tour est fini. Couper l'envoi ne lui donne pas du silence, il
   * lui retire la matière — le décompte se suspend. Or le blip qui compte le plus
   * (« mmh ? ») se joue PILE à la fin de ta phrase : le couper retarderait
   * exactement la réponse qu'il est censé faire attendre moins.
   * Envoyer du silence, lui, dit la vérité — il n'y a effectivement personne qui
   * parle pendant ces 150 ms.
   */
  setSilenced(on: boolean): void {
    this._silenced = on;
  }

  async start(): Promise<boolean> {
    if (this._active) return true;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: this._processing,
          noiseSuppression: this._processing,
          // GARDÉ dans les deux cas : c'est le seul des trois qui AIDE une voix
          // lointaine, en remontant le gain au lieu de la raboter.
          autoGainControl: true,
          channelCount: 1,
        },
      });
    } catch (err) {
      this.cb.onError(`micro refusé : ${(err as Error).message}`);
      return false;
    }

    this.reportApplied();

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // On demande 16 kHz ; si le navigateur impose un autre débit, le worklet
    // rééchantillonne quand même (il lit le `sampleRate` réel).
    this.ctx = new Ctor({ sampleRate: 16000, latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    try {
      await this.ctx.audioWorklet.addModule(WORKLET_URL);
    } catch (err) {
      this.cb.onError(`worklet audio indisponible : ${(err as Error).message}`);
      await this.stop();
      return false;
    }

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-recorder');
    this.node.port.onmessage = (e) => {
      const pcm = e.data as Int16Array;
      this.reportLevel(pcm);
      if (!this._sending) return;
      this.cb.onChunk(int16ToBase64(this._silenced ? this.silence(pcm.length) : pcm));
    };
    // Le gain est INSÉRÉ AVANT le worklet, donc la jauge mesure ce que Gemini
    // reçoit vraiment — et pas ce que le micro a capté. C'est le bon point de
    // mesure : la question n'est pas « le téléphone t'entend-il » mais « qu'est-ce
    // qui part sur le fil ».
    this.boost = this.ctx.createGain();
    this.boost.gain.value = this._gain;
    this.source.connect(this.boost);
    this.boost.connect(this.node);
    // Le node doit être « tiré » par le graphe : on le relie à la sortie. Il
    // n'écrit rien dans ses buffers de sortie → silence (aucun larsen).
    this.node.connect(this.ctx.destination);
    this._active = true;
    return true;
  }

  /**
   * Crête sur la période, pas moyenne : c'est la parole qu'on cherche à voir, et
   * une moyenne la noierait dans les silences entre les mots.
   */
  private reportLevel(pcm: Int16Array): void {
    if (!this.cb.onLevel && !this.cb.onFrame) return;
    let peak = 0;
    for (let i = 0; i < pcm.length; i++) {
      const v = pcm[i] < 0 ? -pcm[i] : pcm[i];
      if (v > peak) peak = v;
    }
    // Paquet par paquet, avant tout lissage : c'est ce que lit la détection de
    // parole. Muet pendant un blip, parce que le micro, lui, ENTEND le blip —
    // sans ce garde-fou Mochi prendrait son propre « mmh ? » pour ta réponse.
    if (!this._silenced) this.cb.onFrame?.(peak / 32768);
    if (!this.cb.onLevel) return;
    if (peak > this.peakAcc) this.peakAcc = peak;
    const now = Date.now();
    if (now - this.lastLevelMs < LEVEL_PERIOD_MS) return;
    this.lastLevelMs = now;
    this.cb.onLevel(this.peakAcc / 32768, this._sending);
    this.peakAcc = 0;
  }

  /**
   * Lit ce que la piste applique VRAIMENT et le remonte en clair. Les trois
   * drapeaux d'abord — ce sont eux qui décident de la portée du micro.
   */
  private reportApplied(): void {
    if (!this.cb.onApplied) return;
    const track = this.stream?.getAudioTracks()[0];
    if (!track) return;
    const s = track.getSettings?.() as
      | (MediaTrackSettings & {
          echoCancellation?: boolean;
          noiseSuppression?: boolean;
          autoGainControl?: boolean;
        })
      | undefined;
    if (!s) {
      this.cb.onApplied('micro ouvert (réglages appliqués non lisibles)');
      return;
    }
    const oui = (v: boolean | undefined) => (v === undefined ? '?' : v ? 'OUI' : 'non');
    this.cb.onApplied(
      `micro : anti-écho ${oui(s.echoCancellation)} · anti-bruit ${oui(s.noiseSuppression)} · ` +
        `AGC ${oui(s.autoGainControl)} · ${s.sampleRate ?? '?'} Hz · gain logiciel ${this._gain}×`,
    );
  }

  /** Paquet de zéros de la taille voulue, réutilisé (cf. setSilenced). */
  private silence(n: number): Int16Array {
    if (!this.zeros || this.zeros.length !== n) this.zeros = new Int16Array(n);
    return this.zeros;
  }

  async stop(): Promise<void> {
    this._active = false;
    if (this.node) this.node.port.onmessage = null;
    this.source?.disconnect();
    this.boost?.disconnect();
    this.boost = null;
    this.node?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        await this.ctx.close();
      } catch {
        /* déjà fermé */
      }
    }
    this.node = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}

/** Int16Array → base64 (par tranches pour ne pas exploser la pile d'arguments). */
function int16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
