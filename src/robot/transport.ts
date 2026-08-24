// Transport actionneur — interface + protocole fil.
//
// Le reste du code ne connaît QUE cette interface. Deux implémentations :
// `MockTransport` (journalise, sans robot) et `BleTransport` (Web Bluetooth).
// Message compact = 1 octet opcode + params (pas de JSON ; MTU BLE réduit).

export const Op = {
  STOP: 0x00,
  // 3e octet OPTIONNEL = allure, en % de la croisière odométrique (cf. protocol.h
  // et driveLoop.ts pour la doctrine « une seule réponse à : à quelle vitesse ce
  // robot se déplace-t-il »). Absent ⇒ 100 %, l'ancien comportement exact.
  FORWARD: 0x01, // int16 cm  [+ uint8 allure %]
  BACKWARD: 0x02, // int16 cm  [+ uint8 allure %]
  TURN: 0x03, // int16 deg [+ uint8 allure %]
  // Téléguidage CONTINU (manette / joystick), cf. firmware/include/protocol.h :
  //   args = [vitesse %, rotation %, ttl ms]  — % dans −100..+100
  // Ce n'est pas un ordre ponctuel mais un ÉTAT, qui EXPIRE côté robot s'il n'est
  // pas rafraîchi (~10 Hz) : lien coupé manette poussée ⇒ le robot s'arrête.
  DRIVE: 0x04, // int8 %v, int8 %rot, uint8 ttl×10ms
  NOD: 0x10,
  BOW: 0x11,
  WIGGLE: 0x12,
  LOOK: 0x20, // int8 dir
  CALIBRATE: 0x30, // recalibre l'IMU (robot immobile+vertical, ~2 s, moteurs coupés)
  // Le robot boote DÉSARMÉ (BOOT_ARMED = false) : sans ARM, tout déplacement est
  // reçu et ignoré en silence côté firmware. Cf. protocol.h.
  ARM: 0x31, // uint8 0/1
  // Zéro d'assiette (cf. protocol.h) : équivalents BLE des consoles `z`, `Z`, `w`.
  ZERO_HERE: 0x32, // la pose actuelle devient 0° — rapide, vaut ce que vaut la main
  ZERO_ADOPT: 0x33, // adopte le zéro que ∫θ a convergé — lent, mais précis
  SAVE: 0x34, // persiste en NVS : sans lui, rien ne survit au reboot
} as const;

export type Opcode = (typeof Op)[keyof typeof Op];

/** Code direction pour LOOK (int8). */
export const LookCode = { center: 0, left: 1, right: 2, up: 3, down: 4 } as const;

const OP_NAMES: Record<number, string> = Object.fromEntries(
  Object.entries(Op).map(([k, v]) => [v, k]),
);

export function opName(op: number): string {
  return OP_NAMES[op] ?? `0x${op.toString(16).padStart(2, '0')}`;
}

/**
 * Événement émis à chaque intention moteur, pour le panneau debug.
 *
 * Il vit ICI et pas dans mockTransport parce que le journal vaut surtout quand le
 * robot est VRAI : c'est la trace qui permet de dire « l'app a bien émis, c'est en
 * face que ça coince ». Le laisser côté mock l'aurait fait disparaître au moment
 * exact où il devient utile.
 */
export interface MotorEvent {
  op: number;
  name: string;
  args: number[];
  bytes: Uint8Array;
  t: number; // timestamp ms
  /** false = l'app a voulu émettre mais le lien était coupé (rien n'est parti). */
  sent: boolean;
}

export interface Transport {
  connect(): Promise<void>;
  disconnect(): void;
  get connected(): boolean;
  /** Envoie une intention moteur (opcode + arguments entiers). */
  sendIntent(op: number, ...args: number[]): void;
  /** Télémétrie remontée par l'ESP32 (paquet brut ; cf. parseTelemetry). */
  onTelemetry(cb: (state: DataView) => void): void;
  /** Journal des intentions émises (panneau debug). */
  onMotorEvent(cb: (e: MotorEvent) => void): void;
}

/**
 * Encode un message fil : 1 octet opcode + params.
 * FORWARD/BACKWARD/TURN → int16 LE. LOOK/ARM → uint8. Le reste → sans param.
 */
export function encodeMessage(op: number, args: number[]): Uint8Array {
  switch (op) {
    case Op.FORWARD:
    case Op.BACKWARD:
    case Op.TURN: {
      // Allure optionnelle (args[1], % de la croisière odométrique — cf.
      // protocol.h). On n'émet le 3e octet QUE s'il y a une allure à dire : un
      // message de 3 octets reste exactement celui d'avant, et un firmware qui
      // ignore cet octet continue de marcher (il lit `len >= 3`).
      const pct = args.length > 1 ? Math.max(1, Math.min(255, Math.round(args[1]))) : 0;
      const buf = new ArrayBuffer(pct ? 4 : 3);
      const dv = new DataView(buf);
      dv.setUint8(0, op);
      dv.setInt16(1, args[0] | 0, true);
      if (pct) dv.setUint8(3, pct);
      return new Uint8Array(buf);
    }
    case Op.DRIVE: {
      // % signés bornés côté émetteur : le robot ne relit pas les intentions, il
      // les exécute. Le TTL voyage en pas de 10 ms (0 = défaut du firmware).
      const pct = (x: number) => Math.max(-100, Math.min(100, Math.round(x || 0)));
      const buf = new ArrayBuffer(4);
      const dv = new DataView(buf);
      dv.setUint8(0, op);
      dv.setInt8(1, pct(args[0]));
      dv.setInt8(2, pct(args[1]));
      dv.setUint8(3, Math.max(0, Math.min(255, Math.round((args[2] || 0) / 10))));
      return new Uint8Array(buf);
    }
    case Op.LOOK: {
      return new Uint8Array([op, (args[0] | 0) & 0xff]);
    }
    case Op.ARM: {
      return new Uint8Array([op, args[0] ? 1 : 0]);
    }
    default:
      return new Uint8Array([op]);
  }
}

/** Fabrique l'événement de journal correspondant à une intention. */
export function motorEvent(op: number, args: number[], sent: boolean): MotorEvent {
  return { op, name: opName(op), args, bytes: encodeMessage(op, args), t: Date.now(), sent };
}
