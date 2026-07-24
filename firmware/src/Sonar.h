// Sonar.h — HC-SR04, mesure bloquante à timeout. Tourne sur le CŒUR 0
// (tâche comms) : le blocage éventuel n'impacte PAS la boucle d'équilibre.

#pragma once
#include <Arduino.h>
#include "config.h"
#include "protocol.h"

class Sonar {
 public:
  void begin() {
    pinMode(PIN_SONAR_TRIG, OUTPUT);
    pinMode(PIN_SONAR_ECHO, INPUT);
    digitalWrite(PIN_SONAR_TRIG, LOW);
  }

  // Retourne la distance en mm, ou SONAR_NO_ECHO si aucun écho (timeout ~4,3 m).
  uint16_t readMm() {
    digitalWrite(PIN_SONAR_TRIG, LOW);
    delayMicroseconds(3);
    digitalWrite(PIN_SONAR_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(PIN_SONAR_TRIG, LOW);

    unsigned long us = pulseIn(PIN_SONAR_ECHO, HIGH, 25000UL); // 25 ms ≈ 4,3 m
    if (us == 0) return SONAR_NO_ECHO;
    // distance = temps × vitesse du son / 2. 0.343 mm/µs → aller-retour ×0.1715.
    float mm = us * 0.1715f;
    if (mm > 4000.0f) return SONAR_NO_ECHO;
    return (uint16_t)mm;
  }
};
