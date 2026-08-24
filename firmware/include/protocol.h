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
  // ALLURE (3e octet, OPTIONNEL) : % de la croisière odométrique de référence
  // (ODO_MOVE_SPEED_MM_S / ODO_TURN_SPEED_DEG_S). Absent ou 0 ⇒ 100 %, donc le
  // comportement d'avant, à l'octet près — les mesures de banc restent valides.
  // ⚠️ POURQUOI ON PEUT SE PERMETTRE DE FAIRE VARIER CETTE VITESSE-LÀ, alors que
  // config.h dit qu'elle est « une mesure, pas un réglage de goût » : ces
  // déplacements terminent sur l'ODOMÉTRIE, pas au chronomètre. Le seul paramètre
  // qui dépendait de la vitesse était l'anticipation de freinage, et elle
  // s'exprime déjà en `cruise × τ` (odoMoveTick) — elle se mettait donc à
  // l'échelle toute seule. τ, lui, est une propriété du robot. Ce qui resterait
  // faux à haute vitesse, c'est le dépassement RÉSIDUEL, et il n'entache rien :
  // l'odométrie compte ce qui a été parcouru, dépassement compris.
  // Borné à `P`/`R` côté firmware : le fond de course reste le fond de course.
  OP_FORWARD = 0x01,  // int16 cm  [+ uint8 allure %]   avance de N cm
  OP_BACKWARD = 0x02, // int16 cm  [+ uint8 allure %]   recule de N cm
  OP_TURN = 0x03,     // int16 deg [+ uint8 allure %]   pivote (+ = droite)
  // Téléguidage CONTINU (manette / joystick / pad du banc). Payload :
  //   int8 speed   −100..+100 = % de TELEOP_MAX_SPEED_MM_S (+ = avant)
  //   int8 steer   −100..+100 = % de TELEOP_MAX_TURN_DEG_S (+ = droite)
  //   uint8 ttl    durée de validité en pas de 10 ms (0 = TELEOP_TTL_MS)
  // ⚠️ POURQUOI DES POURCENTS ET PAS DES mm/s : le plafond reste UN SEUL endroit
  // (config.h). Rendre le robot plus doux ne demande alors pas de retoucher les
  // trois pilotes (app, banc, manette), qui envoient tous « fond de course ».
  // ⚠️ POURQUOI UN TTL (l'homme mort) : la commande n'est pas un ordre ponctuel
  // mais un ÉTAT, qu'il faut donc rafraîchir (~10 Hz). Si le lien tombe manette
  // poussée, le robot s'arrête tout seul au lieu de partir droit devant. Le
  // B-Robot, piloté en OSC/WiFi, n'a pas ce garde-fou : ses faders gardent leur
  // dernière valeur, et il continue.
  OP_DRIVE = 0x04,    // int8 %v, int8 %rot, uint8 ttl×10ms
  OP_NOD = 0x10,      // —              hoche (oui)
  OP_BOW = 0x11,      // —              révérence
  OP_WIGGLE = 0x12,   // —              se dandine
  OP_LOOK = 0x20,     // int8 dir       coup d'œil (petit pivot) — cf. LookCode
  OP_CALIBRATE = 0x30, // —             recalibre l'IMU (robot immobile+vertical, ~2 s, moteurs coupés)
  // ⚠️ ARMEMENT EXPLICITE. Le robot démarre DÉSARMÉ (BOOT_ARMED = false) : sans cet
  // ordre, un déplacement reçu par BLE est accepté, calculé… et ne fait rien, parce que
  // update() garde les moteurs coupés. Jusqu'ici seule la console `m` armait — l'app
  // était donc condamnée à un robot muet qu'aucun message d'erreur n'expliquait.
  // Désarmer stoppe AUSSI le déplacement en cours : une consigne qui survivrait à la
  // coupure repartirait telle quelle au réarmement suivant.
  OP_ARM = 0x31,      // uint8 0/1      1 = arme les moteurs, 0 = désarme (et stoppe)
  // --- ZÉRO D'ASSIETTE (le point d'équilibre). Équivalents BLE de `z`, `Z`, `w`.
  // Deux façons de le trouver, et elles ne se valent pas :
  //   ZERO_HERE  — rapide, robot en main : « cette pose EST le zéro ». Vaut ce que
  //                vaut la main qui tient (1 à 3°). C'est un dépannage.
  //   ZERO_ADOPT — lent, robot debout : adopte ce que ∫θ compense en permanence, donc
  //                ce que le ROBOT a mesuré lui-même après ~30 s d'équilibre calme.
  //                C'est la méthode qui a donné BALANCE_OFFSET_DEG à 0,06° près.
  // Ni l'un ni l'autre ne survit au reboot sans SAVE.
  OP_ZERO_HERE = 0x32,  // —            la pose actuelle devient 0° (console `z`)
  OP_ZERO_ADOPT = 0x33, // —            adopte le zéro suggéré par ∫θ (console `Z`)
  OP_SAVE = 0x34,       // —            persiste les réglages en NVS (console `w`)
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
// ⚠️ ARMÉ ≠ MOTEURS ALIMENTÉS, et confondre les deux trompe l'app. Un robot armé
// mais couché a ses moteurs coupés (cutMotors) et va se rengager tout seul dès qu'on
// le relève : afficher « désarmé » dans cet état ferait cliquer « Armer » pour rien,
// et le clic suivant le désarmerait pour de bon.
constexpr uint8_t TELEM_FLAG_ARMED = 0x04;
// ⚠️ LE BIT QUI PERMET D'ENCHAÎNER DEUX DÉPLACEMENTS. Un déplacement mesuré se
// termine sur l'odométrie, donc sa DURÉE n'est connue de personne à l'avance — ni
// de l'app, ni du robot. Sans ce bit, un émetteur qui veut « avance puis recule »
// n'a que le chronomètre pour deviner quand envoyer le second ordre, et s'il se
// trompe le second ANNULE le premier en silence (startOdoMove écrase la cible).
// Il couvre tout le déplacement, stabilisation comprise : c'est bien « je suis
// occupé », pas « mes roues tournent ».
constexpr uint8_t TELEM_FLAG_MOVING = 0x08;

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
