// protocol.h — protocole fil + profil BLE. DOIT rester aligné avec l'app web :
//   - opcodes           ↔ src/robot/transport.ts (objet Op)
//   - UUIDs / télémétrie ↔ src/robot/bleProfile.ts
// Toute modification ici doit être répercutée là-bas (et réciproquement).

#pragma once
#include <Arduino.h>

// ─────────────────────────────────────────────────────────────────────────
//  Opcodes (1er octet du message de commande). Cf. transport.ts / Op.
// ─────────────────────────────────────────────────────────────────────────
enum Opcode : uint8_t {
  OP_STOP = 0x00,     // —              réflexe : stoppe tout déplacement (reste debout)
  OP_FORWARD = 0x01,  // int16 cm       avance de N cm
  OP_BACKWARD = 0x02, // int16 cm       recule de N cm
  OP_TURN = 0x03,     // int16 deg      pivote (+ = droite)
  OP_NOD = 0x10,      // —              hoche (oui)
  OP_BOW = 0x11,      // —              révérence
  OP_WIGGLE = 0x12,   // —              se dandine
  OP_LOOK = 0x20,     // int8 dir       coup d'œil (petit pivot) — cf. LookCode
  OP_CALIBRATE = 0x30, // —             recalibre l'IMU (robot immobile+vertical, ~2 s, moteurs coupés)
};

// Codes de direction pour OP_LOOK (cf. LookCode dans transport.ts).
enum LookDir : uint8_t {
  LOOK_CENTER = 0,
  LOOK_LEFT = 1,
  LOOK_RIGHT = 2,
  LOOK_UP = 3,
  LOOK_DOWN = 4,
};

// ─────────────────────────────────────────────────────────────────────────
//  Profil BLE. Cf. bleProfile.ts (mêmes chaînes exactes).
// ─────────────────────────────────────────────────────────────────────────
#define MOCHI_DEVICE_NAME "Mochi"
#define MOCHI_SERVICE_UUID "6d6f6368-c0de-4d43-9a11-000000000001"
#define MOCHI_COMMAND_UUID "6d6f6368-c0de-4d43-9a11-000000000002"
#define MOCHI_TELEMETRY_UUID "6d6f6368-c0de-4d43-9a11-000000000003"

// Console de tuning déportée (Tuning.cpp) — le MÊME protocole texte ligne par
// ligne que le moniteur série, transporté par BLE. Permet de régler l'équilibre
// sans câble USB : sur un pendule inversé, le câble tire sur le robot et fausse
// tous les essais. Le série reste actif en parallèle (boot, secours).
//   RX : app → robot, une ligne de commande (`d 66\n`), fragmentée si > MTU.
//   TX : robot → app, la sortie console, découpée en blocs de (MTU-3) octets.
#define MOCHI_CONSOLE_RX_UUID "6d6f6368-c0de-4d43-9a11-000000000004"
#define MOCHI_CONSOLE_TX_UUID "6d6f6368-c0de-4d43-9a11-000000000005"

// ─────────────────────────────────────────────────────────────────────────
//  Télémétrie (robot → app). Little-endian, packed, 9 octets. Cf. bleProfile.ts.
// ─────────────────────────────────────────────────────────────────────────
constexpr uint8_t TELEMETRY_VERSION = 1;
constexpr uint16_t SONAR_NO_ECHO = 0xFFFF;

enum RobotState : uint8_t {
  STATE_IDLE = 0,      // au repos, moteurs coupés
  STATE_BALANCING = 1, // équilibre actif
  STATE_FALLEN = 2,    // tombé → moteurs coupés
};

// Bits du champ `flags`.
constexpr uint8_t TELEM_FLAG_OBSTACLE = 0x01;
constexpr uint8_t TELEM_FLAG_MOTORS = 0x02;

#pragma pack(push, 1)
struct TelemetryPacket {
  uint8_t version;   // = TELEMETRY_VERSION
  uint8_t state;     // RobotState
  int16_t pitchCdeg; // inclinaison en centidegrés (°×100)
  int16_t wheelSpeed; // vitesse roues mm/s (signé)
  uint16_t distanceMm; // HC-SR04 (SONAR_NO_ECHO si pas d'écho)
  uint8_t flags;     // TELEM_FLAG_*
};
#pragma pack(pop)
static_assert(sizeof(TelemetryPacket) == 9, "TelemetryPacket doit faire 9 octets");
