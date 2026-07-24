// pin_scan.cpp — scanner de câblage : pulse chaque GPIO un par un pour
// identifier quel fil arrive réellement sur quelle entrée du CNC Shield.
// Compiler/flasher avec :  pio run -e pinscan -t upload   puis  pio device monitor
//
// Principe : tous les GPIO candidats sont maintenus BAS (EN bas = drivers
// actifs, DIR bas = un sens fixe). Puis chacun est pulsé 3 s à 800 Hz, en
// boucle. Un GPIO branché sur une entrée STEP fait TOURNER un moteur
// (~0.75 tour en 1/16). Un GPIO sur DIR ou EN ne fait rien bouger.
// → Note quel moteur tourne pendant quelle phase, et on en déduit le câblage.
//
// Pas besoin du moniteur série : compte les phases après le double
// clignotement de la LED bleue (GPIO2) qui marque le début d'un cycle.

#include <Arduino.h>

const int PINS[] = {26, 27, 25, 33, 14};
const char *ROLES[] = {"attendu X.STEP (gauche)", "attendu X.DIR",
                       "attendu Y.STEP (droite)", "attendu Y.DIR",
                       "attendu EN"};
constexpr int N_PINS = 5;
constexpr int LED = 2;

constexpr uint32_t PULSE_HZ = 800;      // vitesse de scan (lent = bien visible)
constexpr uint32_t PHASE_MS = 3000;     // durée de pulse par GPIO
constexpr uint32_t PAUSE_MS = 1200;     // silence entre deux phases

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== Scanner de cablage steppers — Mochi ===");
  Serial.println("Tous les GPIO bas (EN actif). Chaque GPIO est pulse 3 s.");
  Serial.println("=> NOTE quel moteur tourne pendant quelle phase !\n");

  pinMode(LED, OUTPUT);
  for (int i = 0; i < N_PINS; i++) {
    pinMode(PINS[i], OUTPUT);
    digitalWrite(PINS[i], LOW);
  }
  delay(1500); // laisser les drivers s'activer (EN bas)
}

void loop() {
  // Double clignotement LED = debut d'un cycle complet
  for (int k = 0; k < 2; k++) {
    digitalWrite(LED, HIGH); delay(150);
    digitalWrite(LED, LOW);  delay(150);
  }
  Serial.println("--- Debut du cycle de scan ---");

  for (int i = 0; i < N_PINS; i++) {
    Serial.printf("Phase %d : pulse GPIO %d (%s)\n", i + 1, PINS[i], ROLES[i]);
    digitalWrite(LED, HIGH); // LED allumee pendant toute la phase active
    uint32_t t0 = millis();
    uint32_t half = 500000 / PULSE_HZ; // demi-periode en µs
    while (millis() - t0 < PHASE_MS) {
      digitalWrite(PINS[i], HIGH); delayMicroseconds(half);
      digitalWrite(PINS[i], LOW);  delayMicroseconds(half);
    }
    digitalWrite(LED, LOW);
    delay(PAUSE_MS);
  }
  Serial.println("--- Fin du cycle. On recommence. ---\n");
  delay(1500);
}
