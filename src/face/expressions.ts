import type { ExpressionTarget, FaceState, Transient, FaceChannels } from './faceState';
import { REST_FACE } from './faceState';

// Presets d'émotion (§5.3). L'intensité module l'amplitude par rapport au repos.
export type Emotion = 'joy' | 'sadness' | 'surprise' | 'curiosity' | 'anger' | 'neutral';

/** Cible « pleine » (intensité 1) par émotion, avant interpolation depuis le repos. */
const PRESETS: Record<Emotion, ExpressionTarget> = {
  joy: {
    tau: 0.1,
    channels: {
      mouthCurve: 0.95,
      mouthOpen: 0.28,
      browRaiseL: 0.35,
      browRaiseR: 0.35,
      eyelidL: 0.32, // yeux légèrement plissés (sourire)
      eyelidR: 0.32,
      pupil: 0.5,
      browFurrow: 0,
    },
  },
  sadness: {
    tau: 0.45,
    channels: {
      mouthCurve: -0.7,
      mouthOpen: 0.05,
      browRaiseL: 0.5, // sourcils intérieurs relevés
      browRaiseR: 0.5,
      gazeY: -0.5,
      eyelidL: 0.35,
      eyelidR: 0.35,
      pupil: 0.3,
    },
  },
  surprise: {
    tau: 0.07,
    channels: {
      eyelidL: 0,
      eyelidR: 0,
      browRaiseL: 0.9,
      browRaiseR: 0.9,
      mouthOpen: 0.7,
      mouthCurve: 0.1,
      pupil: 0.95,
    },
  },
  curiosity: {
    tau: 0.2,
    channels: {
      headTilt: 0.6,
      browRaiseL: 0.15,
      browRaiseR: 0.75, // asymétrie : un sourcil relevé
      pupil: 0.8,
      mouthCurve: 0.3,
      mouthOpen: 0.12,
    },
  },
  anger: {
    tau: 0.12,
    channels: {
      browFurrow: 0.9,
      browRaiseL: -0.6,
      browRaiseR: -0.6,
      mouthCurve: -0.5,
      mouthOpen: 0.1,
      eyelidL: 0.15,
      eyelidR: 0.15,
      pupil: 0.2,
    },
  },
  neutral: {
    tau: 0.3,
    channels: { ...REST_FACE },
  },
};

/** Applique un preset d'émotion à `intensity` ∈ [0,1] (interpolation depuis le repos). */
export function express(face: FaceState, emotion: Emotion, intensity = 1): void {
  const preset = PRESETS[emotion];
  const k = Math.max(0, Math.min(1, intensity));
  const channels: Partial<FaceChannels> = {};
  for (const key of Object.keys(preset.channels) as (keyof FaceChannels)[]) {
    const restV = REST_FACE[key];
    const fullV = preset.channels[key] ?? restV;
    channels[key] = restV + (fullV - restV) * k;
  }
  face.setTarget({ channels, tau: preset.tau });
}

/** Regard directionnel. */
export type LookDir = 'left' | 'right' | 'up' | 'down' | 'center';

const LOOK_VECTORS: Record<LookDir, [number, number]> = {
  left: [-0.85, 0],
  right: [0.85, 0],
  up: [0, 0.8],
  down: [0, -0.8],
  center: [0, 0],
};

export function look(face: FaceState, dir: LookDir): void {
  const [x, y] = LOOK_VECTORS[dir];
  face.setTarget({ channels: { gazeX: x, gazeY: y }, tau: 0.12 });
}

// --- Transients scriptés -------------------------------------------------

/** Clignement : fermeture rapide puis réouverture, sur les deux yeux. */
export function blink(face: FaceState, duration = 0.18): void {
  face.addTransient(makeLidTransient('both', duration));
}

/** Clin d'œil : un seul œil, avec un léger maintien. */
export function wink(face: FaceState, side: 'left' | 'right', duration = 0.32): void {
  face.addTransient(makeLidTransient(side, duration));
}

function makeLidTransient(which: 'both' | 'left' | 'right', duration: number): Transient {
  return {
    duration,
    apply(current, progress) {
      // Courbe fermeture→ouverture : sin(π·t) ∈ [0,1] avec pic à mi-parcours.
      const close = Math.sin(Math.PI * progress);
      if (which !== 'right') current.eyelidL = Math.max(current.eyelidL, close);
      if (which !== 'left') current.eyelidR = Math.max(current.eyelidR, close);
    },
  };
}

/** Clignements spontanés aléatoires — donne de la vie au visage au repos. */
export function startAutoBlink(face: FaceState): () => void {
  let timer = 0;
  const schedule = () => {
    const delay = 2500 + Math.random() * 4000;
    timer = window.setTimeout(() => {
      blink(face);
      schedule();
    }, delay);
  };
  schedule();
  return () => window.clearTimeout(timer);
}
