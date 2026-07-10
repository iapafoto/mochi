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
  NOD: 0x10,
  BOW: 0x11,
  WIGGLE: 0x12,
  LOOK: 0x20, // int8 dir
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
    case Op.LOOK: {
      return new Uint8Array([op, (args[0] | 0) & 0xff]);
    }
    default:
      return new Uint8Array([op]);
  }
}
