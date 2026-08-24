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

/**
 * Seuils ABSOLUS planchers. Le vrai seuil est calculé à partir du bruit de fond
 * mesuré (cf. floor) ; ceux-ci empêchent seulement une pièce très silencieuse de
 * rendre le détecteur fou en descendant son plancher à zéro.
 *
 * ⚠️ Ils sont exprimés APRÈS le gain micro (MicCapture insère son `boost` avant
 * le worklet), et c'est voulu : le réglage de gain du panneau sert précisément à
 * amener la parole à un niveau lisible, et ces seuils en profitent gratuitement.
 */
const MIN_ON = 0.04;
const MIN_OFF = 0.022;

/** Rapport au bruit de fond pour ouvrir / refermer (hystérésis). */
const ON_RATIO = 3.5;
const OFF_RATIO = 2.0;

/** Paquets consécutifs au-dessus du seuil avant de déclarer « ça parle » (~80 ms). */
const ONSET_FRAMES = 2;

/** Silence continu avant de déclarer la fin de parole. */
const HANGOVER_MS = 240;

/** Vitesse d'adaptation du bruit de fond (par paquet, hors parole). */
const FLOOR_ALPHA = 0.05;

export class LocalVad {
  private floor = 0.01;
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

  push(peak: number): void {
    const now = Date.now();
    // Attaque immédiate, retombée en ~200 ms : le visage doit sauter sur une
    // syllabe, pas clignoter entre deux.
    this._level = peak > this._level ? peak : this._level + (peak - this._level) * 0.18;

    const onThreshold = Math.max(MIN_ON, this.floor * ON_RATIO);
    const offThreshold = Math.max(MIN_OFF, this.floor * OFF_RATIO);

    if (!this._speaking) {
      // Le plancher ne se met à jour QUE hors parole : l'intégrer pendant qu'on
      // parle le ferait monter jusqu'au niveau de la voix, et le détecteur
      // deviendrait sourd au bout de quelques phrases.
      this.floor += (peak - this.floor) * FLOOR_ALPHA;
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
