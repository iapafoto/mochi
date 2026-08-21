// Transport actionneur — interface + protocole fil.
//
// Le reste du code ne connaît QUE cette interface. En v1 : mockTransport
// (log). En v2 : bleTransport (Web Bluetooth). Message compact = 1 octet
// opcode + params (pas de JSON ; MTU BLE réduit en v2).

export const Op = {
  STOP: 0x00,
  FORWARD: 0x01, // int16 cm
  BACKWARD: 0x02, // int16 cm
  TURN: 0x03, // int16 deg
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

export interface Transport {
  /** v1 mock : no-op ; v2 : Web Bluetooth. */
  connect(): Promise<void>;
  disconnect(): void;
  get connected(): boolean;
  /** Envoie une intention moteur (opcode + arguments entiers). */
  sendIntent(op: number, ...args: number[]): void;
  /** v2 : télémétrie remontée par l'ESP32. */
  onTelemetry(cb: (state: DataView) => void): void;
}

/**
 * Encode un message fil : 1 octet opcode + params.
 * FORWARD/BACKWARD/TURN → int16 LE. LOOK → int8. Le reste → sans param.
 */
export function encodeMessage(op: number, args: number[]): Uint8Array {
  switch (op) {
    case Op.FORWARD:
    case Op.BACKWARD:
    case Op.TURN: {
      const buf = new ArrayBuffer(3);
      const dv = new DataView(buf);
      dv.setUint8(0, op);
      dv.setInt16(1, args[0] | 0, true);
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
    default:
      return new Uint8Array([op]);
  }
}
