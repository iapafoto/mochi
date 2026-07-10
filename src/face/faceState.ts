// FaceState — contrat unique du visage.
//
// Tous les canaux sont normalisés. Le renderer fait tendre `current` → `target`
// à chaque frame (lissage exponentiel avec un `tau` par canal) ; c'est ce lissage
// qui rend le visage « vivant ». blink/wink sont des transients scriptés
// (voir expressions.ts), pas de simples cibles statiques.

/** Les canaux animables du visage. Cf. tableau §5.1 du PLAN. */
export interface FaceChannels {
  eyelidL: number; // 0..1  fermeture paupière gauche (0 ouvert, 1 fermé)
  eyelidR: number; // 0..1  fermeture paupière droite
  gazeX: number; // -1..1  direction du regard horizontale
  gazeY: number; // -1..1  direction du regard verticale
  pupil: number; // 0..1   dilatation (surprise/curiosité)
  browRaiseL: number; // -1..1  sourcil gauche haut/bas
  browRaiseR: number; // -1..1  sourcil droit haut/bas
  browFurrow: number; // 0..1   froncement (colère/concentration)
  mouthOpen: number; // 0..1   ouverture bouche
  mouthCurve: number; // -1..1  -1 moue … +1 sourire
  headTilt: number; // -1..1  inclinaison 2D de la tête (curiosité)
}

export type Channel = keyof FaceChannels;

/** Constantes de temps de lissage (en secondes) par canal. tau court = vif. */
export type ChannelTau = Record<Channel, number>;

/** Cible partielle : n'importe quel sous-ensemble de canaux + tau optionnel. */
export interface ExpressionTarget {
  channels: Partial<FaceChannels>;
  /** tau global appliqué aux canaux touchés (sinon défaut par canal). */
  tau?: number;
}

export const REST_FACE: FaceChannels = {
  eyelidL: 0,
  eyelidR: 0,
  gazeX: 0,
  gazeY: 0,
  pupil: 0.35,
  browRaiseL: 0,
  browRaiseR: 0,
  browFurrow: 0,
  mouthOpen: 0.08,
  mouthCurve: 0.15, // léger sourire de repos, esprit kawaii
  headTilt: 0,
};

/** tau par défaut par canal (s). Les yeux réagissent vite, la tête plus lentement. */
export const DEFAULT_TAU: ChannelTau = {
  eyelidL: 0.05,
  eyelidR: 0.05,
  gazeX: 0.12,
  gazeY: 0.12,
  pupil: 0.18,
  browRaiseL: 0.14,
  browRaiseR: 0.14,
  browFurrow: 0.16,
  mouthOpen: 0.1,
  mouthCurve: 0.16,
  headTilt: 0.28,
};

const CHANNELS = Object.keys(REST_FACE) as Channel[];

/**
 * FaceState détient `current` (affiché) et `target` (visé), plus le tau courant
 * par canal. Il applique le lissage exponentiel à chaque frame et gère les
 * transients (blink/wink) qui court-circuitent temporairement une cible.
 */
export class FaceState {
  readonly current: FaceChannels = { ...REST_FACE };
  readonly target: FaceChannels = { ...REST_FACE };
  private readonly tau: ChannelTau = { ...DEFAULT_TAU };

  /** Transients actifs : fonction qui écrit dans `current` selon le temps écoulé. */
  private transients: Transient[] = [];

  /** Applique une cible d'expression (fusion partielle). */
  setTarget(t: ExpressionTarget): void {
    for (const key of Object.keys(t.channels) as Channel[]) {
      const v = t.channels[key];
      if (v === undefined) continue;
      this.target[key] = clampChannel(key, v);
      this.tau[key] = t.tau ?? DEFAULT_TAU[key];
    }
  }

  /** Force un canal unique (utilisé par les sliders/boutons debug). */
  setChannel(key: Channel, value: number, tau?: number): void {
    this.target[key] = clampChannel(key, value);
    if (tau !== undefined) this.tau[key] = tau;
  }

  /** Reset complet vers la cible de repos. */
  resetToRest(tau = 0.3): void {
    this.setTarget({ channels: { ...REST_FACE }, tau });
  }

  addTransient(t: Transient): void {
    t.start = performance.now() / 1000;
    this.transients.push(t);
  }

  /** Avance la simulation de `dt` secondes. */
  step(dt: number): void {
    // 1) lissage exponentiel current → target par canal.
    for (const key of CHANNELS) {
      const tau = this.tau[key];
      // alpha = 1 - exp(-dt/tau) : indépendant du framerate.
      const alpha = tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
      this.current[key] += (this.target[key] - this.current[key]) * alpha;
    }

    // 2) transients : écrasent certains canaux par-dessus le lissage.
    const now = performance.now() / 1000;
    this.transients = this.transients.filter((tr) => {
      const elapsed = now - (tr.start ?? now);
      if (elapsed >= tr.duration) {
        tr.onEnd?.(this.current);
        return false;
      }
      tr.apply(this.current, elapsed / tr.duration);
      return true;
    });
  }
}

/** Transient scripté : ferme puis rouvre une paupière, etc. */
export interface Transient {
  duration: number; // secondes
  /** progress ∈ [0,1] ; écrit directement dans `current`. */
  apply(current: FaceChannels, progress: number): void;
  onEnd?(current: FaceChannels): void;
  start?: number; // rempli par addTransient
}

const SIGNED: ReadonlySet<Channel> = new Set<Channel>([
  'gazeX',
  'gazeY',
  'browRaiseL',
  'browRaiseR',
  'mouthCurve',
  'headTilt',
]);

function clampChannel(key: Channel, v: number): number {
  return SIGNED.has(key) ? Math.max(-1, Math.min(1, v)) : Math.max(0, Math.min(1, v));
}
