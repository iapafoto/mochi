// BleBridge.h — pont BLE (NimBLE). Expose le service Mochi :
//   - `command`     (écriture → Balance::onCommand) et `telemetry` (notifications) ;
//   - `console` RX/TX : la console de tuning texte, déportée sans fil (cf. Console.h).
// Tourne sur le CŒUR 0. Cf. protocol.h / bleProfile.ts pour les UUIDs.

#pragma once
#include <Arduino.h>
#include "Balance.h"
#include "protocol.h"

class NimBLEServer;
class NimBLECharacteristic;
class Console;
class Tuning;

class BleBridge {
 public:
  // Plafond d'un bloc de console notifié. Le MTU négocié avec Chrome monte bien
  // plus haut, mais 180 o suffit largement (une ligne de stream ≈ 140 o) et
  // borne le tampon de pile côté Console::pump().
  static constexpr size_t CONSOLE_CHUNK_MAX = 180;

  // Nombre de centraux admis simultanément. DEUX, parce que c'est la situation
  // normale dès qu'on travaille : l'app (commandes + télémétrie) d'un côté, la
  // console de tuning (tuning.html) de l'autre — on règle en pilotant. NimBLE en
  // accepte 3 par défaut ; on s'arrête à 2 pour ne pas manger le temps radio du
  // cœur 0, qui porte aussi le sonar et la télémétrie.
  static constexpr uint8_t MAX_CLIENTS = 2;

  // `console` et `tuning` peuvent être nuls : le pont fonctionne alors sans console
  // déportée, et OP_SAVE est ignoré.
  void begin(Balance* balance, Console* console = nullptr, Tuning* tuning = nullptr);
  void notifyTelemetry(const TelemetryPacket& p);
  bool connected() const { return clients_ > 0; }

  // --- Console déportée ---
  // Un client est-il abonné aux notifications de console ? Tant que non, rien
  // n'est bufferisé (cf. Console::write).
  bool consoleSubscribed() const;
  // Taille utile d'un bloc, d'après le MTU négocié (3 octets d'en-tête ATT).
  size_t consoleChunk() const;
  void notifyConsole(const uint8_t* data, size_t len);

  // Usage interne (callbacks NimBLE).
  //
  // ⚠️ UN COMPTEUR, PAS UN BOOLÉEN. Avec deux centraux, la fermeture de l'un
  // annonçait « plus personne » : la télémétrie s'arrêtait (notifyTelemetry teste
  // ce drapeau) et le MTU retombait à 23 chez celui qui restait, tronçonnant ses
  // lignes de console. Symptôme : « j'ai fermé l'onglet de tuning et l'app s'est
  // figée » — impossible à relier à sa cause sans connaître ce détail.
  void clientConnected() { if (clients_ < 255) clients_++; }
  /** Retourne le nombre de clients ENCORE connectés. */
  uint8_t clientDisconnected() { if (clients_) clients_--; return clients_; }
  uint8_t clients() const { return clients_; }
  void setMtu(uint16_t mtu) { mtu_ = mtu; }
  Balance* balance() { return balance_; }
  Console* console() { return console_; }

 private:
  Balance* balance_ = nullptr;
  Console* console_ = nullptr;
  Tuning* tuning_ = nullptr;
  NimBLEServer* server_ = nullptr;
  NimBLECharacteristic* telemetryChar_ = nullptr;
  NimBLECharacteristic* consoleTxChar_ = nullptr;
  volatile uint8_t clients_ = 0;
  // MTU par défaut de l'ATT tant que rien n'est négocié → 20 octets utiles.
  volatile uint16_t mtu_ = 23;
};
