// Profil BLE de Mochi — SOURCE DE VÉRITÉ PARTAGÉE app ↔ firmware.
//
// Ces UUIDs et le format de télémétrie DOIVENT rester identiques entre :
//   - ce fichier (côté app web, utilisé par bleTransport.ts)
//   - firmware/include/protocol.h (côté ESP32)
// Si tu changes un UUID ou l'ordre des octets ici, change-le AUSSI dans protocol.h.
//
// Le message de COMMANDE écrit sur la caractéristique `command` est exactement
// l'octet-à-octet produit par encodeMessage() de transport.ts (1 octet opcode +
// params). Aucun JSON : le MTU BLE par défaut est réduit (~20 o utiles).

/** Service GATT principal de Mochi. */
export const MOCHI_SERVICE_UUID = '6d6f6368-c0de-4d43-9a11-000000000001';

/**
 * Caractéristique COMMANDE (app → robot), écriture sans réponse.
 * Payload = message fil (voir transport.ts / encodeMessage).
 */
export const MOCHI_COMMAND_UUID = '6d6f6368-c0de-4d43-9a11-000000000002';

/**
 * Caractéristique TÉLÉMÉTRIE (robot → app), notifications.
 * Payload = paquet Telemetry ci-dessous (little-endian).
 */
export const MOCHI_TELEMETRY_UUID = '6d6f6368-c0de-4d43-9a11-000000000003';

/**
 * Console de tuning déportée (utilisée par src/tuning/dashboard.ts), RX = app → robot.
 * Payload = texte UTF-8 : une ligne de commande terminée par `\n` (`d 66\n`).
 * C'est le protocole du moniteur série, transporté par BLE pour régler
 * l'équilibre sans câble USB (le câble tire sur le robot et fausse les essais).
 */
export const MOCHI_CONSOLE_RX_UUID = '6d6f6368-c0de-4d43-9a11-000000000004';

/**
 * Console de tuning déportée, TX = robot → app, notifications.
 * Payload = texte UTF-8 brut, **fragmenté** : un bloc ne contient pas forcément
 * une ligne entière. Le récepteur doit accumuler et découper sur `\n`.
 */
export const MOCHI_CONSOLE_TX_UUID = '6d6f6368-c0de-4d43-9a11-000000000005';

/** Nom BLE annoncé par l'ESP32 (advertising). */
export const MOCHI_DEVICE_NAME = 'Mochi';

/** État global du robot, tel que remonté dans la télémétrie. */
export const RobotState = {
  IDLE: 0, // au repos, moteurs coupés
  BALANCING: 1, // en équilibre actif
  FALLEN: 2, // chute détectée → moteurs coupés (réflexe sécurité)
} as const;
export type RobotStateValue = (typeof RobotState)[keyof typeof RobotState];

/**
 * Paquet de télémétrie (9 octets, little-endian). Doit correspondre au
 * `struct TelemetryPacket` de protocol.h (packed).
 *
 * | offset | type   | champ        | unité                                  |
 * |--------|--------|--------------|----------------------------------------|
 * | 0      | uint8  | version      | = TELEMETRY_VERSION (1)                |
 * | 1      | uint8  | state        | RobotState                             |
 * | 2..3   | int16  | pitchCdeg    | inclinaison, centidegrés (°×100)       |
 * | 4..5   | int16  | wheelSpeed   | vitesse roues, mm/s                     |
 * | 6..7   | uint16 | distanceMm   | HC-SR04, mm (0xFFFF = pas d'écho)       |
 * | 8      | uint8  | flags        | bit0=obstacle bit1=moteursActifs bit2=armé bit3=déplacement |
 */
export const TELEMETRY_VERSION = 1;
export const TELEMETRY_SIZE = 9;

export interface Telemetry {
  version: number;
  state: RobotStateValue;
  /** Inclinaison en degrés (converti depuis les centidegrés du fil). */
  pitchDeg: number;
  /** Vitesse des roues en mm/s (signé, + = avance). */
  wheelSpeedMmS: number;
  /** Distance obstacle en mm ; null si aucun écho. */
  distanceMm: number | null;
  obstacle: boolean;
  /** Moteurs réellement alimentés (broche ENABLE). Faux dès qu'il est tombé. */
  motorsEnabled: boolean;
  /**
   * Autorisé à bouger. À ne PAS confondre avec `motorsEnabled` : un robot armé qui
   * vient de tomber a ses moteurs coupés et se rengagera seul une fois redressé.
   * Le robot boote désarmé — sans Op.ARM, tout déplacement est ignoré en silence.
   */
  armed: boolean;
  /**
   * Un déplacement MESURÉ est en cours (trajet + stabilisation). C'est le seul
   * signal qui dise quand il est fini : sa durée n'est connue à l'avance de
   * personne, puisque c'est l'odométrie qui l'arrête. Cf. MoveQueue.
   */
  moving: boolean;
}

/** Distance renvoyée par le sonar quand aucun écho n'est reçu. */
const SONAR_NO_ECHO = 0xffff;

/** Décode un paquet de télémétrie reçu par notification BLE. */
export function parseTelemetry(dv: DataView): Telemetry | null {
  if (dv.byteLength < TELEMETRY_SIZE) return null;
  const state = dv.getUint8(1) as RobotStateValue;
  const distRaw = dv.getUint16(6, true);
  const flags = dv.getUint8(8);
  return {
    version: dv.getUint8(0),
    state,
    pitchDeg: dv.getInt16(2, true) / 100,
    wheelSpeedMmS: dv.getInt16(4, true),
    distanceMm: distRaw === SONAR_NO_ECHO ? null : distRaw,
    obstacle: (flags & 0x01) !== 0,
    motorsEnabled: (flags & 0x02) !== 0,
    armed: (flags & 0x04) !== 0,
    moving: (flags & 0x08) !== 0,
  };
}
