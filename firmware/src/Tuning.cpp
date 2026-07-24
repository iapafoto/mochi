#include "Tuning.h"

#include <Preferences.h>

#include "Balance.h"
#include "config.h"

namespace {
constexpr uint32_t STREAM_PERIOD_MS = 100; // 10 Hz, lisible au moniteur série
constexpr const char* NVS_NAMESPACE = "mochi-tune";

const char* stateName(uint8_t s) {
  switch (s) {
    case STATE_BALANCING: return "BAL";
    case STATE_FALLEN: return "FALL";
    default: return "IDLE";
  }
}
}  // namespace

void Tuning::begin(Balance* balance) {
  balance_ = balance;
  // Recharge les réglages sauvés (s'il y en a) par-dessus les défauts de config.h.
  // Ouverture en lecture-écriture : crée le namespace au premier boot (évite le
  // log d'erreur NOT_FOUND de nvs_open tant que rien n'a été sauvé).
  Preferences prefs;
  if (prefs.begin(NVS_NAMESPACE, /*readOnly=*/false)) {
    const bool hasNew = prefs.isKey("kpAng");  // format forme-vitesse (Kp/Ki/Kd)
    const bool hasOld = prefs.isKey("kdStab"); // ancien format (boucle en accélération)
    if (hasNew || hasOld) {
      if (hasNew) {
        balance_->setKpAng(prefs.getFloat("kpAng", balance_->kpAng()));
        balance_->setKiAng(prefs.getFloat("kiAng", balance_->kiAng()));
        balance_->setKdAng(prefs.getFloat("kdAng", balance_->kdAng()));
      } else {
        // Migration ancien → nouveau, PAR FONCTION (cf. docs/COMPARAISON.md §1) :
        // l'ancien `d` (kdStab = raideur) devient Kp ; l'ancien `p` (kpStab =
        // intégrale) devient Ki ; Kd (amortissement, nouveau) garde son défaut 0.
        // Préserve le réglage du run 18 (kdStab=66 → Kp=66).
        balance_->setKpAng(prefs.getFloat("kdStab", balance_->kpAng()));
        balance_->setKiAng(prefs.getFloat("kpStab", balance_->kiAng()));
      }
      balance_->setKpSpeed(prefs.getFloat("kpSpeed", balance_->kpSpeed()));
      balance_->setKiSpeed(prefs.getFloat("kiSpeed", balance_->kiSpeed()));
      balance_->setKpPos(prefs.getFloat("kpPos", balance_->kpPos()));
      balance_->setOffsetDeg(prefs.getFloat("offset", balance_->offsetDeg()));
      balance_->setPitchAxis(prefs.getUChar("axis", 0), (int8_t)prefs.getChar("sign", 1));
      balance_->setInvertLeft(prefs.getBool("invL", balance_->invertLeft()));
      balance_->setInvertRight(prefs.getBool("invR", balance_->invertRight()));
      balance_->setRateSign((int8_t)prefs.getChar("rateS", 1));
      Serial.println(hasNew
        ? "[tune] reglages NVS recharges (`g` pour voir, `f` pour defauts usine)"
        : "[tune] NVS ancien format migre (d=raideur->Kp, p->Ki, amortissement e=0) — faire `w` pour figer");
    }
    prefs.end();
  }
  Serial.println("[tune] console de tuning prete — taper `?` pour l'aide");
}

void Tuning::poll() {
  // --- Entrée : accumule les caractères jusqu'au retour à la ligne ---
  while (Serial.available() > 0) {
    const char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (len_ > 0) {
        buf_[len_] = '\0';
        handleLine(buf_);
        len_ = 0;
      }
    } else if (len_ < sizeof(buf_) - 1) {
      buf_[len_++] = c;
    }
  }

  // --- Sortie : stream périodique pitch / consigne / vitesse ---
  const uint32_t now = millis();
  if (stream_ && now - lastStreamMs_ >= STREAM_PERIOD_MS) {
    lastStreamMs_ = now;
    // `glt` = échantillons IMU rejetés depuis le boot (timeouts I2C). Doit rester
    // quasi figé : s'il grimpe pendant un run, le bus est bruité, pas les gains.
    Serial.printf("[tune] pitch=%+7.2f gy=%+7.1f (X=%+7.2f Y=%+7.2f) tgt=%+6.2f v=%+6.0fmm/s x=%+6.0fmm glt=%lu %s%s\n",
                  balance_->pitchDeg(), balance_->gyroRateDps(),
                  balance_->rawAngleX(), balance_->rawAngleY(),
                  balance_->targetDeg(), balance_->wheelMmS(), balance_->traveledMm(),
                  (unsigned long)balance_->glitchCount(),
                  stateName(balance_->state()), balance_->armed() ? "" : " (desarme)");
  }
}

void Tuning::handleLine(char* line) {
  // Format : une lettre de commande + argument optionnel (ex. `p 22.5`, `a -y`).
  while (*line == ' ') line++;
  const char cmd = *line;
  if (cmd == '\0') return;
  char* arg = line + 1;
  while (*arg == ' ') arg++;

  switch (cmd) {
    case '?': printHelp(); break;
    case 'g': printState(); break;
    // Lettres HISTORIQUES conservées (compat dashboard web + mémoire musculaire).
    // Forme vitesse : d = raideur (Kp, θ→v) · p = intégrale (Ki, ∫θ→v) ·
    // e = amortissement (Kd, θ̇→v, le terme ajouté). Le croisement lettre↔gain est
    // volontaire pour ne pas casser tuning.html ni le réglage `d=66` connu-bon.
    case 'd': balance_->setKpAng(atof(arg)); printState(); break;
    case 'p': balance_->setKiAng(atof(arg)); printState(); break;
    case 'e': balance_->setKdAng(atof(arg)); printState(); break;
    case 'v': balance_->setKpSpeed(atof(arg)); printState(); break;
    case 'i': balance_->setKiSpeed(atof(arg)); printState(); break;
    case 'q': balance_->setKpPos(atof(arg)); printState(); break;
    case 'o': balance_->setOffsetDeg(atof(arg)); printState(); break;
    case 'z':
      balance_->zeroOffsetHere();
      Serial.printf("[tune] offset capture : %.2f deg (pose actuelle = 0)\n",
                    balance_->offsetDeg());
      break;
    case 'a': {
      // `a x` / `a y` / `a -x` / `a -y` : axe du tangage + sens.
      int8_t sign = 1;
      if (*arg == '-') { sign = -1; arg++; }
      if (*arg == 'x' || *arg == 'X') balance_->setPitchAxis(0, sign);
      else if (*arg == 'y' || *arg == 'Y') balance_->setPitchAxis(1, sign);
      else { Serial.println("[tune] usage : a x | a y | a -x | a -y"); break; }
      printState();
      break;
    }
    case 'j': {
      if (balance_->armed()) { Serial.println("[tune] j : desarmer d'abord (`m`)"); break; }
      balance_->setJog(atof(arg));
      Serial.printf("[tune] jog roues = %.0f mm/s (j 0 pour stopper)\n", balance_->jog());
      break;
    }
    case 'l':
      balance_->setInvertLeft(!balance_->invertLeft());
      Serial.printf("[tune] roue GAUCHE inversee=%d\n", balance_->invertLeft());
      break;
    case 'r':
      balance_->setInvertRight(!balance_->invertRight());
      Serial.printf("[tune] roue DROITE inversee=%d\n", balance_->invertRight());
      break;
    case 'c':
      balance_->requestImuCalibration();
      Serial.println("[tune] calib IMU demandee — robot IMMOBILE et VERTICAL pendant ~2 s");
      break;
    case 'b':
      balance_->requestGyroCalibration();
      Serial.println("[tune] calib gyro demandee — POSER le robot (pose libre), ne pas toucher ~3 s");
      break;
    case 'k':
      balance_->setRateSign(balance_->rateSign() > 0 ? -1 : 1);
      Serial.printf("[tune] signe gyro = %+d\n", balance_->rateSign());
      break;
    case 't':
      stream_ = !stream_;
      Serial.printf("[tune] stream %s\n", stream_ ? "ON" : "OFF");
      break;
    case 'm':
      balance_->setArmed(!balance_->armed());
      Serial.printf("[tune] moteurs %s\n", balance_->armed() ? "ARMES" : "DESARMES");
      break;
    case 'w': save(); break;
    case 'f': factoryReset(); break;
    default:
      Serial.printf("[tune] commande inconnue `%c` — taper `?`\n", cmd);
      break;
  }
}

void Tuning::printHelp() {
  Serial.println(
      "[tune] commandes (moniteur serie, fin de ligne \\n) :\n"
      "  g          afficher gains + etat\n"
      "  d <val>    raideur Kp    : angle -> vitesse (rattrapage immediat)\n"
      "  p <val>    integrale Ki  : somme(angle) -> vitesse (anti-derive)\n"
      "  e <val>    amortissement Kd : gyro -> vitesse (freine, NOUVEAU)\n"
      "  v <val>    KP_SPEED  (boucle vitesse)\n"
      "  i <val>    KI_SPEED  (anti-derive)\n"
      "  q <val>    KP_POS    (rappel vers le point d'engagement ; 0 = off)\n"
      "  o <deg>    offset d'assiette absolu\n"
      "  z          capturer l'offset (pose actuelle = 0 deg)\n"
      "  c          recalibrer l'IMU (robot immobile+vertical, ~2 s, moteurs coupes)\n"
      "  b          recalibrer le gyro SEUL (robot POSE, pose libre, ~3 s sans toucher)\n"
      "  a [-]x|y   axe du tangage MPU (penche AVANT doit donner pitch > 0)\n"
      "  k          inverser le signe du gyro (terme D) — montage MPU inverse\n"
      "  l / r      inverser le sens de la roue gauche / droite\n"
      "  j <mm/s>   test roues en direct, sans equilibre (desarme seulement ; j 0 = stop)\n"
      "  t          stream pitch/consigne/vitesse ON/OFF (10 Hz)\n"
      "  m          armer/desarmer les moteurs (banc d'essai)\n"
      "  w          sauver les reglages en NVS (recharges au boot)\n"
      "  f          defauts usine (efface NVS, recharge config.h)");
}

void Tuning::printState() {
  Serial.printf(
      "[tune] p=%.3f d=%.3f v=%.4f i=%.5f q=%.3f o=%+.2f e=%.3f axe=%s%c invL=%d invR=%d | pitch=%+.2f glt=%lu %s%s\n",
      balance_->kiAng(), balance_->kpAng(), balance_->kpSpeed(), balance_->kiSpeed(),
      balance_->kpPos(), balance_->offsetDeg(), balance_->kdAng(), balance_->pitchSign() < 0 ? "-" : "",
      balance_->pitchAxis() ? 'y' : 'x', balance_->invertLeft(), balance_->invertRight(),
      balance_->pitchDeg(), (unsigned long)balance_->glitchCount(),
      stateName(balance_->state()), balance_->armed() ? "" : " (desarme)");
}

void Tuning::save() {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, /*readOnly=*/false)) {
    Serial.println("[tune] ERREUR : NVS inaccessible");
    return;
  }
  prefs.putFloat("kpAng", balance_->kpAng());
  prefs.putFloat("kiAng", balance_->kiAng());
  prefs.putFloat("kdAng", balance_->kdAng());
  prefs.remove("kpStab"); // purge de l'ancien format (boucle en accélération)
  prefs.remove("kdStab");
  prefs.putFloat("kpSpeed", balance_->kpSpeed());
  prefs.putFloat("kiSpeed", balance_->kiSpeed());
  prefs.putFloat("kpPos", balance_->kpPos());
  prefs.putFloat("offset", balance_->offsetDeg());
  prefs.putUChar("axis", balance_->pitchAxis());
  prefs.putChar("sign", balance_->pitchSign());
  prefs.putBool("invL", balance_->invertLeft());
  prefs.putBool("invR", balance_->invertRight());
  prefs.putChar("rateS", balance_->rateSign());
  prefs.end();
  Serial.println("[tune] reglages sauves en NVS — penser a reporter dans config.h");
}

void Tuning::factoryReset() {
  Preferences prefs;
  if (prefs.begin(NVS_NAMESPACE, /*readOnly=*/false)) {
    prefs.clear();
    prefs.end();
  }
  balance_->applyDefaultTuning();
  Serial.println("[tune] NVS efface, defauts de config.h recharges");
  printState();
}
