// main.cpp — point d'entrée Mochi (ESP32).
//
//   CŒUR 1 : balanceTask — boucle d'équilibre à LOOP_HZ (temps réel, priorité haute).
//   CŒUR 0 : commsTask   — ping HC-SR04 + notifications de télémétrie ; NimBLE tourne
//            aussi sur le cœur 0 (les commandes arrivent dans son contexte).
//
// setup() prépare le matériel puis lance les deux tâches. loop() reste inactif.

#include <Arduino.h>
#include <Wire.h>
#include <FastAccelStepper.h>
#include <MPU6050_light.h>

#include "config.h"
#include "protocol.h"
#include "Balance.h"
#include "BleBridge.h"
#include "Console.h"
#include "Sonar.h"
#include "Tuning.h"

// Seuil de détection d'obstacle pour le bit de télémétrie (mm).
constexpr uint16_t OBSTACLE_THRESHOLD_MM = 250;

static FastAccelStepperEngine engine = FastAccelStepperEngine();
static FastAccelStepper* stepperL = nullptr;
static FastAccelStepper* stepperR = nullptr;
static MPU6050 mpu(Wire);
static Balance balance;
static BleBridge ble;
static Sonar sonar;
static Console console; // console de tuning : série + BLE en parallèle
static Tuning tuning;

// Dernière distance mesurée (écrite par commsTask, lue pour la télémétrie).
static volatile uint16_t lastDistanceMm = SONAR_NO_ECHO;

// ─────────────────────────────────────────────────────────────────────────
//  CŒUR 1 — boucle d'équilibre, cadence fixe
// ─────────────────────────────────────────────────────────────────────────
static void balanceTask(void*) {
  const TickType_t periodTicks = pdMS_TO_TICKS((uint32_t)(LOOP_DT * 1000.0f + 0.5f));
  TickType_t last = xTaskGetTickCount();
  for (;;) {
    balance.update();
    vTaskDelayUntil(&last, periodTicks);
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  CŒUR 0 — sonar + télémétrie BLE
// ─────────────────────────────────────────────────────────────────────────
static void commsTask(void*) {
  uint32_t lastSonar = 0;
  uint32_t lastTelem = 0;
  for (;;) {
    const uint32_t now = millis();

    tuning.poll();   // console de réglage (gains, axe, offset, stream) — série + BLE
    console.pump();  // écoule la sortie console vers le client BLE abonné

    if (now - lastSonar >= SONAR_PERIOD_MS) {
      lastSonar = now;
      lastDistanceMm = sonar.readMm();
    }

    if (now - lastTelem >= TELEMETRY_PERIOD_MS) {
      lastTelem = now;
      TelemetryPacket p = balance.telemetry();
      const uint16_t d = lastDistanceMm;
      p.distanceMm = d;
      if (d != SONAR_NO_ECHO && d < OBSTACLE_THRESHOLD_MM) p.flags |= TELEM_FLAG_OBSTACLE;
      ble.notifyTelemetry(p);
    }

    // LED d'état : clignote VITE pendant une capture de tuning (repère visuel pour
    // les manips), fixe si BLE connecté, clignote lentement sinon.
    if (tuning.streaming()) digitalWrite(PIN_STATUS_LED, (now / 100) % 2);
    else digitalWrite(PIN_STATUS_LED, ble.connected() ? HIGH : (now / 500) % 2);

    vTaskDelay(pdMS_TO_TICKS(10));
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("[Mochi] boot");

  pinMode(PIN_MOTOR_ENABLE, OUTPUT);
  digitalWrite(PIN_MOTOR_ENABLE, HIGH); // moteurs coupés au démarrage (actif BAS)
  pinMode(PIN_STATUS_LED, OUTPUT);

  // --- IMU ---
  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
  // 100 kHz et pas 400 : les A4988 rayonnent sur SDA/SCL (câbles DuPont, montage
  // léger) et le bus lâchait ~15 fois par run à 400 kHz (`requestFrom Error 263`),
  // chaque timeout injectant un gyro fantôme qui projetait les roues à fond.
  // Marge de bruit ×4 pour ~1,3 ms de lecture, largement tenable à 200 Hz.
  Wire.setClock(100000);
  // ⚠️ TIMEOUT I2C COURT (22/08) — piste de « l'absence » du robot.
  // Le défaut du Wire ESP32 est de 50 ms. Une transaction bloquée (esclave qui tient
  // SDA bas après un parasite des A4988) fige donc la boucle d'équilibre pendant DIX
  // tours : les roues gardent leur dernière consigne, personne ne corrige, et le
  // robot part exactement comme si l'alimentation moteur avait lâché. À 100 kHz une
  // lecture de 14 octets prend ~1,3 ms : 5 ms laissent une marge ×4 et garantissent
  // qu'un incident coûte AU PIRE un tour de boucle au lieu de dix.
  // L'échantillon perdu est déjà géré : c'est le chemin « glitch » de Balance.
  // Se vérifie avec `late=`/`pire=` dans `g` — s'ils grimpent, le bus est en cause.
  Wire.setTimeOut(5);
  // ⚠️ GYRO EN ±250 °/s (config 0), PAS le défaut ±500 de la lib (config 1).
  // Mesuré le 13/08 : à `y 0.95` (accéléro seul) l'angle est juste, à `y 0.9995`
  // (gyro seul) il est exagéré ×~2 → les vitesses angulaires étaient doublées.
  // Cause : beaucoup de MPU6050 clones IGNORENT GYRO_CONFIG et restent à ±250,
  // pendant que la lib divise par 65,5 (la valeur du ±500). 131/65,5 = 2.
  // Demander explicitement le ±250 (diviseur 131) redonne une échelle correcte
  // DANS LES DEUX CAS — puce authentique comme clone bloqué. Contrepartie : la
  // plage sature à 250 °/s, ce qui n'arrive qu'en pleine chute (déjà perdue).
  // Si l'échelle reste fausse, la console `G` permet de la corriger en direct.
  byte status = mpu.begin(/*gyro=±250°/s*/ 0, /*accel=±2g*/ 0);
  Serial.printf("[Mochi] MPU6050 status=%d\n", status);
  // Filtre passe-bas MATERIEL du MPU (DLPF, registre CONFIG 0x1A) : coupe les
  // vibrations des steppers à ~44 Hz dans la puce, avant la fusion d'angle.
  // Sans lui, l'accelerometre rend l'angle inutilisable moteurs en marche.
  // Réglable EN DIRECT ensuite via la console `D` (Balance l'écrit depuis le cœur 1).
  Wire.beginTransmission(0x68);
  Wire.write(0x1A);
  Wire.write(MPU_DLPF_CFG); // 3 = accel 44 Hz / gyro 42 Hz ; 5 = 10 Hz (réglage B-Robot)
  Wire.endTransmission();
  Serial.println("[Mochi] calibration gyro — garder le robot IMMOBILE (pose libre)...");
  delay(1000);
  // Gyro seul : ne demande que l'immobilité. La calibration COMPLETE (gyro+accel,
  // robot tenu vertical) se déclenche volontairement : console `c` ou opcode BLE.
  mpu.calcOffsets(/*gyro=*/true, /*accel=*/false);
  // Poids du gyro dans la fusion d'angle : désormais piloté par Balance
  // (applyDefaultTuning charge FILTER_GYRO_COEF de config.h, réglable en direct via la
  // console `y`, persisté en NVS). Cf. config.h pour le compromis dérive/pollution.
  Serial.println("[Mochi] IMU OK");

  // --- Steppers ---
  engine.init();
  stepperL = engine.stepperConnectToPin(PIN_L_STEP);
  stepperR = engine.stepperConnectToPin(PIN_R_STEP);
  if (!stepperL || !stepperR) {
    Serial.println("[Mochi] ERREUR : stepper non connecté (broche STEP invalide ?)");
    while (true) delay(1000);
  }
  stepperL->setDirectionPin(PIN_L_DIR);
  stepperR->setDirectionPin(PIN_R_DIR);
  stepperL->setAutoEnable(false); // ENABLE géré manuellement (broche commune)
  stepperR->setAutoEnable(false);

  balance.begin(stepperL, stepperR, &mpu);
  console.begin(&ble);
  tuning.begin(&balance, console); // après balance.begin() : la NVS écrase les défauts
  sonar.begin();
  ble.begin(&balance, &console);
  Serial.println("[Mochi] BLE advertising — pret a se connecter (app + console de tuning)");

  xTaskCreatePinnedToCore(balanceTask, "balance", 4096, nullptr, 5, nullptr, CORE_BALANCE);
  xTaskCreatePinnedToCore(commsTask, "comms", 4096, nullptr, 3, nullptr, CORE_COMMS);
}

void loop() {
  vTaskDelay(pdMS_TO_TICKS(1000)); // tout le travail est dans les tâches
}
