// allpins_test.cpp — envoie les MEMES signaux sur X et Y : STEP identique sur
// GPIO 25+26, DIR identique sur GPIO 27+33, EN(14) bas. Peu importe comment
// les fils sont croisés entre X et Y, tout moteur branché doit tourner.
// Boucle : 5 s sens A (LED allumée), 5 s sens B (LED éteinte), à 800 Hz
// (~0.25 tr/s en 1/16 → rotation lente et bien visible).
// Compiler/flasher avec :  pio run -e allpins -t upload

#include <Arduino.h>

const int STEP_PINS[] = {25, 26};
const int DIR_PINS[] = {27, 33};
constexpr int PIN_EN = 14;
constexpr int LED = 2;

constexpr uint32_t PULSE_HZ = 800;
constexpr uint32_t PHASE_MS = 5000;

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== Test 'tout pareil' X+Y — Mochi ===");
  Serial.println("STEP sur 25+26, DIR sur 27+33, EN(14) bas. 5 s par sens.");

  pinMode(LED, OUTPUT);
  pinMode(PIN_EN, OUTPUT);
  digitalWrite(PIN_EN, LOW); // drivers actifs
  for (int p : STEP_PINS) { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
  for (int p : DIR_PINS)  { pinMode(p, OUTPUT); digitalWrite(p, LOW); }
  delay(1000);
}

static void spin(bool dir) {
  Serial.printf("Sens %s pendant 5 s...\n", dir ? "B" : "A");
  digitalWrite(LED, dir ? LOW : HIGH);
  for (int p : DIR_PINS) digitalWrite(p, dir ? HIGH : LOW);
  delayMicroseconds(5);
  uint32_t half = 500000 / PULSE_HZ;
  uint32_t t0 = millis();
  while (millis() - t0 < PHASE_MS) {
    for (int p : STEP_PINS) digitalWrite(p, HIGH);
    delayMicroseconds(half);
    for (int p : STEP_PINS) digitalWrite(p, LOW);
    delayMicroseconds(half);
  }
}

void loop() {
  spin(false);
  spin(true);
}
