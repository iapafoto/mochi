// mpu_test.cpp — test autonome du MPU6050 sur le câblage Mochi (SDA=21, SCL=22).
// Compiler/flasher avec :  pio run -e mputest -t upload   puis  pio device monitor
//
// Séquence : scan I2C (le MPU doit répondre en 0x68, ou 0x69 si AD0=HIGH),
// init + calibration des offsets (robot IMMOBILE !), puis angles à 20 Hz.

#include <Arduino.h>
#include <Wire.h>
#include <MPU6050_light.h>
#include "config.h"

MPU6050 mpu(Wire);
bool mpuOk = false;

static void scanI2C() {
  Serial.println("\n--- Scan I2C (SDA=21, SCL=22) ---");
  int found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  peripherique trouve en 0x%02X%s\n", addr,
                    addr == 0x68 ? "  <-- MPU6050 (AD0=LOW, attendu)" :
                    addr == 0x69 ? "  <-- MPU6050 (AD0=HIGH)" : "");
      found++;
    }
  }
  if (found == 0)
    Serial.println("  AUCUN peripherique ! Verifier VCC/GND/SDA/SCL (et VCC en 3.3V).");
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n=== Test MPU6050 — Mochi ===");

  Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL, 400000);
  scanI2C();

  byte status = mpu.begin();
  Serial.printf("mpu.begin() -> %d %s\n", status, status == 0 ? "(OK)" : "(ECHEC)");
  if (status != 0) return;

  Serial.println("Calibration des offsets : NE PAS BOUGER le capteur (~2 s)...");
  delay(500);
  mpu.calcOffsets(true, true); // gyro + accéléro
  Serial.println("Calibration OK. Angles a 20 Hz :\n");
  mpuOk = true;
}

void loop() {
  if (!mpuOk) { delay(1000); return; }
  mpu.update();

  static uint32_t lastPrint = 0;
  if (millis() - lastPrint >= 50) { // 20 Hz
    lastPrint = millis();
    Serial.printf("angleX=%7.2f  angleY=%7.2f  angleZ=%7.2f  |  accX=%6.2f accY=%6.2f accZ=%6.2f  |  T=%.1fC\n",
                  mpu.getAngleX(), mpu.getAngleY(), mpu.getAngleZ(),
                  mpu.getAccX(), mpu.getAccY(), mpu.getAccZ(),
                  mpu.getTemp());
  }
}
