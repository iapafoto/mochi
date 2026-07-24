#include "Balance.h"
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
}  // namespace

void Balance::begin(FastAccelStepper* left, FastAccelStepper* right, MPU6050* mpu) {
  left_ = left;
  right_ = right;
  mpu_ = mpu;
  applyDefaultTuning();
  left_->setAcceleration((int32_t)MAX_ACCEL_STEPS_S2);
  right_->setAcceleration((int32_t)MAX_ACCEL_STEPS_S2);
  setMotorsEnabled(false);
  state_ = STATE_IDLE;
  armed_ = BOOT_ARMED;
  imuValid_ = false; // pas encore de référence gyro saine
  settleUntilMs_ = millis() + IMU_SETTLE_MS;
}

void Balance::applyDefaultTuning() {
  kpAng_ = KP_ANGLE;
  kiAng_ = KI_ANGLE;
  kdAng_ = KD_ANGLE;
  kpSpeed_ = KP_SPEED;
  kiSpeed_ = KI_SPEED;
  kpPos_ = KP_POS;
  offsetDeg_ = BALANCE_OFFSET_DEG;
  pitchAxis_ = 0;
  pitchSign_ = 1;
  invertLeft_ = INVERT_LEFT;
  invertRight_ = INVERT_RIGHT;
}

void Balance::setArmed(bool on) {
  jogMmS_ = 0.0f; // tout changement d'armement stoppe le test boucle ouverte
  armed_ = on;    // la coupure effective des moteurs se fait dans update() (cœur 1)
}

void Balance::update() {
  const uint32_t now = millis();

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
    imuValid_ = false; // les offsets ont changé : référence gyro à reprendre
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
    imuValid_ = false; // les offsets ont changé : référence gyro à reprendre
    settleUntilMs_ = millis() + 1500;
    return;
  }

  mpu_->update();

  // --- Apprentissage continu du biais gyro (dérive thermique) ---
  // Le biais revient en quelques minutes quand la carte chauffe : avec un terme D
  // fort, 1°/s de biais suffit à décentrer l'équilibre et « manger » la
  // compensation. Moteurs coupés + rotation quasi nulle pendant ~3 s : le résidu
  // lu EST le biais → on le replie dans les offsets du MPU (fusion + D corrigés).
  if (!motorsOn_) {
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
      }
    } else {
      biasSamples_ = 0; // mouvement : reprendre l'accumulation à zéro
    }
  } else {
    biasSamples_ = 0;
  }

  // Tangage fusionné (filtre complémentaire). L'axe (±X/±Y) dépend du montage
  // physique du MPU : il se choisit en live via la console série (commande `a`),
  // l'offset via `o`/`z`. Convention : penché en AVANT = pitch POSITIF.
  const float rawAngle = pitchAxis_ ? mpu_->getAngleY() : mpu_->getAngleX();
  const float rawRate = pitchAxis_ ? mpu_->getGyroY() : mpu_->getGyroX();

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
      if (state_ != STATE_FALLEN) {
        state_ = STATE_FALLEN;
        setMotorsEnabled(false);
        resetControl();
      }
      consecutiveGlitch_ = 0;
    }
    return;
  }
  consecutiveGlitch_ = 0;
  lastRawRate_ = rawRate;
  imuValid_ = true;

  pitchDeg_ = (float)pitchSign_ * rawAngle - offsetDeg_;
  // Signe du gyro vérifiable/corrigeable indépendamment de l'angle (console `k`) :
  // monté à l'envers, gyroY peut être inversé vs angleY → terme D anti-amortisseur.
  const float gyroRate = (float)rateSign_ * (float)pitchSign_ * rawRate; // deg/s
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
    if (state_ != STATE_FALLEN) {
      state_ = STATE_FALLEN;
      setMotorsEnabled(false);
      resetControl();
    }
    return;
  }
  if (state_ != STATE_BALANCING) {
    // Au repos ou tombé : on ne relance l'équilibre que si le robot est proche
    // de la verticale ET quasi immobile (posé à l'équilibre à la main).
    if (fabsf(pitchDeg_) < RECOVER_LIMIT_DEG && fabsf(gyroRate) < RECOVER_RATE_DEG_S) {
      state_ = STATE_BALANCING;
      setMotorsEnabled(true);
      resetControl();
      posAnchorSteps_ = forwardSteps(); // « ici » devient le point à tenir
    } else {
      return;
    }
  }

  // --- Sécurité anti-emballement (roues dans le vide / suite de glitch) ---
  // En équilibre au sol, l'ancre borne la course à quelques centimètres. Une
  // dérive massive signifie que les roues patinent dans le vide (robot suspendu
  // aux longes ou soulevé) ou qu'une consigne s'est emballée. Pendant un
  // déplacement commandé l'ancre suit le robot, donc traveledMm() reste ~0 : ce
  // test ne peut pas déclencher sur un FORWARD légitime.
  if (fabsf(traveledMm()) > RUNAWAY_LIMIT_MM) {
    state_ = STATE_FALLEN;
    setMotorsEnabled(false);
    resetControl();
    return;
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

  // --- Boucle externe (vitesse) : erreur de vitesse → angle de consigne ---
  const float speedError = cmdSpeed + returnMmS - motorSpeedMmS_;
  speedInteg_ += speedError * LOOP_DT;
  speedInteg_ = constrain(speedInteg_, -SPEED_INTEG_LIMIT, SPEED_INTEG_LIMIT);
  float targetAngle = kpSpeed_ * speedError + kiSpeed_ * speedInteg_;
  targetAngle = constrain(targetAngle, -MAX_LEAN_DEG, MAX_LEAN_DEG);
  targetAngle += gestureAngleBias(now); // les gestes penchent brièvement le robot
  lastTargetDeg_ = targetAngle;

  // --- Boucle interne (stabilité) : FORME VITESSE v = Kp·θ + Ki·∫θ + Kd·θ̇ ---
  // Refactor 24/07 (cf. docs/COMPARAISON.md §1). L'ancienne forme sortait une
  // accélération intégrée en vitesse (v = kd·θ + kp·∫θ), SANS terme en θ̇ : pas
  // d'amortissement direct, et le gyro brut intégré transformait tout biais en
  // dérive de vitesse. Ici la sortie EST la vitesse : kdAng_·gyroRate amortit
  // immédiatement, et le biais gyro ne donne qu'un offset constant (pas une rampe).
  const float angleError = pitchDeg_ - targetAngle;
  angleInteg_ += angleError * LOOP_DT;
  angleInteg_ = constrain(angleInteg_, -ANGLE_INTEG_LIMIT, ANGLE_INTEG_LIMIT); // anti-windup
  motorSpeedMmS_ = kpAng_ * angleError + kiAng_ * angleInteg_ + kdAng_ * gyroRate;
  motorSpeedMmS_ = constrain(motorSpeedMmS_, -MAX_WHEEL_SPEED_MM_S, MAX_WHEEL_SPEED_MM_S);

  // --- Direction : différentiel gauche/droite ---
  const float steerMmS = steerToWheelMmS(cmdSteer + gestureSteerBias(now));
  applyWheels(motorSpeedMmS_ + steerMmS, motorSpeedMmS_ - steerMmS);
}

void Balance::applyWheels(float leftMmS, float rightMmS) {
  auto drive = [](FastAccelStepper* s, float mmS, bool invert, long& lastSps) {
    long sps = lroundf(mmS * STEPS_PER_MM);
    if (invert) sps = -sps;
    if (sps == lastSps) return; // consigne inchangée : ne pas re-générer la rampe
    lastSps = sps;
    if (sps == 0) {
      s->stopMove();
      return;
    }
    s->setSpeedInHz((uint32_t)labs(sps));
    if (sps > 0) s->runForward();
    else s->runBackward();
  };
  drive(left_, leftMmS, invertLeft_, lastSpsL_);
  drive(right_, rightMmS, invertRight_, lastSpsR_);
}

void Balance::setMotorsEnabled(bool on) {
  motorsOn_ = on;
  // A4988 : /ENABLE actif à l'état BAS.
  digitalWrite(PIN_MOTOR_ENABLE, on ? LOW : HIGH);
  if (!on) {
    left_->forceStopAndNewPosition(left_->getCurrentPosition());
    right_->forceStopAndNewPosition(right_->getCurrentPosition());
  }
}

void Balance::resetControl() {
  motorSpeedMmS_ = 0.0f;
  speedInteg_ = 0.0f;
  angleInteg_ = 0.0f;
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
