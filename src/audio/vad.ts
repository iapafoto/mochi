// Détection de parole LOCALE — « est-ce que l'humain est en train de parler ? »,
// répondu dans le navigateur, sans réseau.
//
// ⚠️ CE N'EST PAS UN DOUBLON DE LA VAD DE LA SESSION. Celle de Gemini décide des
// TOURS (quand committer, quand répondre) et elle est seule à pouvoir le faire.
// Celle-ci ne décide de rien : elle sert à RÉAGIR, et la seule chose qui compte
// pour elle est d'être en avance. La session voit la fin de ta phrase après
// `silenceDurationMs` (350 ms) puis un aller-retour réseau ; ici on la voit après
// 240 ms de silence, sur place. Ces ~300 ms sont exactement le trou qu'on cherche
// à meubler — un blip et un visage qui bouge y tiennent tout entiers.
//
// Alimentée paquet par paquet (~40 ms) par MicCapture.onFrame.

export interface VadCallbacks {
  onSpeechStart(): void;
  /** Fin de parole, avec la durée du passage (sert à ignorer les brefs bruits). */
  onSpeechEnd(durationMs: number): void;
}

/** Ce que le détecteur voit, pour pouvoir le DIAGNOSTIQUER depuis le téléphone. */
export interface VadDebug {
  peak: number;
  floor: number;
  onThreshold: number;
}

/**
 * Seuils ABSOLUS planchers. Le vrai seuil est calculé à partir du bruit de fond
 * mesuré (cf. floor) ; ceux-ci empêchent seulement une pièce très silencieuse de
 * rendre le détecteur fou en descendant son plancher à zéro.
 *
 * ⚠️ Ils sont exprimés APRÈS le gain micro (MicCapture insère son `boost` avant
 * le worklet), et c'est voulu : le réglage de gain du panneau sert précisément à
 * amener la parole à un niveau lisible, et ces seuils en profitent gratuitement.
 */
const MIN_ON = 0.02;
const MIN_OFF = 0.012;

/** Rapport au bruit de fond pour ouvrir / refermer (hystérésis). */
const ON_RATIO = 3.2;
const OFF_RATIO = 2.0;

/**
 * Le bruit de fond est estimé par un MINIMUM GLISSANT sur deux fenêtres — le
 * minimum vu sur les ~3 dernières secondes.
 *
 * ⚠️ DEUX FAÇONS DE SE TROMPER ICI, ET J'AI FAIT LES DEUX.
 *
 * 1. UNE MOYENNE ne marche pas. `autoGainControl` est actif (seul des trois
 *    traitements à aider une voix lointaine — cf. MicCapture.start) : entre deux
 *    mots l'AGC remonte le gain, et le bruit de la pièce avec. Une moyenne monte
 *    donc jusqu'à frôler le niveau de la parole, le seuil passe au-dessus, et
 *    plus rien ne déclenche jamais. C'est ce qui rendait le détecteur muet.
 *
 * 2. N'ESTIMER LE BRUIT QUE HORS PAROLE ne marche pas non plus, et l'erreur est
 *    plus vicieuse : dans une pièce bruyante, le bruit fait ouvrir la détection
 *    tout de suite, donc on n'est JAMAIS « hors parole », donc le plancher n'est
 *    jamais mis à jour et reste à sa valeur de départ — le seuil qui devait
 *    s'adapter au bruit est précisément celui que le bruit empêche d'apprendre.
 *
 * Le minimum, lui, se mesure EN PERMANENCE, y compris pendant la parole : une
 * voix a des creux, un bruit stationnaire n'en a pas. C'est ce qui les sépare.
 */
const FLOOR_WINDOW_MS = 1500;

/** Paquets consécutifs au-dessus du seuil avant de déclarer « ça parle » (~80 ms). */
const ONSET_FRAMES = 2;

/** Silence continu avant de déclarer la fin de parole. */
const HANGOVER_MS = 240;

/**
 * Durée maximale d'un passage de parole. AUTO-RÉPARATION, pas une règle sur la
 * parole humaine : dans une pièce assez bruyante pour que le fond dépasse le
 * seuil de fermeture, la détection reste ouverte indéfiniment — le visage garde
 * son air attentif pour toujours et plus aucune fin de phrase n'est vue. Au bout
 * de ce délai on ferme d'office ET on repart du niveau courant, ce qui laisse le
 * plancher se recaler sur le vrai bruit ambiant.
 */
const MAX_UTTERANCE_MS = 12000;

/** Plancher absolu du bruit de fond — un micro parfaitement muet ne doit pas
 * faire tomber le seuil à zéro et transformer le souffle en parole. */
const FLOOR_MIN = 0.004;

export class LocalVad {
  private floor = 0.01;
  /** Minimum de la fenêtre en cours et de la précédente (cf. FLOOR_WINDOW_MS). */
  private winMin = Infinity;
  private prevWinMin = Infinity;
  private winStartMs = 0;
  private seeded = false;
  private _speaking = false;
  private above = 0;
  private lastLoudMs = 0;
  private startedMs = 0;
  /** Enveloppe lissée (attaque vive, retombée douce) — anime le visage. */
  private _level = 0;

  constructor(private readonly cb: VadCallbacks) {}

  get speaking(): boolean {
    return this._speaking;
  }

  /** Niveau perçu 0..1, déjà lissé pour être joli à l'écran. */
  get level(): number {
    return this._level;
  }

  /** Depuis combien de ms ça parle (0 si silence). */
  speakingForMs(now = Date.now()): number {
    return this._speaking ? now - this.startedMs : 0;
  }

  /** Depuis combien de ms c'est calme À L'INTÉRIEUR d'un tour (0 si ça parle fort). */
  pauseMs(now = Date.now()): number {
    return this._speaking ? now - this.lastLoudMs : 0;
  }

  /** Repart de zéro (ouverture/fermeture de session, ou Mochi qui prend la parole). */
  reset(): void {
    if (this._speaking) this._speaking = false;
    this.above = 0;
    this._level = 0;
  }

  /**
   * Photo de l'état interne. Existe pour une raison précise : ce détecteur vit
   * dans un téléphone posé sur un robot, où il n'y a ni console ni profileur. La
   * seule question qui compte quand « il ne réagit pas » — le niveau est-il sous
   * le seuil, ou le seuil a-t-il dérivé ? — est indécidable sans ces trois nombres.
   */
  debug(): VadDebug {
    return {
      peak: this._level,
      floor: this.floor,
      onThreshold: Math.max(MIN_ON, this.floor * ON_RATIO),
    };
  }

  /**
   * Minimum glissant sur deux fenêtres. Mis à jour à CHAQUE paquet, parole
   * comprise — c'est le point (cf. le commentaire de FLOOR_WINDOW_MS).
   */
  private trackFloor(peak: number, now: number): void {
    if (!this.seeded) {
      // Estimation immédiate, pour ne pas passer les 1,5 premières secondes sur
      // une valeur arbitraire. Trop haute si on tombe en pleine parole, mais le
      // minimum la corrige à la première fenêtre.
      this.seeded = true;
      this.floor = Math.max(FLOOR_MIN, peak);
      this.winStartMs = now;
    }
    if (peak < this.winMin) this.winMin = peak;
    if (now - this.winStartMs < FLOOR_WINDOW_MS) return;
    this.floor = Math.max(FLOOR_MIN, Math.min(this.winMin, this.prevWinMin));
    this.prevWinMin = this.winMin;
    this.winMin = Infinity;
    this.winStartMs = now;
  }

  push(peak: number): void {
    const now = Date.now();
    // Attaque immédiate, retombée en ~200 ms : le visage doit sauter sur une
    // syllabe, pas clignoter entre deux.
    this._level = peak > this._level ? peak : this._level + (peak - this._level) * 0.18;

    this.trackFloor(peak, now);

    const onThreshold = Math.max(MIN_ON, this.floor * ON_RATIO);
    const offThreshold = Math.max(MIN_OFF, this.floor * OFF_RATIO);

    if (!this._speaking) {
      if (peak > onThreshold) {
        if (++this.above >= ONSET_FRAMES) {
          this._speaking = true;
          this.startedMs = now;
          this.lastLoudMs = now;
          this.cb.onSpeechStart();
        }
      } else {
        this.above = 0;
      }
      return;
    }

    // Détection restée ouverte trop longtemps : on ferme et on recale le plancher
    // sur ce qu'on entend vraiment, sinon on rouvrirait aussitôt sur le même bruit.
    if (now - this.startedMs > MAX_UTTERANCE_MS) {
      this._speaking = false;
      this.above = 0;
      this.floor = Math.max(FLOOR_MIN, peak);
      this.cb.onSpeechEnd(this.lastLoudMs - this.startedMs);
      return;
    }

    if (peak > offThreshold) {
      this.lastLoudMs = now;
      return;
    }
    if (now - this.lastLoudMs < HANGOVER_MS) return;
    this._speaking = false;
    this.above = 0;
    // La durée annoncée s'arrête au dernier son FORT, pas au bout de la rémanence :
    // sinon toute phrase paraîtrait 240 ms plus longue qu'elle ne l'a été.
    this.cb.onSpeechEnd(this.lastLoudMs - this.startedMs);
  }
}
