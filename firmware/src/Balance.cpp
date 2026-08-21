#include "Balance.h"

#include <Wire.h>

#include "config.h"

namespace {
// Angle de consigne max imposé par le PID de vitesse (limite l'inclinaison
// prise pour se déplacer).
constexpr float MAX_LEAN_DEG = 12.0f;
// Bornes de l'intégrateur de vitesse (anti-windup).
constexpr float SPEED_INTEG_LIMIT = 4000.0f;
// Temps laissé au filtre complémentaire pour converger après boot/calibration
// (l'angle part de 0 et rejoint la réalité en ~1-2 s : ne pas s'équilibrer avant).
constexpr uint32_t IMU_SETTLE_MS = 2500;

// Convertit un différentiel de rotation (deg/s) en écart de vitesse roue (mm/s).
inline float steerToWheelMmS(float degPerS) {
  return (degPerS * (float)DEG_TO_RAD) * (WHEEL_BASE_MM * 0.5f);
}

// Replie un angle dans ]-180, +180]. Les entrées sont toujours proches de la
// plage (somme de deux angles bornés), d'où la boucle plutôt qu'un fmod.
inline float wrapDeg180(float d) {
  while (d > 180.0f) d -= 360.0f;
  while (d <= -180.0f) d += 360.0f;
  return d;
}
}  // namespace

void Balance::begin(FastAccelStepper* left, FastAccelStepper* right, MPU6050* mpu) {
  left_ = left;
  right_ = right;
  mpu_ = mpu;
  // Rampe interne du driver : figée une fois pour toutes, quasi instantanée.
  // La limite d'accélération utile est appliquée par applyWheels (cf. config.h).
  left_->setAcceleration((int32_t)DRIVER_RAMP_STEPS_S2);
  right_->setAcceleration((int32_t)DRIVER_RAMP_STEPS_S2);
  applyDefaultTuning();
  setMotorsEnabled(false);
  state_ = STATE_IDLE;
  armed_ = BOOT_ARMED;
  imuValid_ = false; // pas encore de référence gyro saine
  fusedInit_ = false;
  settleUntilMs_ = millis() + IMU_SETTLE_MS;
}

void Balance::applyDefaultTuning() {
  kpAng_ = KP_ANGLE;
  kiAng_ = KI_ANGLE;
  kdAng_ = KD_ANGLE;
  kpSpeed_ = KP_SPEED;
  kiSpeed_ = KI_SPEED;
  kpPos_ = KP_POS;
  autoTrimGain_ = AUTO_TRIM_GAIN;
  offsetDeg_ = BALANCE_OFFSET_DEG;
  pitchAxis_ = DEFAULT_PITCH_AXIS; // montage MPU (config.h) : `f` reproduit `a -y`
  pitchSign_ = DEFAULT_PITCH_SIGN;
  rateSign_ = DEFAULT_RATE_SIGN;   // signe du gyro (à confirmer au banc via `k`)
  gyroScale_ = GYRO_SCALE;         // échelle gyro (clones MPU6050), console `G`
  invertLeft_ = INVERT_LEFT;
  invertRight_ = INVERT_RIGHT;
  // ⚠️ Recharger AUSSI l'accél. driver : sinon `f` (factoryReset) laissait l'ancienne
  // valeur NVS active (ex. 30000, actionneur trop lent = robot « mou/éteint »).
  setMaxAccel(MAX_ACCEL_STEPS_S2);
  setFilterCoef(FILTER_GYRO_COEF); // poids gyro de la fusion d'angle (console `y`)
  maxWheelSpeedMmS_ = MAX_WHEEL_SPEED_MM_S; // autorité de rattrapage (console `V`)
  setSpeedFloorMmS(SPEED_FLOOR_MM_S); // plancher anti-enlisement (console `F`)
  speedEstTilt_ = SPEED_EST_TILT_MM_S_PER_DPS; // correction v_robot ≠ v_roue (console `T`)
  setDlpf(MPU_DLPF_CFG);          // appliqué au prochain tick du cœur 1 (console `D`)
  setDitherMmS(0.0f);             // dither désactivé par défaut (console `H`)
  setSwayDeg(0.0f);               // balancier désactivé par défaut (console `B`)
  // ⚠️ NON NUL par défaut, et c'est volontaire : sans lui le robot tombe au point
  // d'équilibre (cf. SPEED_FLOOR_MM_S). Un `f` doit le RÉTABLIR, pas l'effacer.
  setSpeedFloorMmS(SPEED_FLOOR_MM_S);
}

void Balance::zeroOffsetHere() {
  // L'offset est replié dans ±180 : sans ça, des `z` successifs le feraient
  // dériver hors plage et `pitchDeg_` finirait par sortir de sa fenêtre utile.
  offsetDeg_ = wrapDeg180(offsetDeg_ + pitchDeg_);
  clearAngleInteg(); // le zéro vient de bouger : ∫θ et sa graine ne valent plus rien
}

void Balance::cutMotors(uint8_t cause) {
  // ⚠️ Photographier l'état AVANT resetControl(), qui remet motorSpeedMmS_ à 0 :
  // sinon le journal rapporterait « v=0 » pour toutes les coupures, c'est-à-dire
  // précisément l'information qui distingue un patinage d'une chute franche.
  if (cause < 5) cutCounts_[cause]++;
  // Un seul événement en attente : si le cœur 0 n'a pas encore lu le précédent,
  // on l'écrase. C'est voulu — la coupure la plus récente est celle qu'on regarde,
  // et écrire dans la structure pendant que l'autre cœur la lit ne peut produire
  // qu'un mélange de deux coupures, jamais un plantage (POD de scalaires alignés).
  cut_.cause = cause;
  cut_.pitchDeg = pitchDeg_;
  cut_.wheelMmS = motorSpeedMmS_;
  cut_.traveledMm = traveledMm();
  cut_.glitches = glitchCount_;
  cut_.atMs = millis();
  cutPending_ = true;

  state_ = STATE_FALLEN;
  setMotorsEnabled(false);
  resetControl();
  satTicks_ = 0;

  // --- Anti-acharnement (22/08) ---
  // Sans ça, un robot couché à 17° repasse la porte de réengagement (35°), relance
  // les roues à fond, se refait couper 1,5 s plus tard, et recommence — observé dix
  // fois d'affilée. C'est le régime qui chauffe le plus les A4988, donc exactement
  // ce qu'il ne faut pas faire quand on soupçonne une mise en sécurité thermique.
  reengageAtMs_ = millis() + REENGAGE_COOLDOWN_MS;
  // Après une SATURATION, on exige en plus une pose quasi verticale : la porte
  // large existe pour pouvoir POSER le robot à la main, pas pour qu'il s'acharne
  // depuis une position d'où il ne peut physiquement pas se relever.
  if (cause == CUT_SATURATION) strictGate_ = true;
}

void Balance::setArmed(bool on) {
  jogMmS_ = 0.0f; // tout changement d'armement stoppe le test boucle ouverte
  // Chaque armement ouvre un nouveau run : les stats de boucle repartent à zéro
  // pour que `late`/`pire` décrivent CE run, pas l'historique depuis le boot.
  // (Les compteurs de coupures, eux, restent cumulés : c'est un bilan de séance.)
  if (on) resetLoopStats();
  armed_ = on;    // la coupure effective des moteurs se fait dans update() (cœur 1)
}

void Balance::update() {
  const uint32_t now = millis();

  // --- Santé de la boucle : est-ce qu'on tourne VRAIMENT à LOOP_HZ ? ---
  // Une boucle qui cale ne coupe rien : les roues gardent leur dernière consigne
  // et le robot part sans correction. Vu de l'extérieur, c'est indiscernable d'une
  // coupure d'alimentation — d'où ce compteur, qui tranche entre les deux.
  {
    const uint32_t us = micros();
    if (lastTickUs_ != 0) {
      const uint32_t dt = us - lastTickUs_;
      if (dt > worstTickUs_) worstTickUs_ = dt;
      if (dt > (uint32_t)(LOOP_DT * 2.0f * 1e6f)) lateTicks_++;
    }
    lastTickUs_ = us;
  }

  // --- Changement de DLPF matériel demandé depuis la console (`D`) ---
  // Écrit ICI, cœur 1 : le bus I2C n'appartient qu'à cette boucle.
  if (dlpfRequest_ != dlpfCfg_) {
    dlpfCfg_ = dlpfRequest_;
    Wire.beginTransmission(0x68);
    Wire.write(0x1A); // registre CONFIG
    Wire.write(dlpfCfg_);
    Wire.endTransmission();
    fusedInit_ = false; // la dynamique du capteur change : ré-amorcer sur l'accéléro
  }

  // --- Recalibration IMU à la demande (exécutée ICI, cœur 1, pour ne pas
  //     partager le bus I2C avec le cœur 0). Bloque la boucle ~1-2 s. ---
  if (calibRequest_) {
    calibRequest_ = false;
    setMotorsEnabled(false);
    state_ = STATE_IDLE;
    resetControl();
    mpu_->calcOffsets(); // robot immobile et vertical requis
    biasEstX_ = biasEstY_ = 0.0f;
    biasSamples_ = 0;
    rateBias_ = 0.0f; // les offsets viennent d'etre remis a plat
    clearAngleInteg(); // la reference d'angle change : graine obsolete
    lastTickUs_ = 0;   // calcOffsets bloque ~1-2 s : ne pas compter ce tour comme un retard
    imuValid_ = false; // les offsets ont changé : référence gyro à reprendre
    fusedInit_ = false;
    settleUntilMs_ = millis() + IMU_SETTLE_MS;
    return; // l'équilibre repartira après convergence si le robot est droit
  }
  if (gyroCalibRequest_) {
    gyroCalibRequest_ = false;
    setMotorsEnabled(false);
    state_ = STATE_IDLE;
    resetControl();
    mpu_->calcOffsets(/*gyro=*/true, /*accel=*/false); // immobilité seule (pose libre)
    biasEstX_ = biasEstY_ = 0.0f;
    biasSamples_ = 0;
    rateBias_ = 0.0f; // les offsets viennent d'etre remis a plat
    clearAngleInteg(); // la reference d'angle change : graine obsolete
    lastTickUs_ = 0;   // calcOffsets bloque ~1-2 s : ne pas compter ce tour comme un retard
    imuValid_ = false; // les offsets ont changé : référence gyro à reprendre
    fusedInit_ = false;
    settleUntilMs_ = millis() + 1500;
    return;
  }

  mpu_->update();

  // --- Apprentissage continu du biais gyro (dérive thermique) ---
  // Le biais revient en quelques minutes quand la carte chauffe : avec un terme D
  // fort, 1°/s de biais suffit à décentrer l'équilibre et « manger » la
  // compensation. Moteurs coupés + rotation quasi nulle pendant ~3 s : le résidu
  // lu EST le biais → on le replie dans les offsets du MPU (fusion + D corrigés).
  // ⚠️ ACTIF (GYRO_BIAS_LEARNING=true dans config.h — ce commentaire disait le
  // contraire jusqu'au 13/08, corrigé). Ne tourne QUE moteurs coupés.
  // ⚠️ PIÈGE : il apprend « biais = ce que je lis à l'arrêt ». Un robot SUSPENDU à
  // une longe qui oscille lentement (< 6 °/s, donc sous le seuil) voit cette
  // oscillation absorbée comme un biais → offsets gyro faussés. Poser le robot au
  // sol pour toute calibration, ne pas le laisser pendre.
  if (GYRO_BIAS_LEARNING && !motorsOn_) {
    const float rx = mpu_->getGyroX();
    const float ry = mpu_->getGyroY();
    if (fabsf(rx) < 6.0f && fabsf(ry) < 6.0f) {
      biasEstX_ += (rx - biasEstX_) * 0.005f; // EMA, tau ~1 s a 200 Hz
      biasEstY_ += (ry - biasEstY_) * 0.005f;
      if (++biasSamples_ >= 600) {
        mpu_->setGyroOffsets(mpu_->getGyroXoffset() + biasEstX_,
                             mpu_->getGyroYoffset() + biasEstY_,
                             mpu_->getGyroZoffset());
        biasEstX_ = 0.0f;
        biasEstY_ = 0.0f;
        biasSamples_ = 0;
        // Le biais vient d'être replié dans les offsets du MPU : le suivi
        // permanent repart de zéro, sinon les deux mécanismes compteraient
        // DEUX FOIS la même correction.
        rateBias_ = 0.0f;
      }
    } else {
      biasSamples_ = 0; // mouvement : reprendre l'accumulation à zéro
    }
  } else {
    biasSamples_ = 0;
  }

  // --- Angle accéléro, INDÉPENDANT DE L'ORIENTATION DU MPU ---
  // On n'utilise PLUS getAngleX/getAngleY de MPU6050_light. Ses formules sont
  // dégénérées hors montage à plat (vérifié dans sa source, l. 189-190) :
  //   angleAccY = -atan2(accX, sqrt(accZ²+accY²)) → dénominateur toujours ≥ 0,
  //     donc plage ±90° qui SE REPLIE : à la verticale, +5° et -5° donnent la
  //     même valeur, le signe est perdu ;
  //   angleAccX = atan2(accY, sgZ*sqrt(...)) → plage ±180°, mais discontinu à
  //     ±180°, et la fusion de la lib n'a aucun `wrap` → l'estimation explose.
  // C'est ce qui avait fait abandonner le montage vertical du capteur.
  //
  // Ici : atan2 sur les DEUX composantes accéléro du plan de tangage, toutes
  // deux SIGNÉES → ±180° continu, aucune ambiguïté, quel que soit l'angle de
  // montage. Les axes sont pris dans l'ordre CYCLIQUE (i+1, i+2), ce qui garantit
  // que la dérivée de cet angle vaut exactement +gyro[i] pour les trois axes
  // (règle de la main droite) : sans ça la fusion se battrait contre elle-même.
  // Le décalage constant dû à l'inclinaison de la carte est absorbé par `o`/`z`.
  const float acc[3] = {mpu_->getAccX(), mpu_->getAccY(), mpu_->getAccZ()};
  const float gyr[3] = {mpu_->getGyroX(), mpu_->getGyroY(), mpu_->getGyroZ()};
  const uint8_t ax = pitchAxis_;
  const float accDeg = atan2f(acc[(ax + 1) % 3], acc[(ax + 2) % 3]) * RAD_TO_DEG;
  // `gyroScale_` corrige une sensibilité gyro qui ne correspond pas à GYRO_CONFIG
  // (clones MPU6050). Appliqué AVANT le rejet de glitch pour que le seuil
  // GYRO_GLITCH_JUMP_DPS reste exprimé en vrais degrés par seconde.
  const float rawRate = gyr[ax] * gyroScale_;

  // --- Rejet des lectures IMU corrompues (timeout I2C → gyro fantôme) ---
  // MPU6050_light::fetchData() ne teste pas requestFrom() : sur timeout elle rend
  // du garbage (pics ±380°/s observés au run 16). Un tel saut est physiquement
  // impossible en un tick — on jette l'échantillon AVANT qu'il ne pollue l'angle,
  // le terme D ou l'ancre. La boucle sort sans toucher aux roues, qui gardent leur
  // consigne pour ce tick (5 ms : le robot ne bouge quasiment pas).
  if (imuValid_ && fabsf(rawRate - lastRawRate_) > GYRO_GLITCH_JUMP_DPS) {
    glitchCount_++;
    if (++consecutiveGlitch_ >= IMU_LOST_TICKS) {
      // L'IMU ment en continu (bus mort/nappe débranchée) : tenir la dernière
      // consigne à l'aveugle serait le pire cas → on coupe.
      if (state_ != STATE_FALLEN) cutMotors(CUT_IMU_LOST);
      consecutiveGlitch_ = 0;
    }
    return;
  }
  consecutiveGlitch_ = 0;
  lastRawRate_ = rawRate;
  imuValid_ = true;

  // --- Suivi PERMANENT du biais gyro (recette B-Robot, cf. config.h) ---
  // L'apprentissage plus haut ne tourne QUE moteurs coupés : pendant un run, la
  // dérive thermique s'installe sans personne pour la corriger, et le filtre
  // complémentaire la transforme en erreur d'angle (≈ biais × τ). Ici on suit le
  // biais EN CONTINU, y compris en équilibre.
  // Le clamp est pris AUTOUR de l'estimation courante, pas autour de zéro : une
  // vraie rotation (chute, virage) sort de la fenêtre et n'entre donc dans la
  // moyenne que bornée à ±0.15 °/s. Combiné à α = 2.5e-4, le biais ne peut bouger
  // que de ~0.0075 °/s par seconde — trop lent pour manger une inclinaison réelle,
  // assez rapide pour suivre une dérive thermique de quelques °/s par minute.
  const float clampedRate = constrain(rawRate,
                                      rateBias_ - GYRO_BIAS_TRACK_CLAMP_DPS,
                                      rateBias_ + GYRO_BIAS_TRACK_CLAMP_DPS);
  rateBias_ += GYRO_BIAS_TRACK_ALPHA * (clampedRate - rateBias_);
  // Vitesse angulaire corrigée : c'est ELLE qui alimente la fusion ET le terme D.
  const float rate = rawRate - rateBias_;

  // --- Filtre complémentaire MAISON, insensible au passage par ±180° ---
  // Gain par rapport à la lib : le rejet de glitch ci-dessus protège désormais
  // VRAIMENT l'angle. Avec la fusion interne de MPU6050_light, l'échantillon
  // corrompu était déjà intégré par mpu_->update() avant qu'on puisse le jeter ;
  // on n'écartait que sa propagation au terme D.
  if (!fusedInit_) {
    fusedDeg_ = accDeg; // amorçage : on fait confiance à l'accéléro seul
    fusedInit_ = true;
  } else {
    const float predicted = fusedDeg_ + rate * LOOP_DT;
    // L'écart est replié dans ±180° AVANT d'être pondéré : c'est tout l'intérêt.
    // Sans ce repli, un accDeg à +179° et une prédiction à -179° donneraient une
    // erreur de 358° au lieu de 2°, et la fusion partirait en vrille.
    const float err = wrapDeg180(accDeg - predicted);
    fusedDeg_ = wrapDeg180(predicted + (1.0f - filterGyroCoef_) * err);
  }

  // ⚠️ REPLI OBLIGATOIRE ICI AUSSI (bug corrigé le 13/08). `fusedDeg_` vit dans
  // ]-180,+180] : près de ce point de bascule il passe de +179 à -179, deux valeurs
  // qui décrivent la MÊME attitude. Sans ce wrap, `pitchDeg_` faisait un bond de
  // 360° et le robot se croyait à l'envers. C'est ce qui rendait le montage
  // dépendant de l'orientation alors que tout le reste ne l'est pas. Le robot
  // tombe à 40°, donc sa plage utile n'approche jamais 180 : le repli est sûr.
  pitchDeg_ = wrapDeg180((float)pitchSign_ * fusedDeg_ - offsetDeg_);
  // Signe du gyro vérifiable/corrigeable indépendamment de l'angle (console `k`) :
  // monté à l'envers, gyroY peut être inversé vs angleY → terme D anti-amortisseur.
  const float gyroRate = (float)rateSign_ * (float)pitchSign_ * rate; // deg/s
  lastGyroRate_ = gyroRate;

  // --- Interrupteur banc d'essai (console série `m`) ---
  if (!armed_) {
    const float jog = jogMmS_;
    if (jog != 0.0f) {
      // Test roues en boucle ouverte (console `j`) : vitesse constante, sans PID.
      if (!motorsOn_) setMotorsEnabled(true);
      applyWheels(jog, jog);
    } else if (state_ != STATE_IDLE || motorsOn_) {
      state_ = STATE_IDLE;
      setMotorsEnabled(false);
      resetControl();
    }
    return;
  }

  // Expiration d'un déplacement temporisé (FORWARD/BACKWARD/TURN/LOOK).
  taskENTER_CRITICAL(&mux_);
  const bool motionExpired = motionEndMs_ != 0 && (int32_t)(now - motionEndMs_) >= 0;
  if (motionExpired) {
    cmdSpeed_ = 0.0f;
    cmdSteer_ = 0.0f;
    motionEndMs_ = 0;
  }
  const float cmdSpeed = cmdSpeed_;
  const float cmdSteer = cmdSteer_;
  taskEXIT_CRITICAL(&mux_);

  // Filtre pas encore convergé (post-boot/calib) : on observe sans agir.
  if ((int32_t)(settleUntilMs_ - now) > 0) return;

  // --- Sécurité : détection de chute ---
  if (fabsf(pitchDeg_) > FALL_LIMIT_DEG) {
    if (state_ != STATE_FALLEN) cutMotors(CUT_ANGLE);
    return;
  }
  if (state_ != STATE_BALANCING) {
    // Au repos ou tombé : on ne relance l'équilibre que si le robot est proche
    // de la verticale ET quasi immobile (posé à l'équilibre à la main).
    // Deux verrous supplémentaires depuis le 22/08 (cf. cutMotors) : un délai
    // après toute coupure, et une porte resserrée tant qu'on n'a pas reposé le
    // robot droit après une saturation.
    const float gate = strictGate_ ? STRICT_RECOVER_LIMIT_DEG : RECOVER_LIMIT_DEG;
    if ((int32_t)(reengageAtMs_ - now) > 0) return;
    if (fabsf(pitchDeg_) < gate && fabsf(gyroRate) < RECOVER_RATE_DEG_S) {
      state_ = STATE_BALANCING;
      strictGate_ = false; // reposé droit : on rend sa souplesse à la porte
      setMotorsEnabled(true);
      resetControl();
      posAnchorSteps_ = forwardSteps(); // « ici » devient le point à tenir
    } else {
      return;
    }
  }

  // --- Sécurité anti-emballement (roues dans le vide / suite de glitch) ---
  // ⚠️ CORRIGÉ 22/08 — CE TEST ÉTAIT LUI-MÊME UN SUSPECT DE « L'ABSENCE ».
  // Le raisonnement d'origine (« l'ancre borne la course à quelques centimètres »)
  // n'est vrai QUE si l'ancre est asservie, c'est-à-dire si kpPos_ > 0. Or on
  // tourne avec KP_POS = 0 (base B-Robot) : l'ancre est alors posée une fois à
  // l'engagement et plus jamais recentrée, donc `traveledMm()` mesure la dérive
  // CUMULÉE depuis le début du run. Un robot qui équilibre BIEN dérive quand même
  // de quelques centimètres par seconde → il finit par franchir la limite alors
  // qu'il est parfaitement vertical, et les moteurs se coupent d'un coup. Vu de
  // l'extérieur : « il a une absence alors que rien n'a changé ». Le test ne
  // s'applique donc plus que si l'ancre est réellement en service.
  if (kpPos_ > 0.0f && RUNAWAY_LIMIT_MM > 0.0f &&
      fabsf(traveledMm()) > RUNAWAY_LIMIT_MM) {
    cutMotors(CUT_RUNAWAY);
    return;
  }
  // Détecteur d'emballement qui, lui, ne dépend pas de l'ancre : une roue
  // commandée à fond EN CONTINU n'est plus un rattrapage. Un vrai rattrapage
  // sature quelques dixièmes de seconde ; au-delà, le robot est soulevé, une roue
  // patine, ou la consigne s'est emballée. C'est ce test qui protège vraiment.
  const bool saturated = fabsf(motorSpeedMmS_) >= 0.95f * maxWheelSpeedMmS_;
  // Statistiques d'occupation de la butée : c'est ce qui permet de comparer deux
  // réglages objectivement (cf. satDuty/worstSatMs dans Balance.h).
  satDuty_ += ((saturated ? 1.0f : 0.0f) - satDuty_) * (LOOP_DT / 2.0f); // EMA ~2 s
  // Idem pour l'écrêtage de la limite d'accélération, relevé par applyWheels au
  // tour précédent. Les deux mesures ne disent pas la même chose : la butée dit
  // « je voudrais aller plus vite », l'écrêtage dit « je voudrais CHANGER de
  // vitesse plus vite » — et c'est le second qui rend un robot impossible à
  // stabiliser, parce qu'il coupe la boucle au moment précis du rattrapage.
  slewDuty_ += ((slewClipped_ ? 1.0f : 0.0f) - slewDuty_) * (LOOP_DT / 2.0f);
  slewClipped_ = false;
  if (saturated) {
    const uint32_t ms = (uint32_t)(satTicks_ * LOOP_DT * 1000.0f);
    if (ms > worstSatMs_) worstSatMs_ = ms;
    if (++satTicks_ > (uint16_t)(RUNAWAY_SAT_MS / (LOOP_DT * 1000.0f))) {
      cutMotors(CUT_SATURATION);
      return;
    }
  } else {
    satTicks_ = 0;
  }

  // --- Ancre de position : rappel doux vers le point d'engagement ---
  // Pendant un déplacement commandé, l'ancre suit le robot (pas de rappel) ;
  // à l'arrêt, l'écart de position se convertit en consigne de vitesse bornée.
  float returnMmS = 0.0f;
  if (cmdSpeed != 0.0f || cmdSteer != 0.0f) {
    posAnchorSteps_ = forwardSteps();
  } else {
    returnMmS = constrain(-kpPos_ * traveledMm(),
                          -POS_RETURN_MAX_MM_S, POS_RETURN_MAX_MM_S);
  }

  // --- Estimation de la vitesse du ROBOT (≠ vitesse des roues) ---
  // Recette B-Robot : quand le corps pivote, les roues et le centre de masse ne
  // vont pas à la même vitesse. Injecter la vitesse ROUE brute dans la boucle
  // externe, c'est lui mentir exactement au moment où elle compte (pendant un
  // rattrapage). speedEstTilt_ = 0 ⇒ comportement d'avant (console `T`).
  // Le passe-bas évite que le bruit de la boucle interne remonte dans la consigne
  // d'angle : le B-Robot filtre à 0.9 @100 Hz, on fait le même τ à 200 Hz.
  const float rawEstSpeed = motorSpeedMmS_ + speedEstTilt_ * gyroRate;
  estSpeedMmS_ = SPEED_EST_FILTER * estSpeedMmS_ + (1.0f - SPEED_EST_FILTER) * rawEstSpeed;

  // --- Boucle externe (vitesse) : erreur de vitesse → angle de consigne ---
  // ⚠️ Cette boucle est NON MINIMUM DE PHASE : pour avancer, le robot doit d'abord
  // reculer ses roues afin de se pencher. Sa réponse initiale va donc dans le
  // mauvais sens, et c'est la raison de fond pour laquelle `v` et `i` doivent
  // rester PETITS — une boucle externe rapide se bat contre sa propre réponse.
  const float speedError = cmdSpeed + returnMmS - estSpeedMmS_;
  const float speedIntegPrev = speedInteg_;
  speedInteg_ += speedError * LOOP_DT;
  speedInteg_ = constrain(speedInteg_, -SPEED_INTEG_LIMIT, SPEED_INTEG_LIMIT);
  float targetAngle = kpSpeed_ * speedError + kiSpeed_ * speedInteg_;
  // Anti-windup conditionnel (ajouté 22/08 — il manquait ici alors qu'il existait
  // déjà sur ∫θ). Quand la consigne d'angle est DÉJÀ en butée, continuer
  // d'accumuler ne change plus rien à la sortie mais rend le retour interminable.
  // Cas concret qui l'a révélé : roues en l'air, ou décrochage moteur, ou
  // patinage — la boucle est ouverte, l'erreur ne diminue jamais, l'intégrateur
  // part à fond. Quand l'adhérence revient, le contrôleur commande encore
  // pleine bourre dans une direction qui n'est plus la bonne. Un décrochage se
  // payait donc DEUX fois : pendant, puis après.
  if (fabsf(targetAngle) > MAX_LEAN_DEG && (targetAngle > 0) == (speedError > 0)) {
    speedInteg_ = speedIntegPrev; // gel : la sortie est déjà saturée
    targetAngle = kpSpeed_ * speedError + kiSpeed_ * speedInteg_;
  }
  targetAngle = constrain(targetAngle, -MAX_LEAN_DEG, MAX_LEAN_DEG);
  // Balancier volontaire (console `B`) : phase accumulee plutot que sinf(millis()),
  // dont l'argument croissant perd sa precision au bout de quelques heures.
  if (swayDeg_ != 0.0f) {
    swayPhase_ += 2.0f * PI * SWAY_HZ * LOOP_DT;
    if (swayPhase_ > 2.0f * PI) swayPhase_ -= 2.0f * PI;
    targetAngle += swayDeg_ * sinf(swayPhase_);
  }
  targetAngle += gestureAngleBias(now); // les gestes penchent brièvement le robot
  lastTargetDeg_ = targetAngle;

  // --- Boucle interne (stabilité) : FORME VITESSE v = Kp·θ + Ki·∫θ + Kd·θ̇ ---
  // Refactor 24/07 (cf. docs/COMPARAISON.md §1). L'ancienne forme sortait une
  // accélération intégrée en vitesse (v = kd·θ + kp·∫θ), SANS terme en θ̇ : pas
  // d'amortissement direct, et le gyro brut intégré transformait tout biais en
  // dérive de vitesse. Ici la sortie EST la vitesse : kdAng_·gyroRate amortit
  // immédiatement, et le biais gyro ne donne qu'un offset constant (pas une rampe).
  //
  // ⚠️ 21/08 : le terme kiAng_·∫θ n'est PAS une finition, c'est le terme DOMINANT
  // (cf. KI_ANGLE dans config.h). C'est lui, et lui seul, qui annule une erreur
  // statique sur le zéro d'assiette ; à kiAng_ = 0 le robot part en ligne droite
  // et tombe, quels que soient les autres gains. C'est l'équivalent exact du terme
  // proportionnel du B-Robot, dont la boucle sort une accélération intégrée.
  const float angleError = pitchDeg_ - targetAngle - autoTrimDeg_;
  angleInteg_ += angleError * LOOP_DT;
  angleInteg_ = constrain(angleInteg_, -ANGLE_INTEG_LIMIT, ANGLE_INTEG_LIMIT); // anti-windup
  motorSpeedMmS_ = kpAng_ * angleError + kiAng_ * angleInteg_ + kdAng_ * gyroRate;
  const float vMax = maxWheelSpeedMmS_; // réglable en direct (console `V`)
  // Anti-windup « conditionnel » : tant que la roue est en butée, continuer
  // d'accumuler ∫θ ne sert qu'à rendre le retour plus long. On annule donc le
  // dernier incrément si la sortie sature DANS LE MÊME SENS que l'erreur.
  // Indispensable maintenant que Ki est le terme dominant : sans ça, une seule
  // excursion en butée laisse le robot commandé à fond plusieurs dixièmes de
  // seconde après être revenu à la verticale.
  if (fabsf(motorSpeedMmS_) > vMax && (motorSpeedMmS_ > 0) == (angleError > 0)) {
    angleInteg_ -= angleError * LOOP_DT;
  }
  motorSpeedMmS_ = constrain(motorSpeedMmS_, -vMax, vMax);

  // --- Graine de ∫θ : mémoriser la compensation trouvée en régime CALME ---
  // C'est ce qui sera réinjecté au prochain engagement (cf. resetControl). On ne
  // l'alimente que quand le robot tient VRAIMENT — sinon on mémoriserait le
  // windup d'une chute et le prochain départ serait pire que sans graine.
  // EMA lente (τ ≈ 2 s) : la graine suit la moyenne, pas les à-coups.
  if (fabsf(pitchDeg_) < 5.0f && fabsf(motorSpeedMmS_) < 250.0f &&
      cmdSpeed == 0.0f && cmdSteer == 0.0f) {
    angleIntegSeed_ += (angleInteg_ - angleIntegSeed_) * (LOOP_DT / 2.0f);
  }

  // --- Auto-trim du zéro θ₀ (recette Brokking self_balance_pid_setpoint) ---
  // À l'arrêt commandé (et hors geste), une vitesse roue résiduelle = le robot roule
  // pour rester sous son CdM → c'est le SIGNE de l'erreur sur θ₀. On décale TRÈS
  // lentement le point d'équilibre pour l'annuler (θ₀ ← θ₀ − gain·v·dt). Désactivé si
  // autoTrimGain_ == 0. Contre-réaction lente à NE PAS confondre avec Ki·∫θ (qui, lui,
  // aggraverait un θ₀ faux) : elle porte sur la vitesse, pas l'angle. Cf. docs/TUNING.md.
  if (autoTrimGain_ != 0.0f && cmdSpeed == 0.0f && cmdSteer == 0.0f && gestureOp_ == 0) {
    autoTrimDeg_ -= autoTrimGain_ * motorSpeedMmS_ * LOOP_DT;
    autoTrimDeg_ = constrain(autoTrimDeg_, -AUTO_TRIM_LIMIT_DEG, AUTO_TRIM_LIMIT_DEG);
  }

  // --- Direction : différentiel gauche/droite ---
  const float steerMmS = steerToWheelMmS(cmdSteer + gestureSteerBias(now));
  applyWheels(motorSpeedMmS_ + steerMmS, motorSpeedMmS_ - steerMmS);
  // Le driver a-t-il vraiment obéi ? (diagnostic de « l'absence » — cf. DrvInfo)
  checkDriverFollows();
}

void Balance::applyWheels(float leftMmS, float rightMmS) {
  // --- LIMITATION D'ACCÉLÉRATION CÔTÉ CONTRÔLEUR (recette B-Robot, 22/08) ---
  // C'est le cœur du correctif de « l'absence ». Avant, l'accélération était
  // déléguée au générateur de rampe de FastAccelStepper : on lui balançait une
  // consigne éloignée et on le laissait se débrouiller. Résultat mesuré, il
  // s'enlisait en RAMP_STATE_REVERSE et n'y arrivait pas (cf. DRIVER_RAMP_STEPS_S2).
  // Désormais c'est NOUS qui bornons le pas de consigne à chaque tour — exactement
  // ce que fait le B-Robot avec `MAX_ACCEL` (14 unités par tick de 10 ms) — et le
  // driver n'a plus qu'à exécuter une consigne toujours proche de sa vitesse
  // actuelle. Bénéfice de fond : le contrôleur SAIT ce que l'actionneur va faire,
  // au lieu de l'espérer.
  const long maxStep = max(1L, lroundf(maxAccelStepsS2_ * LOOP_DT));
  const bool force = forceReissue_;
  // --- Dither optionnel (console `H`, 0 = off) ---
  // Petite oscillation ajoutée à la consigne pour que la transmission ne soit
  // JAMAIS à l'arrêt : c'est le remède classique au frottement statique et au
  // JEU MÉCANIQUE, qui créent une zone morte exactement autour de la vitesse
  // nulle — d'où un robot qui tient en mouvement et lâche au point zéro.
  // Ajouté APRÈS la limitation d'accélération (sinon le limiteur le raboterait)
  // et hors du cache `lastSps` (sinon il polluerait l'état du limiteur).
  // Moyenne nulle par construction : aucune dérive.
  if (++ditherTick_ >= DITHER_PERIOD_TICKS) {
    ditherTick_ = 0;
    ditherPhase_ = !ditherPhase_;
  }
  const long dither = ditherSps_ == 0 ? 0 : (ditherPhase_ ? ditherSps_ : -ditherSps_);
  // ─── Phase 1 : calculer les consignes des DEUX roues ────────────────────
  // Il faut les connaitre AVANT de decider quoi que ce soit, parce que le verrou
  // de la phase 2 compare le sens DEMANDE au sens ou va reellement la rampe.
  auto plan = [&](float mmS, bool invert, long lastSps, long& sps, long& out) {
    long want = lroundf(mmS * STEPS_PER_MM);
    if (invert) want = -want;
    sps = constrain(want, lastSps - maxStep, lastSps + maxStep);
    // Le limiteur a-t-il écrêté ? Tant qu'il écrête, le contrôleur commande dans
    // le vide : sa sortie n'atteint plus l'actionneur. C'est une boucle OUVERTE,
    // et c'est invisible autrement (cf. slewDuty).
    if (sps != want) slewClipped_ = true;
    // Le dither doit etre COMMUN aux deux roues (avant/arriere), pas differentiel.
    // Il est exprime en pas MOTEUR : il faut donc lui appliquer la meme inversion
    // qu'a la consigne. Sans ca, +dither sur les deux moteurs = une roue avance et
    // l'autre recule : une oscillation en LACET, pas en translation (22/08).
    out = sps + (invert ? -dither : dither);
    // Plancher de vitesse a SIGNE PRESERVE (console `F`) : borne la latence de la
    // file d'impulsions, qui diverge quand la consigne tend vers zero (cf. Balance.h).
    // Applique apres le limiteur et hors du cache `lastSps`.
    if (floorSps_ > 0 && out != 0 && labs(out) < floorSps_) {
      out = out > 0 ? floorSps_ : -floorSps_;
    }
  };
  long spsL, outL, spsR, outR;
  plan(leftMmS, invertLeft_, lastSpsL_, spsL, outL);
  plan(rightMmS, invertRight_, lastSpsR_, spsR, outR);

  // ─── Phase 2 : VERROU D'INVERSION, COMMUN AUX DEUX ROUES (23/08) ────────
  // Le critere n'est PAS l'etat de rampe, c'est le DESACCORD DE SENS : la rampe
  // va-t-elle la ou la consigne demande ?
  //
  // Premiere version de ce correctif : on testait `== RAMP_STATE_REVERSE` (12).
  // Mesure au banc apres coup : les enlisements se presentaient en `DECELERATE`
  // (68 = COUNT_DOWN|4, 36 = COUNT_UP|4), pas en REVERSE — le test ne se
  // declenchait donc jamais. La rampe annonce « je decelere en marche arriere »
  // avec une vitesse reelle DEJA nulle (-1 pas/s) et une consigne a +1180 : elle
  // decelere depuis zero vers zero, et ne declare jamais avoir fini.
  //
  // Le desaccord de sens attrape les deux formes, et toute autre a venir.
  auto disagrees = [](uint8_t rs, long out) {
    if (out == 0) return false;
    if ((rs & RAMP_STATE_MASK) == RAMP_STATE_IDLE) return false; // rien en cours
    const bool up = (rs & RAMP_DIRECTION_COUNT_UP) != 0;
    const bool down = (rs & RAMP_DIRECTION_COUNT_DOWN) != 0;
    if (up == down) return false; // sens pas encore etabli : laisser faire
    return (out > 0) != up;
  };
  uint8_t rsL = left_->rampState();
  uint8_t rsR = right_->rampState();
  // Verrou COMMUN : le mecanisme est symetrique (meme consigne, meme file, les deux
  // roues sommees d'inverser au meme instant), mais l'aboutissement depend de l'etat
  // de remplissage de chaque file et de la phase electrique de chaque rotor, qui sont
  // independants. C'est une course, et une course a un gagnant : mesure au banc,
  // gauche morte 3 fois, droite 3 fois, les deux 3 fois. Le probleme n'est donc pas
  // la dissymetrie de la CAUSE mais l'accumulation de la CONSEQUENCE — rien ne mesure
  // le lacet, donc chaque pile ou face depose une erreur de cap definitive. En gelant
  // les deux ensemble, le robot perd son autorite EN LIGNE DROITE : rattrapable, et
  // sans trace de cap.
  if (!force && (disagrees(rsL, outL) || disagrees(rsR, outR))) {
    // A BASSE VITESSE on ne NEGOCIE PAS l'inversion : on l'abolit.
    // forceStopAndNewPosition abandonne les ordres en attente sur-le-champ, et la
    // consigne suivante repart d'un moteur A L'ARRET — donc sans inversion du tout.
    // Licite tant qu'il n'y a pas d'inertie a menager : sous REVERSE_FORCE_MAX_SPS on
    // est tres en dessous de la frequence de demarrage/arret d'un NEMA 17. Or c'est
    // exactement le regime ou le piege se referme (mesure : 747 a 1833 pas/s).
    // A vitesse elevee, un arret sec ferait perdre des pas : on laisse alors la rampe
    // travailler, REVERSE_MAX_TICKS servant de garde-fou. Geler les roues coute cher
    // (40 ms = 60 % de tau), ce chemin doit rester l'exception.
    const int32_t actL = left_->getCurrentSpeedInMilliHz() / 1000;
    const int32_t actR = right_->getCurrentSpeedInMilliHz() / 1000;
    const bool slow = labs(actL) < REVERSE_FORCE_MAX_SPS &&
                      labs(actR) < REVERSE_FORCE_MAX_SPS;
    if (slow || ++revTicks_ >= REVERSE_MAX_TICKS) {
      left_->forceStopAndNewPosition(left_->getCurrentPosition());
      right_->forceStopAndNewPosition(right_->getCurrentPosition());
      revForcedCount_++;
      rsL = rsR = RAMP_STATE_IDLE; // l'etat lu plus haut ne vaut plus rien
    } else {
      return; // vitesse elevee : laisser la rampe terminer l'inversion
    }
  }
  revTicks_ = 0;

  // ─── Phase 3 : emettre ──────────────────────────────────────────────────
  auto emit = [&](FastAccelStepper* s, long sps, long out, long& lastSps,
                  long& sentSps, uint8_t rs) {
    // Consigne inchangee : ne pas re-generer la rampe pour rien. `force` couvre le
    // cas d'un driver qu'on vient d'arreter (setMotorsEnabled), dont le cache ne
    // reflete plus l'etat reel.
    if (out == sentSps && !force && rs != RAMP_STATE_IDLE) return;
    lastSps = sps;   // état du limiteur : SANS le dither
    sentSps = out;   // ce qui part réellement au driver : AVEC
    if (out == 0) {
      // Seul cas où la vitesse n'est pas exprimable : setSpeedInHz(0) est invalide.
      s->stopMove();
      return;
    }
    s->setSpeedInHz((uint32_t)labs(out));
    // Meme sens : applySpeedAcceleration() met a jour la vitesse SANS repasser par
    // la planification de direction. runForward/runBackward n'est appele que quand
    // le sens change reellement — au lieu de 200 fois par seconde comme avant.
    const bool wantFwd = out > 0;
    const bool running = (rs & RAMP_STATE_MASK) != RAMP_STATE_IDLE;
    const bool runningFwd = (rs & RAMP_DIRECTION_COUNT_UP) != 0;
    if (running && wantFwd == runningFwd) s->applySpeedAcceleration();
    else if (wantFwd) s->runForward();
    else s->runBackward();
  };
  emit(left_, spsL, outL, lastSpsL_, sentSpsL_, rsL);
  emit(right_, spsR, outR, lastSpsR_, sentSpsR_, rsR);
  forceReissue_ = false;
}

void Balance::checkDriverFollows() {
  // ⚠️ On compare à la consigne RÉELLEMENT ENVOYÉE (après limitation
  // d'accélération), pas à la sortie brute du contrôleur. Comparer à la sortie
  // brute revenait à compter comme « driver muet » chaque instant où NOTRE
  // limiteur écrêtait volontairement — un faux positif garanti, et la métrique
  // ne voulait plus rien dire (11 alertes relevées au banc pour cette raison).
  const long cmdL = sentSpsL_;
  const long cmdR = sentSpsR_;
  const int32_t actL = left_->getCurrentSpeedInMilliHz() / 1000;
  const int32_t actR = right_->getCurrentSpeedInMilliHz() / 1000;

  // « Muet » = on demande une vitesse franche et la rampe reste sous le quart.
  // Le seuil bas évite de compter les consignes minuscules, et la fenêtre de
  // DRIVER_MUTE_MS laisse passer les rampes légitimes (à 170 000 pas/s², monter
  // au quart d'une consigne de 7000 pas/s prend ~10 ms).
  auto mute = [](long cmd, int32_t act) {
    return labs(cmd) > DRIVER_MUTE_MIN_SPS && labs(act) * 4 < labs(cmd);
  };
  // --- CONTRESENS (sans seuil) : la rampe tourne a l'oppose de la consigne. ---
  // C'est la mesure qui manquait sous DRIVER_MUTE_MIN_SPS. Cf. wrongWayMs.
  auto wrongWay = [](long cmd, int32_t act) {
    return cmd != 0 && act != 0 && ((cmd > 0) != (act > 0));
  };
  if (wrongWay(cmdL, actL) || wrongWay(cmdR, actR)) {
    wrongWayTicks_++;
    const uint32_t ms = (uint32_t)(wrongWayTicks_ * LOOP_DT * 1000.0f);
    if (ms > wrongWayMs_) {
      wrongWayMs_ = ms;
      wrongWayCmd_ = labs(cmdL) > labs(cmdR) ? cmdL : cmdR;
    }
  } else {
    wrongWayTicks_ = 0;
  }

  if (mute(cmdL, actL) || mute(cmdR, actR)) {
    if (++drvMuteTicks_ == (uint16_t)(DRIVER_MUTE_MS / (LOOP_DT * 1000.0f))) {
      drvMuteCount_++;
      drv_.cmdL = cmdL;
      drv_.cmdR = cmdR;
      drv_.actL = actL;
      drv_.actR = actR;
      drv_.rampL = left_->rampState();
      drv_.rampR = right_->rampState();
      drv_.atMs = millis();
      drvPending_ = true;
    }
  } else {
    drvMuteTicks_ = 0;
  }
}

void Balance::setMotorsEnabled(bool on) {
  motorsOn_ = on;
  // A4988 : /ENABLE actif à l'état BAS.
  digitalWrite(PIN_MOTOR_ENABLE, on ? LOW : HIGH);
  if (!on) {
    left_->forceStopAndNewPosition(left_->getCurrentPosition());
    right_->forceStopAndNewPosition(right_->getCurrentPosition());
  }
  // ⚠️ BUG CORRIGÉ 22/08 — invalider le cache de consigne. applyWheels() saute
  // l'envoi quand la consigne est identique à la précédente (`sps == lastSps`),
  // pour ne pas re-générer la rampe à 200 Hz. Mais forceStopAndNewPosition()
  // ci-dessus a arrêté le driver SANS que ce cache le sache : si, au
  // réengagement, la première consigne calculée retombait par hasard sur
  // l'ancienne valeur, aucun runForward() n'était émis et les roues restaient
  // MORTES alors que le contrôleur se croyait actif. Le cache repart donc de 0 —
  // l'état réel du driver après l'arrêt — et `forceReissue_` garantit que la
  // prochaine consigne part vraiment, même si elle vaut elle aussi 0.
  // (Une sentinelle type LONG_MIN serait ici un piège : depuis le 22/08 le cache
  // sert AUSSI de point de départ à la limitation d'accélération.)
  lastSpsL_ = lastSpsR_ = 0;
  forceReissue_ = true;
}

void Balance::setMaxAccel(float stepsS2) {
  // ⚠️ Ne touche PLUS à l'accélération du driver (22/08). C'est désormais une
  // limite appliquée par le contrôleur dans applyWheels ; la rampe interne du
  // driver reste figée à DRIVER_RAMP_STEPS_S2 (quasi instantanée). La console `n`
  // garde exactement le même sens pour l'utilisateur — « à quelle vitesse la
  // consigne roue a le droit de changer » — seul le lieu d'application change.
  maxAccelStepsS2_ = stepsS2;
}

void Balance::resetControl() {
  motorSpeedMmS_ = 0.0f;
  estSpeedMmS_ = 0.0f;
  speedInteg_ = 0.0f;
  // ⚠️ ∫θ N'EST PAS remis à zéro : il est REPRIS à sa dernière valeur d'équilibre
  // stable (`angleIntegSeed_`). Repartir de 0 obligeait Ki à re-découvrir l'erreur
  // de zéro θ₀ À CHAQUE ENGAGEMENT — c'est exactement la « dérive du départ » :
  // le robot part, puis se rattrape une fois l'intégrale remontée. En la semant,
  // le premier tick démarre déjà avec la compensation apprise.
  // La graine n'est alimentée QUE pendant un équilibre calme (cf. update()), donc
  // une chute ou un emballement ne peut pas la polluer.
  angleInteg_ = constrain(angleIntegSeed_, -ANGLE_INTEG_LIMIT, ANGLE_INTEG_LIMIT);
  lastTargetDeg_ = 0.0f;
  taskENTER_CRITICAL(&mux_);
  cmdSpeed_ = 0.0f;
  cmdSteer_ = 0.0f;
  motionEndMs_ = 0;
  gestureOp_ = 0;
  taskEXIT_CRITICAL(&mux_);
}

// ─────────────────────────────────────────────────────────────────────────
//  Réception des commandes (cœur 0)
// ─────────────────────────────────────────────────────────────────────────
void Balance::onCommand(uint8_t op, const uint8_t* payload, size_t len) {
  auto i16 = [&](void) -> int16_t {
    return len >= 2 ? (int16_t)(payload[0] | (payload[1] << 8)) : 0; // little-endian
  };
  switch (op) {
    case OP_STOP: {
      taskENTER_CRITICAL(&mux_);
      cmdSpeed_ = 0.0f;
      cmdSteer_ = 0.0f;
      motionEndMs_ = 0;
      gestureOp_ = 0;
      taskEXIT_CRITICAL(&mux_);
      break;
    }
    case OP_FORWARD: {
      float cm = i16();
      startTimedMotion(+CRUISE_SPEED_MM_S, 0.0f,
                       (uint32_t)(fabsf(cm) * 10.0f / CRUISE_SPEED_MM_S * 1000.0f));
      break;
    }
    case OP_BACKWARD: {
      float cm = i16();
      startTimedMotion(-CRUISE_SPEED_MM_S, 0.0f,
                       (uint32_t)(fabsf(cm) * 10.0f / CRUISE_SPEED_MM_S * 1000.0f));
      break;
    }
    case OP_TURN: {
      float deg = i16();
      float rate = deg >= 0 ? TURN_RATE_DEG_S : -TURN_RATE_DEG_S;
      startTimedMotion(0.0f, rate, (uint32_t)(fabsf(deg) / TURN_RATE_DEG_S * 1000.0f));
      break;
    }
    case OP_LOOK: {
      // Petit coup d'œil = brève rotation sur place (gauche/droite seulement).
      uint8_t dir = len >= 1 ? payload[0] : LOOK_CENTER;
      if (dir == LOOK_LEFT) startTimedMotion(0.0f, -TURN_RATE_DEG_S, 250);
      else if (dir == LOOK_RIGHT) startTimedMotion(0.0f, +TURN_RATE_DEG_S, 250);
      break;
    }
    case OP_NOD:
    case OP_BOW:
    case OP_WIGGLE:
      triggerGesture(op);
      break;
    case OP_CALIBRATE:
      requestImuCalibration();
      break;
    default:
      break; // opcode inconnu : ignoré
  }
}

void Balance::startTimedMotion(float speedMmS, float steerDegS, uint32_t durationMs) {
  taskENTER_CRITICAL(&mux_);
  cmdSpeed_ = speedMmS;
  cmdSteer_ = steerDegS;
  motionEndMs_ = millis() + (durationMs == 0 ? 1 : durationMs);
  taskEXIT_CRITICAL(&mux_);
}

void Balance::triggerGesture(uint8_t op) {
  taskENTER_CRITICAL(&mux_);
  gestureOp_ = op;
  gestureStartMs_ = millis();
  taskEXIT_CRITICAL(&mux_);
}

// ─────────────────────────────────────────────────────────────────────────
//  Gestes « numéro de cirque » : petites modulations temporisées de l'assiette
//  ou de la direction. Purement expressifs, sans déplacement net.
// ─────────────────────────────────────────────────────────────────────────
float Balance::gestureAngleBias(uint32_t nowMs) {
  uint8_t op;
  uint32_t start;
  taskENTER_CRITICAL(&mux_);
  op = gestureOp_;
  start = gestureStartMs_;
  taskEXIT_CRITICAL(&mux_);
  if (op == 0) return 0.0f;
  const float t = (nowMs - start) / 1000.0f; // secondes écoulées

  switch (op) {
    case OP_NOD: { // 2 hochements avant/arrière (~1 s)
      if (t > 1.0f) { taskENTER_CRITICAL(&mux_); if (gestureOp_ == OP_NOD) gestureOp_ = 0; taskEXIT_CRITICAL(&mux_); return 0.0f; }
      return 4.0f * sinf(t * 2.0f * TWO_PI); // ±4°, 2 cycles
    }
    case OP_BOW: { // penche en avant puis se redresse (~1.6 s)
      if (t > 1.6f) { taskENTER_CRITICAL(&mux_); if (gestureOp_ == OP_BOW) gestureOp_ = 0; taskEXIT_CRITICAL(&mux_); return 0.0f; }
      return 7.0f * sinf((t / 1.6f) * PI); // demi-sinus, +7° max
    }
    default:
      return 0.0f;
  }
}

float Balance::gestureSteerBias(uint32_t nowMs) {
  uint8_t op;
  uint32_t start;
  taskENTER_CRITICAL(&mux_);
  op = gestureOp_;
  start = gestureStartMs_;
  taskEXIT_CRITICAL(&mux_);
  if (op != OP_WIGGLE) return 0.0f;
  const float t = (nowMs - start) / 1000.0f;
  if (t > 1.2f) { taskENTER_CRITICAL(&mux_); if (gestureOp_ == OP_WIGGLE) gestureOp_ = 0; taskEXIT_CRITICAL(&mux_); return 0.0f; }
  return TURN_RATE_DEG_S * 1.4f * sinf(t * 3.0f * TWO_PI); // frétille gauche/droite
}

// ─────────────────────────────────────────────────────────────────────────
//  Télémétrie
// ─────────────────────────────────────────────────────────────────────────
TelemetryPacket Balance::telemetry() const {
  TelemetryPacket p{};
  p.version = TELEMETRY_VERSION;
  p.state = state_;
  p.pitchCdeg = (int16_t)lroundf(pitchDeg_ * 100.0f);
  p.wheelSpeed = (int16_t)lroundf(motorSpeedMmS_);
  p.distanceMm = SONAR_NO_ECHO; // renseigné par main.cpp (fusion avec le sonar)
  p.flags = motorsOn_ ? TELEM_FLAG_MOTORS : 0;
  return p;
}
