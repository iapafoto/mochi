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

class BleBridge {
 public:
  // Plafond d'un bloc de console notifié. Le MTU négocié avec Chrome monte bien
  // plus haut, mais 180 o suffit largement (une ligne de stream ≈ 140 o) et
  // borne le tampon de pile côté Console::pump().
  static constexpr size_t CONSOLE_CHUNK_MAX = 180;

  // `console` peut être nul : le pont fonctionne alors sans console déportée.
  void begin(Balance* balance, Console* console = nullptr);
  void notifyTelemetry(const TelemetryPacket& p);
  bool connected() const { return connected_; }

  // --- Console déportée ---
  // Un client est-il abonné aux notifications de console ? Tant que non, rien
  // n'est bufferisé (cf. Console::write).
  bool consoleSubscribed() const;
  // Taille utile d'un bloc, d'après le MTU négocié (3 octets d'en-tête ATT).
  size_t consoleChunk() const;
  void notifyConsole(const uint8_t* data, size_t len);

  // Usage interne (callbacks NimBLE).
  void setConnected(bool c) { connected_ = c; }
  void setMtu(uint16_t mtu) { mtu_ = mtu; }
  Balance* balance() { return balance_; }
  Console* console() { return console_; }

 private:
  Balance* balance_ = nullptr;
  Console* console_ = nullptr;
  NimBLEServer* server_ = nullptr;
  NimBLECharacteristic* telemetryChar_ = nullptr;
  NimBLECharacteristic* consoleTxChar_ = nullptr;
  volatile bool connected_ = false;
  // MTU par défaut de l'ATT tant que rien n'est négocié → 20 octets utiles.
  volatile uint16_t mtu_ = 23;
};
