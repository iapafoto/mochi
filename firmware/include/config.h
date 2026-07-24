// config.h — brochage + constantes mécaniques + réglages de la boucle.
//
// TOUT ce qui dépend du câblage physique ou du réglage (tuning) est ici, pour
// n'avoir qu'un seul fichier à éditer. Les broches suivent le schéma de câblage
// (docs/HARDWARE.md). ⚠️ ESP32 : GPIO34-39 sont ENTRÉE SEULE ; GPIO6-11 = flash
// (interdits) ; GPIO0/2/12/15 sont des broches de strap (éviter en sortie).

#pragma once
#include <Arduino.h>

// ─────────────────────────────────────────────────────────────────────────
//  BROCHAGE (voir docs/HARDWARE.md — table ESP32 ↔ modules)
// ─────────────────────────────────────────────────────────────────────────

// --- Bus I2C (MPU6050) ---
constexpr int PIN_I2C_SDA = 21;
constexpr int PIN_I2C_SCL = 22;

// --- Driver A4988 gauche ---
constexpr int PIN_L_STEP = 26;
constexpr int PIN_L_DIR = 27;

// --- Driver A4988 droit ---
constexpr int PIN_R_STEP = 25;
constexpr int PIN_R_DIR = 33;

// --- ENABLE commun aux deux A4988 (actif à l'état BAS) ---
constexpr int PIN_MOTOR_ENABLE = 14;

// --- Montage via CNC Shield V3 (option, cf. docs/HARDWARE.md) ---
// Le brochage ci-dessus ne change PAS : on relie chaque GPIO au bornier de
// signaux SÉRIGRAPHIÉ du shield (câbles DuPont ; ne PAS enficher l'ESP32).
// Correspondance (broches nommées, pas D2/D5) :
//   PIN_L_STEP(26)→X.STEP   PIN_L_DIR(27)→X.DIR   (socket X = roue gauche)
//   PIN_R_STEP(25)→Y.STEP   PIN_R_DIR(33)→Y.DIR   (socket Y = roue droite)
//   PIN_MOTOR_ENABLE(14)→EN            GND→GND
//   ⚠️ alimenter la logique des drivers en 3,3 V via la broche 5V du bornier
//      (5V/GND), PAS en 5 V, sinon les signaux 3,3 V de l'ESP32 sont marginaux.
//      Ne rien injecter d'autre en 5 V sur la carte.
//   12 V → bornier bleu 12-36V. Moteurs → headers 4 broches à côté des sockets
//   (pas les X+/X-/Y+/Y- = fins de course). Micro-pas 1/16 = 3 cavaliers/socket.

// --- HC-SR04 (ECHO via diviseur 5V→3.3V ; 35 est entrée-seule = idéal) ---
constexpr int PIN_SONAR_TRIG = 13;
constexpr int PIN_SONAR_ECHO = 35;

// --- LED d'état embarquée ---
constexpr int PIN_STATUS_LED = 2;

// Sens des moteurs : les deux roues sont montées en miroir. Si le robot
// « fuit » au lieu de se rattraper, inverser UN de ces deux booléens.
constexpr bool INVERT_LEFT = false;
constexpr bool INVERT_RIGHT = true;

// ─────────────────────────────────────────────────────────────────────────
//  MÉCANIQUE (roues Gotronic 84×24 mm + NEMA 17 1.8°, A4988 en 1/16)
// ─────────────────────────────────────────────────────────────────────────
constexpr int MOTOR_FULL_STEPS = 200;     // 1.8° → 200 pas/tour
constexpr int MICROSTEPS = 16;            // jumpers MS1/MS2/MS3 tous à HIGH
constexpr int STEPS_PER_REV = MOTOR_FULL_STEPS * MICROSTEPS; // 3200
constexpr float WHEEL_DIAMETER_MM = 84.0f;
constexpr float WHEEL_CIRCUM_MM = WHEEL_DIAMETER_MM * PI;    // ~263.9 mm
constexpr float STEPS_PER_MM = STEPS_PER_REV / WHEEL_CIRCUM_MM; // ~12.12
constexpr float WHEEL_BASE_MM = 150.0f;   // entraxe des roues (à mesurer sur ton châssis)

// ─────────────────────────────────────────────────────────────────────────
//  BOUCLE D'ÉQUILIBRE (à RÉGLER une fois le robot monté — cf. README §tuning)
// ─────────────────────────────────────────────────────────────────────────
constexpr float LOOP_HZ = 200.0f;         // fréquence de la boucle d'équilibre
constexpr float LOOP_DT = 1.0f / LOOP_HZ;

// Offset d'assiette : angle du MPU quand le robot est réellement à l'équilibre
// (jamais parfaitement 0 à cause du montage). À ajuster à ±0.1° près.
constexpr float BALANCE_OFFSET_DEG = 0.0f;

// PID de stabilité (boucle interne, rapide) : angle → accélération moteur.
// Valeurs issues du tuning live (essais 9-11, MPU remonté à l'endroit).
constexpr float KP_STAB = 15.0f;
constexpr float KI_STAB = 0.0f;
constexpr float KD_STAB = 35.0f;

// PID de vitesse (boucle externe, lente) : erreur de vitesse → angle de consigne.
// C'est lui qui fait « pencher pour avancer » et qui empêche la dérive.
// ⚠️ Trop fort, il claque la consigne d'angle en butée ±12° et couple les deux
// boucles (oscillation lente) : rester doux.
constexpr float KP_SPEED = 0.025f;
constexpr float KI_SPEED = 0.001f;

// Ancre de position : à l'engagement de l'équilibre, la position des steppers
// est mémorisée ; le robot revient doucement vers ce point au lieu de dériver
// (indispensable en test filaire : il reste à portée des fils).
constexpr float KP_POS = 0.4f;                // (mm/s de consigne) par mm d'écart
constexpr float POS_RETURN_MAX_MM_S = 100.0f; // vitesse max du retour à l'ancre

// Armement au boot : false = moteurs inhibés tant qu'on n'arme pas (console `m`).
// Garder false pendant la phase de tuning ; passer à true quand le robot est fiable.
constexpr bool BOOT_ARMED = false;

// Sécurité : au-delà de cet angle, on considère le robot tombé → moteurs coupés.
constexpr float FALL_LIMIT_DEG = 40.0f;
// Conditions de (re)démarrage de l'équilibre : le robot doit être à la fois
// proche de la verticale ET quasi immobile (sinon l'engagement est perdu
// d'avance — il partait dès 20° en plein mouvement).
constexpr float RECOVER_LIMIT_DEG = 5.0f;
constexpr float RECOVER_RATE_DEG_S = 30.0f;

// Rejet des lectures IMU corrompues. MPU6050_light::fetchData() ne teste PAS le
// retour de requestFrom() : sur timeout I2C (EMI des steppers sur SDA/SCL) elle
// lit du garbage, observé au run 16 comme des pics gyro fantômes de ±380°/s. Avec
// un KD fort, UN seul pic projette les roues à ±700 mm/s → emballement → chute.
// Un mouvement réel ne fait pas varier le gyro de plus de ~250°/s en un tick
// (5 ms, soit 50 000°/s²) : au-delà, l'échantillon est jeté et la boucle garde sa
// dernière consigne le temps d'un tick.
constexpr float GYRO_GLITCH_JUMP_DPS = 250.0f;
// Si l'IMU ment en continu (bus mort, nappe débranchée), tenir la dernière
// consigne indéfiniment serait dangereux : au-delà de N rejets d'affilée, on coupe.
constexpr uint16_t IMU_LOST_TICKS = 20; // 20 × 5 ms = 100 ms

// Sécurité anti-emballement : en équilibre au sol, l'ancre de position borne la
// course à quelques centimètres. Une dérive massive = roues dans le vide (robot
// suspendu aux longes / soulevé) ou emballement après un glitch → on coupe. Évite
// aussi de compter ces épisodes comme du « vrai » équilibre dans les mesures.
constexpr float RUNAWAY_LIMIT_MM = 400.0f;

// Bornes moteur. ⚠️ Une accélération trop forte fait SAUTER DES PAS (la vitesse
// réelle décroche de la commande → le contrôleur devient aveugle). Valeurs
// prudentes pour la phase de tuning ; à remonter ensuite si les moteurs suivent.
constexpr float MAX_WHEEL_SPEED_MM_S = 700.0f; // vitesse linéaire max d'une roue
// Le robot (25 cm) chute avec une constante de temps ~0.12 s : les roues doivent
// inverser leur vitesse plus vite que ça, sinon chaque correction arrive en retard
// et nourrit l'oscillation. Si les moteurs sautent des pas, redescendre.
constexpr float MAX_ACCEL_STEPS_S2 = 56000.0f; // accélération FastAccelStepper (~4.6 m/s²)

// Vitesses des déplacements pilotés (FORWARD/BACKWARD/TURN).
constexpr float CRUISE_SPEED_MM_S = 180.0f;    // vitesse de croisière d'un déplacement
constexpr float TURN_RATE_DEG_S = 90.0f;       // vitesse de rotation sur place

// ─────────────────────────────────────────────────────────────────────────
//  ORDONNANCEMENT (cœurs FreeRTOS)
// ─────────────────────────────────────────────────────────────────────────
constexpr BaseType_t CORE_BALANCE = 1; // boucle temps réel (comme loop() Arduino)
constexpr BaseType_t CORE_COMMS = 0;   // BLE + sonar
constexpr uint32_t TELEMETRY_PERIOD_MS = 100; // 10 Hz de notifications
constexpr uint32_t SONAR_PERIOD_MS = 60;      // période de ping HC-SR04
