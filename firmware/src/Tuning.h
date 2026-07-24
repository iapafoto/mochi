// Tuning.h — console série de réglage de l'équilibre (cœur 0).
//
// Permet d'ajuster les gains PID, l'axe du MPU et l'offset d'assiette EN LIVE
// (sans recompiler/reflasher), de streamer pitch/consigne/vitesse, et de
// sauver le tout en NVS (rechargé automatiquement au boot). Taper `?` dans le
// moniteur série (115200) pour l'aide.

#pragma once
#include <Arduino.h>

class Balance;

class Tuning {
 public:
  void begin(Balance* balance); // recharge les réglages sauvés (NVS) s'ils existent
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
  char buf_[48];
  size_t len_ = 0;
  bool stream_ = false;
  uint32_t lastStreamMs_ = 0;
};
