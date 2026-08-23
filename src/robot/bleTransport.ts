import type { Transport, MotorEvent } from './transport';
import { motorEvent, opName } from './transport';
import {
  MOCHI_SERVICE_UUID,
  MOCHI_COMMAND_UUID,
  MOCHI_TELEMETRY_UUID,
  MOCHI_DEVICE_NAME,
} from './bleProfile';

// Web Bluetooth n'est pas dans les types DOM par défaut (lib.dom). On déclare le
// minimum utilisé pour éviter d'ajouter @types/web-bluetooth.
declare global {
  interface Navigator {
    readonly bluetooth?: {
      requestDevice(options: unknown): Promise<BluetoothDeviceLite>;
    };
  }
}
interface BluetoothRemoteGATTCharacteristicLite extends EventTarget {
  readonly value?: DataView;
  writeValueWithoutResponse(value: BufferSource): Promise<void>;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLite>;
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristicLite>;
}
interface BluetoothRemoteGATTServiceLite {
  getCharacteristic(uuid: string): Promise<BluetoothRemoteGATTCharacteristicLite>;
}
interface BluetoothRemoteGATTServerLite {
  readonly connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServerLite>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BluetoothRemoteGATTServiceLite>;
}
interface BluetoothDeviceLite extends EventTarget {
  readonly gatt?: BluetoothRemoteGATTServerLite;
}

/**
 * Transport Web Bluetooth. Parle le profil GATT de Mochi (bleProfile.ts),
 * identique au firmware ESP32 (protocol.h).
 *
 * ⚠️ Web Bluetooth exige un contexte sécurisé (HTTPS ou localhost) et un geste
 * utilisateur pour `requestDevice` (le bouton « Connecter » du panneau).
 *
 * ⚠️ Le robot démarre DÉSARMÉ : se connecter ne suffit pas à le faire bouger, il
 * faut lui envoyer Op.ARM. Sans ça le firmware accepte les déplacements et n'en
 * exécute aucun — symptôme : « ça envoie, rien ne bouge, aucune erreur ».
 */
export class BleTransport implements Transport {
  private device: BluetoothDeviceLite | null = null;
  private commandChar: BluetoothRemoteGATTCharacteristicLite | null = null;
  private telemetryCb: ((state: DataView) => void) | null = null;
  private motorCbs: ((e: MotorEvent) => void)[] = [];
  private connectionCbs: ((connected: boolean) => void)[] = [];
  private _connected = false;

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth indisponible (navigateur/contexte non HTTPS ?).');
    }
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ name: MOCHI_DEVICE_NAME }, { services: [MOCHI_SERVICE_UUID] }],
      optionalServices: [MOCHI_SERVICE_UUID],
    });
    this.device.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
    await this.openGatt();
  }

  /** (Re)ouvre la session GATT et resouscrit aux notifications. */
  private async openGatt(): Promise<void> {
    const gatt = this.device?.gatt;
    if (!gatt) throw new Error('GATT indisponible sur ce périphérique.');
    const server = await gatt.connect();
    const service = await server.getPrimaryService(MOCHI_SERVICE_UUID);

    this.commandChar = await service.getCharacteristic(MOCHI_COMMAND_UUID);

    const telemetry = await service.getCharacteristic(MOCHI_TELEMETRY_UUID);
    telemetry.addEventListener('characteristicvaluechanged', (ev: Event) => {
      const dv = (ev.target as BluetoothRemoteGATTCharacteristicLite).value;
      if (dv && this.telemetryCb) this.telemetryCb(dv);
    });
    await telemetry.startNotifications();

    this.setConnected(true);
    console.info('[bleTransport] connecté à Mochi');
  }

  private handleDisconnect(): void {
    this.commandChar = null;
    this.setConnected(false);
    console.warn('[bleTransport] déconnecté');
  }

  private setConnected(on: boolean): void {
    if (this._connected === on) return;
    this._connected = on;
    for (const cb of this.connectionCbs) cb(on);
  }

  disconnect(): void {
    this.device?.gatt?.disconnect();
    this.handleDisconnect();
  }

  sendIntent(op: number, ...args: number[]): void {
    const live = !!this.commandChar && this._connected;
    // On journalise MÊME quand le lien est coupé, avec `sent: false`. C'est ce qui
    // permet de trancher « l'app n'a rien émis » / « l'app a émis, le robot n'a rien
    // fait » — la première question qu'on se pose devant un robot qui ne bouge pas.
    const e = motorEvent(op, args, live);
    for (const cb of this.motorCbs) cb(e);
    if (!live) {
      console.warn('[bleTransport] non connecté, intention ignorée', opName(op), args);
      return;
    }
    // Copie dans un ArrayBuffer garanti (le générique Uint8Array de TS 5.7 n'est
    // pas directement assignable à BufferSource).
    const bytes = new Uint8Array(e.bytes);
    // Écriture sans réponse : rapide, adaptée au flux de commandes. On avale les
    // rejets transitoires (buffer plein) pour ne pas casser la boucle d'intentions.
    this.commandChar!.writeValueWithoutResponse(bytes).catch((err) => {
      console.warn('[bleTransport] écriture échouée', opName(op), err);
    });
  }

  onTelemetry(cb: (state: DataView) => void): void {
    this.telemetryCb = cb;
  }

  onMotorEvent(cb: (e: MotorEvent) => void): void {
    this.motorCbs.push(cb);
  }

  /** Notifié aussi sur perte de lien subie (robot éteint, hors de portée). */
  onConnectionChange(cb: (connected: boolean) => void): void {
    this.connectionCbs.push(cb);
  }
}
