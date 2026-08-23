// Téléguidage continu — le pilote qui tient une consigne dans le temps.
//
// OP_DRIVE n'est pas un ordre mais un ÉTAT, qui EXPIRE côté robot (homme mort, cf.
// protocol.h). Tenir une trajectoire = réémettre. C'est exactement ce que fait
// déjà le pad du banc de tuning ; ici on s'en sert pour les trajectoires courbes,
// que les déplacements mesurés (`M`/`T`, un axe à la fois) ne savent pas décrire.

import type { Transport } from './transport';
import { Op } from './transport';

/** Cadence de réémission (Hz) — celle du pad du banc. */
const REFRESH_HZ = 10;

/**
 * TTL envoyé au robot. À 3 périodes, deux notifications perdues d'affilée ne
 * hachent pas la trajectoire, et l'app qui se tait (onglet gelé, page fermée)
 * laisse le robot rouler 0,3 s au pire — pas les 0,5 s du défaut firmware.
 */
const TTL_MS = 300;

/**
 * Fonds de course du firmware (config.h : TELEOP_MAX_SPEED_MM_S / _TURN_DEG_S).
 *
 * ⚠️ Ce sont eux qui convertissent mm/s ↔ % du protocole. La console les redéfinit
 * en direct (`P`/`R`, persistés en NVS) : après un réglage au banc, ces deux
 * constantes MENTENT et le rayon dérive d'autant. Les déplacements droits passent
 * eux par OP_FORWARD/OP_TURN, en cm et degrés absolus — immunisés, eux.
 */
const MAX_SPEED_MM_S = 300;
const MAX_TURN_DEG_S = 120;

/** Expo appliqué à la direction côté firmware (config.h : TELEOP_STEER_EXPO). */
const STEER_EXPO = 0.5;

/**
 * Rampe côté PILOTE : temps pour atteindre le fond de course. Reprise du pad du
 * banc, et pour la même raison — ni le firmware ni le protocole ne lissent la
 * consigne. `cmdSpeed_` saute, la boucle externe voit l'erreur entière d'un coup et
 * demande aussitôt MAX_LEAN_DEG : le robot se penche en butée pour démarrer.
 *
 * ⚠️ La rampe s'applique aux DEUX axes par le même facteur, et c'est ce qui la rend
 * utilisable pour un arc : R = v/ω est inchangé si v et ω montent ensemble. Le
 * rayon reste donc juste pendant toute la montée ; seule la durée s'allonge un peu,
 * ce que `circleDrive` compense.
 */
const RAMP_S = 0.45;

const DEG_PER_RAD = 180 / Math.PI;

/**
 * Allures d'un rond, en fraction du fond de course (`P` côté robot).
 *
 * ⚠️ Il n'y a délibérément RIEN au-dessus de 1 : « à quelle vitesse ce robot se
 * déplace-t-il » a UNE réponse, et elle est côté robot (`P`). Inventer ici une
 * vitesse supérieure recréerait exactement la divergence que le firmware a supprimée
 * en fusionnant croisière et téléguidage. Pour aller plus vite : monter `P`.
 */
export const CIRCLE_SPEEDS = { slow: 0.45, normal: 0.75, fast: 1 } as const;
export type CircleSpeed = keyof typeof CIRCLE_SPEEDS;

/**
 * Inverse l'expo que le firmware applique à la direction (driveNormalized) :
 *   sortie = (x·|x| + e·x) / (1 + e)
 *
 * ⚠️ Sans cette inversion, un arc calculé pour 30 cm en décrit un bien plus grand :
 * l'expo écrase précisément le milieu de course, là où vivent les ronds larges. On
 * ne touche pas à l'expo côté robot — elle est taillée pour un pouce humain et elle
 * a raison d'exister ; c'est à l'émetteur d'un ordre CALCULÉ de s'y adapter.
 */
function unExpo(fraction: number): number {
  const y = Math.min(1, Math.abs(fraction));
  const x = (-STEER_EXPO + Math.sqrt(STEER_EXPO * STEER_EXPO + 4 * y * (1 + STEER_EXPO))) / 2;
  return fraction < 0 ? -x : x;
}

/** Une consigne de téléguidage, en unités physiques. */
export interface DriveVector {
  /** mm/s, + = avance. */
  speedMmS: number;
  /** deg/s, + = droite. */
  turnDegS: number;
}

/**
 * Convertit un rond en consigne + durée. Rayon R (mm), vitesse v (mm/s),
 * rotation ω (deg/s) : R = v / ω_rad, soit ω = v·57,3 / R.
 *
 * Si le rayon demandé exige plus que le fond de course en rotation, c'est la
 * VITESSE qui cède, pas le rayon : un rond trop rapide n'est plus un rond, alors
 * qu'un rond lent reste un rond.
 */
export function circleDrive(
  radiusCm: number,
  turns: number,
  dir: 'left' | 'right',
  speed: CircleSpeed = 'normal',
): { vec: DriveVector; durationMs: number } {
  const r = Math.max(50, Math.abs(radiusCm) * 10); // mm, jamais sous 5 cm
  let v = MAX_SPEED_MM_S * (CIRCLE_SPEEDS[speed] ?? CIRCLE_SPEEDS.normal);
  let w = (v * DEG_PER_RAD) / r;
  if (w > MAX_TURN_DEG_S) {
    w = MAX_TURN_DEG_S;
    v = (w * r) / DEG_PER_RAD;
  }
  const laps = Math.max(0.1, Math.abs(turns) || 1);
  // + la moitié de la rampe : pendant la montée le robot tourne à vitesse réduite,
  // donc parcourt moins d'angle. Approximation assumée — un rond en boucle ouverte
  // ne prétend pas à la précision de `M`/`T`.
  return {
    vec: { speedMmS: v, turnDegS: dir === 'left' ? -w : +w },
    durationMs: Math.round(((laps * 360) / w) * 1000 + (RAMP_S * 1000) / 2),
  };
}

/** Rapproche `cur` de `target` d'au plus `step`. */
function approach(cur: number, target: number, step: number): number {
  return cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
}

/**
 * Tient une consigne de téléguidage pendant une durée donnée, en réémettant à
 * REFRESH_HZ, rampe comprise. Une nouvelle consigne remplace la précédente (pas
 * d'empilement : deux trajectoires simultanées n'ont aucun sens sur deux roues).
 */
export class DriveLoop {
  private timer: number | null = null;
  private endAt = 0;
  private target: DriveVector = { speedMmS: 0, turnDegS: 0 };
  /**
   * Avancement de la rampe, 0→1. UN SEUL scalaire pour les deux axes, et c'est
   * essentiel : ramper chaque axe sur SON propre fond de course les ferait arriver
   * à des instants différents (la rotation d'un rond large est loin de sa butée, la
   * vitesse non), donc trop de rotation pour la vitesse au départ — le robot
   * commencerait son rond bien trop serré avant de s'ouvrir. Un facteur commun
   * garde R = v/ω exact d'un bout à l'autre.
   */
  private k = 0;
  /** true = phase de ralentissement, en attente du zéro. */
  private closing = false;

  constructor(
    private readonly transport: Transport,
    /** Appelé quand la trajectoire se termine (échéance ou arrêt). */
    private readonly onEnd?: (completed: boolean) => void,
  ) {}

  get active(): boolean {
    return this.timer !== null;
  }

  /** Lance (ou remplace) une trajectoire. */
  run(vec: DriveVector, durationMs: number): void {
    this.target = vec;
    this.closing = false;
    this.endAt = Date.now() + Math.max(0, durationMs);
    this.tick();
    if (this.timer === null) {
      this.timer = window.setInterval(() => this.tick(), 1000 / REFRESH_HZ);
    }
  }

  /**
   * Arrêt IMMÉDIAT, sans rampe : c'est une interruption (bouton STOP, ou un
   * déplacement ponctuel qui préempte). Le confort de conduite passe après le fait
   * d'obtenir vraiment l'arrêt qu'on a demandé.
   */
  stop(): void {
    if (!this.clearTimer()) return;
    this.k = 0;
    this.transport.sendIntent(Op.DRIVE, 0, 0, TTL_MS);
    this.onEnd?.(false);
  }

  private clearTimer(): boolean {
    if (this.timer === null) return false;
    window.clearInterval(this.timer);
    this.timer = null;
    this.closing = false;
    return true;
  }

  private tick(): void {
    // Échéance atteinte : on ne coupe pas net, on redescend par la même rampe. Un
    // robot lancé à 300 mm/s à qui on demande zéro d'un bloc doit se pencher en
    // arrière pour freiner — c'est le symétrique exact du départ en butée.
    if (!this.closing && Date.now() >= this.endAt) this.closing = true;
    this.k = approach(this.k, this.closing ? 0 : 1, 1 / (REFRESH_HZ * RAMP_S));

    if (this.closing && this.k === 0) {
      // Arrivé à zéro. Le TTL suffirait à arrêter le robot, mais on envoie l'ordre
      // quand même : 300 ms de roulage en moins, et une trace explicite au journal.
      this.clearTimer();
      this.transport.sendIntent(Op.DRIVE, 0, 0, TTL_MS);
      this.onEnd?.(true);
      return;
    }

    const pctV = ((this.target.speedMmS * this.k) / MAX_SPEED_MM_S) * 100;
    const pctW = unExpo((this.target.turnDegS * this.k) / MAX_TURN_DEG_S) * 100;
    this.transport.sendIntent(Op.DRIVE, Math.round(pctV), Math.round(pctW), TTL_MS);
  }
}
