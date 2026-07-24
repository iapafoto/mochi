#include "BleBridge.h"
#include <NimBLEDevice.h>

namespace {

// Réception d'une commande app : payload = message fil (opcode + params).
class CommandCallbacks : public NimBLECharacteristicCallbacks {
 public:
  explicit CommandCallbacks(Balance* b) : balance_(b) {}
  void onWrite(NimBLECharacteristic* c) override {
    std::string v = c->getValue();
    if (v.empty()) return;
    const uint8_t* d = reinterpret_cast<const uint8_t*>(v.data());
    balance_->onCommand(d[0], d + 1, v.size() - 1);
  }

 private:
  Balance* balance_;
};

// Reprise de l'advertising à la déconnexion (reconnexion facile côté app).
class ServerCallbacks : public NimBLEServerCallbacks {
 public:
  explicit ServerCallbacks(BleBridge* b) : bridge_(b) {}
  void onConnect(NimBLEServer*) override { bridge_->setConnected(true); }
  void onDisconnect(NimBLEServer*) override {
    bridge_->setConnected(false);
    NimBLEDevice::startAdvertising();
  }

 private:
  BleBridge* bridge_;
};

}  // namespace

void BleBridge::begin(Balance* balance) {
  balance_ = balance;

  NimBLEDevice::init(MOCHI_DEVICE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9); // portée max

  server_ = NimBLEDevice::createServer();
  server_->setCallbacks(new ServerCallbacks(this));

  NimBLEService* svc = server_->createService(MOCHI_SERVICE_UUID);

  NimBLECharacteristic* cmd = svc->createCharacteristic(
      MOCHI_COMMAND_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  cmd->setCallbacks(new CommandCallbacks(balance_));

  telemetryChar_ = svc->createCharacteristic(
      MOCHI_TELEMETRY_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  svc->start();

  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(MOCHI_SERVICE_UUID);
  adv->setScanResponse(true);
  NimBLEDevice::startAdvertising();
}

void BleBridge::notifyTelemetry(const TelemetryPacket& p) {
  if (!telemetryChar_) return;
  telemetryChar_->setValue(reinterpret_cast<const uint8_t*>(&p), sizeof(p));
  if (connected_) telemetryChar_->notify();
}
