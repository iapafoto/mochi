// Backchannel — ce que Mochi fait PENDANT QUE TU PARLES.
//
// Jusqu'ici : rien. Micro ouvert, visage figé sur son humeur de repos, et la
// première réaction n'arrivait qu'après le modèle. Or dans une vraie conversation
// l'écoute est ACTIVE — on hoche, on lève un sourcil, on dilate la pupille, on
// place un « mmh » — et c'est ce signal-là, pas la vitesse de réponse, qui donne
// l'impression d'être écouté. C'est aussi le seul registre expressif qui ne coûte
// RIEN : ni réseau, ni tokens, ni latence.
//
// Piloté par la VAD locale (src/audio/vad.ts), donc sans rien demander au cloud.

import type { FaceState } from '../face/faceState';
import { blink } from '../face/expressions';

/** Intervalle entre deux micro-hochements pendant l'écoute (ms). */
const NOD_MIN_MS = 1700;
const NOD_MAX_MS = 3300;

/** Clignements pendant l'écoute : plus fréquents qu'au repos (2,5–6,5 s). */
const BLINK_MIN_MS = 1200;
const BLINK_MAX_MS = 2600;

/**
 * Conditions du « mmh » AUDIBLE. Volontairement étroites, parce que ce son est le
 * seul de la famille à avoir un coût réel : le portillon micro remplace 200 ms de
 * ta phrase par du silence (cf. MicCapture.setSilenced). Dans une PAUSE c'est
 * gratuit — il n'y avait rien à garder ; au milieu d'un mot ça abîmerait la
 * transcription. D'où : seulement en pause, seulement sur un tour déjà long
 * (avant, personne ne ponctue), une seule fois par tour, et pas systématiquement.
 */
const HUM_MIN_TURN_MS = 2500;
const HUM_MIN_PAUSE_MS = 220;
const HUM_CHANCE = 0.3;

export interface BackchannelCallbacks {
  /** Joue le petit « mmh » d'écoute (déjà porté par le portillon micro). */
  playHum(): void;
}

export class Backchannel {
  private _active = false;
  private nextNodMs = 0;
  private nextBlinkMs = 0;
  private hummedThisTurn = false;

  constructor(
    private readonly face: FaceState,
    private readonly cb: BackchannelCallbacks,
  ) {}

  /**
   * Vrai tant que Mochi écoute activement. La boucle d'humeur s'en sert pour ne
   * PAS réécrire le visage au repos par-dessus (elle tourne à 10 Hz et gagnerait).
   */
  get active(): boolean {
    return this._active;
  }

  start(): void {
    this._active = true;
    this.hummedThisTurn = false;
    const now = Date.now();
    this.nextNodMs = now + rand(NOD_MIN_MS, NOD_MAX_MS);
    this.nextBlinkMs = now + rand(BLINK_MIN_MS, BLINK_MAX_MS);
    // Ouverture d'attention : la pupille se dilate, le regard revient au centre.
    this.face.setTarget({
      channels: { pupil: 0.62, gazeX: 0, gazeY: 0.08, mouthCurve: 0.28, mouthOpen: 0.05 },
      tau: 0.22,
    });
  }

  stop(): void {
    if (!this._active) return;
    this._active = false;
    // On ne remet RIEN au repos ici : soit le modèle répond et son `express`
    // écrase tout, soit la boucle d'humeur reprend la main d'elle-même. Écrire une
    // cible de repos entre les deux ferait retomber le visage une demi-seconde
    // avant la réponse — un petit trou d'inattention, pile au mauvais moment.
  }

  /**
   * Un paquet micro (~40 ms). `level` est l'enveloppe lissée de la VAD.
   * Ne fait rien si l'écoute n'est pas active.
   */
  push(level: number, turnMs: number, pauseMs: number): void {
    if (!this._active) return;
    const now = Date.now();

    // L'intensité de la voix pilote sourcils et pupille : c'est ce qui donne
    // l'impression qu'il suit ce que tu dis, et pas seulement que tu parles.
    const k = Math.min(1, level * 2.2);
    this.face.setTarget({
      channels: {
        pupil: 0.55 + k * 0.3,
        browRaiseL: k * 0.3,
        browRaiseR: k * 0.34, // très légèrement asymétrique = vivant, pas mécanique
        mouthOpen: 0.04 + k * 0.05,
      },
      tau: 0.13,
    });

    if (now >= this.nextBlinkMs) {
      blink(this.face);
      this.nextBlinkMs = now + rand(BLINK_MIN_MS, BLINK_MAX_MS);
    }

    if (now >= this.nextNodMs) {
      this.nod();
      this.nextNodMs = now + rand(NOD_MIN_MS, NOD_MAX_MS);
    }

    if (
      !this.hummedThisTurn &&
      turnMs > HUM_MIN_TURN_MS &&
      pauseMs > HUM_MIN_PAUSE_MS &&
      Math.random() < HUM_CHANCE
    ) {
      this.hummedThisTurn = true;
      this.cb.playHum();
    }
  }

  /**
   * Micro-hochement : le regard descend puis remonte, la tête suit un peu.
   * Un transient plutôt qu'une cible — il doit s'imposer par-dessus l'expression
   * en cours et se retirer sans rien laisser derrière lui.
   */
  private nod(): void {
    const depth = 0.16 + Math.random() * 0.1;
    this.face.addTransient({
      duration: 0.42,
      apply(current, progress) {
        const d = Math.sin(Math.PI * progress);
        current.gazeY -= depth * d;
        current.headTilt += depth * 0.35 * d;
      },
    });
  }
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}
