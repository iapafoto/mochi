import type { FaceState } from '../face/faceState';
import { express, look, blink, wink, type Emotion, type LookDir } from '../face/expressions';
import type { SoundEngine, SoundName } from '../audio/sounds';
import type { Transport } from '../robot/transport';
import { Op } from '../robot/transport';
import {
  DriveLoop,
  circleDrive,
  CIRCLE_SPEEDS,
  MOVE_SPEEDS,
  moveSpeedFromArousal,
  type CircleSpeed,
  type MoveSpeed,
} from '../robot/driveLoop';
import type { MoveQueue } from '../robot/moveQueue';
import type { IntentCall } from './intents';
import type { MoodEngine } from '../affect/mood';
import type { EmoteLayer, EmoteKind } from '../fx/emotes';
import { EMOTE_KINDS } from '../fx/emotes';

/** Résultat d'un dispatch, remonté au panneau debug. */
export interface DispatchResult {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Les intentions qui font ROULER le robot. Même liste que la famille DÉPLACEMENT
 * décrite à Gemini dans intents.ts — si l'une des deux bouge, l'autre aussi.
 */
const MOVING_INTENTS = new Set(['forward', 'backward', 'turn', 'circle', 'nod', 'bow', 'wiggle']);

/**
 * Route un IntentCall vers le visage, le son et/ou le transport.
 * C'est le point unique de traduction « intention → effet ».
 */
export class Dispatcher {
  constructor(
    private readonly face: FaceState,
    private readonly sound: SoundEngine,
    private readonly transport: Transport,
    private readonly mood?: MoodEngine,
    private readonly emotes?: EmoteLayer,
    /** Pilote des trajectoires continues (ronds). Absent = pas de courbes. */
    private readonly drive?: DriveLoop,
    /**
     * Le robot peut-il se déplacer, là, maintenant ? Rend la RAISON du refus, ou
     * null si c'est bon.
     *
     * Le firmware refuse déjà tout déplacement hors équilibre, et il le fait en
     * silence — c'est son rôle. Ce que personne ne fait sans ce garde-fou, c'est
     * le DIRE : « avance » émet alors un ordre parfaitement légitime, le robot ne
     * bouge pas, et rien nulle part ne distingue ça d'une panne.
     */
    private readonly moveGate?: () => string | null,
    /**
     * File des déplacements mesurés (cf. move()). Absente = émission directe,
     * donc un seul déplacement à la fois.
     */
    private readonly moves?: MoveQueue,
  ) {}

  dispatch(call: IntentCall): DispatchResult {
    const a = call.args;
    // Un seul contrôle pour toute la famille DÉPLACEMENT (cf. intents.ts) : c'est
    // exactement l'ensemble des intentions qui font tourner les roues, gestes
    // compris — un `bow` sur un robot couché ne se voit pas davantage.
    if (MOVING_INTENTS.has(call.name)) {
      const refus = this.moveGate?.();
      if (refus) return { name: call.name, ok: false, detail: refus };
    }
    switch (call.name) {
      case 'express': {
        const emotion = String(a.emotion ?? 'neutral') as Emotion;
        const intensity = clamp01(num(a.intensity, 0.8));
        express(this.face, emotion, intensity);
        this.sound.play(emotion as SoundName);
        this.mood?.nudgeFromEmotion(emotion, intensity); // l'émotion fait évoluer l'humeur
        return ok(call.name, `${emotion} @ ${intensity.toFixed(2)}`);
      }
      case 'emote': {
        const kind = (EMOTE_KINDS as string[]).includes(String(a.kind))
          ? (a.kind as EmoteKind)
          : 'sparkles';
        this.emotes?.spawn(kind);
        return ok(call.name, kind);
      }
      case 'blink':
        blink(this.face);
        this.sound.play('blink');
        return ok(call.name, '');
      case 'wink': {
        const side = a.side === 'right' ? 'right' : 'left';
        wink(this.face, side);
        this.sound.play('wink');
        return ok(call.name, side);
      }
      case 'look': {
        // REGARD SEUL — volontairement plus de OP_LOOK ici.
        // Le modèle appelle look à presque chaque réplique : sur un mock c'était
        // gratuit, sur roues ça donnait un robot qui pivote sans arrêt, use ses
        // A4988 et sa batterie pour dire « je regarde à gauche ». Tourner le CORPS
        // reste possible — c'est `turn`, que le modèle n'appelle que si on le demande.
        const dir = String(a.dir ?? 'center') as LookDir;
        look(this.face, dir);
        return ok(call.name, dir);
      }

      // --- Déplacement réel ---
      case 'forward':
      case 'backward': {
        const op = call.name === 'forward' ? Op.FORWARD : Op.BACKWARD;
        return this.move(call.name, op, int(a.cm), a.speed, `${int(a.cm)} cm`);
      }
      case 'turn':
        return this.move(call.name, Op.TURN, int(a.deg), a.speed, `${int(a.deg)}°`);
      case 'circle': {
        if (!this.drive) return { name: call.name, ok: false, detail: 'pas de pilote de trajectoire' };
        const dir = a.dir === 'left' ? 'left' : 'right';
        const radius = int(a.radius_cm) || 30;
        const turns = num(a.turns, 1);
        // Allure inconnue → `normal`, jamais `fast` : un modèle qui invente une valeur
        // ne doit pas pouvoir lancer le robot à fond de course par accident.
        const speed: CircleSpeed = (String(a.speed) in CIRCLE_SPEEDS
          ? (a.speed as CircleSpeed)
          : 'normal');
        const { vec, durationMs } = circleDrive(radius, turns, dir, speed);
        this.sound.play('move');
        this.drive.run(vec, durationMs);
        return ok(
          call.name,
          `r=${radius} cm, ${turns} tour(s) à ${dir === 'left' ? 'gauche' : 'droite'}, ${speed} ` +
            `(${Math.round(vec.speedMmS)} mm/s, ${Math.round(Math.abs(vec.turnDegS))} °/s, ` +
            `${(durationMs / 1000).toFixed(1)} s)`,
        );
      }
      case 'nod':
        this.transport.sendIntent(Op.NOD);
        return ok(call.name, '');
      case 'bow':
        this.transport.sendIntent(Op.BOW);
        return ok(call.name, '');
      case 'wiggle':
        this.transport.sendIntent(Op.WIGGLE);
        return ok(call.name, '');

      default:
        return { name: call.name, ok: false, detail: 'intention inconnue' };
    }
  }

  /**
   * Déplacement MESURÉ (forward / backward / turn) : allure, son, et mise en file.
   *
   * ⚠️ PASSE PAR LA FILE, ET C'EST TOUT L'INTÉRÊT. « Avance vite puis recule
   * lentement » arrive au dispatcher comme deux appels dans la même milliseconde ;
   * émis tous les deux tout de suite, le second écrase la cible du premier côté
   * firmware et le robot ne fait que reculer, sans que rien ne le signale. La file
   * attend que le robot ait fini (TELEM_FLAG_MOVING) avant d'envoyer le suivant.
   * Sans file (aucune passée au constructeur), on retombe sur l'émission directe :
   * un seul déplacement à la fois, comme avant.
   */
  private move(
    name: string,
    op: number,
    value: number,
    askedSpeed: unknown,
    what: string,
  ): DispatchResult {
    const { pct, label } = this.allure(askedSpeed);
    this.sound.play('move');
    if (!this.moves) {
      this.preempt();
      this.transport.sendIntent(op, value, pct);
      return ok(name, `${what} ${label}`);
    }
    // La trajectoire continue ne se préempte qu'une fois, à l'entrée de la file :
    // le faire à chaque pas couperait un rond qui n'existe déjà plus.
    if (!this.moves.busy) this.preempt();
    const queued = this.moves.enqueue({ op, value, pct, label: `${name} ${what} ${label}` });
    return queued
      ? ok(name, `${what} ${label}${this.moves.busy ? ' — en file' : ''}`)
      : { name, ok: false, detail: 'trop de déplacements en attente' };
  }

  /**
   * Résout l'allure d'un déplacement mesuré : ce que le modèle a demandé, ou —
   * s'il n'a rien dit — celle de l'humeur du moment.
   *
   * ⚠️ MÊME PRUDENCE QUE POUR `circle` : une valeur non reconnue ne devient JAMAIS
   * `fast`. Mais ici elle ne devient pas non plus `normal` : elle retombe sur
   * l'humeur, c'est-à-dire sur le cas « personne n'a demandé d'allure » — parce
   * qu'un modèle qui invente un mot n'a rien demandé de plus qu'un modèle muet.
   */
  private allure(asked: unknown): { pct: number; label: string } {
    const name = String(asked);
    if (name in MOVE_SPEEDS) {
      const scale = MOVE_SPEEDS[name as MoveSpeed];
      return { pct: Math.round(scale * 100), label: `(${name})` };
    }
    const scale = moveSpeedFromArousal(this.mood?.mood.arousal ?? 0.35);
    return { pct: Math.round(scale * 100), label: `(humeur ×${scale.toFixed(2)})` };
  }

  /**
   * Coupe une trajectoire continue avant un déplacement ponctuel.
   * Sans ça, le rond réémet sa consigne 10 fois par seconde et écrase le FORWARD
   * dans les 100 ms : l'ordre part bien, et le robot continue son rond.
   */
  private preempt(): void {
    this.drive?.stop();
  }
}

function ok(name: string, detail: string): DispatchResult {
  return { name, ok: true, detail };
}

function num(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : dflt;
}

function int(v: unknown): number {
  return Math.round(num(v, 0));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
