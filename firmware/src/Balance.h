// Balance.h — contrôleur d'équilibre du pendule inversé + exécuteur d'intentions.
//
// update() tourne à LOOP_HZ sur le CŒUR 1 (temps réel). onCommand() est appelé
// depuis la tâche BLE sur le CŒUR 0 : les échanges se font via de petits champs
// protégés par un spinlock (portMUX). Aucune allocation dans la boucle.

#pragma once
#include <Arduino.h>
#include <FastAccelStepper.h>
#include <MPU6050_light.h>
#include "config.h"
#include "protocol.h"

class Balance {
 public:
  void begin(FastAccelStepper* left, FastAccelStepper* right, MPU6050* mpu);

  // Boucle temps réel (cœur 1). À appeler à cadence fixe (LOOP_DT).
  void update();

  // Réception d'une commande app (cœur 0). payload = octets après l'opcode.
  void onCommand(uint8_t op, const uint8_t* payload, size_t len);

  // Snapshot thread-safe pour la télémétrie (cœur 0).
  TelemetryPacket telemetry() const;

  // --- Réglage en live (console série, cœur 0) ---
  // Les écritures de float 32 bits alignés sont atomiques sur ESP32 : les
  // setters ci-dessous peuvent être appelés depuis le cœur 0 sans verrou.
  void applyDefaultTuning();            // recharge les constantes de config.h
  // Gains de la boucle interne en forme vitesse : v = Kp·θ + Ki·∫θ + Kd·θ̇.
  void setKpAng(float v) { kpAng_ = v; } // θ  → vitesse (raideur)      [console `d`]
  void setKiAng(float v) { kiAng_ = v; } // ∫θ → vitesse (intégrale)    [console `p`]
  void setKdAng(float v) { kdAng_ = v; } // θ̇  → vitesse (amortissement) [console `e`]
  void setKpSpeed(float v) { kpSpeed_ = v; }
  void setKiSpeed(float v) { kiSpeed_ = v; }
  void setKpPos(float v) { kpPos_ = v; }
  // Gain auto-trim θ₀ [console `s`]. ⚠️ Mettre le gain à 0 EFFACE aussi le θ₀ déjà
  // trouvé : sans ça, un `s 0` laissait un décalage fantôme (vu à +0.64° le 21/08)
  // qui continuait de biaiser l'angle d'erreur sans plus aucun moyen de le corriger
  // ni même de deviner d'où il venait, puisque le mécanisme était affiché « off ».
  void setAutoTrimGain(float v) {
    autoTrimGain_ = v;
    if (v == 0.0f) autoTrimDeg_ = 0.0f;
  }
  void setMaxAccel(float stepsS2);                      // accél. driver, en direct [console `n`]
  // Vitesse roue maximale [console `V`] : autorité de rattrapage du contrôleur.
  void setMaxWheelSpeed(float mmS) { maxWheelSpeedMmS_ = constrain(mmS, 100.0f, 3000.0f); }
  float maxWheelSpeed() const { return maxWheelSpeedMmS_; }
  // Correction « vitesse roue → vitesse robot » par l'inclinaison [console `T`].
  void setSpeedEstTilt(float k) { speedEstTilt_ = constrain(k, -5.0f, 5.0f); }
  float speedEstTilt() const { return speedEstTilt_; }
  // DLPF matériel du MPU [console `D`, valeurs 0..6]. L'écriture I2C est différée
  // au cœur 1 : le bus n'appartient qu'à la boucle d'équilibre.
  void setDlpf(uint8_t cfg) { dlpfRequest_ = cfg > 6 ? 6 : cfg; }
  uint8_t dlpf() const { return dlpfCfg_; }
  // Biais gyro suivi en continu (°/s), pour diagnostic depuis la console.
  float gyroBiasDps() const { return rateBias_; }
  // Dither : petite oscillation de la consigne roue pour que la transmission ne
  // soit jamais à l'arrêt [console `H`, en mm/s ; 0 = désactivé]. Remède classique
  // au JEU MÉCANIQUE et au frottement statique, qui créent une zone morte autour
  // de la vitesse nulle. ⚠️ À n'utiliser QU'APRÈS avoir vérifié le jeu à la main :
  // le dither compense un défaut mécanique, il ne le répare pas — et il injecte
  // de la vibration dans l'accéléromètre dont dépend toute la boucle.
  void setDitherMmS(float mmS) {
    ditherSps_ = lroundf(constrain(mmS, 0.0f, 100.0f) * STEPS_PER_MM);
  }
  float ditherMmS() const { return ditherSps_ / STEPS_PER_MM; }
  // Plancher de vitesse roue [console `F`, en mm/s ; 0 = desactive], SIGNE PRESERVE.
  // Motivation (23/08) : la latence de l'actionneur explose quand la consigne tend
  // vers zero. FastAccelStepper execute une file d'ordres d'impulsions ; la duree
  // d'un ordre vaut 1/vitesse. A 8 pas/s, un seul ordre dure 125 ms — le controleur
  // tourne toujours a 200 Hz mais ses corrections n'atteignent plus la roue avant
  // un huitieme de seconde. Or c'est PRECISEMENT au point d'equilibre que la
  // consigne passe par zero. La bande passante de la boucle s'effondre donc la ou
  // on en a le plus besoin, et c'est invisible : checkDriverFollows est bride a
  // DRIVER_MUTE_MIN_SPS (600 pas/s), soit au-dessus de toute cette zone.
  // Le plancher borne cette duree : floor pas/s => latence <= 1000/floor ms.
  // 200 pas/s (16 mm/s) => 5 ms, soit un tour de boucle. Il PRESERVE le signe, donc
  // il ne force aucune inversion : contrairement au dither, c'est le controleur qui
  // choisit le sens, on ne lui impose qu'une vitesse minimale pour l'exprimer.
  // (Une tentative anterieure a 8 pas/s avait echoue — trop bas pour borner quoi
  // que ce soit, elle n'ajoutait que les inconvenients.)
  void setSpeedFloorMmS(float mmS) {
    floorSps_ = lroundf(constrain(mmS, 0.0f, 200.0f) * STEPS_PER_MM);
  }
  float speedFloorMmS() const { return floorSps_ / STEPS_PER_MM; }
  // Balancier volontaire [console `B`, amplitude en degres ; 0 = desactive].
  // Oscillation lente ajoutee a la CONSIGNE D'ANGLE, donc en amont de toute la
  // chaine : le robot se balance pour de vrai, il ne vibre pas. La vitesse roue
  // qui en resulte a pour amplitude ~ kpAng x B, ce qui donne la correspondance
  // avec l'autre garde-fou :  B ~ F / kpAng  (F=16 mm/s a kp=33,5  =>  B ~ 0,5 deg).
  // Les deux expriment la meme exigence — ne jamais s'immobiliser au point zero —
  // l'un au niveau de l'actionneur, l'autre au niveau de la consigne.
  void setSwayDeg(float deg) { swayDeg_ = constrain(deg, 0.0f, 5.0f); }
  float swayDeg() const { return swayDeg_; }
  // Poids du gyro dans la fusion d'angle (filtre complémentaire), en direct [console `y`].
  // Bas = plus d'accéléro = angle qui ne dérive pas (mais plus bruité en conduite).
  void setFilterCoef(float v) {
    filterGyroCoef_ = constrain(v, 0.80f, 0.9999f);
    if (mpu_) mpu_->setFilterGyroCoef(filterGyroCoef_);
  }
  // ⚠️ Tout changement de zéro remet ∫θ ET sa graine à plat : la compensation
  // qu'ils portaient VIENT d'être transférée dans l'offset. Les garder ferait
  // compter la correction deux fois et ferait partir le robot dans l'autre sens.
  void setOffsetDeg(float v) { offsetDeg_ = v; clearAngleInteg(); }
  void zeroOffsetHere();     // pose actuelle = 0° (offset replié dans ±180)
  // Zéro d'assiette SUGGÉRÉ par l'intégrale : à l'équilibre au repos, la loi
  // impose Kp·θ + Ki·∫θ ≈ 0, donc l'angle réellement tenu vaut −(Ki/Kp)·∫θ. Ce que
  // ∫θ compense en permanence, c'est exactement l'erreur de `o`. Recopier cette
  // valeur dans `o` (puis `w`) fait démarrer les runs suivants déjà compensés,
  // même après un reboot — ce que la graine seule ne peut pas faire.
  float suggestedOffsetDeg() const {
    return kpAng_ == 0.0f ? offsetDeg_
                          : offsetDeg_ - (kiAng_ / kpAng_) * angleIntegSeed_;
  }
  // Adopte ce zéro suggéré [console `Z`] : à faire après ~30 s d'équilibre calme,
  // puis `w`. setOffsetDeg remet ∫θ à plat — la compensation a changé de porteur.
  void adoptSuggestedOffset() { setOffsetDeg(suggestedOffsetDeg()); }
  // `axis` = axe de ROTATION du tangage dans le repère de la puce (0=X, 1=Y, 2=Z),
  // c'est-à-dire l'axe PARALLÈLE À L'ESSIEU des roues. Console `a x|y|z` (± pour le sens).
  void setPitchAxis(uint8_t axis, int8_t sign) {
    pitchAxis_ = axis > 2 ? 0 : axis;
    pitchSign_ = sign;
    fusedInit_ = false; // le plan de mesure change : repartir de l'accéléro
  }
  void setRateSign(int8_t s) { rateSign_ = s; } // correctif signe gyro (montage inversé)
  // Échelle du gyro [console `G`]. Filet de sécurité contre les MPU6050 clones dont
  // la sensibilité réelle ne correspond pas à GYRO_CONFIG : à 1.0 on fait confiance
  // à la lib. Se mesure en comparant l'angle gyro (`y 0.9999`) à l'angle accéléro
  // (`y 0.95`), qui lui est fiable. Cf. docs/TUNING.md.
  void setGyroScale(float v) { gyroScale_ = constrain(v, 0.1f, 10.0f); }
  float gyroScale() const { return gyroScale_; }
  int8_t rateSign() const { return rateSign_; }
  float gyroRateDps() const { return lastGyroRate_; } // vitesse angulaire utilisée (deg/s)
  void setInvertLeft(bool v) { invertLeft_ = v; }
  void setInvertRight(bool v) { invertRight_ = v; }
  void setArmed(bool on);               // false = moteurs coupés (banc d'essai)
  // Test roues en boucle ouverte (console `j`, seulement si désarmé) : fait
  // tourner les deux roues à vitesse constante, sans équilibre. 0 = stop.
  // ⚠️ PLAFOND LEVÉ 22/08 (était 300 mm/s). C'est LE test de décrochage : il faut
  // pouvoir demander jusqu'à MAX_WHEEL_SPEED pour trouver où le moteur lâche.
  // Le passage de 0 à la consigne emprunte la MÊME rampe que la boucle d'équilibre
  // (`n`), donc ce test éprouve à la fois l'accélération et la vitesse de pointe :
  // un moteur qui décroche fait un bruit rauque et la roue ne tourne pas à la
  // vitesse demandée (ou pas du tout). Commander au-delà du décrochage est PIRE que
  // de commander moins — un pas-à-pas décroché ne rend AUCUN couple.
  void setJog(float mmS) { jogMmS_ = constrain(mmS, -3000.0f, 3000.0f); }
  float jog() const { return jogMmS_; }
  // Recalibration IMU à la demande (console `c` ou opcode BLE). Exécutée par la
  // boucle du cœur 1 (moteurs coupés, ~2 s, robot immobile et vertical requis).
  void requestImuCalibration() { calibRequest_ = true; }
  // Recalibration du gyro SEUL (console `b`) : pose libre, immobilité suffit —
  // poser le robot au sol, sans les mains. Corrige la dérive thermique du biais.
  void requestGyroCalibration() { gyroCalibRequest_ = true; }

  float kpAng() const { return kpAng_; }
  float kiAng() const { return kiAng_; }
  float kdAng() const { return kdAng_; }
  float kpSpeed() const { return kpSpeed_; }
  float kiSpeed() const { return kiSpeed_; }
  float kpPos() const { return kpPos_; }
  float autoTrimGain() const { return autoTrimGain_; }
  float autoTrimDeg() const { return autoTrimDeg_; } // θ₀ trouvé par l'auto-trim (deg)
  float maxAccel() const { return maxAccelStepsS2_; } // accél. driver courante (steps/s²)
  float filterCoef() const { return filterGyroCoef_; } // poids gyro fusion (console `y`)
  // Distance parcourue depuis l'ancre de position (mm, + = avant). Lisible du
  // cœur 0 (getCurrentPosition est une simple lecture).
  float traveledMm() const {
    return (forwardSteps() - posAnchorSteps_) / STEPS_PER_MM;
  }
  float offsetDeg() const { return offsetDeg_; }
  uint8_t pitchAxis() const { return pitchAxis_; }
  int8_t pitchSign() const { return pitchSign_; }
  bool invertLeft() const { return invertLeft_; }
  bool invertRight() const { return invertRight_; }
  bool armed() const { return armed_; }
  float pitchDeg() const { return pitchDeg_; }
  // Angles bruts du MPU (pour identifier l'axe de tangage depuis la console).
  float rawAngleX() const { return mpu_ ? mpu_->getAngleX() : 0.0f; }
  float rawAngleY() const { return mpu_ ? mpu_->getAngleY() : 0.0f; }
  float targetDeg() const { return lastTargetDeg_; }
  float wheelMmS() const { return motorSpeedMmS_; }
  uint8_t state() const { return state_; }
  // Nombre d'échantillons IMU rejetés depuis le boot (timeouts I2C). Doit rester
  // proche de 0 : s'il grimpe, le bus est bruité (câblage/EMI), pas les gains.
  uint32_t glitchCount() const { return glitchCount_; }

  // ─── Journal des COUPURES moteur ────────────────────────────────────────
  // « Le robot a une absence, comme si l'alim moteur avait lâché. » Il n'y a que
  // deux familles d'explications, et elles se distinguent par UN fait observable :
  // est-ce que le FIRMWARE a coupé, oui ou non ?
  //   • oui → une des causes ci-dessous, et on sait laquelle ;
  //   • non → c'est le MATÉRIEL qui a lâché tout seul (mise en sécurité thermique
  //     d'un A4988, protection du BMS de l'accu, faux contact). Le firmware ne peut
  //     pas le voir, mais son SILENCE est le diagnostic.
  // L'événement est LATCHÉ ici (cœur 1) et imprimé par la console (cœur 0) : pas de
  // printf dans la boucle temps réel.
  enum CutCause : uint8_t {
    CUT_NONE = 0,
    CUT_ANGLE,      // chute franche : |θ| > FALL_LIMIT_DEG (normal)
    CUT_IMU_LOST,   // IMU_LOST_TICKS rejets I2C consécutifs → on ne sait plus où on est
    CUT_RUNAWAY,    // dérive au-delà de l'ancre de position
    CUT_SATURATION, // roue commandée à fond en continu (patinage / roue en l'air)
  };
  struct CutInfo {
    uint8_t cause;
    float pitchDeg, wheelMmS, traveledMm;
    uint32_t glitches, atMs;
  };
  // Consomme l'événement en attente (cœur 0). false s'il n'y en a pas.
  bool takeCutEvent(CutInfo& out) {
    if (!cutPending_) return false;
    out = cut_;
    cutPending_ = false;
    return true;
  }
  uint16_t cutCount(uint8_t cause) const {
    return cause < 5 ? cutCounts_[cause] : 0;
  }

  // ─── Santé de la boucle temps réel ──────────────────────────────────────
  // TROISIÈME famille d'explications à « l'absence », et la plus sournoise : la
  // boucle ne coupe rien, elle CALE. Les roues gardent alors leur dernière consigne
  // pendant des dizaines de millisecondes — le robot part sans que personne ne
  // corrige, ce qui ressemble trait pour trait à une coupure d'alimentation.
  // Cause principale possible : le bus I2C. Le timeout par défaut du Wire ESP32 est
  // de 50 ms ; UNE transaction bloquée mange donc dix tours de boucle. D'où
  // `Wire.setTimeOut()` court dans main.cpp, et ce compteur pour le vérifier.
  uint32_t lateTicks() const { return lateTicks_; }   // tours > 2× la période
  uint32_t worstTickUs() const { return worstTickUs_; } // pire écart observé
  void resetLoopStats() {
    lateTicks_ = 0;
    worstTickUs_ = 0;
    drvMuteCount_ = 0;
    satDuty_ = 0.0f;
    worstSatMs_ = 0;
    slewDuty_ = 0.0f;
    wrongWayMs_ = 0;
    wrongWayCmd_ = 0;
    revForcedCount_ = 0;
    for (uint8_t i = 0; i < 5; i++) cutCounts_[i] = 0;
  }

  // ─── Combien le contrôleur passe-t-il de temps en butée ? ───────────────
  // De quoi arbitrer un réglage AVEC UN CHIFFRE plutôt qu'à l'œil. La butée n'est
  // pas un défaut en soi : pendant un vrai rattrapage, on VEUT toute l'autorité
  // disponible. Ce qui compte est la DURÉE.
  //   `satDuty` (moyenne glissante ~2 s) : la part du temps passée en butée.
  //     Quelques % = sain. 30-40 % = le contrôleur demande en permanence plus que
  //     l'actionneur ne peut donner, donc les gains ne servent plus à rien.
  //   `worstSatMs` : le plus long épisode continu du run. Sous ~300 ms = de vrais
  //     rattrapages. Proche de RUNAWAY_SAT_MS = on sort de l'enveloppe.
  float satDuty() const { return satDuty_; }
  uint32_t worstSatMs() const { return worstSatMs_; }
  // Part du temps où la LIMITE D'ACCÉLÉRATION écrête la commande. Distinct de la
  // butée de vitesse, et bien plus insidieux : tant que ça écrête, la sortie du
  // contrôleur n'atteint plus l'actionneur — la boucle est OUVERTE. Quelques % =
  // normal sur les gros rattrapages. Durablement au-dessus de ~20 % = `n` est trop
  // bas pour le `d` choisi (rappel : accélération demandée = d × θ̇), et le robot
  // ne peut PAS s'équilibrer quels que soient les gains.
  float slewDuty() const { return slewDuty_; }

  // ─── Le driver suit-il la consigne ? ────────────────────────────────────
  // QUATRIÈME famille, celle que les trois autres compteurs ne voient pas : la
  // boucle tourne, l'IMU est saine, rien ne coupe… mais le pas-à-pas ne fait pas
  // ce qu'on lui demande. On compare donc la consigne à la vitesse RÉELLE du
  // générateur de rampe (`getCurrentSpeedInMilliHz`). Si elle reste proche de zéro
  // alors qu'on demande une vitesse franche, le contrôleur commande dans le vide :
  // c'est « l'absence », et c'est enfin visible.
  struct DrvInfo {
    long cmdL, cmdR;      // consigne, pas/s
    int32_t actL, actR;   // vitesse réelle de la rampe, pas/s
    uint8_t rampL, rampR; // état interne FastAccelStepper (cf. rampState())
    uint32_t atMs;
  };
  bool takeDrvEvent(DrvInfo& out) {
    if (!drvPending_) return false;
    out = drv_;
    drvPending_ = false;
    return true;
  }
  uint16_t drvMuteCount() const { return drvMuteCount_; }
  // Nombre de fois ou une inversion enlisee a du etre tranchee de force
  // (cf. applyWheels / REVERSE_MAX_TICKS). Doit rester bas : s'il grimpe, la file
  // d'impulsions n'arrive pas a suivre le rythme des changements de signe.
  uint16_t revForcedCount() const { return revForcedCount_; }
  // ─── CONTRESENS : le driver va-t-il dans le mauvais sens ? ──────────────
  // Le pendant BASSE VITESSE de drvMuteCount, qui lui est aveugle sous 600 pas/s.
  // Ici pas de seuil du tout : on compte le temps pendant lequel la rampe tourne
  // dans le sens OPPOSE a la consigne. Un renversement legitime traverse zero en
  // 0,2 ms a DRIVER_RAMP_STEPS_S2, donc un tour de boucle (5 ms) est le maximum
  // explicable. Des dizaines de ms = la file d'impulsions est en retard, et le
  // robot est pousse dans le sens de sa chute. Pour un pendule inverse c'est
  // fatal, et aucun reglage de gains ne le rattrape.
  // `wrongWayCmd` retient la consigne (pas/s) au pire moment : si elle est petite,
  // c'est la latence basse vitesse ; si elle est grande, c'est autre chose.
  uint32_t wrongWayMs() const { return wrongWayMs_; }
  long wrongWayCmd() const { return wrongWayCmd_; }

 private:
  void clearAngleInteg() { angleInteg_ = 0.0f; angleIntegSeed_ = 0.0f; }
  // Compare la consigne RÉELLEMENT ENVOYÉE et la vitesse réelle des deux rampes.
  void checkDriverFollows();
  // Coupe les moteurs en enregistrant POURQUOI (cœur 1). Toutes les transitions
  // vers STATE_FALLEN doivent passer par ici — sinon on perd le diagnostic.
  void cutMotors(uint8_t cause);
  void applyWheels(float leftMmS, float rightMmS);
  void setMotorsEnabled(bool on);
  void resetControl();
  // Position « robot » moyenne des deux roues, en pas signés (+ = avant).
  int32_t forwardSteps() const {
    const int32_t l = left_ ? left_->getCurrentPosition() : 0;
    const int32_t r = right_ ? right_->getCurrentPosition() : 0;
    return ((invertLeft_ ? -l : l) + (invertRight_ ? -r : r)) / 2;
  }
  void startTimedMotion(float speedMmS, float steerDegS, uint32_t durationMs);
  void triggerGesture(uint8_t op);
  float gestureAngleBias(uint32_t nowMs); // non-const : efface gestureOp_ en fin de geste
  float gestureSteerBias(uint32_t nowMs);

  FastAccelStepper* left_ = nullptr;
  FastAccelStepper* right_ = nullptr;
  MPU6050* mpu_ = nullptr;
  long lastSpsL_ = 0; // état du limiteur d'accélération (consigne HORS dither)
  long lastSpsR_ = 0;
  long sentSpsL_ = 0; // ce qui est réellement parti au driver (dither compris) :
  long sentSpsR_ = 0; // c'est à ÇA que checkDriverFollows doit se comparer
  // Dither optionnel autour de zéro (console `H`) — cf. applyWheels.
  // ⚠️ Valeur reelle posee par begin()/applyDefaultTuning depuis SPEED_FLOOR_MM_S,
  // qui n'est PAS nul : ce plancher corrige un defaut d'actionneur, pas un gout.
  volatile long floorSps_ = 0; // plancher de vitesse signe (console `F`)
  volatile float swayDeg_ = 0.0f; // balancier volontaire (console `B`)
  float swayPhase_ = 0.0f;
  volatile long ditherSps_ = 0;
  uint8_t ditherTick_ = 0;
  bool ditherPhase_ = false;
  // Force le prochain applyWheels à ré-émettre, même si la consigne est identique :
  // après un setMotorsEnabled(false), le driver a été arrêté et le cache ci-dessus
  // ne décrit plus son état réel.
  bool forceReissue_ = true;
  // Détection « le driver ne suit pas » (cf. DrvInfo).
  DrvInfo drv_{};
  volatile bool drvPending_ = false;
  uint16_t drvMuteCount_ = 0;
  uint16_t drvMuteTicks_ = 0;
  // Inversion de sens en cours — COMMUN aux deux roues (cf. applyWheels).
  uint8_t revTicks_ = 0;
  uint16_t revForcedCount_ = 0;
  // Contresens basse vitesse (cf. wrongWayMs).
  uint16_t wrongWayTicks_ = 0;
  uint32_t wrongWayMs_ = 0;
  long wrongWayCmd_ = 0;

  // --- État de contrôle (cœur 1) ---
  uint8_t state_ = STATE_IDLE;
  bool motorsOn_ = false;
  float pitchDeg_ = 0.0f;      // inclinaison filtrée
  float lastTargetDeg_ = 0.0f; // dernier angle de consigne (pour la console)
  float motorSpeedMmS_ = 0.0f; // vitesse commandée (sortie boucle stabilité)
  // Vitesse estimée du ROBOT (≠ vitesse des roues quand il pivote), filtrée :
  // c'est elle qui alimente la boucle externe. Cf. SPEED_EST_* dans config.h.
  float estSpeedMmS_ = 0.0f;
  float speedInteg_ = 0.0f;    // intégrateur du PID de vitesse (boucle externe)
  float angleInteg_ = 0.0f;    // intégrateur ∫θ de la boucle interne (terme Ki)
  // Dernière valeur de ∫θ observée en équilibre CALME : réinjectée au prochain
  // engagement pour ne pas re-payer la « dérive du départ » (cf. resetControl).
  float angleIntegSeed_ = 0.0f;
  float autoTrimDeg_ = 0.0f;   // θ₀ trouvé par auto-trim (recette Brokking, cf. `s`)

  // --- Réglages à chaud (écrits cœur 0 par la console, lus cœur 1) ---
  volatile float kpAng_ = 0.0f;    // initialisés depuis config.h dans begin()
  volatile float kiAng_ = 0.0f;    // (forme vitesse : v = Kp·θ + Ki·∫θ + Kd·θ̇)
  volatile float kdAng_ = 0.0f;
  volatile float kpSpeed_ = 0.0f;
  volatile float kiSpeed_ = 0.0f;
  volatile float kpPos_ = 0.0f;    // rappel vers l'ancre de position (0 = off)
  volatile float autoTrimGain_ = 0.0f; // gain auto-trim θ₀ (0 = off) ; écrit cœur 0
  volatile float maxWheelSpeedMmS_ = MAX_WHEEL_SPEED_MM_S; // autorité de rattrapage [console `V`]
  volatile float speedEstTilt_ = 0.0f; // k de estSpeed = v_roue + k·θ̇ [console `T`]
  float maxAccelStepsS2_ = 0.0f;   // accél. driver courante (set via begin() / console `n`)
  volatile float filterGyroCoef_ = FILTER_GYRO_COEF; // poids gyro fusion (console `y`)
  int32_t posAnchorSteps_ = 0;     // position mémorisée à l'engagement (pas)
  volatile float offsetDeg_ = 0.0f;
  // Fusion d'angle MAISON (cf. Balance.cpp) : atan2 sur les deux axes accéléro du
  // plan de tangage → plage ±180° sans repli, quelle que soit l'orientation du MPU.
  float fusedDeg_ = 0.0f;
  bool fusedInit_ = false;         // false = amorcer sur l'accéléro au prochain tick

  volatile uint8_t pitchAxis_ = 0; // axe de rotation du tangage : 0=X, 1=Y, 2=Z
  volatile int8_t pitchSign_ = 1;  // +1 / -1 : sens « penche en avant = positif »
  volatile int8_t rateSign_ = 1;   // +1 / -1 : signe du gyro vs l'angle (montage)
  volatile float gyroScale_ = 1.0f; // correctif d'échelle gyro (clones MPU6050)
  float lastGyroRate_ = 0.0f;      // dernière vitesse angulaire utilisée (deg/s)
  volatile bool invertLeft_ = false;  // sens roue gauche (défaut : config.h)
  volatile bool invertRight_ = false; // sens roue droite
  volatile bool armed_ = true;     // false = équilibre inhibé, moteurs coupés
  volatile float jogMmS_ = 0.0f;   // test boucle ouverte (actif si désarmé)
  volatile bool calibRequest_ = false; // demande de recalibration IMU (cœur 0 → cœur 1)
  volatile bool gyroCalibRequest_ = false; // recalibration gyro seule (pose libre)
  // Apprentissage continu du biais gyro (dérive thermique) : moteurs coupés et
  // rotation quasi nulle ≥3 s → le résidu lu est replié dans les offsets du MPU.
  float biasEstX_ = 0.0f;
  float biasEstY_ = 0.0f;
  uint16_t biasSamples_ = 0;
  // Suivi PERMANENT du biais gyro sur l'axe de tangage (recette B-Robot) : actif
  // aussi pendant l'équilibre, contrairement à l'apprentissage ci-dessus. Exprimé
  // en °/s APRÈS gyroScale_, et retranché de rawRate avant la fusion et le terme D.
  float rateBias_ = 0.0f;
  // DLPF matériel du MPU : `dlpfRequest_` != dlpfCfg_ ⇒ écriture I2C au prochain
  // tick du cœur 1 (le bus n'appartient qu'à la boucle d'équilibre).
  uint8_t dlpfCfg_ = MPU_DLPF_CFG;
  volatile uint8_t dlpfRequest_ = MPU_DLPF_CFG;
  uint32_t settleUntilMs_ = 0; // équilibre inhibé le temps que le filtre converge
  // Rejet des échantillons IMU corrompus (cf. GYRO_GLITCH_JUMP_DPS dans config.h).
  float lastRawRate_ = 0.0f;       // dernière vitesse gyro brute SAINE (référence)
  bool imuValid_ = false;          // false tant qu'aucune référence saine (boot/calib)
  uint16_t consecutiveGlitch_ = 0; // rejets consécutifs → IMU considérée perdue
  uint32_t glitchCount_ = 0;       // total rejeté depuis le boot (diagnostic)
  // Journal des coupures (cf. CutCause plus haut). `cutPending_` est le drapeau
  // cœur 1 → cœur 0 ; les compteurs survivent pour un bilan de fin de run.
  CutInfo cut_{};
  volatile bool cutPending_ = false;
  uint16_t cutCounts_[5] = {0, 0, 0, 0, 0};
  // Ticks consécutifs passés avec la roue commandée à fond : au-delà de
  // RUNAWAY_SAT_MS, ce n'est plus un rattrapage, c'est un patinage.
  uint16_t satTicks_ = 0;
  // Anti-acharnement après une coupure (cf. update()). `reengageAtMs_` impose un
  // délai ; `strictGate_` exige en plus une pose quasi verticale après une
  // saturation — un robot couché ne doit pas relancer les roues à fond en boucle.
  uint32_t reengageAtMs_ = 0;
  bool strictGate_ = false;
  // Santé de la boucle : écart réel entre deux passages dans update().
  uint32_t lastTickUs_ = 0;
  uint32_t lateTicks_ = 0;
  uint32_t worstTickUs_ = 0;
  // Occupation de la butée de vitesse (cf. satDuty/worstSatMs).
  float satDuty_ = 0.0f;
  uint32_t worstSatMs_ = 0;
  float slewDuty_ = 0.0f;      // part du temps ou la limite d'accel ecrete
  bool slewClipped_ = false;   // ecretage vu au dernier applyWheels

  // --- Consignes partagées (écrites cœur 0, lues cœur 1) ---
  volatile float cmdSpeed_ = 0.0f;  // mm/s
  volatile float cmdSteer_ = 0.0f;  // deg/s
  volatile uint32_t motionEndMs_ = 0; // 0 = pas de déplacement temporisé en cours
  volatile uint8_t gestureOp_ = 0;    // 0 = aucun geste
  volatile uint32_t gestureStartMs_ = 0;

  mutable portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
};
