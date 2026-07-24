# Câblage & montage de Mochi

Schémas de câblage, tables broche-à-broche et guide de montage étape par étape
du robot équilibriste **Mochi**. Le brochage ici correspond **exactement** à
[`firmware/include/config.h`](../firmware/include/config.h) — si tu changes une
broche, change-la aux deux endroits.

> Version visuelle interactive (diagramme + guide) : voir l'Artifact généré à
> côté de ce fichier. Ce document est la référence texte, versionnée dans le repo.

---

## 1. Nomenclature (rappel du matériel commandé)

| # | Élément | Qté | Rôle |
|---|---|---|---|
| 1 | ESP32-WROOM-32 (38 broches) | 1 | contrôleur temps réel |
| 2 | NEMA 17 17HS4401 | 2 | moteurs des roues |
| 3 | Driver A4988 (rouge) + dissipateur | 2 | pilotage des steppers |
| 3b | CNC Shield V3 | 1 | porte les 2 A4988 (sockets, condos intégrés, cavaliers micro-pas) |
| 4 | MPU6050 | 1 | centrale inertielle (angle) |
| 5 | HC-SR04 | 1 | télémètre à ultrasons (obstacle) |
| 6 | Pack 18650 3S 12 V + BMS intégré | 1 | alimentation |
| 7 | ~~Buck LM2596 (nu)~~ | ~~1~~ | **plus nécessaire** : la carte ESP32 a une entrée DC 6,5–16 V (régulateur intégré) |
| 8 | Connecteurs WAGO 221 (2–5 trous) | qq | jonctions puissance sans soudure (voir §2 bis) |
| 9 | Roue scooter 84×24 mm + moyeu 5 mm | 2 | roues |
| — | Fils DuPont femelle-femelle | lot | signaux (I2C, STEP/DIR/EN, TRIG/ECHO) |
| — | ~~Condensateurs 100 µF/25 V~~ | ~~2~~ | **plus nécessaires** : un condo est déjà intégré à chaque socket du CNC Shield |
| — | Résistances 1 kΩ + 2 kΩ | 1 paire | diviseur ECHO 5 V→3,3 V |

> **Note connecteur pack.** Le pack 3S est livré avec **son connecteur 2P d'origine**
> (JST/XH, faible courant), **pas** un XT60. Deux options pour la ligne 12 V :
> (a) sertir/souder un **XT60** (demande une pince) ; (b) — recommandé si tu soudes
> peu — répartir la puissance avec des **WAGO 221** (bornes à levier, 0 soudure,
> tiennent le courant). Voir §2 bis.

---

## 2. Deux rails d'alimentation séparés

C'est le point le plus important pour ne pas griller l'ESP32.

```
  Pack 3S 12 V ──WAGO──┬────► bornier « 12-36V » du CNC Shield (→ VMOT des A4988)
   (BMS intégré)       │
                       └────► carte d'extension 30P, entrée « DC 6.5–16V »
                              (l'ESP32 s'enfiche dessus ; régulateur → 5 V / 3,3 V)

  Broche V (5 V) de la carte d'extension → VCC du HC-SR04.
  ⚠️ UNE SEULE masse commune : GND pack = GND extension = GND shield.
```

- Le **12 V** alimente les moteurs (bornier `12-36V` du CNC Shield → `VMOT` des
  A4988) **et** la **carte d'extension 30P** par son **entrée DC 6,5–16 V**
  (un pack 3S varie de ~9 à 12,6 V : dans la plage).
- **Broches G/V/S de la carte d'extension** : chaque GPIO est exposé en trio
  **S** (signal = le GPIO), **V** (**5 V** du régulateur), **G** (GND) — les
  capteurs se branchent en DuPont directement sur leur trio, sans breadboard.
  ⚠️ Le **V est du 5 V** : OK pour le VCC du HC-SR04, mais les signaux restent
  en 3,3 V, et le MPU6050 se branche sur la broche **3V3** dédiée.
- Le HC-SR04 (~15 mA) se nourrit donc du **V** de son trio (5 V), et son ECHO
  passe **toujours par le diviseur** (voir §5 — c'est une question de signal,
  pas d'alimentation).
- L'ESP32 fournit le **3,3 V** logique au MPU6050 et à la logique des drivers
  (broche `5V` du bornier `5V/GND` du shield — voir §2 bis).
- **Plus besoin du buck LM2596** avec cette carte. (Si un jour la carte change
  pour un modèle sans entrée large plage — VIN 5 V classique — reprendre un buck
  12 V → 5,0 V, réglé au multimètre AVANT branchement.)
- ⚠️ Ne pas brancher **USB + 12 V en même temps**, sauf pendant le debug si la
  doc de la carte confirme une protection (diode) entre les deux entrées.
- Le 12 V n'entre dans la carte ESP32 **que** par l'entrée `DC 6.5–16V` — **jamais**
  sur `3V3`, `5V` ou un GPIO. Ne pas alimenter le MPU6050 en 5 V sur ses broches
  logiques si ta carte n'a pas de régulateur (la plupart des modules GY-521 ont
  un régulateur et tolèrent 5 V sur VCC — dans le doute, **3,3 V**).

---

## 2 bis. Montage sans soudure (recommandé si tu soudes peu)

La plupart des liaisons ne demandent **aucune soudure** :

| Liaison | Méthode | Soudure ? |
|---|---|---|
| Signaux (I2C, STEP/DIR/EN, TRIG/ECHO) | **fils DuPont** F/F sur les pin headers | non |
| Répartition 12 V (pack → 2× VMOT + entrée DC de l'ESP32) | **WAGO 221** (bornes à levier) | non |
| 5 V carte → VCC HC-SR04 | DuPont sur la broche `5V` | non |
| Masse commune | 1 **WAGO 5 trous** relie tout | non |
| **A4988** | s'enfichent dans les sockets du CNC Shield | non |
| Condensateurs 100 µF | déjà intégrés au shield (un par socket) | non |

Les **WAGO 221** tiennent largement le courant moteur et remplacent l'XT60 sans
pince à sertir. ⚠️ Sur un robot **qui bouge**, **attache les fils au châssis** :
les vibrations desserrent les liaisons volantes (évite la breadboard).

**Et un PCB ?** Pas pour le premier proto (le circuit n'est pas encore figé).
Une fois que le robot tient debout, une petite **carte-mère « shield »** (l'ESP32
et les 2 A4988 se clipsent sur des supports, borniers à vis pour moteurs/alim,
condos intégrés) supprime le plat de spaghettis et fiabilise contre les
vibrations — ~2–5 € les 5 cartes chez JLCPCB/PCBWay, 100 % traversant, conçue
dans EasyEDA ou KiCad.

### Montage retenu : CNC Shield V3

**C'est la solution retenue pour Mochi.** Un **CNC Shield V3** (celui qui
accueille 4 A4988) porte les drivers, **sans quasiment aucune soudure** :

- les A4988 **s'enfichent dans les sockets** (souvent un **condensateur par
  socket** déjà présent → découplage réglé) ;
- **bornier à vis** pour le 12 V moteur, **connecteurs** pour les moteurs ;
- **cavaliers de micro-pas** sous chaque socket (les 3 = 1/16), **EN commun** et
  **RST/SLP** déjà routés.

On **ne branche PAS l'ESP32 dessus** (format/logique Uno) : on relie l'ESP32 au
**bornier de signaux sérigraphié** de la carte en **DuPont**. Selon le modèle, ce
bornier expose les signaux **par nom** (`EN, X.STEP/DR, Y.STEP/DR, …, 5V/GND`) —
c'est le cas de la carte rouge de ce projet, plus clair que les positions Uno. Le
brochage `config.h` ne change pas :

| ESP32 (`config.h`) | Broche shield (nom) | Rôle |
|---|---|---|
| `GPIO26` | `X.STEP` | pas roue gauche |
| `GPIO27` | `X.DIR` (`X…DR`) | sens roue gauche |
| `GPIO25` | `Y.STEP` | pas roue droite |
| `GPIO33` | `Y.DIR` | sens roue droite |
| `GPIO14` | `EN` | enable commun (actif bas) |
| `3V3` | `5V` (bornier `5V/GND`) | **logique drivers en 3,3 V** |
| `GND` | `GND` | masse commune |

(Sur une V3 « à l'ancienne » sans noms, les équivalents sont `X.STEP=D2`,
`X.DIR=D5`, `Y.STEP=D3`, `Y.DIR=D6`, `EN=D8`.)

- **12 V** → bornier bleu **`12-36V`**. **Moteurs** → les **headers 4 broches à
  côté de chaque socket** (X = gauche, Y = droite) — *pas* les `X+ X- Y+ Y-`, qui
  sont les **fins de course (END STOPS)**, inutilisées ici.
- ⚠️ **Logique des drivers en 3,3 V** via la broche `5V` du bornier `5V/GND`, pas
  en 5 V : l'A4988 voit un « HIGH » à ~0,7×VDD, donc avec VDD=5 V le seuil (3,5 V)
  dépasse les 3,3 V de l'ESP32 → pas/dir non fiables. **Ne rien injecter d'autre
  en 5 V** sur la carte (le header `RX TX 5V 3V3` = liaison série optionnelle, à
  ignorer).
- A4988 dans les sockets **X** et **Y** ; **Vref** à régler comme d'habitude.

---

## 3. Table de câblage — ESP32 (broches)

| Broche ESP32 | Va vers | Remarque |
|---|---|---|
| `GPIO21` (SDA) | MPU6050 SDA | bus I2C |
| `GPIO22` (SCL) | MPU6050 SCL | bus I2C |
| `3V3` | MPU6050 VCC **+** broche `5V` du bornier `5V/GND` du shield | logique 3,3 V |
| `GPIO26` | shield `X.STEP` | A4988 roue **gauche** |
| `GPIO27` | shield `X.DIR` | |
| `GPIO25` | shield `Y.STEP` | A4988 roue **droite** |
| `GPIO33` | shield `Y.DIR` | |
| `GPIO14` | shield `EN` (commun aux 2 A4988) | actif à l'état BAS |
| `GPIO13` | HC-SR04 TRIG | sortie 3,3 V (OK pour le TRIG) |
| `GPIO35` | HC-SR04 ECHO **via diviseur** | entrée-seule, 3,3 V max |
| `GPIO2` | LED d'état (embarquée) | fixe = connecté, clignote = attente |
| Entrée `DC 6.5–16V` | +12 V (pack) | jack de la **carte d'extension 30P** (régulateur intégré) |
| `V` (trio G/V/S) | HC-SR04 VCC | 5 V du régulateur de la carte d'extension |
| `3V3` | MPU6050 VCC + logique shield | broche dédiée de la carte d'extension |
| `G` / `GND` | masse commune | relier TOUS les GND |

---

## 4. A4988 sur le CNC Shield (identique pour les 2, ×2)

Tout le câblage fin du driver (VMOT, VDD, MS1-3, RESET/SLEEP, EN) est **routé
par le shield** — il ne reste que des réglages mécaniques :

| Élément | Réglage | Remarque |
|---|---|---|
| Socket **X** / **Y** | enficher le driver | X = roue **gauche**, Y = roue **droite** ; sens : repérer le **potentiomètre** |
| Cavaliers micro-pas | les **3 posés** sous chaque socket | → micro-pas 1/16 |
| Condensateur 100 µF | intégré au shield (un par socket) | rien à souder |
| `RESET`/`SLEEP`, `EN` | déjà routés par le shield | — |
| **Vref** (potentiomètre) | ~1,0–1,2 A pour le 17HS4401 | régler au multimètre **avant** de faire tourner |
| Moteur | header **4 broches à côté du socket** | *pas* les `X+ X- Y+ Y-` (fins de course, inutilisées) |

> **Repérer les bobines** du NEMA 17 : deux fils qui se « court-circuitent »
> (résistance faible) = une même bobine. En cas de doute, tester au multimètre.
> Si un moteur tourne à l'envers, inverser **une** de ses deux paires (1A↔1B) ou
> basculer `INVERT_LEFT/RIGHT` dans `config.h`.

---

## 5. Table de câblage — MPU6050 & HC-SR04

**MPU6050 (I2C)**

| Broche | Connexion |
|---|---|
| `VCC` | 3,3 V |
| `GND` | masse commune |
| `SDA` | GPIO21 |
| `SCL` | GPIO22 |
| `AD0` | GND (adresse 0x68) |

Monter le MPU6050 **bas et rigide** sur le châssis, aligné avec l'axe des roues.

**HC-SR04 (ultrasons)**

| Broche | Connexion |
|---|---|
| `VCC` | 5 V (broche `V` du trio G/V/S de la carte d'extension) |
| `GND` | masse commune |
| `TRIG` | GPIO13 |
| `ECHO` | **diviseur** → GPIO35 |

**Diviseur de tension pour ECHO (5 V → 3,3 V)** — l'ECHO sort du 5 V, `GPIO35`
ne tolère que 3,3 V :

```
  ECHO ──[ 1 kΩ ]──┬── GPIO35
                   │
               [ 2 kΩ ]
                   │
                  GND
```
(5 V × 2 kΩ / (1 kΩ + 2 kΩ) ≈ 3,33 V)

---

## 6. Guide de montage — étape par étape

### Étape 0 — Avant de câbler (bench, sans batterie)
1. Flasher le firmware sur l'ESP32 seul en USB (voir
   [firmware/README.md](../firmware/README.md)). Vérifier au moniteur série que
   le boot affiche `MPU6050 status=0` (une fois le MPU branché) et
   `BLE advertising`.
2. Depuis un téléphone, ouvrir l'app Mochi et tester la connexion BLE (le robot
   « Mochi » doit apparaître). *Aucun moteur encore.*

### Étape 1 — Bus de masse et alimentation
3. Répartir le **12 V** du pack : le connecteur 2P d'origine est faible → soit un
   **WAGO 221** en sortie (sans soudure, cf. §2 bis), soit sertir un **XT60**.
4. Amener le 12 V sur le **jack `DC 6.5–16V` de la carte d'extension 30P**
   (régulateur intégré — pas de buck externe, pas de réglage) et sur le
   **bornier `12-36V` du CNC Shield**. Vérifier au multimètre qu'une broche `V`
   sort bien ~5 V : elle alimentera le HC-SR04.
5. Établir une **masse commune** : un point/bus où se rejoignent GND du pack, de
   la carte d'extension et du CNC Shield.

### Étape 2 — Drivers moteurs (sur CNC Shield — cf. §2 bis)
6. Enficher les A4988 dans les **sockets X et Y** (bon sens : repérer le potentiomètre),
   poser les **dissipateurs**, placer les **3 cavaliers de micro-pas** sous chaque
   socket (= 1/16).
7. Régler le **courant (Vref)** de chaque A4988 (potentiomètre) au multimètre,
   avant de faire tourner : viser ~1,0–1,2 A pour le 17HS4401.
8. **12 V sur le bornier** du shield ; **moteurs** sur les connecteurs X/Y.
9. Relier l'ESP32 en **DuPont** sur le bornier de signaux nommé : `26→X.STEP`,
   `27→X.DIR`, `25→Y.STEP`, `33→Y.DIR`, `14→EN`, `GND→GND`, et **`3V3` → `5V`**
   (bornier `5V/GND`) — logique 3,3 V, jamais 5 V.

### Étape 3 — Capteurs
10. Câbler le **MPU6050** en I2C (3,3 V).
11. Câbler le **HC-SR04** (5 V), ECHO via le **diviseur** vers GPIO35.

### Étape 4 — Premiers tests moteurs (roues en l'air)
12. Poser le robot sur un support, **roues ne touchant pas le sol**.
13. Mettre sous tension. Au boot, garder le robot **immobile et vertical** le
    temps de la calibration IMU.
14. Vérifier dans la télémétrie que `pitch` suit bien l'inclinaison réelle.
15. Régler `BALANCE_OFFSET_DEG` puis les gains PID (voir README firmware §tuning).
    Si une roue « fuit » au lieu de rattraper → inverser `INVERT_*`.

### Étape 5 — Debout
16. Une fois le PID stable roues en l'air, poser au sol et régler finement
    `KP_STAB`/`KD_STAB`, puis `KP_SPEED`/`KI_SPEED` pour supprimer la dérive.
17. Tester les commandes depuis l'app : `forward`, `turn`, `nod`, `bow`,
    `wiggle`, et surtout le **STOP** (réflexe d'arrêt).

---

## 7. Basculer l'app de la simulation au vrai robot

Dans `src/main.ts`, le transport est instancié en `MockTransport` (log console,
utile en dev desktop). Pour piloter le vrai robot :

```ts
// import { MockTransport } from './robot/mockTransport';
import { BleTransport } from './robot/bleTransport';
// ...
const transport = new BleTransport();
```

Rien d'autre ne change (tout le code amont ne dépend que de l'interface
`Transport`). ⚠️ Le panneau debug qui logue les intentions moteur écoute
`MockTransport.onMotorEvent` — en mode BLE, ce log précis n'est plus alimenté
(prévoir un branchement sur la télémétrie si besoin). Web Bluetooth exige
**HTTPS** et un **geste utilisateur** (le bouton « Connecter le robot »).

---

## 8. Checklist sécurité

- [ ] 12 V branché sur le jack **`DC 6.5–16V`** de la carte d'extension et le
      bornier **`12-36V`** du shield uniquement (jamais sur `3V3`, un `S` ou un
      `V`) ; broche `V` vérifiée à ~5 V avant de brancher le HC-SR04.
- [ ] Pas d'**USB et 12 V simultanés** (sauf protection confirmée par la doc carte).
- [ ] **Une seule masse commune** partout.
- [ ] Condensateur 100 µF présent sur chaque socket du shield (sinon pics de
      tension → A4988 grillés).
- [ ] Diviseur sur l'ECHO du HC-SR04 (jamais 5 V direct sur un GPIO).
- [ ] Vref des A4988 réglé avant de faire tourner les moteurs.
- [ ] Premiers essais **roues en l'air**.
- [ ] Ne jamais débrancher un moteur A4988 sous tension (pic destructeur).
