#include "BleBridge.h"
#include <NimBLEDevice.h>

#include "Console.h"

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

// Réception d'une frappe de console : texte brut, éventuellement fragmenté.
// On ne fait qu'empiler dans la FIFO — c'est Tuning::poll qui recompose les
// lignes, exactement comme il le fait pour le série.
class ConsoleRxCallbacks : public NimBLECharacteristicCallbacks {
 public:
  explicit ConsoleRxCallbacks(Console* c) : console_(c) {}
  void onWrite(NimBLECharacteristic* c) override {
    std::string v = c->getValue();
    if (v.empty() || !console_) return;
    console_->pushRx(reinterpret_cast<const uint8_t*>(v.data()), v.size());
  }

 private:
  Console* console_;
};

// Reprise de l'advertising à la déconnexion (reconnexion facile côté app).
class ServerCallbacks : public NimBLEServerCallbacks {
 public:
  explicit ServerCallbacks(BleBridge* b) : bridge_(b) {}
  void onConnect(NimBLEServer*) override { bridge_->setConnected(true); }
  void onDisconnect(NimBLEServer*) override {
    bridge_->setConnected(false);
    // Le MTU est renégocié à chaque connexion : ne pas garder celui du client
    // précédent, sinon le premier bloc de console de la session suivante peut
    // être tronqué silencieusement.
    bridge_->setMtu(23);
    // SÉCURITÉ : plus de lien = plus de pilote. Le jog (`j`, roues en direct,
    // moteurs désarmés) est la seule commande qui laisse le robot en mouvement
    // continu — on la coupe. L'équilibre, lui, est laissé actif : couper les
    // moteurs d'un robot debout le ferait tomber.
    if (Balance* b = bridge_->balance()) b->setJog(0);
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, ble_gap_conn_desc*) override {
    bridge_->setMtu(mtu);
  }

 private:
  BleBridge* bridge_;
};

}  // namespace

void BleBridge::begin(Balance* balance, Console* console) {
  balance_ = balance;
  console_ = console;

  NimBLEDevice::init(MOCHI_DEVICE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9); // portée max
  // MTU préféré : la console texte débite ~140 o par ligne de stream. Avec le
  // MTU par défaut (23) il faudrait 7 notifications par ligne ; à 247 une seule
  // suffit. Le central (Chrome) reste maître de la négociation.
  NimBLEDevice::setMTU(247);

  server_ = NimBLEDevice::createServer();
  server_->setCallbacks(new ServerCallbacks(this));

  NimBLEService* svc = server_->createService(MOCHI_SERVICE_UUID);

  NimBLECharacteristic* cmd = svc->createCharacteristic(
      MOCHI_COMMAND_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  cmd->setCallbacks(new CommandCallbacks(balance_));

  telemetryChar_ = svc->createCharacteristic(
      MOCHI_TELEMETRY_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);

  if (console_) {
    NimBLECharacteristic* rx = svc->createCharacteristic(
        MOCHI_CONSOLE_RX_UUID, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
    rx->setCallbacks(new ConsoleRxCallbacks(console_));

    consoleTxChar_ = svc->createCharacteristic(
        MOCHI_CONSOLE_TX_UUID, NIMBLE_PROPERTY::NOTIFY);
  }

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

bool BleBridge::consoleSubscribed() const {
  if (!connected_ || !consoleTxChar_) return false;
  return consoleTxChar_->getSubscribedCount() > 0;
}

size_t BleBridge::consoleChunk() const {
  const uint16_t mtu = mtu_;
  const size_t usable = mtu > 3 ? (size_t)(mtu - 3) : 20;
  return usable > CONSOLE_CHUNK_MAX ? CONSOLE_CHUNK_MAX : usable;
}

void BleBridge::notifyConsole(const uint8_t* data, size_t len) {
  if (!consoleTxChar_ || !connected_) return;
  consoleTxChar_->setValue(data, len);
  consoleTxChar_->notify();
}
