import type { Transport, MotorEvent } from './transport';
import { motorEvent } from './transport';

/**
 * Transport mocké : ne pilote aucun moteur, journalise chaque intention et
 * notifie les abonnés (panneau debug). Encode réellement le message fil pour
 * valider le protocole sans robot sous la main.
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
    const e = motorEvent(op, args, true);
    console.info('[mockTransport] intent', e.name, args, e.bytes);
    for (const cb of this.listeners) cb(e);
  }

  onTelemetry(_cb: (state: DataView) => void): void {
    // Un mock n'a rien à raconter sur un robot qui n'existe pas.
  }

  onMotorEvent(cb: (e: MotorEvent) => void): void {
    this.listeners.push(cb);
  }
}
