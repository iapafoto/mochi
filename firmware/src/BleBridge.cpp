#include "BleBridge.h"
#include <NimBLEDevice.h>

#include "Console.h"
#include "Tuning.h"

namespace {

// Réception d'une commande app : payload = message fil (opcode + params).
class CommandCallbacks : public NimBLECharacteristicCallbacks {
 public:
  CommandCallbacks(Balance* b, Tuning* t) : balance_(b), tuning_(t) {}
  void onWrite(NimBLECharacteristic* c) override {
    std::string v = c->getValue();
    if (v.empty()) return;
    const uint8_t* d = reinterpret_cast<const uint8_t*>(v.data());
    // OP_SAVE ne parle pas d'équilibre mais de PERSISTANCE : il part vers Tuning,
    // seul propriétaire de la NVS. Balance n'a pas à connaître l'existence d'un
    // stockage, et surtout pas à servir de boîte aux lettres pour y accéder.
    if (d[0] == OP_SAVE) {
      if (tuning_) tuning_->requestSave();
      return;
    }
    balance_->onCommand(d[0], d + 1, v.size() - 1);
  }

 private:
  Balance* balance_;
  Tuning* tuning_;
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
  void onConnect(NimBLEServer*) override {
    bridge_->clientConnected();
    // On CONTINUE d'annoncer tant qu'il reste une place. Sans ça NimBLE arrête
    // l'advertising dès le premier client : le premier arrivé ferme la porte, et
    // ouvrir la console de tuning à côté de l'app devient impossible — le robot
    // n'apparaît tout simplement plus dans le sélecteur Bluetooth.
    if (bridge_->clients() < BleBridge::MAX_CLIENTS) NimBLEDevice::startAdvertising();
  }
  void onDisconnect(NimBLEServer*) override {
    const uint8_t remaining = bridge_->clientDisconnected();
    // Le MTU est renégocié à chaque connexion : ne pas garder celui du client
    // précédent, sinon le premier bloc de console de la session suivante peut
    // être tronqué silencieusement. Mais le MTU appartient à CHAQUE lien : le
    // rabattre alors qu'un AUTRE client a négocié 247 tronçonnerait ses blocs. On
    // n'y touche donc qu'une fois la DERNIÈRE connexion partie.
    if (remaining == 0) bridge_->setMtu(23);
    // SÉCURITÉ, et volontairement pessimiste : on stoppe dès qu'UN client s'en va,
    // sans chercher si c'était le pilote — on ne peut pas le savoir ici. Se tromper
    // dans ce sens coûte une pichenette à repousser ; se tromper dans l'autre laisse
    // un robot rouler sans plus personne au bout du fil. On coupe donc TOUT ce qui
    // laisse le robot en mouvement continu : le jog (`j`, roues en direct, moteurs
    // désarmés) et le téléguidage. L'équilibre, lui, est laissé actif : couper
    // les moteurs d'un robot debout le ferait tomber.
    // ⚠️ Le téléguidage a DÉJÀ son homme mort (TELEOP_TTL_MS) : ceci n'est que la
    // ceinture par-dessus les bretelles, et elle agit tout de suite au lieu
    // d'attendre l'expiration.
    if (Balance* b = bridge_->balance()) {
      b->setJog(0);
      b->stopMotion();
    }
    NimBLEDevice::startAdvertising();
  }
  void onMTUChange(uint16_t mtu, ble_gap_conn_desc*) override {
    bridge_->setMtu(mtu);
  }

 private:
  BleBridge* bridge_;
};

}  // namespace

void BleBridge::begin(Balance* balance, Console* console, Tuning* tuning) {
  balance_ = balance;
  console_ = console;
  tuning_ = tuning;

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
  cmd->setCallbacks(new CommandCallbacks(balance_, tuning_));

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
  if (connected()) telemetryChar_->notify();
}

bool BleBridge::consoleSubscribed() const {
  if (!connected() || !consoleTxChar_) return false;
  return consoleTxChar_->getSubscribedCount() > 0;
}

size_t BleBridge::consoleChunk() const {
  const uint16_t mtu = mtu_;
  const size_t usable = mtu > 3 ? (size_t)(mtu - 3) : 20;
  return usable > CONSOLE_CHUNK_MAX ? CONSOLE_CHUNK_MAX : usable;
}

void BleBridge::notifyConsole(const uint8_t* data, size_t len) {
  if (!consoleTxChar_ || !connected()) return;
  consoleTxChar_->setValue(data, len);
  consoleTxChar_->notify();
}
