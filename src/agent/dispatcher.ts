import type { FaceState } from '../face/faceState';
import { express, look, blink, wink, type Emotion, type LookDir } from '../face/expressions';
import type { SoundEngine, SoundName } from '../audio/sounds';
import type { Transport } from '../robot/transport';
import { Op, LookCode } from '../robot/transport';
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
 * Route un IntentCall vers le visage (réel), le son et/ou le transport (mock).
 * C'est le point unique de traduction « intention → effet ».
 */
export class Dispatcher {
  constructor(
    private readonly face: FaceState,
    private readonly sound: SoundEngine,
    private readonly transport: Transport,
    private readonly mood?: MoodEngine,
    private readonly emotes?: EmoteLayer,
  ) {}

  dispatch(call: IntentCall): DispatchResult {
    const a = call.args;
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
        const dir = String(a.dir ?? 'center') as LookDir;
        look(this.face, dir);
        this.transport.sendIntent(Op.LOOK, LookCode[dir] ?? 0); // v2 : oriente aussi la base
        return ok(call.name, dir);
      }

      // --- Mouvement (mocké) ---
      case 'forward':
        this.sound.play('move');
        this.transport.sendIntent(Op.FORWARD, int(a.cm));
        return ok(call.name, `${int(a.cm)} cm`);
      case 'backward':
        this.sound.play('move');
        this.transport.sendIntent(Op.BACKWARD, int(a.cm));
        return ok(call.name, `${int(a.cm)} cm`);
      case 'turn':
        this.sound.play('move');
        this.transport.sendIntent(Op.TURN, int(a.deg));
        return ok(call.name, `${int(a.deg)}°`);
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
