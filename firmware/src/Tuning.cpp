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

void Tuning::begin(Balance* balance, Console& io) {
  balance_ = balance;
  io_ = &io;
  // Recharge les réglages sauvés (s'il y en a) par-dessus les défauts de config.h.
  // Ouverture en lecture-écriture : crée le namespace au premier boot (évite le
  // log d'erreur NOT_FOUND de nvs_open tant que rien n'a été sauvé).
  Preferences prefs;
  if (prefs.begin(NVS_NAMESPACE, /*readOnly=*/false)) {
    // ⚠️ GÉNÉRATION DES GAINS (21/08). Les gains internes sont stockés sous des clés
    // versionnées (`kpAngV2`…). Quand config.h change la LOI DE COMMANDE elle-même —
    // ici l'entrée en service de Ki comme terme dominant — recharger les anciennes
    // valeurs NVS revient à reflasher pour rien : on repartirait avec Ki=0, donc avec
    // exactement le firmware qui ne tenait pas. Sur bascule de génération, les gains
    // reprennent les défauts de config.h, mais TOUT LE RESTE (offset, axe, sens des
    // roues, échelle gyro : de la calibration durement gagnée) est conservé.
    const bool hasNew = prefs.isKey("kpAngV2"); // génération courante (Ki actif)
    const bool hasV1 = prefs.isKey("kpAng");    // forme vitesse, Ki neutralisé
    const bool hasOld = prefs.isKey("kdStab");  // ancien format (boucle en accélération)
    if (hasNew || hasV1 || hasOld) {
      if (hasNew) {
        balance_->setKpAng(prefs.getFloat("kpAngV2", balance_->kpAng()));
        balance_->setKiAng(prefs.getFloat("kiAngV2", balance_->kiAng()));
        balance_->setKdAng(prefs.getFloat("kdAngV2", balance_->kdAng()));
        balance_->setMaxWheelSpeed(prefs.getFloat("vmax", balance_->maxWheelSpeed()));
        balance_->setSpeedEstTilt(prefs.getFloat("estTilt", balance_->speedEstTilt()));
        balance_->setDlpf(prefs.getUChar("dlpf", balance_->dlpf()));
        balance_->setDitherMmS(prefs.getFloat("dither", balance_->ditherMmS()));
        balance_->setSpeedFloorMmS(prefs.getFloat("vfloor", balance_->speedFloorMmS()));
        balance_->setSwayDeg(prefs.getFloat("sway", balance_->swayDeg()));
        balance_->setMaxLeanDeg(prefs.getFloat("lean", balance_->maxLeanDeg()));
        balance_->setTeleopMaxSpeed(prefs.getFloat("tlSpeed", balance_->teleopMaxSpeed()));
        balance_->setTeleopMaxTurn(prefs.getFloat("tlTurn", balance_->teleopMaxTurn()));
      } else if (hasV1) {
        // Gains de la génération précédente ignorés VOLONTAIREMENT (cf. ci-dessus).
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
      balance_->setAutoTrimGain(prefs.getFloat("autoTrim", balance_->autoTrimGain()));
      balance_->setMaxAccel(prefs.getFloat("accel", balance_->maxAccel()));
      balance_->setFilterCoef(prefs.getFloat("fcoef", balance_->filterCoef()));
      balance_->setGyroScale(prefs.getFloat("gscale", balance_->gyroScale()));
      if (hasNew) {
        io_->println("[tune] reglages NVS recharges (`g` pour voir, `f` pour defauts usine)");
      } else if (hasV1) {
        io_->println("[tune] NOUVELLE LOI DE COMMANDE (Ki actif) : gains internes repris "
                     "aux defauts de config.h, calibration NVS conservee — `w` pour figer");
      } else {
        io_->println("[tune] NVS ancien format migre (d=raideur->Kp, p->Ki, amortissement e=0) "
                     "— faire `w` pour figer");
      }
    }
    prefs.end();
  }
  io_->println("[tune] console de tuning prete — taper `?` pour l'aide");
}

void Tuning::poll() {
  if (!io_ || !balance_) return; // begin() pas encore passé
  // --- Entrée : accumule les caractères jusqu'au retour à la ligne ---
  // Chaque source (série, BLE) a sa PROPRE file : une commande tapée au moniteur
  // et une commande envoyée par le dashboard sans fil suivent le même traitement,
  // mais ne peuvent jamais se mélanger en cours de route.
  for (uint8_t src = 0; src < Console::SRC_COUNT; src++) {
    for (int v = io_->readFrom(src); v >= 0; v = io_->readFrom(src)) {
      const char c = (char)v;
      if (c == '\n' || c == '\r') {
        if (len_[src] > 0) {
          buf_[src][len_[src]] = '\0';
          handleLine(buf_[src]);
          len_[src] = 0;
        }
      } else if (c >= 0x20 && c < 0x7F) {
        // ASCII imprimable uniquement : tout le reste est du bruit de ligne
        // (RX0 qui flotte, parasites des A4988) et n'a rien à faire dans une
        // commande. Le jeter ici évite des « commande inconnue » fantômes.
        if (len_[src] < sizeof(buf_[src]) - 1) buf_[src][len_[src]++] = c;
      }
    }
  }

  // --- Journal des coupures moteur (le diagnostic de « l'absence ») ---
  // Imprimé ICI, cœur 0 : la boucle d'équilibre latche l'événement et repart, elle
  // ne peut pas se permettre un printf. Si le robot a une absence et que RIEN ne
  // s'affiche ici, c'est que le firmware n'a PAS coupé → la panne est matérielle
  // (sécurité thermique d'un A4988, protection du BMS, faux contact d'alim).
  Balance::CutInfo cut;
  if (balance_->takeCutEvent(cut)) {
    static const char* const CAUSE[] = {
      "?", "ANGLE (chute franche, normal)",
      "IMU PERDUE (rejets I2C consecutifs — bus bruite, PAS les gains)",
      "DERIVE (ancre de position depassee)",
      "SATURATION (roue a fond en continu — soulevee ? patinage ?)",
    };
    io_->printf("[CUT ] %s | pitch=%+.1f v=%+.0fmm/s x=%+.0fmm glt=%lu t=%lus\n",
                CAUSE[cut.cause < 5 ? cut.cause : 0], cut.pitchDeg, cut.wheelMmS,
                cut.traveledMm, (unsigned long)cut.glitches,
                (unsigned long)(cut.atMs / 1000));
  }

  // --- Le driver n'a pas suivi la consigne (diagnostic de « l'absence ») ---
  Balance::DrvInfo drv;
  if (balance_->takeDrvEvent(drv)) {
    io_->printf("[DRV ] driver MUET : cmd L=%ld R=%ld pas/s, reel L=%ld R=%ld, "
                "ramp L=%u R=%u t=%lus\n",
                drv.cmdL, drv.cmdR, (long)drv.actL, (long)drv.actR,
                (unsigned)drv.rampL, (unsigned)drv.rampR,
                (unsigned long)(drv.atMs / 1000));
  }

  // --- Sortie : stream périodique pitch / consigne / vitesse ---
  const uint32_t now = millis();
  if (stream_ && now - lastStreamMs_ >= STREAM_PERIOD_MS) {
    lastStreamMs_ = now;
    // `glt` = échantillons IMU rejetés depuis le boot (timeouts I2C). Doit rester
    // quasi figé : s'il grimpe pendant un run, le bus est bruité, pas les gains.
    // `o*` = zéro que l'intégrale compense en permanence. Quand il se stabilise
    // pendant un équilibre calme, `Z` puis `w` le gravent → plus de dérive au départ.
    io_->printf("[tune] pitch=%+7.2f gy=%+7.1f (X=%+7.2f Y=%+7.2f) tgt=%+6.2f v=%+6.0fmm/s x=%+6.0fmm glt=%lu trim=%+6.2f o*=%+6.2f %s%s\n",
                  balance_->pitchDeg(), balance_->gyroRateDps(),
                  balance_->rawAngleX(), balance_->rawAngleY(),
                  balance_->targetDeg(), balance_->wheelMmS(), balance_->traveledMm(),
                  (unsigned long)balance_->glitchCount(), balance_->autoTrimDeg(),
                  balance_->suggestedOffsetDeg(),
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
    case 'n':
      balance_->setMaxAccel(atof(arg));
      // L'accélération demandée par la boucle vaut d × θ̇ (mm/s² pour θ̇ en °/s).
      // En prenant 100 °/s comme vitesse de chute de dimensionnement, la commande
      // reste dans le domaine réalisable tant que d <= accel/(STEPS_PER_MM*100).
      // Au-delà, le limiteur écrête pendant les rattrapages : la boucle s'ouvre au
      // pire moment et le robot part en oscillation. C'est un COUPLE (n, d), pas
      // deux réglages indépendants.
      io_->printf("[tune] accel = %.0f steps/s2 = %.1f m/s2 (B-Robot : 70000 = 6 m/s2)\n"
                  "       limite appliquee PAR LE CONTROLEUR (rampe driver figee, cf. config.h)\n"
                  "       => avec cette accel, garder d <= %.0f (accel demandee = d x gyro)\n",
                    balance_->maxAccel(), balance_->maxAccel() / STEPS_PER_MM / 1000.0f,
                    balance_->maxAccel() / STEPS_PER_MM / 100.0f);
      break;
    case 'y':
      balance_->setFilterCoef(atof(arg));
      io_->printf("[tune] filtre coef gyro = %.4f (bas=+accelero, angle sans derive ; baisser si l'angle ment droit)\n",
                    balance_->filterCoef());
      break;
    case 's':
      balance_->setAutoTrimGain(atof(arg));
      io_->printf("[tune] auto-trim theta0 gain = %.4f (0=off ; sol plat, sans contact)\n",
                    balance_->autoTrimGain());
      break;
    case 'V':
      balance_->setMaxWheelSpeed(atof(arg));
      io_->printf("[tune] vitesse roue max = %.0f mm/s (B-Robot : ~2160 ; monter tant "
                  "que les moteurs ne perdent pas de pas)\n",
                  balance_->maxWheelSpeed());
      break;
    case 'T':
      balance_->setSpeedEstTilt(atof(arg));
      io_->printf("[tune] correction v_robot = v_roue + %.2f*gyro (0 = off ; B-Robot ~1.0 ; "
                  "ajoute de l'amortissement, redescendre `e` en consequence)\n",
                  balance_->speedEstTilt());
      break;
    case 'H':
      balance_->setDitherMmS(atof(arg));
      io_->printf("[tune] dither = %.0f mm/s (0 = off ; contre le JEU mecanique et le "
                  "frottement autour de zero — verifier le jeu a la main d'abord)\n",
                  balance_->ditherMmS());
      break;
    case 'x':
      // Sans ça, tous les compteurs datent du BOOT : impossible de comparer deux
      // réglages sans reflasher entre les deux. À taper juste avant chaque essai.
      balance_->resetLoopStats();
      io_->println("[tune] compteurs remis a zero — nouveau run");
      break;
    case 'B':
      balance_->setSwayDeg(atof(arg));
      io_->printf("[tune] balancier = %.2f deg a %.1f Hz (0 = off) -> ~%.0f mm/s "
                  "d'amplitude sur la vitesse roue ; le robot ne s'immobilise plus "
                  "au point zero, comme le B-Robot\n",
                  balance_->swayDeg(), SWAY_HZ,
                  balance_->swayDeg() * balance_->kpAng());
      break;
    case 'F':
      balance_->setSpeedFloorMmS(atof(arg));
      io_->printf("[tune] plancher vitesse = %.0f mm/s (%ld pas/s) -> latence actionneur "
                  "bornee a %.0f ms (0 = off ; le signe est PRESERVE, aucune inversion "
                  "forcee)\n",
                  balance_->speedFloorMmS(),
                  lroundf(balance_->speedFloorMmS() * STEPS_PER_MM),
                  balance_->speedFloorMmS() <= 0.0f
                      ? 0.0f
                      : 1000.0f / (balance_->speedFloorMmS() * STEPS_PER_MM));
      break;
    case 'D':
      balance_->setDlpf((uint8_t)atoi(arg));
      io_->printf("[tune] DLPF MPU = %u (3=44Hz defaut, 4=21Hz, 5=10Hz=reglage B-Robot ; "
                  "plus filtre = angle plus propre mais amortissement en retard)\n",
                  (unsigned)balance_->dlpf());
      break;
    case 'o': balance_->setOffsetDeg(atof(arg)); printState(); break;
    case 'Z':
      // Le zéro que l'intégrale a fini par compenser. À prendre APRÈS un équilibre
      // calme prolongé, sinon on grave une valeur transitoire.
      balance_->adoptSuggestedOffset();
      io_->printf("[tune] zero adopte depuis l'integrale : o = %.2f deg — `w` pour le "
                  "garder au reboot\n",
                  balance_->offsetDeg());
      break;
    case 'z':
      balance_->zeroOffsetHere();
      io_->printf("[tune] offset capture : %.2f deg (pose actuelle = 0)\n",
                    balance_->offsetDeg());
      break;
    case 'a': {
      // `a x|y|z` (± pour le sens) : axe de ROTATION du tangage dans le repère de
      // la puce, c'est-à-dire l'axe parallèle à l'essieu. L'inclinaison de la carte
      // autour de cet axe est libre (absorbée par `o`) — cf. Balance.cpp.
      int8_t sign = 1;
      if (*arg == '-') { sign = -1; arg++; }
      const char a = *arg | 0x20; // insensible à la casse
      if (a == 'x') balance_->setPitchAxis(0, sign);
      else if (a == 'y') balance_->setPitchAxis(1, sign);
      else if (a == 'z') balance_->setPitchAxis(2, sign);
      else { io_->println("[tune] usage : a x|y|z ou a -x|-y|-z"); break; }
      printState();
      break;
    }
    // --- Teleguidage ---
    // `u <mm/s> [deg/s] [ms]` — avancer / pivoter. La commande EXPIRE d'elle-meme
    // (homme mort, cf. protocol.h) : tapee a la main elle donne une pichenette de
    // TELEOP_TTL_MS, le pad du banc la rafraichit a 10 Hz tant qu'on appuie.
    // `u 0` = arret immediat.
    case 'u': {
      char* end = nullptr;
      const float v = strtod(arg, &end);
      const float w = (end && *end) ? strtod(end, &end) : 0.0f;
      const double ms = (end && *end) ? strtod(end, &end) : 0.0;
      balance_->drive(v, w, (uint32_t)(ms < 0 ? 0 : ms));
      io_->printf("[tune] pilote v=%+.0f mm/s rot=%+.0f deg/s pendant %lu ms%s\n",
                  balance_->cmdSpeedMmS(), balance_->cmdSteerDegS(),
                  (unsigned long)(ms > 0 ? (uint32_t)ms : TELEOP_TTL_MS),
                  balance_->armed() ? "" : " — MOTEURS DESARMES (`m`)");
      break;
    }
    case 'A':
      balance_->setMaxLeanDeg(atof(arg));
      io_->printf("[tune] inclinaison max en deplacement = %.1f deg "
                  "(B-Robot : 14 normal / 26 pro)\n", balance_->maxLeanDeg());
      break;
    case 'P':
      balance_->setTeleopMaxSpeed(atof(arg));
      io_->printf("[tune] fond de course vitesse = %.0f mm/s\n", balance_->teleopMaxSpeed());
      break;
    case 'R':
      balance_->setTeleopMaxTurn(atof(arg));
      io_->printf("[tune] fond de course rotation = %.0f deg/s\n", balance_->teleopMaxTurn());
      break;
    case 'j': {
      if (balance_->armed()) { io_->println("[tune] j : desarmer d'abord (`m`)"); break; }
      balance_->setJog(atof(arg));
      io_->printf("[tune] jog roues = %.0f mm/s (j 0 pour stopper)\n", balance_->jog());
      break;
    }
    case 'l':
      balance_->setInvertLeft(!balance_->invertLeft());
      io_->printf("[tune] roue GAUCHE inversee=%d\n", balance_->invertLeft());
      break;
    case 'r':
      balance_->setInvertRight(!balance_->invertRight());
      io_->printf("[tune] roue DROITE inversee=%d\n", balance_->invertRight());
      break;
    case 'c':
      balance_->requestImuCalibration();
      io_->println("[tune] calib IMU demandee — robot IMMOBILE et VERTICAL pendant ~2 s");
      break;
    case 'b':
      balance_->requestGyroCalibration();
      io_->println("[tune] calib gyro demandee — POSER le robot (pose libre), ne pas toucher ~3 s");
      break;
    case 'k':
      balance_->setRateSign(balance_->rateSign() > 0 ? -1 : 1);
      io_->printf("[tune] signe gyro = %+d\n", balance_->rateSign());
      break;
    case 'G':
      balance_->setGyroScale(atof(arg));
      io_->printf("[tune] echelle gyro = %.3f (1.0 = confiance lib ; 0.5 si clone bloque en +-500)\n",
                  balance_->gyroScale());
      break;
    case 't':
      stream_ = !stream_;
      io_->printf("[tune] stream %s\n", stream_ ? "ON" : "OFF");
      break;
    case 'm':
      balance_->setArmed(!balance_->armed());
      io_->printf("[tune] moteurs %s\n", balance_->armed() ? "ARMES" : "DESARMES");
      break;
    case 'w': save(); break;
    case 'f': factoryReset(); break;
    default:
      io_->printf("[tune] commande inconnue `%c` — taper `?`\n", cmd);
      break;
  }
}

void Tuning::printHelp() {
  io_->println(
      "[tune] commandes (moniteur serie OU console BLE, fin de ligne \\n) :\n"
      "  g          afficher gains + etat\n"
      "  d <val>    raideur Kp    : angle -> vitesse (rattrapage immediat)\n"
      "  p <val>    integrale Ki  : somme(angle) -> vitesse — TERME DOMINANT (~6.4*Kp)\n"
      "             a 0 le robot part en ligne droite et tombe, quels que soient les autres\n"
      "  e <val>    amortissement Kd : gyro -> vitesse (freine, NOUVEAU)\n"
      "  v <val>    KP_SPEED  (boucle vitesse)\n"
      "  i <val>    KI_SPEED  (anti-derive)\n"
      "  q <val>    KP_POS    (rappel vers le point d'engagement ; 0 = off)\n"
      "  n <val>    accel driver steps/s2 (LIVE ; viser 2e5..1e6 ; baisser si pas sautes)\n"
      "  y <val>    filtre coef gyro 0.80..0.9999 (LIVE ; baisser si l'angle ment quand droit)\n"
      "  s <val>    auto-trim theta0 (0=off ; le robot trouve son zero, sol plat sans contact)\n"
      "  V <mm/s>   vitesse roue max = autorite de rattrapage (B-Robot ~2160)\n"
      "  T <k>      v_robot = v_roue + k*gyro (0=off, B-Robot ~1.0 ; amortit en plus de `e`)\n"
      "  D <0..6>   DLPF materiel du MPU (3=44Hz, 4=21Hz, 5=10Hz=reglage B-Robot)\n"
      "  H <mm/s>   dither : oscillation de la consigne pour traverser la zone morte\n"
      "             (jeu mecanique / frottement) ; 0 = off. Verifier le jeu a la main d'abord\n"
      "  F <mm/s>   plancher de vitesse a signe preserve : borne la latence de l'actionneur\n"
      "             pres de zero (16 mm/s = 5 ms). 0 = off. Cf. `contresens` dans `g`\n"
      "  B <deg>    balancier volontaire sur la consigne d'angle (0 = off ; ~0.5 pour\n"
      "             commencer). Empeche la consigne roue de s'immobiliser au point zero\n"
      "  x          remet les compteurs a zero (a taper avant chaque essai)\n"
      "  o <deg>    offset d'assiette absolu\n"
      "  z          capturer l'offset (pose actuelle = 0 deg)\n"
      "  Z          adopter le zero `o*` trouve par l'integrale (apres ~30 s d'equilibre\n"
      "             calme), puis `w` : supprime la derive au demarrage, meme apres reboot\n"
      "  c          recalibrer l'IMU (robot immobile+vertical, ~2 s, moteurs coupes)\n"
      "  b          recalibrer le gyro SEUL (robot POSE, pose libre, ~3 s sans toucher)\n"
      "  a [-]x|y|z axe de ROTATION du tangage = axe // a l'essieu (penche AVANT -> pitch > 0)\n"
      "             l'inclinaison de la carte autour de cet axe est libre (`z` absorbe)\n"
      "  k          inverser le signe du gyro (terme D) — montage MPU inverse\n"
      "  G <val>    echelle gyro (clones MPU6050). Mesure : `y 0.95` = angle accelero\n"
      "             (fiable) vs `y 0.9999` = angle gyro ; basculer 90 deg, ajuster.\n"
      "  l / r      inverser le sens de la roue gauche / droite\n"
      "  j <mm/s>   test roues en direct, sans equilibre (desarme seulement ; j 0 = stop)\n"
      "  --- teleguidage (le robot doit etre ARME et en equilibre) ---\n"
      "  u <mm/s> [deg/s] [ms]  piloter : avancer(+)/reculer(-), pivoter droite(+)\n"
      "             la commande EXPIRE (homme mort) — tapee a la main = une pichenette\n"
      "             de 0,5 s ; le pad du banc la rafraichit tant qu'on appuie. `u 0` = stop\n"
      "  A <deg>    inclinaison max autorisee pour se deplacer = plafond d'acceleration\n"
      "             (monter si le robot refuse d'avancer ; B-Robot : 14 normal / 26 pro)\n"
      "  P <mm/s>   fond de course vitesse d'une manette (OP_DRIVE en %)\n"
      "  R <deg/s>  fond de course rotation d'une manette\n"
      "  t          stream pitch/consigne/vitesse ON/OFF (10 Hz)\n"
      "  m          armer/desarmer les moteurs (banc d'essai)\n"
      "  w          sauver les reglages en NVS (recharges au boot)\n"
      "  f          defauts usine (efface NVS, recharge config.h)");
}

void Tuning::printState() {
  io_->printf(
      "[tune] p=%.3f d=%.3f v=%.4f i=%.5f q=%.3f o=%+.2f e=%.3f axe=%s%c invL=%d invR=%d | "
      "pitch=%+.2f glt=%lu acc=%.0f y=%.4f s=%.4f gs=%.3f trim=%+.2f | "
      "V=%.0f T=%.2f D=%u H=%.0f F=%.0f B=%.2f | conduite A=%.0f P=%.0f R=%.0f | "
      "bias=%+.2f o*=%+.2f %s%s\n",
      balance_->kiAng(), balance_->kpAng(), balance_->kpSpeed(), balance_->kiSpeed(),
      balance_->kpPos(), balance_->offsetDeg(), balance_->kdAng(), balance_->pitchSign() < 0 ? "-" : "",
      "xyz"[balance_->pitchAxis() % 3], balance_->invertLeft(), balance_->invertRight(),
      balance_->pitchDeg(), (unsigned long)balance_->glitchCount(),
      balance_->maxAccel(), balance_->filterCoef(), balance_->autoTrimGain(),
      balance_->gyroScale(), balance_->autoTrimDeg(),
      balance_->maxWheelSpeed(), balance_->speedEstTilt(), (unsigned)balance_->dlpf(),
      balance_->ditherMmS(), balance_->speedFloorMmS(), balance_->swayDeg(),
      balance_->maxLeanDeg(), balance_->teleopMaxSpeed(), balance_->teleopMaxTurn(),
      balance_->gyroBiasDps(), balance_->suggestedOffsetDeg(),
      stateName(balance_->state()), balance_->armed() ? "" : " (desarme)");
  // Bilan des coupures depuis le boot. Un run qui « a des absences » sans qu'AUCUN
  // de ces compteurs ne bouge désigne le matériel, pas le firmware.
  io_->printf("[tune] coupures : angle=%u imu=%u derive=%u saturation=%u | "
              "boucle late=%lu pire=%lums drv_muet=%u | butee %.0f%% max=%lums ecret=%.0f%% | "
              "contresens max=%lums @cmd=%ld inv_forcee=%u\n",
              balance_->cutCount(Balance::CUT_ANGLE),
              balance_->cutCount(Balance::CUT_IMU_LOST),
              balance_->cutCount(Balance::CUT_RUNAWAY),
              balance_->cutCount(Balance::CUT_SATURATION),
              (unsigned long)balance_->lateTicks(),
              (unsigned long)(balance_->worstTickUs() / 1000),
              balance_->drvMuteCount(),
              balance_->satDuty() * 100.0f,
              (unsigned long)balance_->worstSatMs(),
              balance_->slewDuty() * 100.0f,
              (unsigned long)balance_->wrongWayMs(), balance_->wrongWayCmd(),
              balance_->revForcedCount());
}

void Tuning::save() {
  Preferences prefs;
  if (!prefs.begin(NVS_NAMESPACE, /*readOnly=*/false)) {
    io_->println("[tune] ERREUR : NVS inaccessible");
    return;
  }
  prefs.putFloat("kpAngV2", balance_->kpAng());
  prefs.putFloat("kiAngV2", balance_->kiAng());
  prefs.putFloat("kdAngV2", balance_->kdAng());
  prefs.putFloat("vmax", balance_->maxWheelSpeed());
  prefs.putFloat("estTilt", balance_->speedEstTilt());
  prefs.putUChar("dlpf", balance_->dlpf());
  prefs.putFloat("dither", balance_->ditherMmS());
  prefs.putFloat("vfloor", balance_->speedFloorMmS());
  prefs.putFloat("sway", balance_->swayDeg());
  prefs.putFloat("lean", balance_->maxLeanDeg());
  prefs.putFloat("tlSpeed", balance_->teleopMaxSpeed());
  prefs.putFloat("tlTurn", balance_->teleopMaxTurn());
  // Purge des clés des générations précédentes (sinon `isKey("kpAng")` ferait
  // croire éternellement à une migration en attente). `isKey` d'abord : après un
  // `f` elles n'existent pas et `remove` loggerait une erreur NOT_FOUND.
  for (const char* dead : {"kpStab", "kdStab", "kpAng", "kiAng", "kdAng"}) {
    if (prefs.isKey(dead)) prefs.remove(dead);
  }
  prefs.putFloat("kpSpeed", balance_->kpSpeed());
  prefs.putFloat("kiSpeed", balance_->kiSpeed());
  prefs.putFloat("kpPos", balance_->kpPos());
  prefs.putFloat("offset", balance_->offsetDeg());
  prefs.putUChar("axis", balance_->pitchAxis());
  prefs.putChar("sign", balance_->pitchSign());
  prefs.putBool("invL", balance_->invertLeft());
  prefs.putBool("invR", balance_->invertRight());
  prefs.putChar("rateS", balance_->rateSign());
  prefs.putFloat("autoTrim", balance_->autoTrimGain());
  prefs.putFloat("accel", balance_->maxAccel());
  prefs.putFloat("fcoef", balance_->filterCoef());
  prefs.putFloat("gscale", balance_->gyroScale());
  prefs.end();
  io_->println("[tune] reglages sauves en NVS — penser a reporter dans config.h");
}

void Tuning::factoryReset() {
  Preferences prefs;
  if (prefs.begin(NVS_NAMESPACE, /*readOnly=*/false)) {
    prefs.clear();
    prefs.end();
  }
  balance_->applyDefaultTuning();
  io_->println("[tune] NVS efface, defauts de config.h recharges");
  printState();
}
