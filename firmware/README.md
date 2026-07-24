# Firmware Mochi (ESP32)

Moelle épinière temps réel du robot équilibriste **Mochi**. L'ESP32 tient seul
la boucle d'équilibre et exécute les intentions de haut niveau envoyées par
l'app web (téléphone) via **Web Bluetooth**. Aucune IA ici : le « cerveau »
(Gemini + visage) est côté app.

## Architecture

```
              BLE (GATT)                         I2C
  App web  ─────────────►  ESP32  ◄─── MPU6050 (angle)
 (téléphone)   commandes   │  │
              ◄─────────   │  └──► 2× A4988 ──► 2× NEMA 17 (roues)
              télémétrie   └────► HC-SR04 (obstacle)

  Cœur 1 : boucle d'équilibre 200 Hz (MPU6050 → PID cascadé → steppers)
  Cœur 0 : BLE (NimBLE) + HC-SR04 + télémétrie 10 Hz
```

Le protocole fil et le profil BLE sont **partagés avec l'app** :
- opcodes ↔ [`src/robot/transport.ts`](../src/robot/transport.ts)
- UUIDs + télémétrie ↔ [`src/robot/bleProfile.ts`](../src/robot/bleProfile.ts)

En modifier un ici (`include/protocol.h`) impose de le répercuter là-bas.

## Fichiers

| Fichier | Rôle |
|---|---|
| `platformio.ini` | environnement + dépendances verrouillées |
| `include/config.h` | **brochage + réglages** (le seul fichier à éditer pour le tuning) |
| `include/protocol.h` | opcodes, UUIDs BLE, format télémétrie |
| `src/Balance.*` | équilibre (MPU6050 → PID cascadé → steppers) + gestes |
| `src/BleBridge.*` | serveur NimBLE (commandes + notifications) |
| `src/Tuning.*` | console série de réglage en live (gains, axe MPU, offset, NVS) |
| `src/Sonar.h` | HC-SR04 non bloquant (cœur 0) |
| `src/main.cpp` | init matériel + tâches FreeRTOS |

## Prérequis

- [PlatformIO](https://platformio.org/) (extension VS Code, ou CLI `pip install platformio`).
- Un ESP32-WROOM-32 relié en USB.

## Build & flash

```bash
cd firmware
pio run                 # compile
pio run -t upload       # flashe l'ESP32 (détection auto du port)
pio device monitor      # console série 115200 (logs de boot + tuning)
```

Les bibliothèques (`FastAccelStepper`, `MPU6050_light`, `NimBLE-Arduino`) sont
téléchargées automatiquement au premier build.

## ⚠️ Sécurité avant le premier essai

1. **Roues en l'air** (robot sur un support) pour les premiers tests — il peut
   partir en vrille tant que le PID n'est pas réglé.
2. Vérifier au multimètre que le **buck sort bien 5,0 V** AVANT de brancher
   l'ESP32 (cf. [docs/HARDWARE.md](../docs/HARDWARE.md)).
3. Régler le **courant des A4988** (Vref) avant de faire tourner les moteurs.
4. Garder le robot **immobile et vertical** pendant la calibration IMU au boot
   (message série « garder le robot IMMOBILE »).

## Réglage (tuning) de l'équilibre

Le réglage se fait **en live au moniteur série** (115200), sans recompiler :
la console de tuning (`src/Tuning.*`) permet d'ajuster les gains, l'axe du MPU
et l'offset à chaud, puis de **sauver en NVS** (rechargé au boot). Taper `?`
pour l'aide complète. Commandes principales :

| Commande | Effet |
|---|---|
| `t` | stream `pitch / consigne / vitesse` à 10 Hz |
| `m` | armer/désarmer les moteurs (banc d'essai) |
| `a x` `a y` `a -x` `a -y` | axe du tangage (penché en **avant** ⇒ pitch **positif**) |
| `z` | capturer l'offset : la pose actuelle devient 0° |
| `p` `d` `v` `i` `o` `<val>` | KP_STAB, KD_STAB, KP_SPEED, KI_SPEED, offset |
| `w` / `f` | sauver en NVS / retour aux défauts de `config.h` |

Ordre conseillé (robot **roues en l'air** au début, puis fils tenus au-dessus) :

1. **Axe** — `t` pour streamer, pencher le robot en avant : le pitch doit
   devenir **positif** et l'angle doit bien réagir à ce mouvement. Sinon `a y`,
   `a -x`… jusqu'à ce que ce soit bon.
2. **Sens moteur** — robot penché en avant, les roues doivent tourner **comme
   pour avancer** (rouler sous la chute). Sinon inverser
   `INVERT_LEFT`/`INVERT_RIGHT` dans `config.h` (seul réglage qui reflashe).
3. **Offset** — tenir le robot à son point d'équilibre réel, taper `z`.
4. **`p` (KP_STAB)** — augmenter jusqu'à ce que le robot réagisse vite et se
   maintienne ; trop haut = oscillations nerveuses.
5. **`d` (KD_STAB)** — augmenter pour amortir ces oscillations (mais trop =
   bruit / tremblement).
6. **`v` / `i` (boucle vitesse)** — une fois qu'il tient debout, régler pour
   qu'il **ne dérive pas** et revienne se poser sans avancer.
7. `w` pour sauver, puis **reporter les valeurs finales dans `config.h`**
   (source de vérité versionnée).

`MICROSTEPS` doit correspondre aux **jumpers MS1/MS2/MS3** des A4988
(1/16 = les trois à HIGH). `WHEEL_DIAMETER_MM` et `WHEEL_BASE_MM` doivent
correspondre à **ton** montage (mesure au réglet) pour que les distances/angles
des commandes FORWARD/TURN soient justes.

## Vocabulaire exécuté (opcodes)

| Opcode | Commande | Effet firmware |
|---|---|---|
| `0x00` STOP | arrêt | stoppe tout déplacement, **reste debout** (réflexe sécurité) |
| `0x01` FORWARD `int16 cm` | avance | croisière avant, durée ≈ distance/vitesse |
| `0x02` BACKWARD `int16 cm` | recule | idem, arrière |
| `0x03` TURN `int16 deg` | pivote | rotation sur place (+ = droite) |
| `0x10` NOD | oui | hochement avant/arrière (~1 s) |
| `0x11` BOW | révérence | penche en avant puis se redresse |
| `0x12` WIGGLE | dandine | frétille gauche/droite (~1,2 s) |
| `0x20` LOOK `int8 dir` | coup d'œil | bref pivot (gauche/droite) |

> FORWARD/BACKWARD sont **temporisés** (croisière pendant une durée calculée),
> pas asservis en distance absolue — suffisant pour une démo. Passer à un
> asservissement par odométrie des pas si besoin de précision.

## Notes

- **Un seul fil de masse commun** entre l'alim moteur (12 V), le buck 5 V et
  l'ESP32 : sinon l'IMU et les A4988 ne partagent pas de référence → chaos.
- L'ECHO du HC-SR04 est en 5 V → **diviseur de tension** vers `GPIO35`
  (entrée-seule, tolère juste le 3,3 V). Ne jamais l'attaquer en 5 V direct.
- La détection de chute coupe les moteurs au-delà de `FALL_LIMIT_DEG` ; remettre
  le robot droit relance l'équilibre automatiquement.
