// stepper_test.cpp — test autonome des 2 steppers via CNC Shield (câblage Mochi).
// Compiler/flasher avec :  pio run -e steppertest -t upload   puis  pio device monitor
//
// Séquence auto au démarrage : roue GAUCHE 1 tour avant/arrière, roue DROITE
// 1 tour avant/arrière, puis les DEUX ensemble. Ensuite, commandes série :
//   l / r : N tours avant gauche / droite      L / R : N tours arrière
//   b     : les deux, N tours avant            B     : les deux, arrière
//   c     : rotation CONTINUE des deux roues   s     : stop immédiat
//   + / - : vitesse x2 / :2
//   e     : toggle ENABLE (relâche/alimente les moteurs)
//
// Diagnostic : si un moteur vibre sans tourner → DIR pas connecté ou courant
// trop faible (potentiomètre A4988). S'il ne bouge pas du tout → STEP ou EN.

#include <Arduino.h>
#include <FastAccelStepper.h>
#include "config.h"

FastAccelStepperEngine engine;
FastAccelStepper *stepL = nullptr;
FastAccelStepper *stepR = nullptr;

uint32_t speedHz = 1600;   // 0.5 tr/s en 1/16 (3200 pas/tour)
bool motorsEnabled = true;
constexpr int TEST_REVS = 5; // nb de tours par mouvement de test

static void setEnable(bool on) {
  motorsEnabled = on;
  digitalWrite(PIN_MOTOR_ENABLE, on ? LOW : HIGH); // actif à l'état BAS
  Serial.printf("ENABLE %s (moteurs %s)\n", on ? "LOW" : "HIGH",
                on ? "alimentes" : "libres");
}

static void applySpeed() {
  stepL->setSpeedInHz(speedHz);
  stepR->setSpeedInHz(speedHz);
  Serial.printf("vitesse = %lu pas/s (%.2f tr/s)\n",
                (unsigned long)speedHz, speedHz / (float)STEPS_PER_REV);
}

// N tours complets (bloquant), signe = sens. inv applique le miroir mécanique.
static void revs(FastAccelStepper *s, const char *name, int dir, bool inv) {
  int32_t steps = (inv ? -dir : dir) * STEPS_PER_REV * TEST_REVS;
  Serial.printf("  %s : %d tours %s...", name, TEST_REVS,
                dir > 0 ? "AVANT" : "ARRIERE");
  s->move(steps);
  while (s->isRunning()) delay(10);
  Serial.println(" fini");
}

static void bothRevs(int dir) {
  Serial.printf("  LES DEUX : %d tours %s...", TEST_REVS,
                dir > 0 ? "AVANT" : "ARRIERE");
  stepL->move((INVERT_LEFT ? -dir : dir) * STEPS_PER_REV * TEST_REVS);
  stepR->move((INVERT_RIGHT ? -dir : dir) * STEPS_PER_REV * TEST_REVS);
  while (stepL->isRunning() || stepR->isRunning()) delay(10);
  Serial.println(" fini");
}

// Rotation continue (non bloquant) — arrêt avec 's'.
static void continuous() {
  Serial.println("  CONTINU : les deux roues, sens 'avance' — 's' pour stop");
  if (INVERT_LEFT) stepL->runBackward(); else stepL->runForward();
  if (INVERT_RIGHT) stepR->runBackward(); else stepR->runForward();
}

static void autoSequence() {
  Serial.printf("\n--- Sequence automatique (%d tours par mouvement) ---\n", TEST_REVS);
  revs(stepL, "GAUCHE (X)", +1, INVERT_LEFT);
  delay(400);
  revs(stepL, "GAUCHE (X)", -1, INVERT_LEFT);
  delay(400);
  revs(stepR, "DROITE (Y)", +1, INVERT_RIGHT);
  delay(400);
  revs(stepR, "DROITE (Y)", -1, INVERT_RIGHT);
  delay(400);
  bothRevs(+1);
  Serial.println("--- Sequence terminee. Commandes: l r L R b B c + - s e ---");
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== Test steppers (CNC Shield) — Mochi ===");
  Serial.printf("L: STEP=%d DIR=%d | R: STEP=%d DIR=%d | EN=%d\n",
                PIN_L_STEP, PIN_L_DIR, PIN_R_STEP, PIN_R_DIR, PIN_MOTOR_ENABLE);

  pinMode(PIN_MOTOR_ENABLE, OUTPUT);
  setEnable(true);

  engine.init();
  stepL = engine.stepperConnectToPin(PIN_L_STEP);
  stepR = engine.stepperConnectToPin(PIN_R_STEP);
  if (!stepL || !stepR) {
    Serial.println("ECHEC stepperConnectToPin ! (pin STEP invalide ?)");
    while (true) delay(1000);
  }
  stepL->setDirectionPin(PIN_L_DIR);
  stepR->setDirectionPin(PIN_R_DIR);
  stepL->setAcceleration((uint32_t)MAX_ACCEL_STEPS_S2);
  stepR->setAcceleration((uint32_t)MAX_ACCEL_STEPS_S2);
  applySpeed();

  delay(1000); // le temps d'ouvrir le moniteur / poser le robot roues en l'air
  autoSequence();
}

void loop() {
  if (!Serial.available()) { delay(20); return; }
  char c = Serial.read();
  switch (c) {
    case 'l': revs(stepL, "GAUCHE", +1, INVERT_LEFT); break;
    case 'L': revs(stepL, "GAUCHE", -1, INVERT_LEFT); break;
    case 'r': revs(stepR, "DROITE", +1, INVERT_RIGHT); break;
    case 'R': revs(stepR, "DROITE", -1, INVERT_RIGHT); break;
    case 'b': bothRevs(+1); break;
    case 'B': bothRevs(-1); break;
    case 'c': continuous(); break;
    case '+': speedHz = min<uint32_t>(speedHz * 2, 12800); applySpeed(); break;
    case '-': speedHz = max<uint32_t>(speedHz / 2, 100); applySpeed(); break;
    case 's': stepL->forceStop(); stepR->forceStop(); Serial.println("STOP"); break;
    case 'e': setEnable(!motorsEnabled); break;
    default: break; // ignore \r\n etc.
  }
}
