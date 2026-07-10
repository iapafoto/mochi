import type { Transport } from './transport';

/**
 * STUB v2 — Web Bluetooth (GATT). Non implémenté en v1.
 * Basculer main.ts de MockTransport à BleTransport ne devra rien changer
 * d'autre : tout le code amont ne dépend que de l'interface Transport.
 */
export class BleTransport implements Transport {
  get connected(): boolean {
    return false;
  }

  async connect(): Promise<void> {
    throw new Error('BleTransport: non implémenté (v2).');
  }

  disconnect(): void {
    /* v2 */
  }

  sendIntent(): void {
    throw new Error('BleTransport: non implémenté (v2).');
  }

  onTelemetry(): void {
    /* v2 */
  }
}
