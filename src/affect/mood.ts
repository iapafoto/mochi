// Moteur d'humeur — état affectif continu de Mochi.
//
// Modèle « circumplex » (Russell), deux axes :
//   valence : -1 (malheureux) … +1 (heureux)
//   arousal :  0 (calme)      …  1 (excité)
// Les émotions exprimées poussent l'humeur ; elle revient ensuite doucement à une
// baseline (Mochi est un petit gars plutôt joyeux). L'humeur sert à adapter le
// visage au repos, la teinte d'ambiance et à déclencher des emotes automatiques.

import type { Emotion } from '../face/expressions';
import type { FaceChannels } from '../face/faceState';

export interface Mood {
  valence: number;
  arousal: number;
}

// Coordonnées (valence, arousal) cibles par émotion.
const EMOTION_COORD: Record<Emotion, Mood> = {
  joy: { valence: 0.9, arousal: 0.7 },
  sadness: { valence: -0.8, arousal: 0.2 },
  surprise: { valence: 0.15, arousal: 0.95 },
  curiosity: { valence: 0.35, arousal: 0.55 },
  anger: { valence: -0.7, arousal: 0.85 },
  neutral: { valence: 0.2, arousal: 0.35 },
};

const BASELINE: Mood = { valence: 0.25, arousal: 0.35 };
const DECAY_TAU = 22; // s — retour lent vers la baseline (donne de la continuité)

export class MoodEngine {
  private v = BASELINE.valence;
  private a = BASELINE.arousal;
  private _lastActivity = performance.now() / 1000;

  get mood(): Mood {
    return { valence: this.v, arousal: this.a };
  }

  /** Secondes écoulées depuis la dernière poussée d'émotion (pour le repos). */
  get idleFor(): number {
    return performance.now() / 1000 - this._lastActivity;
  }

  /** Pousse l'humeur vers l'émotion exprimée (intensité 0..1). */
  nudgeFromEmotion(emotion: Emotion, intensity = 0.8): void {
    const c = EMOTION_COORD[emotion] ?? BASELINE;
    const k = 0.6 * clamp01(intensity);
    this.v = clamp(this.v + (c.valence - this.v) * k, -1, 1);
    this.a = clamp01(this.a + (c.arousal - this.a) * k);
    this._lastActivity = performance.now() / 1000;
  }

  /** Ajustement direct (compliments, interactions réussies…). */
  nudge(dv: number, da: number): void {
    this.v = clamp(this.v + dv, -1, 1);
    this.a = clamp01(this.a + da);
    this._lastActivity = performance.now() / 1000;
  }

  /** Décroissance vers la baseline. À appeler à chaque tick (dt en s). */
  step(dt: number): void {
    const alpha = 1 - Math.exp(-dt / DECAY_TAU);
    this.v += (BASELINE.valence - this.v) * alpha;
    this.a += (BASELINE.arousal - this.a) * alpha;
  }

  /** Résumé court injectable dans le contexte du LLM (français). */
  summary(): string {
    const val =
      this.v > 0.55 ? 'très content' : this.v > 0.15 ? 'content' : this.v > -0.2 ? 'neutre' : this.v > -0.6 ? 'grognon' : 'tout triste';
    const ar = this.a > 0.65 ? 'très excité' : this.a > 0.4 ? 'enjoué' : 'calme';
    return `${val}, ${ar}`;
  }
}

/** Couleur d'ambiance (RGB 0..1, subtile) à ajouter au fond du shader. */
export function ambientFromMood(m: Mood): [number, number, number] {
  const warm = Math.max(0, m.valence); // content → rose/or
  const cold = Math.max(0, -m.valence); // triste → bleu
  const anger = cold * m.arousal; // négatif + excité → rouge
  const k = 0.65 + 0.35 * m.arousal; // plus vif quand excité
  const r = (warm * 0.18 + anger * 0.22) * k;
  const g = (warm * 0.07 + cold * 0.02) * k;
  const b = (warm * 0.13 + cold * 0.2) * k;
  return [r, g, b];
}

/** Cible de visage au repos reflétant l'humeur (canaux doux ; pas le regard). */
export function restingFaceFromMood(m: Mood): Partial<FaceChannels> {
  const sad = Math.max(0, -m.valence);
  return {
    mouthCurve: 0.15 + m.valence * 0.6, // sourire ↔ moue
    mouthOpen: 0.06 + m.arousal * 0.06,
    browRaiseL: m.valence * 0.12 + sad * 0.25, // sourcils intérieurs relevés si triste
    browRaiseR: m.valence * 0.12 + sad * 0.25,
    pupil: 0.35 + m.arousal * 0.22,
  };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function clamp01(x: number): number {
  return clamp(x, 0, 1);
}
