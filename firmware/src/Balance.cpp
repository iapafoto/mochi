#include "Balance.h"

#include <Wire.h>

#include "config.h"

namespace {
// (L'angle de consigne max — l'inclinaison prise pour se déplacer — a déménagé
// dans config.h : c'est devenu un réglable de conduite, cf. console `A`.)
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
  offsetDeg_ = BALANCE_OFFSET_DEG;
  pitchAxis_ = DEFAULT_PITCH_AXIS; // montage MPU (config.h) : `f` reproduit `a -y`
  pitchSign_ = DEFAULT_PITCH_SIGN;
  rateSign_ = DEFAULT_RATE_SIGN;   // signe du gyro (à confirmer au banc via `k`)
  yawSign_ = DEFAULT_YAW_SIGN;     // signe du lacet gyro (à confirmer au banc via `K`)
  gyroScale_ = GYRO_SCALE;         // échelle gyro (clones MPU6050), console `G`
  invertLeft_ = INVERT_LEFT;
  invertRight_ = INVERT_RIGHT;
  // ⚠️ Recharger AUSSI l'accél. driver : sinon `f` (factoryReset) laissait l'ancienne
  // valeur NVS active (ex. 30000, actionneur trop lent = robot « mou/éteint »).
  setMaxAccel(MAX_ACCEL_STEPS_S2);
  setFilterCoef(FILTER_GYRO_COEF); // poids gyro de la fusion d'angle (console `y`)
  maxWheelSpeedMmS_ = MAX_WHEEL_SPEED_MM_S; // autorité de rattrapage (console `V`)
  setMaxLeanDeg(MAX_LEAN_DEG);              // inclinaison max en déplacement (console `A`)
  setTeleopMaxSpeed(TELEOP_MAX_SPEED_MM_S); // fond de course manette (console `P`)
  setTeleopMaxTurn(TELEOP_MAX_TURN_DEG_S);  // fond de course manette (console `R`)
  setSpeedFloorMmS(SPEED_FLOOR_MM_S); // plancher anti-enlisement (console `F`)
  setDlpf(MPU_DLPF_CFG);          // appliqué au prochain tick du cœur 1 (console `D`)
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

bool Balance::captureZeroHere() {
  // Cf. ZERO_CAPTURE_MAX_DEG dans config.h pour le pourquoi de ce seuil large.
  if (fabsf(pitchDeg_) > ZERO_CAPTURE_MAX_DEG) return false;
  zeroOffsetHere();
  return true;
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
  // ⚠️ Z A ÉTÉ AJOUTÉ LE 23/08, et son absence était un vrai défaut. Tant que rien
  // ne lisait le lacet, `getGyroZoffset()` repassait tel quel et personne ne le
  // voyait. Depuis que la projection du lacet lit Z (avec un poids sin(o) ≈ 0,36),
  // un biais Z jamais corrigé se retrouvait INTÉGRALEMENT dans l'intégrale de
  // lacet. Mesuré au banc sur trois trajets indépendants : −6,8 ± 0,6 °/s, soit
  // ≈ 19 °/s de biais Z brut — ordinaire sur un MPU6050 clone jamais calibré sur
  // cet axe. C'est ce qui faisait annoncer « cap dévié de −91° » sur une ligne
  // droite parfaitement droite.
  // ⚠️ POURQUOI LA PORTE NE TESTE PAS |rz| : ce serait circulaire. Un biais Z de
  // 19 °/s ne franchirait jamais un seuil à 6, donc ne serait jamais appris, donc
  // resterait à 19 — un mécanisme qui ne peut pas corriger ce pour quoi il existe.
  // On se fie donc à l'immobilité constatée sur X et Y, ce qui suppose (comme tout
  // le reste de ce bloc) un robot POSÉ AU SOL, moteurs coupés.
  if (GYRO_BIAS_LEARNING && !motorsOn_) {
    const float rx = mpu_->getGyroX();
    const float ry = mpu_->getGyroY();
    const float rz = mpu_->getGyroZ();
    if (fabsf(rx) < 6.0f && fabsf(ry) < 6.0f) {
      biasEstX_ += (rx - biasEstX_) * 0.005f; // EMA, tau ~1 s a 200 Hz
      biasEstY_ += (ry - biasEstY_) * 0.005f;
      biasEstZ_ += (rz - biasEstZ_) * 0.005f;
      if (++biasSamples_ >= 600) {
        mpu_->setGyroOffsets(mpu_->getGyroXoffset() + biasEstX_,
                             mpu_->getGyroYoffset() + biasEstY_,
                             mpu_->getGyroZoffset() + biasEstZ_);
        biasEstX_ = 0.0f;
        biasEstY_ = 0.0f;
        biasEstZ_ = 0.0f;
        biasSamples_ = 0;
        // Le biais vient d'être replié dans les offsets du MPU : les suivis
        // permanents repartent de zéro, sinon les deux mécanismes compteraient
        // DEUX FOIS la même correction.
        rateBias_ = 0.0f;
        yawBias_ = 0.0f;
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

  // --- ODOMÉTRIE : lacet mesuré par le GYRO, indépendamment des roues ---
  // Placé AVANT l'interrupteur d'armement, et c'est voulu : moteurs coupés, on veut
  // pouvoir pivoter le robot À LA MAIN et lire ce que les deux sources en disent.
  // C'est comme ça qu'on constate le signe (`K`) sans rien faire rouler.
  //
  // POURQUOI IL FAUT PROJETER, ET SUR QUOI. L'axe de lacet du robot est sa
  // VERTICALE, qui n'est aucun des trois axes de la puce : l'inclinaison de la
  // carte autour de l'essieu est libre (c'est tout l'intérêt du montage, cf. `o`),
  // donc le lacet se répartit entre les deux axes du plan de tangage. Mais cette
  // inclinaison, on la CONNAÎT déjà — c'est `fusedDeg_`, l'angle de la gravité dans
  // ce plan, que la fusion suit en permanence. L'accéléro au repos pointe vers le
  // HAUT, donc le vecteur vertical vaut (sin, cos) sur les axes (u, v) pris dans le
  // même ordre cyclique que l'atan2 plus haut. Le lacet est la projection du gyro
  // dessus. Aucune constante nouvelle : le capteur se calibre tout seul en même
  // temps qu'il mesure le tangage.
  //
  // SIGNE : (u, v, ax) est une permutation cyclique de (0,1,2), donc un repère
  // DIRECT — une rotation positive autour de la verticale est un virage à GAUCHE.
  // D'où le `-`, qui aligne le lacet sur la convention maison « + = droite »
  // (celle de `steerToWheelMmS` et de `cmdSteer_`). `yawSign_` reste là pour le
  // fait de montage, exactement comme `rateSign_` pour le tangage.
  const uint8_t yu = (ax + 1) % 3, yv = (ax + 2) % 3;
  const float fusedRad = fusedDeg_ * (float)DEG_TO_RAD;
  const float rawYaw =
      -(gyr[yu] * sinf(fusedRad) + gyr[yv] * cosf(fusedRad)) * gyroScale_;
  // Même recette de suivi de biais que le tangage (clamp AUTOUR de l'estimation
  // courante), MAIS GELÉ PENDANT UN PIVOT COMMANDÉ — et ce n'est pas une précaution
  // théorique, c'est un défaut mesuré (`T 3600`, 23/08).
  //
  // Le clamp ne suffit pas à protéger une rotation LONGUE et à SENS UNIQUE. Il
  // borne l'incrément, il ne l'annule pas : le biais marche donc vers la rotation à
  // ALPHA × CLAMP × LOOP_HZ = 0,0075 °/s par seconde de pivot. Sur 60 s ça fait
  // 0,46 °/s de faux biais, et l'intégrale en perd la moitié × la durée, soit ≈ 14°
  // avalés — sur un pivot de 3600°, exactement le genre d'erreur qui fait
  // sous-estimer la rotation et donc SURESTIMER la voie.
  // Le tangage n'a jamais eu ce problème : il oscille autour de zéro, il ne part
  // pas dans un sens pendant une minute. Un traqueur de biais doit se taire quand
  // il y a du signal, et ici on SAIT quand il y en a — on l'a commandé.
  if (cmdSteer_ == 0.0f) {
    const float clampedYaw = constrain(rawYaw, yawBias_ - GYRO_BIAS_TRACK_CLAMP_DPS,
                                       yawBias_ + GYRO_BIAS_TRACK_CLAMP_DPS);
    yawBias_ += GYRO_BIAS_TRACK_ALPHA * (clampedYaw - yawBias_);
  }
  lastYawRate_ = (float)yawSign_ * (rawYaw - yawBias_);
  // La remise à zéro est traitée ICI, sur le cœur 1, pour que les trois compteurs
  // repartent du MÊME tick : comparer roues et gyro n'a de sens que s'ils comptent
  // à partir du même instant. La faire depuis le cœur 0 les décalerait d'un tour.
  if (odoResetRequest_) {
    odoResetRequest_ = false;
    odoFwdAnchor_ = forwardSteps();
    odoTurnAnchor_ = turnSteps();
    yawGyroDeg_ = 0.0f;
  }
  yawGyroDeg_ += lastYawRate_ * LOOP_DT;

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

  // Déplacement MESURÉ : il écrit cmdSpeed_/cmdSteer_ AVANT qu'on les lise, donc
  // le reste de la boucle n'a rien de spécial à savoir — pour elle c'est un
  // déplacement commandé comme un autre. Il pose `motionEndMs_ = 0` : ce n'est
  // plus le chronomètre qui décide de la fin, c'est l'odométrie.
  odoMoveTick(now);

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
  // ⚠️ HISTORIQUE, à ne pas re-tenter : il y avait ici un second test, sur la
  // DISTANCE parcourue depuis l'ancre. Il partait du principe que l'ancre borne la
  // course à quelques centimètres — ce qui n'est vrai QUE si elle est asservie. Sans
  // asservissement de position (on suit la base B-Robot, qui n'en a pas), l'ancre est
  // posée une fois à l'engagement et jamais recentrée : le test mesurait donc la
  // dérive CUMULÉE du run et coupait un robot parfaitement vertical au bout de
  // quelques dizaines de secondes. Vu de l'extérieur : « il a une absence alors que
  // rien n'a changé ». Il a d'abord été conditionné à l'ancre, donc rendu inerte,
  // puis supprimé avec elle — une sécurité qui ne s'exécute jamais est pire qu'une
  // sécurité absente, parce qu'on croit l'avoir.
  // Le détecteur ci-dessous, lui, ne dépend d'aucune ancre : une roue
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

  // --- Ancre de position : repère de MESURE, plus un asservissement ---
  // Elle ne commande plus rien (le rappel vers le point d'engagement a été retiré
  // avec `q`/KP_POS : jamais utilisé, et la base de référence n'en a pas). Elle sert
  // uniquement à `traveledMm()`, donc au `x=` du stream — combien le robot a dérivé
  // depuis l'engagement, ce qui reste l'indicateur le plus lisible d'un zéro faux.
  // Pendant un déplacement commandé, l'ancre suit le robot : sinon `x` mesurerait le
  // trajet voulu au lieu de la dérive subie.
  if (cmdSpeed != 0.0f || cmdSteer != 0.0f) posAnchorSteps_ = forwardSteps();

  // --- Estimation de la vitesse du ROBOT (≠ vitesse des roues) ---
  // Recette B-Robot : quand le corps pivote, les roues et le centre de masse ne
  // vont pas à la même vitesse. Injecter la vitesse ROUE brute dans la boucle
  // externe, c'est lui mentir exactement au moment où elle compte (pendant un
  // Le passe-bas évite que le bruit de la boucle interne remonte dans la consigne
  // d'angle : le B-Robot filtre à 0.9 @100 Hz, on fait le même τ à 200 Hz.
  const float rawEstSpeed = motorSpeedMmS_;
  estSpeedMmS_ = SPEED_EST_FILTER * estSpeedMmS_ + (1.0f - SPEED_EST_FILTER) * rawEstSpeed;

  // --- Boucle externe (vitesse) : erreur de vitesse → angle de consigne ---
  // ⚠️ Cette boucle est NON MINIMUM DE PHASE : pour avancer, le robot doit d'abord
  // reculer ses roues afin de se pencher. Sa réponse initiale va donc dans le
  // mauvais sens, et c'est la raison de fond pour laquelle `v` et `i` doivent
  // rester PETITS — une boucle externe rapide se bat contre sa propre réponse.
  const float speedError = cmdSpeed - estSpeedMmS_;
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
  const float leanMax = maxLeanDeg_; // réglable en direct (console `A`)
  if (fabsf(targetAngle) > leanMax && (targetAngle > 0) == (speedError > 0)) {
    speedInteg_ = speedIntegPrev; // gel : la sortie est déjà saturée
    targetAngle = kpSpeed_ * speedError + kiSpeed_ * speedInteg_;
  }
  targetAngle = constrain(targetAngle, -leanMax, leanMax);
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
  const float angleError = pitchDeg_ - targetAngle;
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
  // ─── Phase 1 : calculer les consignes des DEUX roues ────────────────────
  // Il faut les connaitre AVANT de decider quoi que ce soit, parce que le verrou
  // de la phase 2 compare le sens DEMANDE au sens ou va reellement la rampe.
  auto plan = [&](float mmS, bool invert, long lastSps, long& sps, long& out) {
    // Bride PAR ROUE, après l'ajout de la direction (le B-Robot fait le même
    // `constrain(motor1, ±MAX_CONTROL_OUTPUT)` juste après `+ steering`).
    // Sans elle, `motorSpeedMmS_` est bien borné à ±V mais le différentiel de
    // pivot passe par-dessus : en virage à pleine vitesse, une roue se voyait
    // commandée AU-DELÀ du domaine où le pas-à-pas tient — et un pas-à-pas
    // décroché ne rend AUCUN couple, donc le robot tombe du côté de la roue
    // sortie du domaine. Le virage perd de l'autorité quand ça sature : c'est le
    // compromis assumé, et c'est celui de la référence.
    mmS = constrain(mmS, -maxWheelSpeedMmS_, maxWheelSpeedMmS_);
    long want = lroundf(mmS * STEPS_PER_MM);
    if (invert) want = -want;
    sps = constrain(want, lastSps - maxStep, lastSps + maxStep);
    // Le limiteur a-t-il écrêté ? Tant qu'il écrête, le contrôleur commande dans
    // le vide : sa sortie n'atteint plus l'actionneur. C'est une boucle OUVERTE,
    // et c'est invisible autrement (cf. slewDuty).
    if (sps != want) slewClipped_ = true;
    out = sps;
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
    lastSps = sps;   // état du limiteur : SANS le plancher
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
  odoPhase_ = 0; // une chute ou un ré-engagement annule un déplacement mesuré
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
    case OP_STOP:
      stopMotion();
      break;
    case OP_DRIVE: {
      // Téléguidage continu : deux axes normalisés en % + TTL (cf. protocol.h).
      // Les octets sont SIGNÉS : un cast direct depuis uint8_t rendrait −100
      // comme 156, soit « plein avant » au lieu de « plein arrière ».
      const float v = len >= 1 ? (float)(int8_t)payload[0] / 100.0f : 0.0f;
      const float w = len >= 2 ? (float)(int8_t)payload[1] / 100.0f : 0.0f;
      const uint32_t ttl = len >= 3 && payload[2] != 0
                               ? (uint32_t)payload[2] * 10u : TELEOP_TTL_MS;
      driveNormalized(v, w, ttl);
      break;
    }
    // Déplacements SCRIPTÉS : ils roulent à la même vitesse que « manette à fond »
    // (`P`/`R`). Une seule vitesse pour un seul robot — il y avait avant une
    // « vitesse de croisière » distincte, qui divergeait de celle du téléguidage dès
    // le premier réglage. La garde `<= 0` n'est pas décorative : la durée se calcule
    // en divisant PAR la vitesse.
    case OP_FORWARD:
    case OP_BACKWARD: {
      const float v = teleopMaxSpeedMmS_;
      if (v <= 0.0f) break;
      const float mm = fabsf((float)i16()) * 10.0f;
      startTimedMotion(op == OP_FORWARD ? +v : -v, 0.0f,
                       (uint32_t)(mm / v * 1000.0f));
      break;
    }
    case OP_TURN: {
      const float w = teleopMaxTurnDegS_;
      if (w <= 0.0f) break;
      const float deg = i16();
      startTimedMotion(0.0f, deg >= 0 ? +w : -w,
                       (uint32_t)(fabsf(deg) / w * 1000.0f));
      break;
    }
    case OP_LOOK: {
      // Petit coup d'œil = brève rotation sur place (gauche/droite seulement).
      uint8_t dir = len >= 1 ? payload[0] : LOOK_CENTER;
      if (dir == LOOK_LEFT) startTimedMotion(0.0f, -teleopMaxTurnDegS_, 250);
      else if (dir == LOOK_RIGHT) startTimedMotion(0.0f, +teleopMaxTurnDegS_, 250);
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
    case OP_ZERO_HERE:
      // Silence si refusé : le pilote a la télémétrie pour le voir (l'assiette ne
      // retombe pas à zéro), et l'app applique déjà la même garde avant d'émettre.
      captureZeroHere();
      break;
    case OP_ZERO_ADOPT:
      adoptSuggestedOffset();
      break;
    case OP_ARM: {
      // Armer reste un acte VOLONTAIRE : aucun déplacement ne le fait implicitement.
      // Un robot qui s'arme parce qu'on lui a demandé d'avancer, c'est un robot qui se
      // met debout tout seul dans sa caisse de transport.
      const bool on = len >= 1 && payload[0] != 0;
      if (!on) stopMotion(); // sinon la consigne dormirait jusqu'au prochain armement
      setArmed(on);
      break;
    }
    default:
      break; // opcode inconnu : ignoré
  }
}

void Balance::startTimedMotion(float speedMmS, float steerDegS, uint32_t durationMs) {
  // 0 est la valeur SENTINELLE de « aucun déplacement en cours » : une échéance
  // qui tomberait pile dessus (au repliement de millis(), tous les 49 jours)
  // rendrait la commande ÉTERNELLE — donc un robot qui part et ne s'arrête plus.
  uint32_t end = millis() + (durationMs == 0 ? 1 : durationMs);
  if (end == 0) end = 1;
  taskENTER_CRITICAL(&mux_);
  cmdSpeed_ = speedMmS;
  cmdSteer_ = steerDegS;
  motionEndMs_ = end;
  // TOUTE commande de déplacement annule un déplacement mesuré en cours. C'est le
  // seul garde-fou qui compte vraiment ici : le pad, `u`, OP_DRIVE et OP_STOP
  // passent tous par ici ou par stopMotion(), donc l'humain reprend la main sans
  // qu'aucun d'eux n'ait à connaître l'existence de la calibration.
  odoPhase_ = 0;
  taskEXIT_CRITICAL(&mux_);
}

// Départ d'un déplacement MESURÉ (cœur 0). On ne fait que POSER la demande : la
// remise à zéro de l'odométrie est faite par le cœur 1 au premier tick, pour que
// le compteur parte exactement du même instant que le mouvement.
void Balance::startOdoMove(float mm, float deg) {
  const uint32_t budget =
      (uint32_t)(ODO_MOVE_TIMEOUT_FACTOR * 1000.0f *
                 (mm != 0.0f ? fabsf(mm) / ODO_MOVE_SPEED_MM_S
                             : fabsf(deg) / ODO_TURN_SPEED_DEG_S)) +
      ODO_MOVE_TIMEOUT_PAD_MS;
  taskENTER_CRITICAL(&mux_);
  odoGoalMm_ = mm;
  odoGoalDeg_ = deg;
  odoDeadlineMs_ = millis() + budget;
  odoPhase_ = 1;
  taskEXIT_CRITICAL(&mux_);
}

// Machine à états du déplacement mesuré (cœur 1).
void Balance::odoMoveTick(uint32_t nowMs) {
  taskENTER_CRITICAL(&mux_);
  uint8_t phase = odoPhase_;
  const float goalMm = odoGoalMm_, goalDeg = odoGoalDeg_;
  const uint32_t deadline = odoDeadlineMs_;
  taskEXIT_CRITICAL(&mux_);
  if (phase == 0) return;

  if (phase == 1) {
    // Départ : l'odométrie repart de zéro ICI, dans le même tick que le premier
    // mouvement. La faire côté cœur 0 laisserait passer un tour de boucle.
    odoFwdAnchor_ = forwardSteps();
    odoTurnAnchor_ = turnSteps();
    yawGyroDeg_ = 0.0f;
    phase = 2;
    taskENTER_CRITICAL(&mux_);
    odoPhase_ = 2;
    taskEXIT_CRITICAL(&mux_);
  }

  const bool straight = goalMm != 0.0f;

  if (phase == 2) {
    const float goal = straight ? goalMm : goalDeg;
    const float done = straight ? odoForwardMm() : odoYawWheelDeg();
    const float cruise = straight ? ODO_MOVE_SPEED_MM_S : ODO_TURN_SPEED_DEG_S;
    const float sgn = goal >= 0.0f ? 1.0f : -1.0f;
    // On lâche la commande AVANT la cible : le robot roule encore ≈ v·τ. Le
    // dépassement résiduel est mesuré, pas supposé — il n'entache rien.
    const float lead = cruise * (straight ? ODO_BRAKE_LEAD_S : ODO_TURN_BRAKE_LEAD_S);
    const bool arrived = sgn * done >= sgn * goal - lead;
    const bool late = (int32_t)(nowMs - deadline) >= 0;
    taskENTER_CRITICAL(&mux_);
    if (arrived || late) {
      odoEndReason_ = late ? MOVE_TIMEOUT : MOVE_REACHED;
      odoSettleAtMs_ = nowMs + ODO_SETTLE_MS;
      cmdSpeed_ = 0.0f;
      cmdSteer_ = 0.0f;
      odoPhase_ = 3;
    } else {
      cmdSpeed_ = straight ? sgn * cruise : 0.0f;
      cmdSteer_ = straight ? 0.0f : sgn * cruise;
    }
    motionEndMs_ = 0; // c'est l'odométrie qui décide de la fin, pas le chrono
    taskEXIT_CRITICAL(&mux_);
    return;
  }

  // Phase 3 : stabilisation. On tient la consigne à zéro et on ne lit qu'une fois
  // le robot revenu debout et immobile — avant ça, l'odométrie du point de contact
  // décrit le redressement, pas le trajet.
  taskENTER_CRITICAL(&mux_);
  cmdSpeed_ = 0.0f;
  cmdSteer_ = 0.0f;
  taskEXIT_CRITICAL(&mux_);
  if ((int32_t)(nowMs - odoSettleAtMs_) < 0) return;

  move_.askedMm = goalMm;
  move_.askedDeg = goalDeg;
  move_.gotMm = odoForwardMm();
  move_.gotWheelDeg = odoYawWheelDeg();
  move_.gotGyroDeg = odoYawGyroDeg();
  move_.reason = odoEndReason_;
  movePending_ = true;
  taskENTER_CRITICAL(&mux_);
  odoPhase_ = 0;
  taskEXIT_CRITICAL(&mux_);
}

void Balance::stopMotion() {
  taskENTER_CRITICAL(&mux_);
  cmdSpeed_ = 0.0f;
  cmdSteer_ = 0.0f;
  motionEndMs_ = 0;
  gestureOp_ = 0;
  odoPhase_ = 0;
  taskEXIT_CRITICAL(&mux_);
}

void Balance::drive(float speedMmS, float steerDegS, uint32_t ttlMs) {
  // Un déplacement téléguidé n'est qu'un déplacement temporisé dont le pilote
  // rearme le chronomètre : rien de neuf sous le capot, et donc rien de neuf à
  // vérifier côté boucle temps réel — elle voit exactement ce qu'elle voit déjà
  // pour un FORWARD (cf. `motionExpired` dans update()).
  startTimedMotion(constrain(speedMmS, -teleopMaxSpeedMmS_, teleopMaxSpeedMmS_),
                   constrain(steerDegS, -teleopMaxTurnDegS_, teleopMaxTurnDegS_),
                   ttlMs == 0 ? TELEOP_TTL_MS : ttlMs);
}

void Balance::driveNormalized(float speedFrac, float steerFrac, uint32_t ttlMs) {
  const float v = constrain(speedFrac, -1.0f, 1.0f);
  float w = constrain(steerFrac, -1.0f, 1.0f);
  // Expo sur la direction (recette B-Robot) : écrase le milieu de course, laisse
  // le fond de course intact. |w|·(|w| + expo)/(1 + expo) — normalisé pour rendre
  // exactement 1 en butée (cf. TELEOP_STEER_EXPO dans config.h).
  w = (w * fabsf(w) + TELEOP_STEER_EXPO * w) / (1.0f + TELEOP_STEER_EXPO);
  drive(v * teleopMaxSpeedMmS_, w * teleopMaxTurnDegS_, ttlMs);
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
  return teleopMaxTurnDegS_ * 1.4f * sinf(t * 3.0f * TWO_PI); // frétille gauche/droite
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
  p.flags = (motorsOn_ ? TELEM_FLAG_MOTORS : 0) | (armed_ ? TELEM_FLAG_ARMED : 0);
  return p;
}
