// config.h — brochage + constantes mécaniques + réglages de la boucle.
//
// TOUT ce qui dépend du câblage physique ou du réglage (tuning) est ici, pour
// n'avoir qu'un seul fichier à éditer. Les broches suivent le schéma de câblage
// (docs/HARDWARE.md). ⚠️ ESP32 : GPIO34-39 sont ENTRÉE SEULE ; GPIO6-11 = flash
// (interdits) ; GPIO0/2/12/15 sont des broches de strap (éviter en sortie).

#pragma once
#include <Arduino.h>

// ─────────────────────────────────────────────────────────────────────────
//  BROCHAGE (voir docs/HARDWARE.md — table ESP32 ↔ modules)
// ─────────────────────────────────────────────────────────────────────────

// --- Bus I2C (MPU6050) ---
constexpr int PIN_I2C_SDA = 21;
constexpr int PIN_I2C_SCL = 22;

// --- Driver A4988 gauche ---
constexpr int PIN_L_STEP = 26;
constexpr int PIN_L_DIR = 27;

// --- Driver A4988 droit ---
constexpr int PIN_R_STEP = 25;
constexpr int PIN_R_DIR = 33;

// --- ENABLE commun aux deux A4988 (actif à l'état BAS) ---
constexpr int PIN_MOTOR_ENABLE = 14;

// --- Montage via CNC Shield V3 (option, cf. docs/HARDWARE.md) ---
// Le brochage ci-dessus ne change PAS : on relie chaque GPIO au bornier de
// signaux SÉRIGRAPHIÉ du shield (câbles DuPont ; ne PAS enficher l'ESP32).
// Correspondance (broches nommées, pas D2/D5) :
//   PIN_L_STEP(26)→X.STEP   PIN_L_DIR(27)→X.DIR   (socket X = roue gauche)
//   PIN_R_STEP(25)→Y.STEP   PIN_R_DIR(33)→Y.DIR   (socket Y = roue droite)
//   PIN_MOTOR_ENABLE(14)→EN            GND→GND
//   ⚠️ alimenter la logique des drivers en 3,3 V via la broche 5V du bornier
//      (5V/GND), PAS en 5 V, sinon les signaux 3,3 V de l'ESP32 sont marginaux.
//      Ne rien injecter d'autre en 5 V sur la carte.
//   12 V → bornier bleu 12-36V. Moteurs → headers 4 broches à côté des sockets
//   (pas les X+/X-/Y+/Y- = fins de course). Micro-pas 1/16 = 3 cavaliers/socket.

// --- HC-SR04 (ECHO via diviseur 5V→3.3V ; 35 est entrée-seule = idéal) ---
constexpr int PIN_SONAR_TRIG = 13;
constexpr int PIN_SONAR_ECHO = 35;

// --- LED d'état embarquée ---
constexpr int PIN_STATUS_LED = 2;

// Sens des moteurs : les deux roues sont montées en miroir. Si le robot
// « fuit » au lieu de se rattraper, inverser UN de ces deux booléens.
constexpr bool INVERT_LEFT = false;
constexpr bool INVERT_RIGHT = true;

// ─────────────────────────────────────────────────────────────────────────
//  MÉCANIQUE (roues Gotronic 84×24 mm + NEMA 17 1.8°, A4988 en 1/16)
// ─────────────────────────────────────────────────────────────────────────
constexpr int MOTOR_FULL_STEPS = 200;     // 1.8° → 200 pas/tour
// MICROSTEPS : 16 = 3 cavaliers par socket sur le CNC shield ; 8 = seulement MS1 et
// MS2 (retirer le cavalier MS3, le plus proche du bornier d'alim). ⚠️ Passer à 8 est
// LE remède aux pas perdus : même vitesse roue pour deux fois moins de pas/s, donc
// bien plus loin du décrochage — c'est le réglage livré du B-Robot ESP32.
// Contrepartie : résolution deux fois plus grossière (0,15 mm de roue par pas au lieu
// de 0,08), sans importance pour l'équilibre. Tout le reste (STEPS_PER_MM, accél.,
// vitesses) se recalcule automatiquement à partir d'ici.
// ⚠️ APRÈS le changement : faire `n 100000` (ou `f`) — la valeur d'accél. en NVS est
// stockée EN PAS/s² et resterait deux fois trop rapide physiquement.
constexpr int MICROSTEPS = 16;            // 16 = 3 cavaliers/socket ; 8 = MS1+MS2 seuls
constexpr int STEPS_PER_REV = MOTOR_FULL_STEPS * MICROSTEPS; // 3200
constexpr float WHEEL_DIAMETER_MM = 84.0f;
constexpr float WHEEL_CIRCUM_MM = WHEEL_DIAMETER_MM * PI;    // ~263.9 mm
constexpr float STEPS_PER_MM = STEPS_PER_REV / WHEEL_CIRCUM_MM; // ~12.12
constexpr float WHEEL_BASE_MM = 150.0f;   // entraxe des roues (à mesurer sur ton châssis)

// ─────────────────────────────────────────────────────────────────────────
//  BOUCLE D'ÉQUILIBRE (à RÉGLER une fois le robot monté — cf. README §tuning)
// ─────────────────────────────────────────────────────────────────────────
constexpr float LOOP_HZ = 200.0f;         // fréquence de la boucle d'équilibre
constexpr float LOOP_DT = 1.0f / LOOP_HZ;

// Filtre complémentaire (fusion accéléro+gyro) : poids du GYRO. τ ≈ LOOP_DT/(1-coef).
// C'est un ARBITRAGE ENTRE DEUX PANNES OPPOSÉES, et le bon réglage dépend de ce qui
// est actif ailleurs dans le firmware :
//
//   coef HAUT (τ long)  → le gyro domine. Sa dérive thermique n'est plus corrigée
//     par l'accéléro : l'erreur en régime vaut ≈ biais×τ. C'est ce qui a produit les
//     15-25° d'écart des runs 12/17 (robot vu vertical, pitch=-20°).
//   coef BAS (τ court)  → l'accéléro domine. Or il ne distingue pas la gravité d'une
//     accélération de roue : à 1 m/s² il fabrique atan(1/9.81) ≈ 5.8° de faux angle,
//     DANS LE SENS de la correction → boucle de réaction positive. Le robot tremble,
//     et le seuil de tremblement plafonne KP_ANGLE (mesuré : ~21 à coef 0.98).
//
// RÉVISÉ 13/08 : 0.98 → 0.999. La panne « coef haut » est désormais traitée à la
// source — Balance::update() apprend le biais gyro EN CONTINU, et l'auto-trim θ₀
// (`s`) recentre le point d'équilibre. Les deux n'existaient pas quand 0.98 a été
// choisi. Reste donc la panne « coef bas », qui elle bride directement le gain.
//
// RÉGLABLE EN DIRECT via la console `y`. Ce qu'il faut surveiller après ce passage :
// si `pitch` DÉRIVE lentement alors que le robot est visiblement droit et immobile,
// c'est la panne « coef haut » qui revient → redescendre (0.995, puis 0.99).
//
// COMPARAISON B-ROBOT (docs/COMPARAISON.md §2) : lui tient à 0.99 @100 Hz, soit
// τ ≈ 1 s — CINQ FOIS plus court qu'ici. Il peut se le permettre parce que son
// DLPF matériel est à 10 Hz (MPU_DLPF_CFG=5) : l'accéléro qu'il fusionne est déjà
// débarrassé des vibrations steppers. Nous filtrons à 44 Hz et compensons par un τ
// long → 5× plus sensible au biais gyro. Depuis que le biais est suivi EN CONTINU
// (GYRO_BIAS_TRACK_*), on peut redescendre : essayer `D 5` puis `y 0.995`.
constexpr float FILTER_GYRO_COEF = 0.998f; // valeur du banc (run du 21/08)

// Filtre passe-bas MATÉRIEL du MPU (registre CONFIG 0x1A, DLPF_CFG) :
//   3 = accel 44 Hz / gyro 42 Hz (retard ~4.9 ms)   ← défaut ici
//   4 = accel 21 Hz / gyro 20 Hz (retard ~8.5 ms)
//   5 = accel 10 Hz / gyro 10 Hz (retard ~13.8 ms)  ← le réglage du B-Robot
// Plus on filtre, plus l'angle accéléro est propre (donc plus on peut baisser
// FILTER_GYRO_COEF et donc la sensibilité au biais gyro), mais plus le terme
// d'amortissement KD_ANGLE·θ̇ arrive en retard. Réglable EN DIRECT : console `D`.
constexpr uint8_t MPU_DLPF_CFG = 3;

// Offset d'assiette : angle du MPU quand le robot est réellement à l'équilibre
// (jamais parfaitement 0 à cause du montage). À ajuster à ±0.1° près.
// Valeur MESURÉE au banc, relevée sur le run de recette (10 min sans chute) : un
// `f` (défauts usine) doit rendre un robot immédiatement utilisable. À re-trimmer
// (`z` puis `w`) si la mécanique bouge.
// ⚠️ SOLIDAIRE DE `DEFAULT_PITCH_SIGN` ci-dessous : l'offset est mesuré DANS une
// convention de signe. Changer l'un sans l'autre donne un zéro faux de deux fois
// l'offset. Les deux ont changé ensemble (le montage se lit `a y`, plus `a -y`).
// ⚠️ +21° n'est pas une anomalie : le MPU est monté incliné, et l'inclinaison de
// la carte autour de l'axe de tangage est LIBRE (cf. `a`) — c'est `o` qui l'absorbe.
// Confirmation que ce zéro est juste : au banc `o* = +21.02` contre `o = +20.96`,
// soit 0,06° que l'intégrale compense en permanence. C'est la signature d'un zéro
// correct — quand `o*` s'éloigne de `o`, c'est là qu'il faut refaire un `Z`.
constexpr float BALANCE_OFFSET_DEG = 20.96f;

// --- Orientation du MPU (faits physiques du montage) ---
// Rechargés par `f`/defauts usine (via applyDefaultTuning) pour reproduire un
// montage cohérent sans tout recalibrer. Convention : penché en AVANT = pitch > 0.
//   AXIS = axe de ROTATION du tangage dans le repère de la puce (0=X, 1=Y, 2=Z),
//   c'est-à-dire l'axe PARALLÈLE À L'ESSIEU des roues. RÉVISÉ 13/08 : ce n'était
//   avant qu'un choix entre getAngleX/getAngleY de la lib ; Balance calcule
//   désormais l'angle lui-même (atan2 signé), donc les 3 axes sont disponibles et
//   ⚠️ l'INCLINAISON DE LA CARTE AUTOUR DE CET AXE EST LIBRE — à plat, verticale
//   ou à 45°, seul `o`/`z` change. Seule contrainte : l'essieu doit être parallèle
//   à l'axe choisi. SIGN ±1 ; RATE_SIGN = signe du gyro vs l'angle (montage
//   inversé → terme D anti-amortisseur si faux, corrigeable `k`).
// Montage courant : `a -y` ⇒ AXIS=1, SIGN=-1. Vérifier RATE_SIGN via `k` après flash.
constexpr uint8_t DEFAULT_PITCH_AXIS = 1;   // Y
constexpr int8_t  DEFAULT_PITCH_SIGN = 1;   // ⇒ axe = y  (relevé au banc : `axe=y`)
constexpr int8_t  DEFAULT_RATE_SIGN = 1;    // à confirmer au banc (`k`) — cf. ⚠️ ci-dessous
// ⚠️ `DEFAULT_PITCH_SIGN` était à -1 alors que le robot tourne à +1 : un `f` aurait
// retourné la polarité de TOUTE la boucle (pitchSign_ multiplie l'angle ET le gyro),
// c'est-à-dire un robot qui FONCE DANS LE SENS DE SA CHUTE. C'est le piège n°1 de
// docs/TUNING.md, et il était armé dans les défauts d'usine.
// ⚠️ `DEFAULT_RATE_SIGN` reste le seul fait de calibration que `g` N'AFFICHE PAS :
// impossible de vérifier qu'il correspond au banc sans le lire en NVS. À ajouter
// dans printState.
// Correctif d'ÉCHELLE du gyro (console `G`). 1.0 = on fait confiance à la lib.
// Utile parce que beaucoup de MPU6050 vendus sont des clones qui IGNORENT le
// registre GYRO_CONFIG : la lib croit être en ±500 °/s et divise par 65,5 alors
// que la puce est restée en ±250 (sensibilité 131) → toutes les vitesses
// doublées. main.cpp demande désormais explicitement le ±250, ce qui règle le cas
// général ; ce facteur reste le filet si l'échelle est encore fausse.
// Se MESURE : `y 0.95` donne l'angle accéléro (fiable) ; `y 0.9999` donne l'angle
// gyro. Basculer le robot de 90° et ajuster `G` jusqu'à ce que les deux coïncident.
constexpr float GYRO_SCALE = 1.0f;

// PID de stabilité (boucle interne, rapide) — FORME VITESSE (refactor du 24/07,
// cf. docs/COMPARAISON.md §1) : la boucle sort une VITESSE roue, plus une
// accélération intégrée. C'est la forme naturelle pour des steppers (actionneurs
// de vitesse) et celle de rekomerio.
//   v = KP_ANGLE·θ + KI_ANGLE·∫θ + KD_ANGLE·θ̇
// KD_ANGLE·θ̇ est l'AMORTISSEMENT DIRECT qui manquait à l'ancienne forme
// accélération (aucun terme en θ̇). Console : `d`=Kp (raideur), `p`=Ki (intégrale),
// `e`=Kd (amortissement).
// ⚠️ ÉCHELLE DU Kd — le piège qui a fait croire que `e` « ne marchait pas » : chez
// Brokking `pid_d=30` multiplie (err−err_préc)=θ̇·dt (dt=4 ms) ⇒ gain effectif par
// °/s = 30×0.004 = 0.12. Ici Kd multiplie gyroRate (°/s) DIRECTEMENT ⇒ l'équivalent
// Brokking est Kd ≈ 0.008·Kp ≈ 0.3 (pour Kp=40), PAS 20-30 (qui saturent la roue dès
// ~23 °/s). Un premier passage au banc avait conclu « 0.1 passe sans buzz, 0.3
// siffle → on garde 0.1 » ; le run de recette tourne à 0.3 sans siffler. Ce qui a
// changé entre les deux, c'est le plancher `F` : le sifflement venait de
// l'actionneur qui s'enlisait, pas du gain d'amortissement.
//
// ═══ KI_ANGLE : LE TERME QUI MANQUAIT (21/08, cf. docs/COMPARAISON.md §1) ═══
// Le B-Robot ESP32 sort une ACCÉLÉRATION qu'il intègre (`control_output += PD`).
// En développant la somme (Kp=0.32, Kd=0.050, dt=0.01 s), sa vitesse roue vaut :
//     v = (Kd/dt)·θ + (Kp/dt)·∫θ  =  5·θ + 32·∫θ   [unités B-Robot]
//       ≈ 21.6·θ + 138·∫θ                          [mm/s, θ en degrés]
// Autrement dit : chez lui le terme INTÉGRAL est SIX FOIS plus gros que le terme
// proportionnel, avec une constante de temps d'action de 1/6.4 = 0.16 s. C'est le
// terme DOMINANT de sa commande, pas une correction de finition.
//
// Ici il était à 0, et rien d'autre n'était actif pour annuler une erreur statique
// (KP_POS=0, AUTO_TRIM=0, KI_SPEED minuscule) : avec un zéro d'assiette faux de
// seulement 0.5°, la loi rendait une vitesse roue constante de ~17 mm/s qui ne
// s'annulait JAMAIS → le robot part, accélère, tombe. Signature exacte du « il
// corrige, il a l'air vivant, mais il ne tient jamais ».
// ⚠️ Le commentaire « OFF : évite la bagarre d'intégrateurs » était le raisonnement
// faux : dans la forme vitesse, Ki·∫θ N'EST PAS un intégrateur en concurrence,
// c'est l'équivalent EXACT du terme proportionnel de la forme accélération.
// Valeur retenue : même ratio Ki/Kp que le B-Robot (6.4 s⁻¹) ⇒ Ki ≈ 6.4·Kp.
// Valeurs du run de recette (10 min sans chute, statique + téléguidage).
// ⚠️ Le ratio Ki/Kp vaut ici 200/40.5 = 4.9 s⁻¹, et non les 6.4 du B-Robot. C'est
// ce qui marche sur CE châssis (τ = 66 ms, deux fois plus court que le sien) : la
// cible de 6.4 était un point de départ, pas une consigne.
constexpr float KP_ANGLE = 40.5f;  // θ  → vitesse (raideur ; valeur du banc)
constexpr float KI_ANGLE = 200.0f; // ∫θ → vitesse (TERME DOMINANT, cf. ci-dessus)
constexpr float KD_ANGLE = 0.3f;   // θ̇  → vitesse (amortissement ; valeur du banc)
// Borne anti-windup de l'intégrateur d'angle ∫θ (en deg·s). ⚠️ À RECALER AVEC Ki :
// à Ki=200, ±3 deg·s = ±600 mm/s d'autorité intégrale (ordre de grandeur du
// B-Robot). L'ancien ±20 laissait passer ±4000 mm/s, soit un windup incontrôlable.
constexpr float ANGLE_INTEG_LIMIT = 3.0f;

// PID de vitesse (boucle externe, lente) : erreur de vitesse → angle de consigne.
// C'est lui qui fait « pencher pour avancer » et qui empêche la dérive.
// ⚠️ Trop fort, il claque la consigne d'angle en butée ±12° et couple les deux
// boucles (oscillation lente) : rester doux.
// Équivalences B-Robot (1 unité = 50 pas/s ≈ 4.3 mm/s) : KP_THROTTLE=0.080 ⇒
// 0.0185 °/(mm/s) — on est du même ordre. KI_THROTTLE=0.1 ⇒ 0.023 °/mm, soit ~8×
// notre 0.003 : il y a de la marge pour monter `i` si la dérive persiste.
constexpr float KP_SPEED = 0.017f;  // valeur du banc
constexpr float KI_SPEED = 0.003f;  // valeur du banc (B-Robot ≈ 0.023 : monter par paliers)

// Passe-bas sur la vitesse estimée (poids de l'ancienne valeur). Le B-Robot filtre
// à 0.9 @100 Hz (τ = 0.1 s) ; à 200 Hz le même τ demande 0.95.
constexpr float SPEED_EST_FILTER = 0.95f;

// Armement au boot : false = moteurs inhibés tant qu'on n'arme pas (console `m`).
// Garder false pendant la phase de tuning ; passer à true quand le robot est fiable.
constexpr bool BOOT_ARMED = false;

// Sécurité : au-delà de cet angle, on considère le robot tombé → moteurs coupés.
// 45° (au lieu de 40) : le B-Robot laisse tourner jusqu'à 74°, on garde une marge
// mais on cesse d'abandonner une récupération encore possible.
constexpr float FALL_LIMIT_DEG = 45.0f;
// Conditions de (re)démarrage de l'équilibre : le robot doit être sous cet angle
// ET pas trop en rotation. 5° était BEAUCOUP trop serré (impossible à poser à la
// main) → élargi à 30°, juste sous FALL_LIMIT_DEG (40°) pour garder ~10° d'hystérésis
// et éviter de chatterer engage/chute à la frontière. ⚠️ Depuis 30° il ne PEUT
// physiquement pas toujours se rattraper (les roues n'arrivent pas à repasser sous le
// CdM), mais il ESSAIE — bien mieux pour poser/régler. RECOVER_RATE borne la vitesse
// angulaire à l'engagement : monté à 60°/s pour tolérer une pose pas parfaitement figée.
// RÉVISÉ 21/08 (comparaison B-Robot) : lui n'a AUCUNE porte de réengagement — il
// alimente les moteurs dès que |angle| < 74°, sans condition sur la vitesse
// angulaire, et il n'a pas d'état « tombé » qui se verrouille. Notre porte à
// 60 °/s empêchait tout rattrapage réel : dès la moindre excursion le robot se
// coupait et refusait de repartir tant qu'on ne l'immobilisait pas à la main.
// 150 °/s laisse le contrôleur ESSAYER pendant que le robot bouge encore.
constexpr float RECOVER_LIMIT_DEG = 35.0f;
constexpr float RECOVER_RATE_DEG_S = 150.0f;
// Verrous anti-acharnement (22/08). Observé : robot couché à 17°, donc SOUS la porte
// de 35° — il relançait les roues à fond, se faisait couper sur saturation 1,5 s plus
// tard, et recommençait, dix fois de suite. Inutile (il ne peut pas se relever depuis
// là) et c'est le régime qui chauffe le plus les drivers.
constexpr uint32_t REENGAGE_COOLDOWN_MS = 1500; // délai imposé après TOUTE coupure
// Porte resserrée tant que le robot n'a pas été REPOSÉ droit après une saturation.
// La porte large de 35° sert à poser le robot à la main, pas à s'acharner depuis
// une position d'où il ne peut physiquement pas revenir.
constexpr float STRICT_RECOVER_LIMIT_DEG = 12.0f;

// Rejet des lectures IMU corrompues. MPU6050_light::fetchData() ne teste PAS le
// retour de requestFrom() : sur timeout I2C (EMI des steppers sur SDA/SCL) elle
// lit du garbage, observé au run 16 comme des pics gyro fantômes de ±380°/s. Avec
// un KD fort, UN seul pic projette les roues à ±700 mm/s → emballement → chute.
// Un mouvement réel ne fait pas varier le gyro de plus de ~250°/s en un tick
// (5 ms, soit 50 000°/s²) : au-delà, l'échantillon est jeté et la boucle garde sa
// dernière consigne le temps d'un tick.
constexpr float GYRO_GLITCH_JUMP_DPS = 250.0f;
// Si l'IMU ment en continu (bus mort, nappe débranchée), tenir la dernière
// consigne indéfiniment serait dangereux : au-delà de N rejets d'affilée, on coupe.
constexpr uint16_t IMU_LOST_TICKS = 20; // 20 × 5 ms = 100 ms

// Apprentissage CONTINU du biais gyro (repli du résidu dans les offsets MPU quand
// moteurs coupés + immobile ≥3 s). RÉACTIVÉ — le désactiver était une ERREUR (24/07).
// Raisonnement faux au départ : « en forme vitesse un biais gyro n'est qu'un offset
// de vitesse constant, donc inutile ». Vrai pour le terme D (kdAng·gyroRate), mais le
// biais corrompt AUSSI l'angle fusionné (filtre complémentaire : erreur_angle ≈ biais×τ),
// EN AMONT de la loi de commande. Symptôme diagnostique observé : angle qui lit le MÊME
// signe qu'on penche en avant ou arrière (gros offset ≈ biais×τ) → `pitch` coincé hors
// de la fenêtre ±5° → désengagement à la verticale, ne ré-engage plus. Le biais gyro de
// Mochi est THERMIQUE (+1..+17°/s en chauffant) → l'apprentissage est INDISPENSABLE, pas
// une fioriture. (Brokking peut garder 0.9996 sans apprentissage car son gyro est stable.)
constexpr bool GYRO_BIAS_LEARNING = true;

// SUIVI PERMANENT du biais gyro (ajouté 21/08 — recette B-Robot MPU6050.cpp) :
//   correction = constrain(rate_brut, biais ± CLAMP)
//   biais     += ALPHA · (correction − biais)
// L'apprentissage ci-dessus ne tourne QUE moteurs coupés : pendant un run, la
// dérive THERMIQUE (+1..+17 °/s documentée sur ce MPU) s'installe librement, et
// avec τ ≈ 2.5 s de filtre complémentaire elle se traduit directement en erreur
// d'angle de plusieurs degrés → le robot part et ne revient pas. Le B-Robot, lui,
// corrige son biais EN PERMANENCE, y compris en équilibre.
// Le double garde-fou (clamp étroit AUTOUR de l'estimation + α minuscule) fait que
// le biais ne peut bouger que de ~0.0075 °/s par seconde : impossible d'absorber une
// inclinaison réelle, on ne rattrape que la dérive lente. Mêmes chiffres que lui.
constexpr float GYRO_BIAS_TRACK_ALPHA = 0.00025f; // τ ≈ 20 s à 200 Hz
constexpr float GYRO_BIAS_TRACK_CLAMP_DPS = 0.15f; // = ±10 LSB à 65.5 LSB/(°/s)

// Sécurité anti-emballement : roues dans le vide (robot soulevé) ou emballement
// après un glitch. ⚠️ Il y avait ici un second test, sur la DISTANCE parcourue
// depuis l'ancre de position ; il est parti avec elle — cf. Balance::update(), qui
// garde l'explication de pourquoi il ne faut pas le re-tenter.
// Durée max pendant laquelle la
// roue peut rester commandée à fond. Un vrai rattrapage sature quelques dixièmes de
// seconde ; 1,5 s de pleine vitesse continue = robot soulevé ou roue qui patine.
constexpr float RUNAWAY_SAT_MS = 1500.0f;

// Bornes moteur.
// ⚠️ RELEVÉ 700→1400 (21/08). Le B-Robot plafonne à 500 unités × 50 pas/s =
// 25 000 pas/s ⇒ 7.8 tr/s ⇒ ~2160 mm/s : TROIS FOIS notre ancienne limite. Une
// autorité de rattrapage trop faible est une cause classique de « il corrige mais
// il n'y arrive jamais » — le contrôleur demande, la roue ne suit pas.
// RAMENÉ 1400 → 900 : la géométrie MESURÉE a remplacé la comparaison. Avec
// τ = 66 ms, le Δv nécessaire pour rattraper 10° vaut 340 mm/s — 900 est donc déjà
// large, et 1400 n'achetait rien qu'un domaine où l'A4988 décroche (17 000 pas/s au
// 1/16 sur un NEMA17 en 12 V). Un pas-à-pas décroché ne rend AUCUN couple : au-delà
// du décrochage, monter `V` retire de l'autorité au lieu d'en ajouter.
// Réglable EN DIRECT (console `V`). Si ça décroche, passer les cavaliers en 1/8 et
// MICROSTEPS=8 (le réglage livré du B-Robot) : même vitesse, deux fois moins de pas/s.
constexpr float MAX_WHEEL_SPEED_MM_S = 900.0f; // vitesse linéaire max d'une roue
// Accélération du driver (rampe FastAccelStepper). ⚠️ POINT CRITIQUE de l'équilibre :
// les robots de référence à pas-à-pas (Brokking YABR, rekomerio) écrivent la fréquence
// de pas DIRECTEMENT, sans rampe — la roue change de vitesse quasi instantanément. Une
// rampe trop molle rend l'actionneur aussi lent que la chute (τ~0.12 s) → robot « mou »
// qui ne rattrape jamais. 56000 (~4.6 m/s²) était bien trop bas. Réglable EN DIRECT au
// banc via la console `n` (viser 2e5 → 1e6) : monter tant que les moteurs ne SAUTENT PAS
// de pas (sinon la vitesse réelle décroche → contrôleur aveugle), redescendre sinon.
// ⚠️ CE N'EST PLUS LE FACTEUR LIMITANT (vérifié 21/08 contre le B-Robot) : lui
// plafonne à MAX_ACCEL=14 unités par tick de 10 ms, soit 70 000 pas/s² ≈ 6 m/s².
// Ce qui manquait n'était pas l'accélération, c'était KI_ANGLE et la vitesse max.
//
// ⚠️ 22/08 — C'EST MAINTENANT LE SUSPECT N°1 DES PAS PERDUS. Le robot rattrape, puis
// tombe « au bout d'un moment » : signature d'un moteur qui décroche. Un stepper perd
// des pas quand le COUPLE demandé dépasse ce qu'il peut fournir, et le couple demandé
// est proportionnel à l'ACCÉLÉRATION. À 14 m/s² on demande 2,3× la référence B-Robot.
// Et un pas perdu est invisible du contrôleur : il croit rouler à la vitesse commandée
// alors que la roue décroche → l'angle part sans que la commande ne le voie.
// TRANCHÉ, et ce n'est plus un essai à l'aveugle : la géométrie mesurée (1,1 kg,
// CdM à 8,5 cm, l = 4,3 cm, τ = 66 ms) donne une FENÊTRE. Plancher 40 600 pas/s²
// (en dessous, la limite d'accélération écrête la sortie du contrôleur à d = 40) ;
// plafond 123 000 pas/s² (au-delà, le couple demandé dépasse ce que les moteurs
// rendent à 1,1 kg, donc pas perdus). Réglé à 75 000 pas/s², au milieu — soit
// ~6,2 m/s², c'est-à-dire très exactement l'ordre de grandeur du B-Robot (~6).
// L'ancienne valeur (14 m/s² ≈ 170 000 pas/s²) était AU-DESSUS du plafond de couple.
// Si le robot redevient « mou » avant que les pas cessent d'être perdus, c'est le
// couple qui manque, pas le réglage → 1/8 de pas et/ou Vref des A4988.
//
// Exprimé en mm/s² et converti : sinon, passer MICROSTEPS de 16 à 8 DOUBLERAIT
// silencieusement l'accélération physique pour la même constante en pas/s².
constexpr float MAX_ACCEL_MM_S2 = 6185.0f; // ≈ 75 000 pas/s² (valeur du banc), ~6,2 m/s²
constexpr float MAX_ACCEL_STEPS_S2 = MAX_ACCEL_MM_S2 * STEPS_PER_MM;

// Rampe INTERNE du driver, volontairement quasi instantanée (22/08).
// MESURÉ : avec une rampe driver « normale », le générateur de FastAccelStepper
// restait bloqué en RAMP_STATE_REVERSE (décélération pour inverser le sens) plus
// de 60 ms d'affilée — on commandait 5000 pas/s, la roue tournait à 12. Près de
// l'équilibre la consigne change de signe en permanence : la roue passait son
// temps à COMMENCER des inversions sans jamais en finir une. C'était « l'absence ».
// À 5e6 pas/s², une inversion pleine échelle prend ~3 ms : la machine à états ne
// peut plus s'installer, et le driver redevient ce qu'il doit être — un exécutant.
// La VRAIE limite d'accélération est désormais appliquée dans Balance::applyWheels,
// comme le fait le B-Robot (`MAX_ACCEL` côté contrôleur, période écrite en direct).
constexpr float DRIVER_RAMP_STEPS_S2 = 5000000.0f;

// Détection « le driver ne suit pas la consigne » (Balance::checkDriverFollows).
// Seuil bas : en dessous, la consigne est trop petite pour conclure quoi que ce
// soit. Fenêtre : une rampe légitime atteint le quart de sa cible en ~10 ms à
// 170 000 pas/s², donc 60 ms ne peuvent pas être un faux positif.
constexpr long DRIVER_MUTE_MIN_SPS = 600;  // ≈ 50 mm/s
constexpr float DRIVER_MUTE_MS = 60.0f;

// ═══ PLANCHER DE VITESSE ROUE (console `F`) — N'EST PAS UN REGLAGE DE GOUT ═══
// C'est le contournement d'un DEFAUT D'ACTIONNEUR, d'ou un defaut d'usine non nul.
// FastAccelStepper s'enlise des que la consigne roue passe par zero : sa rampe doit
// deceler depuis une vitesse DEJA nulle vers zero et ne declare jamais avoir fini
// (mesure au banc : ramp=DECELERATE, reel=-1 pas/s, consigne=+1180, pendant >60 ms).
// Or la consigne passe par zero EXACTEMENT au point d'equilibre — d'ou le symptome
// « il tient en mouvement puis lache a la verticale », qui a resiste des mois.
//
// Ce n'est PAS un reglage de latence : a 48 pas/s (F 4) un ordre de file dure encore
// 20 ms, autant que sans plancher. Il suffit d'eviter l'etat degenere, rien de plus.
// Valide au banc le 23/08 a 4 mm/s : premier etat ou le robot ne tombe plus.
//
// REVISE 4 -> 8 a la session suivante. F 4 n'a PAS reproduit son efficacite ce
// jour-la (chute au point d'equilibre, comme avant le correctif) ; F 8 a tenu, et
// c'est le reglage du run de recette : 10 min sans une seule chute, en statique ET
// en teleguidage. On ne sait pas encore pourquoi 4 a suffi un jour et pas l'autre
// (temperature, charge accu, usure de la zone morte) — d'ou une marge x2 plutot
// qu'un retour a la valeur juste. Monter davantage reste inutile et vibre (F 16).
//
// ⚠️ SI LE PLANCHER SEMBLE INOPERANT : ce n'est probablement pas sa valeur. Une fois
// la rampe ENLISEE, le plancher ne l'en sort pas — il l'entretient meme, parce qu'il
// epingle la consigne a une valeur CONSTANTE et que `emit` (Balance.cpp) saute
// l'envoi quand `out == sentSps`. Plus rien ne repart vers le driver. Seuls un
// `setMotorsEnabled(false)` (donc `m`/`m`, ou une chute) ou le verrou d'inversion
// debloquent. Le detecteur « driver muet » ne le voit pas : il est bride a
// DRIVER_MUTE_MIN_SPS = 600 pas/s, tres au-dessus de la zone du plancher (F 8 = 97).
constexpr float SPEED_FLOOR_MM_S = 8.0f;

// Tours de boucle pendant lesquels on laisse une inversion de sens aboutir sans la
// re-planifier (cf. applyWheels). La file d'impulsions de FastAccelStepper contient
// ~20 ms de mouvement engage ; 8 tours a 200 Hz = 40 ms, soit le double, ce qui
// laisse la marge necessaire sans jamais figer une roue longtemps.
constexpr uint8_t REVERSE_MAX_TICKS = 8;

// En dessous de cette vitesse REELLE, une inversion de sens est tranchee net
// (file videe, redemarrage a l'arret) plutot que negociee par la rampe. Mesure au
// banc : les neuf enlisements observes etaient tous entre 747 et 1833 pas/s.
// 2500 pas/s = 206 mm/s couvre tous ces cas en restant tres en dessous de la
// frequence de demarrage/arret d'un NEMA 17 charge — l'arret sec ne coute rien.
constexpr int32_t REVERSE_FORCE_MAX_SPS = 2500;

// ─────────────────────────────────────────────────────────────────────────
//  TÉLÉGUIDAGE (OP_DRIVE / console `u`) — cf. protocol.h
// ─────────────────────────────────────────────────────────────────────────
// Rappel d'architecture, et c'est le point important : les deux axes N'ENTRENT
// PAS au même endroit de la chaîne (même choix que le B-Robot, cf. son .ino) :
//   • la VITESSE est la CONSIGNE de la boucle externe (`cmdSpeed`), qui la
//     convertit en angle de consigne. Le robot « veut avancer » ⇒ il se penche.
//     Non négociable : pousser directement les roues ferait tomber le robot en
//     arrière (c'est le propre du pendule inversé).
//   • la DIRECTION est injectée DIRECTEMENT sur le différentiel des roues,
//     après toute la boucle : pivoter ne remet pas l'équilibre en jeu.
//
// Plafonds volontairement DOUX pour la première mise en main (le B-Robot est à
// ±1180 mm/s en mode normal et ±1700 en mode PRO — c'est une fusée). À monter à
// la console une fois la conduite prise en main : `P` et `R`.
// ⚠️ CE SONT AUSSI les vitesses des déplacements SCRIPTÉS (FORWARD/BACKWARD/TURN/
// LOOK). Il y avait avant une « vitesse de croisière » distincte (180 mm/s, 90 °/s) :
// deux vitesses pour un seul robot, qui divergeaient au premier réglage et dont
// personne ne savait laquelle s'appliquait. `P` et `R` répondent désormais à une
// seule question — « à quelle vitesse ce robot se déplace-t-il ? ».
constexpr float TELEOP_MAX_SPEED_MM_S = 300.0f; // fond de course avant/arrière
constexpr float TELEOP_MAX_TURN_DEG_S = 120.0f; // fond de course rotation

// Homme mort : durée de validité d'une commande de téléguidage non rafraîchie.
// 500 ms = 5 rafraîchissements manqués à 10 Hz. Assez long pour absorber une
// hoquet BLE, assez court pour que le robot ne traverse pas la pièce si le lien
// tombe (à 300 mm/s : 15 cm).
constexpr uint32_t TELEOP_TTL_MS = 500;

// Expo sur la DIRECTION (recette B-Robot, verbatim de son .ino) :
//   steer = (s² + 0.5·s) · max      pour s ∈ [0, 1]
// Une manette n'a pas de cran au centre : sans expo, le moindre appui de travers
// fait pivoter. La partie quadratique écrase le milieu de course (à mi-course on
// obtient 0.375 au lieu de 0.5) et laisse le fond de course intact.
// ⚠️ Chez lui la course du fader vaut ±0.5, donc son fond de course ne rend que
// la MOITIÉ de MAX_STEERING. Ici s est normalisé à ±1, la formule rend donc bien
// 100 % en butée — ne pas comparer les constantes des deux projets de front.
constexpr float TELEOP_STEER_EXPO = 0.5f; // poids de la partie linéaire

// Inclinaison MAXIMALE que la boucle externe a le droit de demander pour se
// déplacer. C'est LE plafond d'accélération du robot : plus il peut se pencher,
// plus il peut accélérer — et plus une erreur de conduite coûte cher.
// B-Robot : 14° en mode normal, 26° en mode PRO (max recommandé 32°).
// Réglable en direct (console `A`) : c'est le premier paramètre à monter si le
// robot « refuse » d'avancer, et le premier à baisser s'il part en avant.
constexpr float MAX_LEAN_DEG = 12.0f;

// ─────────────────────────────────────────────────────────────────────────
//  ORDONNANCEMENT (cœurs FreeRTOS)
// ─────────────────────────────────────────────────────────────────────────
constexpr BaseType_t CORE_BALANCE = 1; // boucle temps réel (comme loop() Arduino)
constexpr BaseType_t CORE_COMMS = 0;   // BLE + sonar
constexpr uint32_t TELEMETRY_PERIOD_MS = 100; // 10 Hz de notifications
constexpr uint32_t SONAR_PERIOD_MS = 60;      // période de ping HC-SR04
