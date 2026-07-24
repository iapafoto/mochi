// BleBridge.h — pont BLE (NimBLE). Expose le service Mochi : caractéristique
// `command` (écriture → Balance::onCommand) et `telemetry` (notifications).
// Tourne sur le CŒUR 0. Cf. protocol.h / bleProfile.ts pour les UUIDs.

#pragma once
#include <Arduino.h>
#include "Balance.h"
#include "protocol.h"

class NimBLEServer;
class NimBLECharacteristic;

class BleBridge {
 public:
  void begin(Balance* balance);
  void notifyTelemetry(const TelemetryPacket& p);
  bool connected() const { return connected_; }

  // Usage interne (callbacks NimBLE).
  void setConnected(bool c) { connected_ = c; }
  Balance* balance() { return balance_; }

 private:
  Balance* balance_ = nullptr;
  NimBLEServer* server_ = nullptr;
  NimBLECharacteristic* telemetryChar_ = nullptr;
  volatile bool connected_ = false;
};
