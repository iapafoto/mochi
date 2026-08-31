// Polyligne → programme de conduite (v, ω) échantillonné dans le temps.
//
// C'EST LE CŒUR DE L'AFFAIRE, et l'idée tient en une ligne : un robot différentiel
// suit n'importe quelle courbe par ω = v·κ. On ne découpe donc PAS le chemin en
// virages successifs — on produit un programme de COURBURE, joué en continu.
//
// ⚠️ POURQUOI PAS UNE SUITE DE `forward`/`turn` : ces déplacements-là terminent sur
// l'odométrie et se stabilisent 1,5 s avant de rendre la main (ODO_SETTLE_MS, et
// c'est indispensable — sur un pendule inversé l'odométrie ne vaut qu'à l'arrêt et
// debout). Un chemin de douze segments passerait dix-huit secondes immobile. Ça ne
// ressemble pas à un tracé, ça ressemble à une hésitation.
//
// ⚠️ CE QUI REND CE ROBOT-LÀ BON À CE JEU. Ses deux axes n'ont pas du tout la même
// agilité, et c'est MESURÉ dans son firmware (cf. ODO_BRAKE_LEAD_S) :
//   • la ROTATION est injectée directement sur le différentiel des roues, τ ≈ 17 ms ;
//   • la VITESSE traverse toute la cascade et elle est à non-minimum de phase — pour
//     accélérer, il doit d'abord se pencher EN ARRIÈRE. τ ≈ 170 ms.
// Dix fois plus vif en rotation qu'en vitesse. Une courbe à vitesse constante dont
// seule la courbure varie est donc exactement ce qu'il fait le mieux ; ce qu'il fait
// mal, c'est changer de vitesse souvent. D'où un profil de vitesse qui ne ralentit
// QUE là où la géométrie l'exige, et le plus doucement possible.

import type { DriveVector } from './driveLoop';
import type { Point } from './svgPath';

/** Pas d'échantillonnage du chemin, en mm. Fin devant les rayons en jeu. */
export const PATH_DS_MM = 5;

/**
 * Demi-largeur du lissage du cap, en échantillons. Le lissage est ce qui ARRONDIT
 * les angles : un coin vif a une courbure infinie, qu'aucun robot ne suit. Lisser
 * θ(s) sur une fenêtre de 2·HALF·ds transforme le coin en raccordement de rayon
 * ≈ fenêtre/Δθ — soit ~2,5 cm pour un angle droit avec ces valeurs. Assez net pour
 * qu'un carré reste un carré, assez rond pour être roulable.
 */
const SMOOTH_HALF = 4;

/**
 * Vitesse plancher, uniquement là pour que le temps de parcours reste fini.
 *
 * ⚠️ ELLE ÉTAIT À 60 mm/s, ET C'ÉTAIT UNE ERREUR DE RAISONNEMENT COÛTEUSE. Je
 * l'avais posée en croyant qu'un pendule a besoin d'une vitesse minimale pour tenir
 * debout — c'est faux : la ROTATION est injectée directement sur le différentiel
 * des roues, sans passer par la boucle vitesse (cf. `turn`, qui pivote sur place à
 * v = 0). Rien n'interdit donc de ralentir jusqu'à presque pivoter dans un angle.
 *
 * Et ce plancher-là fixait le plafond de courbure, qui ÉCRÊTAIT les virages serrés :
 * le robot ne tournait pas assez, la forme s'ouvrait, un triangle ne se refermait
 * plus (186° de virage cumulé au lieu de 240). L'écrêtage ne « arrondissait » pas
 * l'angle — il en perdait la moitié, en silence, et le tracé n'y ressemblait plus.
 * Ce qui arrondit les angles, et lui seul, c'est le lissage du cap.
 */
const V_FLOOR_MM_S = 15;

/**
 * Accélération admise. Volontairement basse : accélérer, sur un pendule, c'est se
 * pencher. 400 mm/s² amène à la vitesse de croisière en ~0,7 s, ce qui reste dans
 * ce que la boucle d'angle absorbe sans à-coup visible.
 */
const A_MAX_MM_S2 = 400;

const RAD_TO_DEG = 180 / Math.PI;

export interface PathPlan {
  /** Consignes successives, une par période de rafraîchissement. */
  frames: DriveVector[];
  durationMs: number;
  lengthMm: number;
  /** Rayon le plus serré effectivement tracé (diagnostic). */
  minRadiusMm: number;
  /** Vitesse de croisière réellement atteinte. */
  topSpeedMmS: number;
}

export interface PlanOptions {
  /** Vitesse visée en ligne droite (bornée par le fond de course du robot). */
  cruiseMmS: number;
  /** Fond de course en rotation (deg/s) — cf. driveLoop, config.h `R`. */
  maxTurnDegS: number;
  /** Cadence de réémission du pilote (Hz). */
  refreshHz: number;
}

/**
 * Construit le programme de conduite d'une polyligne à pas constant.
 *
 * Le chemin est tracé DEPUIS la position et le cap courants du robot : on ne
 * regarde que la FORME (les variations de cap), jamais les coordonnées absolues.
 */
export function planPath(points: Point[], opts: PlanOptions): PathPlan {
  const n = points.length;
  if (n < 3) throw new Error('chemin trop court pour être planifié');
  const ds = PATH_DS_MM;
  const omegaMax = opts.maxTurnDegS / RAD_TO_DEG; // rad/s

  // 1) Cap brut entre points consécutifs, déroulé (sans saut de ±2π).
  const heading: number[] = new Array(n - 1);
  let prev = 0;
  for (let i = 0; i < n - 1; i++) {
    const raw = Math.atan2(points[i + 1].y - points[i].y, points[i + 1].x - points[i].x);
    heading[i] = i === 0 ? raw : prev + wrap(raw - prev);
    prev = heading[i];
  }

  // 2) Lissage du cap — c'est lui qui rend les angles roulables (cf. SMOOTH_HALF).
  const smooth = movingAverage(heading, SMOOTH_HALF);

  // 3) Courbure κ = dθ/ds, par différence centrée.
  const m = smooth.length;
  const kappa: number[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const a = smooth[Math.max(0, i - 1)];
    const b = smooth[Math.min(m - 1, i + 1)];
    const span = (Math.min(m - 1, i + 1) - Math.max(0, i - 1)) * ds;
    kappa[i] = span > 0 ? (b - a) / span : 0;
  }

  // 4) Plafond de courbure : au-delà, même à la vitesse plancher on dépasserait le
  // fond de course en rotation. On écrête plutôt que de mentir — la forme s'arrondit
  // un peu là où elle était de toute façon intraçable.
  const kappaCeil = omegaMax / V_FLOOR_MM_S;
  for (let i = 0; i < m; i++) {
    if (kappa[i] > kappaCeil) kappa[i] = kappaCeil;
    else if (kappa[i] < -kappaCeil) kappa[i] = -kappaCeil;
  }

  // 5) Vitesse admissible par la géométrie, puis passes avant/arrière pour
  // respecter l'accélération. C'est un planificateur d'avance classique : sans les
  // deux passes, le robot arriverait trop vite dans un virage qu'il voit venir.
  const v: number[] = new Array(m);
  for (let i = 0; i < m; i++) {
    const byCurve = Math.abs(kappa[i]) > 1e-9 ? omegaMax / Math.abs(kappa[i]) : Infinity;
    v[i] = Math.max(V_FLOOR_MM_S, Math.min(opts.cruiseMmS, byCurve));
  }
  v[0] = 0;
  for (let i = 1; i < m; i++) v[i] = Math.min(v[i], Math.sqrt(v[i - 1] ** 2 + 2 * A_MAX_MM_S2 * ds));
  v[m - 1] = 0;
  for (let i = m - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * A_MAX_MM_S2 * ds));

  // 6) Temps cumulé le long du chemin. dt = 2·ds/(v₁+v₂) : la forme qui accepte
  // une vitesse nulle à une extrémité sans partir à l'infini.
  const t: number[] = new Array(m);
  t[0] = 0;
  for (let i = 1; i < m; i++) {
    const vm = v[i - 1] + v[i];
    t[i] = t[i - 1] + (vm > 1e-6 ? (2 * ds) / vm : 0);
  }
  const total = t[m - 1];

  // 7) Rééchantillonnage dans le TEMPS, à la cadence du pilote : c'est ce qu'il
  // réémet, donc autant le lui donner déjà prêt.
  const dt = 1 / opts.refreshHz;
  const count = Math.max(1, Math.ceil(total / dt));
  const frames: DriveVector[] = new Array(count);
  let idx = 0;
  for (let f = 0; f < count; f++) {
    const time = f * dt;
    while (idx < m - 2 && t[idx + 1] < time) idx++;
    const span = t[idx + 1] - t[idx];
    const u = span > 1e-9 ? (time - t[idx]) / span : 0;
    const ki = kappa[idx] + (kappa[idx + 1] - kappa[idx]) * clamp01(u);
    let vi = v[idx] + (v[idx + 1] - v[idx]) * clamp01(u);
    // ⚠️ RE-BORNER ICI, MÊME SI v ET κ RESPECTENT DÉJÀ LA LIMITE À CHAQUE
    // ÉCHANTILLON. Le produit de deux interpolations linéaires n'est pas borné par
    // le produit des bornes : entre un échantillon lent-et-courbe et un autre
    // rapide-et-droit, le point milieu combine une vitesse moyenne avec une
    // courbure moyenne et dépasse ω_max. Mesuré au banc — un triangle sortait à
    // 123 °/s pour un fond de course à 120.
    // C'est la VITESSE qui cède, jamais le rayon : même doctrine que `circleDrive`,
    // parce qu'un virage trop rapide n'est plus le bon virage alors qu'un virage
    // lent reste le bon virage.
    if (Math.abs(ki) > 1e-9) vi = Math.min(vi, omegaMax / Math.abs(ki));
    frames[f] = { speedMmS: vi, turnDegS: vi * ki * RAD_TO_DEG };
  }

  let maxK = 0;
  for (const k of kappa) maxK = Math.max(maxK, Math.abs(k));
  return {
    frames,
    durationMs: Math.round(total * 1000),
    lengthMm: (n - 1) * ds,
    minRadiusMm: maxK > 1e-9 ? 1 / maxK : Infinity,
    topSpeedMmS: Math.max(...v),
  };
}

/** Ramène un écart d'angle dans ]−π, π]. */
function wrap(a: number): number {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

/**
 * Moyenne glissante à fenêtre SYMÉTRIQUE RÉTRÉCIE aux bords.
 *
 * ⚠️ LA SYMÉTRIE N'EST PAS UN DÉTAIL D'ESTHÉTIQUE, C'EST CE QUI CONSERVE LE VIRAGE
 * TOTAL. Avec une fenêtre simplement rognée (lo = max(0, i−half)), la moyenne au
 * premier point porte sur les points SUIVANTS uniquement : elle est donc tirée vers
 * l'intérieur du chemin, et pareil à l'autre bout, en sens inverse. Le cap de départ
 * et celui d'arrivée se rapprochent l'un de l'autre, et c'est exactement du virage
 * PERDU — un carré ne tournait plus que de 270° au lieu de 360, une vague finissait
 * de travers. En rétrécissant la fenêtre des DEUX côtés à la fois, les extrémités
 * sont rendues intactes et le virage cumulé est exact.
 */
function movingAverage(xs: number[], half: number): number[] {
  const out: number[] = new Array(xs.length);
  const n = xs.length;
  for (let i = 0; i < n; i++) {
    const h = Math.min(half, i, n - 1 - i);
    let sum = 0;
    for (let j = i - h; j <= i + h; j++) sum += xs[j];
    out[i] = sum / (2 * h + 1);
  }
  return out;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
