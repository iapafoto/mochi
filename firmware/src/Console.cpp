#include "Console.h"

#include "BleBridge.h"

size_t Console::txCount() const {
  return (txHead_ + TX_CAP - txTail_) % TX_CAP;
}

size_t Console::rxCount() const {
  return (rxHead_ + RX_CAP - rxTail_) % RX_CAP;
}

size_t Console::write(uint8_t c) {
  return write(&c, 1);
}

size_t Console::write(const uint8_t* data, size_t len) {
  // Le série est TOUJOURS servi, lien BLE ou pas : c'est la trace de référence
  // (et le seul canal disponible pendant le boot).
  Serial.write(data, len);

  // Ne rien bufferiser tant que personne n'écoute : sinon le stream de tuning
  // remplirait le tampon en permanence pour rien.
  if (!ble_ || !ble_->consoleSubscribed()) return len;

  portENTER_CRITICAL(&mux_);
  for (size_t i = 0; i < len; i++) {
    const size_t next = (txHead_ + 1) % TX_CAP;
    if (next == txTail_) {
      // Plein : on jette le PLUS ANCIEN. Sur un flux temps réel, l'octet frais
      // vaut mieux que l'octet périmé — après un hoquet du lien, l'affichage
      // repart sur les valeurs courantes au lieu de rejouer le passé. La ligne
      // tronquée qui en résulte est simplement ignorée par le dashboard.
      txTail_ = (txTail_ + 1) % TX_CAP;
      overflows_++;
    }
    tx_[txHead_] = data[i];
    txHead_ = next;
  }
  portEXIT_CRITICAL(&mux_);
  return len;
}

// Le moniteur série est-il neutralisé en ENTRÉE ? Oui dès qu'un client BLE
// écoute : USB alors débranché, RX0 flotte et capte le bruit des A4988 (cf. le
// piège documenté dans Console.h). La SORTIE série n'est jamais coupée.
bool Console::serialInputMuted() const {
  return ble_ && ble_->consoleSubscribed();
}

int Console::readFrom(uint8_t src) {
  if (src == SRC_SERIAL) {
    if (serialInputMuted()) {
      // Purger : sans ça, tout le bruit accumulé pendant la session sans fil
      // partirait d'un coup dans la console au moment de la déconnexion BLE.
      while (Serial.available() > 0) Serial.read();
      return -1;
    }
    return Serial.available() > 0 ? Serial.read() : -1;
  }

  int c = -1;
  portENTER_CRITICAL(&mux_);
  if (rxTail_ != rxHead_) {
    c = rx_[rxTail_];
    rxTail_ = (rxTail_ + 1) % RX_CAP;
  }
  portEXIT_CRITICAL(&mux_);
  return c;
}

int Console::available() {
  const int s = serialInputMuted() ? 0 : Serial.available();
  portENTER_CRITICAL(&mux_);
  const size_t n = rxCount();
  portEXIT_CRITICAL(&mux_);
  return s + (int)n;
}

int Console::read() {
  const int s = readFrom(SRC_SERIAL);
  return s >= 0 ? s : readFrom(SRC_BLE);
}

int Console::peek() {
  if (!serialInputMuted() && Serial.available() > 0) return Serial.peek();
  int c = -1;
  portENTER_CRITICAL(&mux_);
  if (rxTail_ != rxHead_) c = rx_[rxTail_];
  portEXIT_CRITICAL(&mux_);
  return c;
}

void Console::pushRx(const uint8_t* data, size_t len) {
  portENTER_CRITICAL(&mux_);
  for (size_t i = 0; i < len; i++) {
    const size_t next = (rxHead_ + 1) % RX_CAP;
    if (next == rxTail_) break; // FIFO pleine : on ignore le reste (commande perdue)
    rx_[rxHead_] = data[i];
    rxHead_ = next;
  }
  portEXIT_CRITICAL(&mux_);
}

void Console::pump() {
  if (!ble_ || !ble_->consoleSubscribed()) {
    // Personne n'écoute : on repart de zéro plutôt que de garder un tampon
    // périmé qui serait déversé d'un coup à la prochaine connexion.
    portENTER_CRITICAL(&mux_);
    txTail_ = txHead_;
    portEXIT_CRITICAL(&mux_);
    return;
  }

  const size_t chunk = ble_->consoleChunk();
  uint8_t buf[BleBridge::CONSOLE_CHUNK_MAX];

  for (size_t k = 0; k < MAX_CHUNKS_PER_PUMP; k++) {
    size_t n = 0;
    portENTER_CRITICAL(&mux_);
    while (n < chunk && txTail_ != txHead_) {
      buf[n++] = tx_[txTail_];
      txTail_ = (txTail_ + 1) % TX_CAP;
    }
    portEXIT_CRITICAL(&mux_);
    if (n == 0) return;
    ble_->notifyConsole(buf, n);
  }
}
