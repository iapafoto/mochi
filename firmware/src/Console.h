// Console.h — console de tuning bi-support : moniteur série ET BLE, en parallèle.
//
// POURQUOI. Régler un pendule inversé avec un câble USB planté dedans fausse les
// essais : le câble tire, ajoute un couple parasite et retient le robot. Cette
// classe transporte la MÊME console texte (Tuning.cpp) sur BLE, pour régler les
// gains à distance, robot posé libre. Le série reste actif en permanence : c'est
// lui qui parle au boot (avant que le BLE soit prêt) et le secours si le lien
// tombe.
//
// COMMENT. En SORTIE, `Console` est un `Stream` Arduino, utilisable exactement
// comme `Serial` (`printf`/`println`) : Tuning.cpp ne sait rien du transport, le
// texte part en miroir sur le série ET dans le tampon circulaire BLE.
//
// En ENTRÉE, au contraire, les deux sources restent SÉPARÉES (`readFrom`), et
// c'est essentiel — cf. ci-dessous.
//
// ⚠️ PIÈGE PAYÉ (13/08). La v1 fusionnait aussi l'entrée dans une seule file.
// Robot sur accu, USB débranché : la broche RX0 flotte et capte le hachage des
// A4988, ce qui injecte des octets fantômes dans UART0. Fusionnés au flux BLE,
// ils se collaient devant la commande reçue (`\xFFd 19.0`) et le firmware
// répondait « commande inconnue » — les réglages n'arrivaient jamais. D'où :
//   1. une file d'assemblage de ligne PAR SOURCE (Tuning::poll) : le bruit d'une
//      source ne peut plus corrompre l'autre ;
//   2. l'entrée série est PURGÉE ET IGNORÉE tant qu'un client BLE est abonné —
//      si tu pilotes sans fil, personne ne tape sur le moniteur ;
//   3. les octets non imprimables sont jetés (Tuning::poll).
// La SORTIE, elle, continue de partir sur les deux : le moniteur reste la trace
// de référence.
//
// CONCURRENCE. Les octets BLE arrivent dans le contexte de la tâche NimBLE, mais
// sont consommés par commsTask : la FIFO d'entrée est donc protégée par un
// spinlock. La sortie, elle, n'est écrite que depuis commsTask (Tuning::poll) et
// vidée depuis la même tâche (pump), mais elle est gardée aussi — le coût est
// négligeable et ça évite un piège si un jour on écrit depuis ailleurs.

#pragma once
#include <Arduino.h>

class BleBridge;

class Console : public Stream {
 public:
  // Sources d'entrée, tenues séparées jusqu'à la ligne complète.
  enum Source : uint8_t { SRC_SERIAL = 0, SRC_BLE = 1, SRC_COUNT = 2 };

  void begin(BleBridge* ble) { ble_ = ble; }

  // --- Print (sortie) ---
  size_t write(uint8_t c) override;
  size_t write(const uint8_t* data, size_t len) override;

  // --- Entrée, source par source ---
  // Renvoie l'octet suivant de `src`, ou -1 s'il n'y a rien. C'est l'API que
  // Tuning doit utiliser : elle seule garantit qu'un octet parasite du série
  // n'ira pas se mélanger à une commande BLE.
  int readFrom(uint8_t src);

  // --- Stream (entrée fusionnée) ---
  // Fournies parce que `Stream` les exige, et pratiques pour du code générique.
  // NE PAS s'en servir pour assembler des lignes : cf. le piège en tête de fichier.
  int available() override;
  int read() override;
  int peek() override;

  // Pousse des octets reçus par BLE (appelé depuis le callback NimBLE).
  void pushRx(const uint8_t* data, size_t len);

  // Vide le tampon de sortie vers BLE, par blocs compatibles avec le MTU
  // négocié. À appeler régulièrement depuis commsTask (cœur 0).
  void pump();

  // La sortie a-t-elle débordé (lien BLE trop lent) ? Purement informatif.
  uint32_t overflows() const { return overflows_; }

 private:
  static constexpr size_t TX_CAP = 1024; // ~7 lignes de stream : encaisse un hoquet BLE
  static constexpr size_t RX_CAP = 128;  // une ligne de commande fait < 48 o
  static constexpr size_t MAX_CHUNKS_PER_PUMP = 4;

  size_t txCount() const;
  size_t rxCount() const;
  bool serialInputMuted() const;

  BleBridge* ble_ = nullptr;

  uint8_t tx_[TX_CAP];
  size_t txHead_ = 0, txTail_ = 0;
  uint8_t rx_[RX_CAP];
  size_t rxHead_ = 0, rxTail_ = 0;
  uint32_t overflows_ = 0;

  portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
};
