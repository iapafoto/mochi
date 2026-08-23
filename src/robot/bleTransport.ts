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
      /** Robots DÉJÀ appairés à cette origine. Optionnel : voir tryAutoConnect. */
      getDevices?(): Promise<BluetoothDeviceLite[]>;
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
  readonly name?: string;
  readonly gatt?: BluetoothRemoteGATTServerLite;
}

/**
 * Attente entre deux tentatives de (re)connexion, en ms. Vif au début — un robot
 * qui reboote revient en une seconde — puis on se calme pour ne pas mouliner la
 * radio quand il est simplement éteint. Le dernier délai est répété indéfiniment :
 * allumer le robot suffit alors à le voir arriver, sans toucher au téléphone.
 */
const RETRY_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

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
  /** On VEUT être connecté : distingue une perte de lien d'un arrêt demandé. */
  private wanted = false;
  private retryTimer: number | null = null;
  private retryIndex = 0;

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Un robot est-il déjà désigné ? Vrai dès que l'appairage est connu, MÊME hors
   * de portée : c'est ce qui permet à l'app de ne pas rouvrir le sélecteur pour
   * un robot qu'elle sait retrouver toute seule.
   */
  get paired(): boolean {
    return this.device !== null;
  }

  async connect(): Promise<void> {
    if (!navigator.bluetooth) {
      throw new Error('Web Bluetooth indisponible (navigateur/contexte non HTTPS ?).');
    }
    this.adopt(
      await navigator.bluetooth.requestDevice({
        filters: [{ name: MOCHI_DEVICE_NAME }, { services: [MOCHI_SERVICE_UUID] }],
        optionalServices: [MOCHI_SERVICE_UUID],
      }),
    );
    await this.openGatt();
  }

  /**
   * Reconnexion SILENCIEUSE au robot déjà appairé : ni clic, ni sélecteur.
   * Rend `true` si le lien est ouvert, `false` sinon — jamais d'exception, c'est
   * un confort de démarrage, pas un chemin critique.
   *
   * ⚠️ `getDevices()` N'EXISTE PAS PARTOUT, ET C'EST LA VRAIE LIMITE DE TOUT CECI.
   * L'API qui se souvient d'un appairage est encore expérimentale : sur Chrome
   * elle dort derrière `chrome://flags/#enable-web-bluetooth-new-permissions-backend`.
   * Sans elle, `requestDevice` — donc un geste utilisateur — est le SEUL moyen
   * d'obtenir un `BluetoothDevice`, et aucune astuce côté app n'y change rien.
   * D'où le `?.` : on tente, l'appelant retombe sur le sélecteur si ça rate.
   *
   * ⚠️ `false` ne veut pas dire « renoncé » : robot connu mais hors de portée
   * (éteint, à l'autre bout de la pièce), une boucle de reprise reste armée.
   */
  async tryAutoConnect(): Promise<boolean> {
    const known = await navigator.bluetooth?.getDevices?.().catch(() => []);
    if (!known?.length) return false;
    // Filtre par nom : une origine peut avoir mémorisé d'autres périphériques.
    const dev = known.find((d) => d.name === MOCHI_DEVICE_NAME);
    if (!dev) return false;
    this.adopt(dev);
    try {
      await this.openGatt();
      return true;
    } catch {
      this.scheduleRetry();
      return false;
    }
  }

  /** Retient le périphérique et s'abonne à ses pertes de lien. */
  private adopt(dev: BluetoothDeviceLite): void {
    this.device = dev;
    this.wanted = true;
    this.retryIndex = 0;
    dev.addEventListener('gattserverdisconnected', () => this.handleDisconnect());
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

    this.retryIndex = 0;
    this.setConnected(true);
    console.info('[bleTransport] connecté à Mochi');
  }

  /**
   * Retente l'ouverture plus tard. Ne fait rien si l'arrêt était volontaire, ou
   * si une reprise est déjà armée — sinon deux pertes rapprochées lanceraient
   * deux boucles, qui se doubleraient à chaque tour.
   */
  private scheduleRetry(): void {
    if (!this.wanted || !this.device || this.retryTimer !== null) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.retryIndex, RETRY_DELAYS_MS.length - 1)];
    this.retryIndex++;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      if (!this.wanted || this._connected) return;
      this.openGatt().catch(() => this.scheduleRetry());
    }, delay);
  }

  private handleDisconnect(): void {
    this.commandChar = null;
    this.setConnected(false);
    console.warn('[bleTransport] déconnecté');
    this.scheduleRetry();
  }

  private setConnected(on: boolean): void {
    if (this._connected === on) return;
    this._connected = on;
    for (const cb of this.connectionCbs) cb(on);
  }

  disconnect(): void {
    // D'ABORD couper l'intention : sans ça, le `gattserverdisconnected` qui suit
    // relance aussitôt la boucle de reprise qu'on vient de demander d'arrêter.
    this.wanted = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
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
