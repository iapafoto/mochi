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

/**
 * Inclinaison de tête MAINTENUE pendant toute ton intervention.
 *
 * ⚠️ C'est elle qui rend l'écoute lisible, et c'est ce qui manquait à la première
 * version. Celle-ci ne faisait que moduler pupille et sourcils au fil de la voix :
 * du mouvement, mais aucune POSE — or ce qu'on reconnaît chez quelqu'un qui
 * écoute, c'est une posture tenue, pas une agitation. Le canal existait et servait
 * déjà à ça ailleurs (le preset `curiosity` incline à 0,6) ; le backchannel, lui,
 * plafonnait à 0,09, soit rien de visible sur un écran de téléphone.
 */
const TILT = 0.34;

/** Plissement des paupières : l'œil attentif, pas l'œil rond. */
const LID = 0.16;

/** Clignements pendant l'écoute : plus fréquents qu'au repos (2,5–6,5 s). */
const BLINK_MIN_MS = 1200;
const BLINK_MAX_MS = 2600;

/**
 * ⚠️ IL N'Y A PAS DE « MMH » AUDIBLE PENDANT QUE TU PARLES, ET IL NE FAUT PAS EN
 * REMETTRE. La première version en jouait un dans les pauses, ce qui paraissait
 * inoffensif — la pause était vide, il n'y avait rien à écraser. C'est faux, et
 * l'arithmétique est implacable : un son joué micro ouvert doit être couvert par
 * le portillon (sinon la VAD, en sensibilité haute, le prend pour de la parole et
 * ouvre un tour), or le portillon envoie du SILENCE, et le silence est exactement
 * ce qui termine ton tour. Pause de 220 ms + 210 ms de portillon = 430 ms de
 * silence continu, pour un serveur qui commite à 350 : la phrase était coupée en
 * deux et Gemini répondait à la première moitié. D'où « il comprend de travers ».
 *
 * Le backchannel reste donc PUREMENT VISUEL tant que tu parles. Le son, lui, a sa
 * place à la FIN de ta phrase (le « mmh ? » de main.ts) : là, le silence
 * supplémentaire ne coupe rien — il ne fait qu'avancer une fin déjà décidée.
 */

export class Backchannel {
  private _active = false;
  private nextNodMs = 0;
  private nextBlinkMs = 0;
  /** Côté de l'inclinaison pour l'intervention en cours (cf. TILT). */
  private tilt = TILT;

  constructor(private readonly face: FaceState) {}

  /**
   * Vrai tant que Mochi écoute activement. La boucle d'humeur s'en sert pour ne
   * PAS réécrire le visage au repos par-dessus (elle tourne à 10 Hz et gagnerait).
   */
  get active(): boolean {
    return this._active;
  }

  start(): void {
    this._active = true;
    const now = Date.now();
    this.nextNodMs = now + rand(NOD_MIN_MS, NOD_MAX_MS);
    this.nextBlinkMs = now + rand(BLINK_MIN_MS, BLINK_MAX_MS);
    // Le côté change à chaque fois : une tête qui penche TOUJOURS du même bord
    // cesse d'être une réaction et devient une caractéristique du dessin.
    this.tilt = Math.random() < 0.5 ? -TILT : TILT;
    // Ouverture d'attention : il penche la tête, plisse un peu les yeux, la
    // pupille se dilate et le regard revient sur toi.
    this.face.setTarget({
      channels: {
        headTilt: this.tilt,
        eyelidL: LID,
        eyelidR: LID,
        pupil: 0.62,
        gazeX: 0,
        gazeY: 0.08,
        mouthCurve: 0.28,
        mouthOpen: 0.05,
      },
      tau: 0.22,
    });
  }

  stop(): void {
    if (!this._active) return;
    this._active = false;
    // On ne relâche QUE la pose tenue — l'inclinaison et les paupières — et
    // lentement : il se redresse en commençant à répondre, ce qui se lit très bien.
    //
    // ⚠️ IL FAUT LA RELÂCHER ICI, ET NULLE PART AILLEURS NE LE FERA. La plupart des
    // presets d'émotion ne touchent pas `headTilt` (seul `curiosity` l'écrit), et
    // le visage au repos de l'humeur non plus : sans cette ligne, la tête resterait
    // penchée pour le restant de la session, et l'écoute cesserait de vouloir dire
    // quoi que ce soit puisqu'elle ne s'arrêterait jamais.
    //
    // Le reste — pupille, sourcils, bouche — est laissé tel quel exprès : le
    // modèle va répondre et son `express` va tout écraser. Écrire une cible de
    // repos entre les deux ferait retomber le visage une demi-seconde avant la
    // réponse, soit un petit trou d'inattention, pile au mauvais moment.
    this.face.setTarget({ channels: { headTilt: 0, eyelidL: 0, eyelidR: 0 }, tau: 0.5 });
  }

  /**
   * Un paquet micro (~40 ms). `level` est l'enveloppe lissée de la VAD.
   * Ne fait rien si l'écoute n'est pas active.
   */
  push(level: number): void {
    if (!this._active) return;
    const now = Date.now();

    // L'intensité de la voix pilote sourcils, pupille et l'inclinaison : c'est ce
    // qui donne l'impression qu'il suit ce que tu DIS, et pas seulement que tu
    // parles. La tête penche un peu plus quand tu appuies — comme on se penche
    // vers quelqu'un qui dit quelque chose d'intéressant.
    const k = Math.min(1, level * 2.2);
    this.face.setTarget({
      channels: {
        pupil: 0.55 + k * 0.32,
        browRaiseL: 0.12 + k * 0.4,
        browRaiseR: 0.14 + k * 0.44, // très légèrement asymétrique = vivant, pas mécanique
        mouthOpen: 0.04 + k * 0.05,
        headTilt: this.tilt * (1 + k * 0.35),
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
  }

  /**
   * Micro-hochement : le regard descend puis remonte, la tête suit un peu.
   * Un transient plutôt qu'une cible — il doit s'imposer par-dessus l'expression
   * en cours et se retirer sans rien laisser derrière lui.
   */
  private nod(): void {
    // Franc, et sur TROIS canaux à la fois. Un hochement qui ne bouge que le
    // regard de 0,16 ne se lit pas : ce qu'on reconnaît, c'est la tête qui plonge
    // et les paupières qui suivent le mouvement.
    const depth = 0.3 + Math.random() * 0.16;
    this.face.addTransient({
      duration: 0.5,
      apply(current, progress) {
        const d = Math.sin(Math.PI * progress);
        current.gazeY -= depth * d;
        current.headTilt -= depth * 0.5 * d;
        current.eyelidL = Math.max(current.eyelidL, depth * 0.5 * d);
        current.eyelidR = Math.max(current.eyelidR, depth * 0.5 * d);
      },
    });
  }
}

function rand(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}
