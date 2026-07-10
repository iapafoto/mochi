import type { Transport } from './transport';
import { encodeMessage, opName } from './transport';

/** Événement émis à chaque intention moteur, pour le panneau debug. */
export interface MotorEvent {
  op: number;
  name: string;
  args: number[];
  bytes: Uint8Array;
  t: number; // timestamp ms
}

/**
 * Transport mocké (v1) : ne pilote aucun moteur, logue chaque intention en
 * console et notifie les abonnés (panneau debug). Encode réellement le message
 * fil pour valider le protocole côté mock.
 */
export class MockTransport implements Transport {
  private _connected = false;
  private listeners: ((e: MotorEvent) => void)[] = [];

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    this._connected = true;
    console.info('[mockTransport] connecté (no-op)');
  }

  disconnect(): void {
    this._connected = false;
  }

  sendIntent(op: number, ...args: number[]): void {
    const bytes = encodeMessage(op, args);
    const e: MotorEvent = { op, name: opName(op), args, bytes, t: Date.now() };
    console.info('[mockTransport] intent', e.name, args, bytes);
    for (const cb of this.listeners) cb(e);
  }

  onTelemetry(_cb: (state: DataView) => void): void {
    // v2 uniquement.
  }

  /** Abonnement du panneau debug aux intentions moteur. */
  onMotorEvent(cb: (e: MotorEvent) => void): void {
    this.listeners.push(cb);
  }
}
