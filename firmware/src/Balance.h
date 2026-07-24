// Balance.h — contrôleur d'équilibre du pendule inversé + exécuteur d'intentions.
//
// update() tourne à LOOP_HZ sur le CŒUR 1 (temps réel). onCommand() est appelé
// depuis la tâche BLE sur le CŒUR 0 : les échanges se font via de petits champs
// protégés par un spinlock (portMUX). Aucune allocation dans la boucle.

#pragma once
#include <Arduino.h>
#include <FastAccelStepper.h>
#include <MPU6050_light.h>
#include "config.h"
#include "protocol.h"

class Balance {
 public:
  void begin(FastAccelStepper* left, FastAccelStepper* right, MPU6050* mpu);

  // Boucle temps réel (cœur 1). À appeler à cadence fixe (LOOP_DT).
  void update();

  // Réception d'une commande app (cœur 0). payload = octets après l'opcode.
  void onCommand(uint8_t op, const uint8_t* payload, size_t len);

  // Snapshot thread-safe pour la télémétrie (cœur 0).
  TelemetryPacket telemetry() const;

  // --- Réglage en live (console série, cœur 0) ---
  // Les écritures de float 32 bits alignés sont atomiques sur ESP32 : les
  // setters ci-dessous peuvent être appelés depuis le cœur 0 sans verrou.
  void applyDefaultTuning();            // recharge les constantes de config.h
  void setKpStab(float v) { kpStab_ = v; }
  void setKdStab(float v) { kdStab_ = v; }
  void setKpSpeed(float v) { kpSpeed_ = v; }
  void setKiSpeed(float v) { kiSpeed_ = v; }
  void setKpPos(float v) { kpPos_ = v; }
  void setOffsetDeg(float v) { offsetDeg_ = v; }
  void zeroOffsetHere() { offsetDeg_ = offsetDeg_ + pitchDeg_; } // pose actuelle = 0°
  void setPitchAxis(uint8_t axis, int8_t sign) { pitchAxis_ = axis; pitchSign_ = sign; }
  void setRateSign(int8_t s) { rateSign_ = s; } // correctif signe gyro (montage inversé)
  int8_t rateSign() const { return rateSign_; }
  float gyroRateDps() const { return lastGyroRate_; } // vitesse angulaire utilisée (deg/s)
  void setInvertLeft(bool v) { invertLeft_ = v; }
  void setInvertRight(bool v) { invertRight_ = v; }
  void setArmed(bool on);               // false = moteurs coupés (banc d'essai)
  // Test roues en boucle ouverte (console `j`, seulement si désarmé) : fait
  // tourner les deux roues à vitesse constante, sans équilibre. 0 = stop.
  void setJog(float mmS) { jogMmS_ = constrain(mmS, -300.0f, 300.0f); }
  float jog() const { return jogMmS_; }
  // Recalibration IMU à la demande (console `c` ou opcode BLE). Exécutée par la
  // boucle du cœur 1 (moteurs coupés, ~2 s, robot immobile et vertical requis).
  void requestImuCalibration() { calibRequest_ = true; }
  // Recalibration du gyro SEUL (console `b`) : pose libre, immobilité suffit —
  // poser le robot au sol, sans les mains. Corrige la dérive thermique du biais.
  void requestGyroCalibration() { gyroCalibRequest_ = true; }

  float kpStab() const { return kpStab_; }
  float kdStab() const { return kdStab_; }
  float kpSpeed() const { return kpSpeed_; }
  float kiSpeed() const { return kiSpeed_; }
  float kpPos() const { return kpPos_; }
  // Distance parcourue depuis l'ancre de position (mm, + = avant). Lisible du
  // cœur 0 (getCurrentPosition est une simple lecture).
  float traveledMm() const {
    return (forwardSteps() - posAnchorSteps_) / STEPS_PER_MM;
  }
  float offsetDeg() const { return offsetDeg_; }
  uint8_t pitchAxis() const { return pitchAxis_; }
  int8_t pitchSign() const { return pitchSign_; }
  bool invertLeft() const { return invertLeft_; }
  bool invertRight() const { return invertRight_; }
  bool armed() const { return armed_; }
  float pitchDeg() const { return pitchDeg_; }
  // Angles bruts du MPU (pour identifier l'axe de tangage depuis la console).
  float rawAngleX() const { return mpu_ ? mpu_->getAngleX() : 0.0f; }
  float rawAngleY() const { return mpu_ ? mpu_->getAngleY() : 0.0f; }
  float targetDeg() const { return lastTargetDeg_; }
  float wheelMmS() const { return motorSpeedMmS_; }
  uint8_t state() const { return state_; }
  // Nombre d'échantillons IMU rejetés depuis le boot (timeouts I2C). Doit rester
  // proche de 0 : s'il grimpe, le bus est bruité (câblage/EMI), pas les gains.
  uint32_t glitchCount() const { return glitchCount_; }

 private:
  void applyWheels(float leftMmS, float rightMmS);
  void setMotorsEnabled(bool on);
  void resetControl();
  // Position « robot » moyenne des deux roues, en pas signés (+ = avant).
  int32_t forwardSteps() const {
    const int32_t l = left_ ? left_->getCurrentPosition() : 0;
    const int32_t r = right_ ? right_->getCurrentPosition() : 0;
    return ((invertLeft_ ? -l : l) + (invertRight_ ? -r : r)) / 2;
  }
  void startTimedMotion(float speedMmS, float steerDegS, uint32_t durationMs);
  void triggerGesture(uint8_t op);
  float gestureAngleBias(uint32_t nowMs); // non-const : efface gestureOp_ en fin de geste
  float gestureSteerBias(uint32_t nowMs);

  FastAccelStepper* left_ = nullptr;
  FastAccelStepper* right_ = nullptr;
  MPU6050* mpu_ = nullptr;
  long lastSpsL_ = 0; // dernières consignes envoyées aux drivers (évite de
  long lastSpsR_ = 0; // recommander/recalculer les rampes à 200 Hz sans besoin)

  // --- État de contrôle (cœur 1) ---
  uint8_t state_ = STATE_IDLE;
  bool motorsOn_ = false;
  float pitchDeg_ = 0.0f;      // inclinaison filtrée
  float lastTargetDeg_ = 0.0f; // dernier angle de consigne (pour la console)
  float motorSpeedMmS_ = 0.0f; // vitesse intégrée (sortie boucle stabilité)
  float speedInteg_ = 0.0f;    // intégrateur du PID de vitesse

  // --- Réglages à chaud (écrits cœur 0 par la console, lus cœur 1) ---
  volatile float kpStab_ = 0.0f;   // initialisés depuis config.h dans begin()
  volatile float kdStab_ = 0.0f;
  volatile float kpSpeed_ = 0.0f;
  volatile float kiSpeed_ = 0.0f;
  volatile float kpPos_ = 0.0f;    // rappel vers l'ancre de position (0 = off)
  int32_t posAnchorSteps_ = 0;     // position mémorisée à l'engagement (pas)
  volatile float offsetDeg_ = 0.0f;
  volatile uint8_t pitchAxis_ = 0; // 0 = getAngleX, 1 = getAngleY
  volatile int8_t pitchSign_ = 1;  // +1 / -1 : sens « penche en avant = positif »
  volatile int8_t rateSign_ = 1;   // +1 / -1 : signe du gyro vs l'angle (montage)
  float lastGyroRate_ = 0.0f;      // dernière vitesse angulaire utilisée (deg/s)
  volatile bool invertLeft_ = false;  // sens roue gauche (défaut : config.h)
  volatile bool invertRight_ = false; // sens roue droite
  volatile bool armed_ = true;     // false = équilibre inhibé, moteurs coupés
  volatile float jogMmS_ = 0.0f;   // test boucle ouverte (actif si désarmé)
  volatile bool calibRequest_ = false; // demande de recalibration IMU (cœur 0 → cœur 1)
  volatile bool gyroCalibRequest_ = false; // recalibration gyro seule (pose libre)
  // Apprentissage continu du biais gyro (dérive thermique) : moteurs coupés et
  // rotation quasi nulle ≥3 s → le résidu lu est replié dans les offsets du MPU.
  float biasEstX_ = 0.0f;
  float biasEstY_ = 0.0f;
  uint16_t biasSamples_ = 0;
  uint32_t settleUntilMs_ = 0; // équilibre inhibé le temps que le filtre converge
  // Rejet des échantillons IMU corrompus (cf. GYRO_GLITCH_JUMP_DPS dans config.h).
  float lastRawRate_ = 0.0f;       // dernière vitesse gyro brute SAINE (référence)
  bool imuValid_ = false;          // false tant qu'aucune référence saine (boot/calib)
  uint16_t consecutiveGlitch_ = 0; // rejets consécutifs → IMU considérée perdue
  uint32_t glitchCount_ = 0;       // total rejeté depuis le boot (diagnostic)

  // --- Consignes partagées (écrites cœur 0, lues cœur 1) ---
  volatile float cmdSpeed_ = 0.0f;  // mm/s
  volatile float cmdSteer_ = 0.0f;  // deg/s
  volatile uint32_t motionEndMs_ = 0; // 0 = pas de déplacement temporisé en cours
  volatile uint8_t gestureOp_ = 0;    // 0 = aucun geste
  volatile uint32_t gestureStartMs_ = 0;

  mutable portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
};
