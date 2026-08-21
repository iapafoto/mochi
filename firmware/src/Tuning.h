// Tuning.h — console de réglage de l'équilibre (cœur 0).
//
// Permet d'ajuster les gains PID, l'axe du MPU et l'offset d'assiette EN LIVE
// (sans recompiler/reflasher), de streamer pitch/consigne/vitesse, et de
// sauver le tout en NVS (rechargé automatiquement au boot). Taper `?` pour l'aide.
//
// La console ne connaît PAS son transport : elle lit et écrit sur un `Stream`
// injecté. En pratique c'est `Console` (Console.h), qui sert le moniteur série
// (115200) ET le BLE simultanément — régler l'équilibre sans câble USB, dont la
// traction fausse les essais sur un pendule inversé.

#pragma once
#include <Arduino.h>

#include "Console.h"

class Balance;

class Tuning {
 public:
  // `io` doit survivre à l'objet (instance statique côté main.cpp).
  void begin(Balance* balance, Console& io); // recharge les réglages sauvés (NVS) s'ils existent
  void poll();                  // à appeler régulièrement depuis commsTask (cœur 0)
  // Stream actif ? (la LED d'état clignote vite pendant une capture — repère visuel)
  bool streaming() const { return stream_; }

 private:
  void handleLine(char* line);
  void printHelp();
  void printState();
  void save();
  void factoryReset();

  Balance* balance_ = nullptr;
  Console* io_ = nullptr;
  // UNE file d'assemblage PAR SOURCE (série / BLE). Deux sources qui partagent
  // un tampon, c'est un octet parasite de l'une qui détruit la commande de
  // l'autre — le bug du 13/08, cf. l'en-tête de Console.h.
  char buf_[Console::SRC_COUNT][48];
  size_t len_[Console::SRC_COUNT] = {0, 0};
  bool stream_ = false;
  uint32_t lastStreamMs_ = 0;
};
