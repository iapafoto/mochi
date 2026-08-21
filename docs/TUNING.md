# Journal de tuning équilibre — état et pistes

> Session du 22-23/07/2026. Objectif : tenir en équilibre sur place.
> Meilleur résultat à date : **22 s d'équilibre continu** (run 11), avec une
> phase parfaitement posée de 8,5 s (pitch ±2°, roues quasi immobiles).

## 📏 22/08 (5) — régler AVEC des chiffres, et le couple (n, d)

### Ne jamais juger un réglage roues décollées

Roues en l'air, le robot sature ses moteurs même à θ ≈ 0. C'est **normal** : les roues ne
peuvent plus changer l'angle, donc la boucle est ouverte, les intégrateurs voient une erreur
qui ne diminue jamais et partent en butée. Ce n'est pas un symptôme de mauvais réglage.

Mais c'est une démonstration utile de ce que coûte un **décrochage ou un patinage** : pendant
l'épisode la boucle est ouverte exactement pareil, le contrôleur s'enfonce en butée, et quand
l'adhérence revient il commande encore à fond dans une direction qui n'est plus la bonne.
Un décrochage se payait donc deux fois. D'où l'ajout d'un **anti-windup conditionnel sur la
boucle de vitesse** (il n'existait que sur `∫θ`) : quand la consigne d'angle est déjà en butée
à ±`MAX_LEAN_DEG`, l'intégrateur gèle au lieu d'accumuler.

### `n` et `d` sont un COUPLE, pas deux réglages

La loi interne étant `v = d·θ`, l'accélération demandée vaut :

```
a_demandée = d × θ̇      (mm/s² pour d en mm/s/° et θ̇ en °/s)
```

En prenant 100 °/s comme vitesse de chute de dimensionnement, la commande reste réalisable
tant que **`d ≤ n / 1200`** :

| `n` | accélération | `d` max |
|---|---|---|
| 40000 | 3,3 m/s² | 33 |
| 60000 | 5,0 m/s² | 49 |
| 100000 | 8,3 m/s² | 82 |

Au-delà, le limiteur écrête pendant les rattrapages : **la boucle s'ouvre au pire moment**, ce
qui produit un pompage d'amplitude croissante (le pendant, pour un asservissement, du pompage
induit par saturation de vitesse en aéronautique). Constaté au banc : `d=68.5` avec `n=40000`
⇒ « oscillation incontrôlable, il s'envoie lui-même au tapis ». La console rappelle le plafond
à chaque `n`.

### Les trois métriques de `g`

| Champ | Ce qu'il dit | Sain |
|---|---|---|
| `butee X% max=Yms` | temps passé à la vitesse maximale | quelques %, `max` < 300 ms |
| `ecret X%` | temps où la LIMITE D'ACCÉLÉRATION écrête la commande | < 10 % |
| `drv_muet` | le driver n'a pas suivi la consigne | 0 |

`butee` dit « je voudrais aller plus vite », `ecret` dit « je voudrais CHANGER de vitesse plus
vite ». C'est le second qui rend un robot impossible à stabiliser.

### La boucle externe est non minimum de phase

Pour avancer, le robot doit d'abord reculer ses roues afin de se pencher : la réponse initiale
de la boucle de vitesse va **dans le mauvais sens**. C'est la raison de fond pour laquelle `v`
et `i` doivent rester petits — une boucle externe rapide se bat contre sa propre réponse.
Constaté : `i` monté à 0.018 a contribué au pompage.

### Micro-pas : rester en 1/16

Le conseil « passer en 1/8 pour gagner du couple » donné plus haut dans ce journal **est
faux** et a été corrigé. La chute de couple en vitesse est gouvernée par la fréquence
ÉLECTRIQUE (donc les tr/min), pas par la finesse du micro-pas : c'est la même sinusoïde,
échantillonnée plus finement. À haute vitesse la régulation de courant de l'A4988 dégénère
d'elle-même vers du pas entier, donc les deux réglages convergent là où le problème se pose.
En 1/8 on perdrait de la douceur — donc plus de vibrations dans l'accéléromètre, donc un
plafond plus bas sur `d` et `e`. Mauvais échange.

Ce qui achète vraiment du couple, dans l'ordre : hauteur du centre de masse (réduit le
BESOIN), **roues plus petites** (`T = F·r` ; on a de la vitesse en excès et un déficit de
couple — l'échange est direct), DRV8825 en remplacement direct, tension plus élevée.

## 🏁 22/08 (4) — CAUSE TROUVÉE, MESURÉE : la rampe du driver s'enlise en inversion

Le détecteur `[DRV ]` a capturé la panne, deux runs de suite, ~14 fois par run :

```
[DRV ] driver MUET : cmd L=5057 R=-5057 pas/s, reel L=-23 R=23, ramp L=76 R=44
[DRV ] driver MUET : cmd L=3332 R=-3332 pas/s, reel L=-3  R=3,  ramp L=76 R=44
```

On commande **5057 pas/s**, la roue tourne à **23**. Décodage des `rampState` avec les
constantes de la bibliothèque (`COUNT_UP=32`, `COUNT_DOWN=64`, `REVERSE=4+8=12`) :

- `76 = 64+12` et `44 = 32+12` → **les deux roues sont en `RAMP_STATE_REVERSE`**, donc en
  décélération pour changer de sens — et elles y restent plus de 60 ms.
- `34/66 = ACCELERATE` : démarrage légitime en cours, faux positifs du seuil.

**Mécanisme.** Près de l'équilibre, la consigne change de signe en permanence (c'est le
« avant-arrière tranquille » observé). Chaque changement de signe demande au générateur de
rampe une inversion physique : décélérer jusqu'à zéro, basculer la broche DIR, réaccélérer.
Avec une rampe driver « normale » (1,2·10⁵ pas/s²), cette inversion dure des dizaines de ms —
plus longtemps que l'intervalle entre deux consignes. **La roue passe donc son temps à
commencer des inversions sans jamais en finir une**, et reste collée près de zéro. Le
contrôleur commande dans le vide : c'est exactement l'absence, y compris le « si c'est court
il se rattrape ».

⚠️ La vitesse de reptation introduite en (3) **aggravait** le problème : elle forçait une
inversion de sens à chaque passage par zéro. Retirée.

### Correctif — l'architecture du B-Robot

Le B-Robot n'a pas ce problème parce qu'il n'a **pas de générateur de rampe** : il écrit la
période du timer directement (`timerAlarmWrite(timer1, 2000000/speed, true)`) et borne
l'accélération **dans le contrôleur** (`MAX_ACCEL 14` unités par tick de 10 ms). On reproduit
la même répartition des rôles en gardant la bibliothèque :

- **rampe interne du driver figée à `DRIVER_RAMP_STEPS_S2= 5·10⁶`** (inversion pleine échelle
  en ~3 ms) : la machine à états ne peut plus s'installer ;
- **la vraie limite d'accélération passe dans `Balance::applyWheels`**, en bornant le pas de
  consigne à `maxAccelStepsS2_ · dt` à chaque tour — la transposition directe du `MAX_ACCEL`
  du B-Robot.

La console `n` garde exactement le même sens pour l'utilisateur (« à quelle vitesse la consigne
roue a le droit de changer ») ; seul le lieu d'application change. Bénéfice de fond : **le
contrôleur sait ce que l'actionneur va faire, au lieu de l'espérer.**

Vérification : `drv_muet` dans `g` doit rester à 0. S'il grimpe encore, le driver n'est pas
en cause et il faut chercher côté mécanique (patinage, laisse USB).

### ⚠️ Effet de bord à réparer : l'offset a été empoisonné

Relevé pendant la panne : `o=-9.37` alors qu'il valait `-2.96`. Le zéro suggéré `o*` se
calcule à partir de `∫θ`, or pendant que le driver était muet l'intégrale s'accumulait sans
que la roue ne réponde — `∫θ` ne décrivait plus une erreur de zéro mais un actionneur absent.
**Ne pas utiliser `Z` tant que le robot n'équilibre pas calmement**, et remettre `o -2.96`
puis `w`.

## 🎯 22/08 (3) — « l'absence » se produit AU PASSAGE PAR ZÉRO de la consigne

Fait rapporté par l'utilisateur, décisif : *« il fait avant-arrière tranquillement, se rapproche
du point d'équilibre, puis plouf »*. La panne arrive quand la correction devient **petite**,
donc quand la vitesse roue commandée traverse **zéro**. Et il y avait un cas particulier du
code exactement à cet endroit :

```cpp
if (sps == 0) { s->stopMove(); return; }   // ancien applyWheels
```

`stopMove()` lance une rampe de décélération **et sort le générateur de son état « en
marche »**. Près de l'équilibre, la consigne vaut 0 en permanence : on appelait donc
`stopMove()` des dizaines de fois par seconde, et chaque consigne suivante (5 ms plus tard)
tombait au milieu d'une décélération. Le contrôleur commande, la roue ne réagit pas.

**Correction** : plus jamais de `stopMove()` dans la boucle. Une consigne nulle est remplacée
par une **vitesse de reptation** (`WHEEL_CREEP_SPS = 8` pas/s ≈ 0,7 mm/s) dans le dernier sens
connu — le générateur ne quitte jamais son régime nominal, et le passage par zéro redevient un
simple changement de consigne. Pas de dérive : le signe alterne autour de l'équilibre.

**Vérification** (`checkDriverFollows`) : à chaque tour, la consigne est comparée à la vitesse
RÉELLE de la rampe (`getCurrentSpeedInMilliHz`). Si on demande plus de `DRIVER_MUTE_MIN_SPS`
et que la rampe reste sous le quart pendant `DRIVER_MUTE_MS`, une ligne `[DRV ] driver MUET`
est émise avec consigne, vitesse réelle et `rampState()` des deux roues ; compteur `drv_muet`
dans `g`. C'est la **quatrième famille** de causes, celle que les trois compteurs précédents ne
pouvaient pas voir : boucle saine, IMU saine, rien ne coupe — mais le moteur n'obéit pas.

### Ce que l'hypothèse « il se croit hors zone » ne peut pas être

Les trois coupures relevées : `pitch = -46.0 / -46.2 / -45.1`, toutes à moins de 1,2° de la
limite de 45°. Un angle corrompu donnerait des valeurs quelconques ; à 200 Hz le robot traverse
le seuil à ~1°/tick, donc ces valeurs décrivent **un franchissement propre et progressif**.
La chute est réelle, l'angle ne ment pas — la panne est en amont.

### Résultats du test de décrochage (roues en l'air)

Aucun décrochage de 400 à 3000 mm/s, **dans les deux sens**. Les moteurs et les drivers sont
donc hors de cause pour la vitesse comme pour la rampe. ⚠️ Piège de vocabulaire rencontré :
`[CUT ] SATURATION` ne peut **jamais** apparaître pendant un `j` (le jog court-circuite la
boucle d'équilibre) — son absence ne prouve rien, seule l'observation de la roue compte.

## 🔎 22/08 (2) — « l'absence » : comment l'identifier au lieu de la deviner

Symptôme, ancien et récurrent : le robot est stable et vertical, puis **comme une coupure
d'alimentation moteur**. Bref → il se rattrape. Long → il tombe.

Il n'y a que **trois familles** d'explications, et elles sont maintenant discernables :

| Famille | Ce qu'on voit dans la console | Diagnostic |
|---|---|---|
| Le firmware a coupé | une ligne `[CUT ] …` avec sa cause | c'est écrit dedans |
| La boucle a calé (rien coupé) | `late=` / `pire=` grimpent dans `g` | bus I2C, ordonnancement |
| Le matériel a lâché | **rien du tout** — silence complet | driver, accu, câblage |

**Le silence est le diagnostic.** Si l'absence se produit et qu'aucun compteur ne bouge,
le firmware n'a pas coupé et la boucle a tourné : c'est physique.

### Ce qui a été ajouté

- **Journal des coupures** : toute transition vers `STATE_FALLEN` passe par `cutMotors(cause)`
  et latche un événement (cause, pitch, vitesse roue, distance, `glt`, horodatage), imprimé
  par le cœur 0 sous la forme `[CUT ] IMU PERDUE … | pitch=+1.2 v=+340mm/s x=+180mm glt=41 t=63s`.
  Bilan cumulé dans `g` : `coupures : angle=… imu=… derive=… saturation=…`.
- **Santé de la boucle** : `late=` (tours ayant dépassé 2× la période) et `pire=` (pire écart,
  en ms), remis à zéro à chaque armement. Une boucle qui cale **ne coupe rien** — les roues
  gardent leur dernière consigne et le robot part sans correction : indiscernable d'une
  coupure d'alim à l'œil, évident dans ces deux compteurs.
- **Timeout I2C 50 ms → 5 ms** (`Wire.setTimeOut(5)`, `main.cpp`). C'était le mécanisme le plus
  crédible de calage : le défaut ESP32 est de **50 ms**, soit **dix tours de boucle** perdus sur
  UNE transaction bloquée. À 100 kHz une lecture de 14 octets prend ~1,3 ms.

### Deux bugs trouvés en cherchant, qui produisaient ce symptôme

1. **Le test anti-emballement se déclenchait sur un robot parfaitement vertical.**
   Il comparait `traveledMm()` à `RUNAWAY_LIMIT_MM`, en supposant que « l'ancre borne la course
   à quelques centimètres ». Vrai seulement si l'ancre est asservie, donc si `KP_POS > 0`. Or on
   tourne à `KP_POS = 0` : l'ancre est posée une fois à l'engagement et plus jamais recentrée,
   donc `traveledMm()` mesure la dérive **cumulée du run**. Un robot qui équilibre BIEN dérive
   quand même — il finissait par franchir la limite et couper. Exactement « ça marche bien, puis
   absence ». Le test ne s'applique plus que si l'ancre est en service ; à sa place, un détecteur
   qui ne dépend pas d'elle : roue commandée à fond pendant plus de `RUNAWAY_SAT_MS` (1,5 s).
2. **Cache de consigne non invalidé à la coupure.** `applyWheels()` saute l'envoi quand
   `sps == lastSps` (pour ne pas régénérer la rampe à 200 Hz), mais `setMotorsEnabled(false)`
   appelait `forceStopAndNewPosition()` sans en informer ce cache. Si la première consigne
   calculée au réengagement retombait sur l'ancienne valeur, **aucun `runForward()` n'était émis
   et les roues restaient mortes** alors que le contrôleur se croyait actif. `lastSps` est
   désormais mis à une sentinelle inatteignable à chaque changement d'état.

### Si la console reste muette : les pistes matérielles, par ordre de probabilité

1. **Mise en sécurité thermique d'un A4988** (~150 °C jonction). Il coupe ses sorties puis
   repart en refroidissant : signature *exacte* du symptôme, y compris le « bref → il se
   rattrape ». Et c'est cohérent avec le fait que ça empire maintenant : depuis que `Ki` est
   actif, les moteurs tiennent du couple **en permanence** au lieu d'être surtout au repos.
   Test : toucher les dissipateurs après un run (ils brûlent), souffler dessus avec un
   ventilateur, ou baisser le Vref. Si le symptôme disparaît sous ventilateur, c'est réglé.
2. **Protection du BMS de l'accu 3S** sur pic de courant. Test : même run sur alim de labo.
3. **Le fil EN** (déjà coupable une fois, cf. [[mochi-stepper-bringup]]) ou un faux contact
   d'alimentation. Test : remuer les câbles pendant un run désarmé, roues en `j`.

## ✅ 22/08 — ÇA TIENT. Deux défauts résiduels, deux causes distinctes

Premier équilibre réel après le passage à `KI_ANGLE = 200`. Ce qui reste :

### 1. Dérive au démarrage, rattrapée ensuite → **∫θ repartait de zéro**

Ce n'était pas un défaut de réglage. `resetControl()` remettait `angleInteg_` à 0 à chaque
engagement, donc **Ki devait re-découvrir l'erreur de zéro θ₀ à chaque fois** : le robot
part, l'intégrale remonte, il se rattrape. Exactement le symptôme décrit.

Deux corrections, complémentaires :

- **Graine de ∫θ** (`angleIntegSeed_`, `Balance.cpp`) : la valeur atteinte pendant un
  équilibre CALME (|θ|<5°, |v|<250 mm/s, aucun ordre en cours) est mémorisée par une EMA
  lente (τ ≈ 2 s), et réinjectée au prochain engagement. Le premier tick démarre donc déjà
  compensé. La graine n'est alimentée qu'en régime calme : une chute ne peut pas la polluer.
- **Zéro suggéré `o*`** (nouveau champ de `g` et du stream, commande **`Z`**) : à l'équilibre
  au repos la loi impose `Kp·θ + Ki·∫θ ≈ 0`, donc l'angle réellement tenu vaut `−(Ki/Kp)·∫θ`.
  Ce que l'intégrale compense en permanence **est** l'erreur de `o`. Après ~30 s d'équilibre
  calme, `Z` la grave dans `o`, `w` la persiste → plus de dérive au départ, **même après reboot**
  (ce que la graine seule ne peut pas faire, elle vit en RAM).

⚠️ Tout changement de zéro (`o`, `z`, `Z`, calibration `c`/`b`) remet ∫θ **et** sa graine à
plat : la compensation vient de changer de porteur, la garder la compterait deux fois.

### 2. Pas perdus → chute « au bout d'un moment » → **l'accélération, d'abord**

Un pas perdu est **invisible du contrôleur** : il croit rouler à la vitesse commandée
pendant que la roue décroche. L'angle part sans que la commande ne le voie — d'où une chute
qui arrive « d'un coup » après une série de rattrapages réussis.

Le couple demandé à un stepper est proportionnel à l'**accélération**. À `acc=170000`
(≈ 14 m/s²) on demande **2,3× la référence B-Robot** (`MAX_ACCEL 14` ⇒ ~6 m/s²).
Ordre des essais, du gratuit au matériel :

1. `n 100000`, puis `n 70000` (= exactement le B-Robot). En direct, sans reflash.
   `n` affiche maintenant l'équivalent en m/s² pour situer.
2. Si le robot redevient « mou » avant que les pas cessent d'être perdus, c'est le **couple**
   qui manque, pas le réglage → **1/8 de pas** : retirer le cavalier MS3 de chaque socket
   (le plus proche du bornier d'alim), `MICROSTEPS = 8` dans `config.h`, reflash.
   Même vitesse roue pour deux fois moins de pas/s, donc bien plus loin du décrochage.
   ⚠️ Ensuite `n 100000` (ou `f`) : la valeur d'accél. en NVS est stockée **en pas/s²** et
   resterait deux fois trop rapide physiquement.
3. En dernier ressort, **Vref des A4988** (plus de courant = plus de couple, plus de chaleur).
   Se mesure USB branché, cf. [[mochi-stepper-bringup]] / `docs/HARDWARE.md`.

`MAX_ACCEL_STEPS_S2` est désormais dérivé de `MAX_ACCEL_MM_S2` : changer `MICROSTEPS` ne
modifie plus silencieusement l'accélération physique.

## ⭐ Session 21/08 — le terme intégral remis en service (LIRE EN PREMIER)

Comparaison ligne à ligne avec **B-ROBOT ESP32** (mêmes composants) : voir
[COMPARAISON.md, addendum A1](COMPARAISON.md). Résumé : sa vitesse roue vaut
`21.6·θ + 138·∫θ`, **le terme intégral est six fois le proportionnel**. Chez nous il
était à zéro, et rien d'autre n'annulait une erreur statique sur θ₀ → le robot partait
en ligne droite et tombait, quels que soient les autres gains.

Réglages avant la session (pour mémoire) :
`p=0 d=33.5 v=0.017 i=0.003 q=0 o=-2.96 e=0.1 y=0.998 acc=170000 s=0 trim=+0.64`.

### Procédure d'essai, dans l'ordre

Après le flash, la console annonce `NOUVELLE LOI DE COMMANDE (Ki actif)` : les gains
internes repartent de `config.h`, **la calibration NVS (offset, axe, sens des roues,
échelle gyro) est conservée**. Vérifier avec `g` qu'on lit bien `p=200.000 d=33.500 V=1400`.

1. **Vérifier le zéro AVANT tout.** Robot tenu à la verticale, désarmé (`m`), `t` pour
   streamer : `pitch` doit passer par 0 quand le robot est réellement d'aplomb, et
   changer de signe des deux côtés. Sinon `z` puis `w`. Rien d'autre ne sert tant que
   ce point n'est pas juste — c'est précisément ce que `Ki` va traquer.
2. **Regarder `bias`** (nouveau champ de `g`) sur 2-3 minutes moteurs coupés : il doit
   rester sous ~0.5 °/s et se stabiliser. S'il grimpe sans fin, le gyro dérive plus vite
   que le suivi ne corrige → refaire `b` (calibration gyro, robot posé, ne pas le suspendre).
3. **Premier run.** `m` pour armer, poser le robot d'aplomb. Attendu : il **cesse de
   partir tout droit**. Il peut osciller — c'est la suite du réglage, pas un échec.
4. **Si ça oscille lentement (période > 1 s)** → `Ki` trop fort : `p 150`, puis `p 120`.
   **Si ça tremble vite (période < 0.3 s)** → `Kp` trop fort : `d 28`, puis `d 24`.
   **Si ça part encore tout droit** → `Ki` trop faible : `p 250`, `p 300`.
5. **Autorité de rattrapage.** Si le robot « abandonne » lors des grosses corrections,
   monter `V` par paliers de 200 (`V 1600`, `V 1800`). **Surveiller le décrochage** :
   un moteur qui perd des pas fait un bruit rauque et la vitesse réelle décroche de la
   consigne → le contrôleur devient aveugle. Si ça décroche avant d'avoir assez
   d'autorité : passer les cavaliers du CNC shield en **1/8** et `MICROSTEPS = 8` dans
   `config.h` (c'est le réglage livré du B-Robot) — même vitesse, deux fois moins de pas/s.
6. **Seulement une fois qu'il tient 10 s** : essayer le filtrage du B-Robot,
   `D 5` (DLPF 10 Hz) puis `y 0.995`. L'angle devient moins sensible au biais gyro,
   au prix d'un amortissement un peu en retard — si ça tremble, revenir à `D 3`.
7. **Puis** `T 1` (estimation `v_robot = v_roue + k·θ̇`, recette B-Robot), en redescendant
   `e` à 0 en compensation : `T 1` ajoute déjà ~0.57 mm/s/(°/s) d'amortissement.
8. `w` pour figer dès qu'un réglage tient mieux que le précédent.

### Ce qu'il ne faut PAS faire

- Ne pas réactiver `s` (auto-trim θ₀) en même temps que `Ki` : les deux corrigent le
  même défaut, ils se battront. `Ki` est le mécanisme de référence, `s` est l'alternative.
  (`s 0` efface désormais le θ₀ déjà trouvé — le `trim=+0.64` fantôme est corrigé.)
- Ne pas changer deux réglages entre deux runs.
- Ne pas juger un run où `glt` grimpe : c'est le bus I2C qui ment, pas les gains.

## 🟢 Base Brokking (24/07) — on repart propre

La boucle interne est **déjà** la forme vitesse de Brokking/rekomerio
(`v = Kp·θ + Ki·∫θ + Kd·θ̇`, `Balance.cpp`) : rien de structurel à porter. La ligne
live `p=0 d=40 e=0 … acc=30000` a révélé **trois** vraies causes du « ne tient pas,
part dans un sens » :

1. **`e=0` (aucun amortissement)** → P pur = oscillateur non amorti. Terme Brokking manquant.
2. **`acc=30000`** (rampe FastAccelStepper bien trop molle ; défaut 200000) → actionneur
   plus lent que la chute (« mou puis fonce »). La **NVS écrasait config.h** (piège connu).
3. **Échelle du `e` mal comprise** : `pid_d=30` de Brokking agit sur `(err−err_préc)=θ̇·dt`
   (dt=4 ms) ⇒ gain effectif = `30×0.004 = 0.12`/(°/s). Ici `e` multiplie `gy` (°/s)
   **directement** ⇒ équivalent `e ≈ 0.008·d ≈ 0.3` (d=40), **pas** 20-30 (satureraient la
   roue dès ~23 °/s). D'où « `e` n'a jamais rien fait d'utile ».

Base config.h (défauts usine, rechargés par `f`) :

| Cmd | Gain | Valeur | Rôle |
|---|---|---|---|
| `d` | KP_ANGLE | **40** | raideur θ→v (balayer 40→55→66) |
| `e` | KD_ANGLE | **0.3** | amortissement θ̇→v = 0.008·Kp — **le terme ajouté** ; balayer ↑ |
| `p` | KI_ANGLE | 0 | ∫θ→v OFF (évite la bagarre d'intégrateurs) |
| `v` | KP_SPEED | 0.025 | frein de Brokking (×0.015) — **gardé** (proportionnel, borne la dérive) |
| `i` | KI_SPEED | 0 | intégrateur OFF pour la base |
| `q` | KP_POS | 0 | ancre de position **neutralisée** (fioriture) |
| `s` | AUTO_TRIM | 0 | OFF phase 1 (activer 0.0005 en phase 2) |
| `n` | MAX_ACCEL | 200000 | **critique** ; balayer 2e5→1e6 (tant que pas de pas sautés) |
| `o` | offset | 0 | à **re-trimmer** (le 5.25 en NVS était du déchet) |

**Deux suspects neutralisés (réversible, code conservé)** :
- **Arrêt roues au soulèvement** : `RUNAWAY_LIMIT_MM` relâché 400→1000 (sans ancre, la
  dérive légitime atteignait 400 mm et coupait). FALL 40° reste le garde-fou.
- **Auto-détermination du zéro** : l'apprentissage continu du biais gyro a d'abord été
  neutralisé (`GYRO_BIAS_LEARNING=false`) — **⚠️ ERREUR, remis `true`**. Le désactiver +
  passer le filtre à 0.9996 corrompait l'**angle fusionné** (biais gyro thermique ×τ) :
  angle qui lit le même signe des deux côtés (`abs(angle)`) et grimpe/verrouille (+15°) →
  désengage à la verticale, ne ré-engage plus. Le biais de Mochi est thermique → cet
  apprentissage est **indispensable**. Filtre revenu **0.999** (τ 5 s, l'accéléro recale
  2,5× plus vite que 0.9996). Calib gyro au boot + `b` conservés.

**Application** (la NVS écrase config.h → repartir propre) : après flash, en console —
`f` (efface la NVS déchet + charge la base), puis recalibration physique (voir *Protocoles* :
`j 40` sens roues, `a`/`k` axe+signe gyro, `z` zéro), puis `w`. Ensuite armer et **balayer
`e` puis `n`**. Phase 2 (une fois qu'il tient) : `s 0.0005` pour l'anti-dérive.

## 🚨 DÉCOUVERTE run 16 — le bus I2C lâche (ce n'est PAS un problème de gain)

Run 16 fait avec `p 12`/`d 48` (appliqués + `w` le 23/07). Le log révèle la vraie
cause qui bloque tous les réglages depuis le début :

**~15 timeouts I2C sur le MPU6050 pendant le run** (`Wire.cpp:499 requestFrom()
returned Error 263`/`-1`). La lib MPU6050_light (`fetchData`) **ne vérifie PAS**
le retour de `requestFrom` → sur timeout, elle lit du garbage → **gyro fantôme
±300-400°/s** sur 1 échantillon. Avec `d=48`, ce pic = coup d'accél. énorme →
**roues à ±700 mm/s instantané → runaway → chute**. Signature nette dans le log :
chaque `Error 263` est suivi d'un `gy=±356/388` puis `v=±700`.

Corrélation forte : les erreurs arrivent **quand les roues tournent vite** (EMI
des A4988 sur SDA/SCL 21/22, câbles DuPont + montage scotch/carton). `Wire.setClock`
est à **400 kHz** (`main.cpp:93`) = agressif sur bus bruité.

Second facteur (confirmé par l'utilisateur) : **repositionnement suspendu par les
longes** → robot « presque vertical » mais roues dans le vide qui s'emballent
(x file sur > 1 m, pitch stable à -8° impossible au sol). Gonfle le « BAL » cumulé.

### ⏳ PROCHAINE ACTION — fiabiliser AVANT de toucher aux gains
Impossible de juger d48/p12 tant que le capteur ment violemment plusieurs fois/run.
Plan firmware (NVS survit au flash, gains p12/d48 conservés) :
1. **I2C 400 kHz → 100 kHz** (`main.cpp:93`) — immunité au bruit, ~1 ligne.
2. **Garde anti-glitch gyro** dans `Balance::update()` : si saut gyro > ~200°/s en
   un tick (5 ms = physiquement impossible), rejeter l'échantillon (garder le
   précédent / sauter le cycle). Empêche 1 lecture corrompue de kicker les roues.
3. **Garde runaway/suspension** : si `|traveledMm| > ~400 mm` hors déplacement
   commandé → `STATE_FALLEN` + moteurs coupés. Tue l'artefact longe + protège la
   méca. (L'ancre légitime ne dépasse jamais ±~100 mm/s.)
Physique (utilisateur) : éloigner/torsader SDA-SCL des fils moteurs, vérifier les
connexions MPU (montage scotch = suspect), pull-ups 2.2k, cap 100 nF près du MPU.

Une fois propre : refaire un run, ALORS seulement juger d/p (si tremblement HF : d 42 ;
si mou : d 55).

## 🚨 DÉCOUVERTE 23/07 (interface de tuning) — le zéro est faux de ~27°

Mesure directe sur `tuning.html`, robot tenu **physiquement vertical** : le stream
affiche **pitch = −27°**. Avec `pitch = pitchSign×rawAngle − offset` (axe `-y`,
`o=+0.81`) ⇒ **rawY ≈ +26° alors que le robot est droit**. L'erreur est dans
l'angle fusionné du MPU, pas dans `o`.

Ça explique enfin l'observation « il ne repart que si je le penche » :
la fenêtre `|pitch| < 5°` exige que le robot soit **physiquement penché de ~27°**.
Présenté droit, il ne peut PAS s'engager — d'où les 45 % du run bloqués en FALL.

**Conséquence : le « meilleur résultat » du run 17 est un artefact.** La phase
finale (4 s à pitch ±0,25°, roues à l'arrêt, x verrouillé) correspond à un robot
**pendu dans les longes** à la pose que le capteur appelle 0° — pas à un équilibre
au sol, impossible à 27° d'inclinaison réelle. L'estimation −31° tirée des fenêtres
FALL (run 17) mesurait donc bien l'erreur capteur, et concorde avec les −27° mesurés.

### Ce que dit la lib (MPU6050_light, vérifié dans les sources)
- La fusion recale l'angle sur l'accéléromètre en continu (`angleY = 0.995*(…) +
  0.005*angleAccY`, tau ≈ 1 s à 200 Hz). **Une erreur de 26° qui PERSISTE au repos
  prouve donc que l'angle ACCÉLÉRO lui-même est faux de 26°** — ce n'est ni la
  condition initiale, ni une dérive gyro.
- **Les offsets accéléro ne sont PAS persistés** : mis à zéro dans le constructeur,
  et le boot ne calibre que le gyro. ⇒ **une mauvaise calib `c` ne survit pas à un
  reset.** C'est le test décisif.

### Confirmation par le réglage : `d 66`, TOUT le reste à zéro (meilleur à ce jour)
Trouvé empiriquement le 23/07 : `d=66`, `p=v=i=q=0`. Ça marche **parce que** le
zéro est faux, et ça corrobore le diagnostic :
```
motorSpeed += (p·angleError + d·gyroRate)·dt   avec p=0
            → motorSpeed = d·∫gyro·dt = d·(θ − θ₀)
```
L'intégrale du gyro est la **variation** d'angle ⇒ la vitesse roue devient
proportionnelle à l'angle **relatif à l'engagement**, et l'offset absolu de −27°
**sort de la boucle**. Le gyro (une rotation) est sain ; seul l'angle absolu ment.
Restent tributaires du pitch absolu : la **fenêtre d'engagement** (±5°) et la
**détection de chute** (±40°, donc asymétrique de 27°).

Coût : sans `p`, aucune référence absolue — le robot tient θ₀, pas le vrai point
d'équilibre ⇒ **fuite lente inévitable** (et tout biais gyro s'intègre). C'est un
étage 1 valide, pas un réglage final. Après remontage du MPU : réintroduire `p`
par paliers (2→4→8→16) à d=66 ; meilleur ratio d/p connu = 4,0 ⇒ cible p ≈ 16.
Puis `v 0.025`, puis `q 0.4`.

### ⏳ PROCHAINE ACTION — restaurer le zéro AVANT tout autre essai
Ne pas relancer de run d'équilibre : le robot vise un point 27° hors verticale,
il partira toujours en fuite.
1. **Test décisif (10 s)** : reset de l'ESP32 (offsets accéléro remis à 0, garanti),
   tenir le robot vertical, lire `pitch` sur `tuning.html`.
   - **≈ 0°** ⇒ c'était une calib `c` ratée dans la session courante. Ne plus
     refaire `c` (voir piège ci-dessous).
   - **encore ≈ −27°** ⇒ cause **physique** : la puce est basculée de ~26° sur son
     scotch/carton. Offsets à zéro = géométrie pure, le logiciel est hors de cause.
2. Si physique : **redresser mécaniquement** la carte MPU (à plat quand le robot
   est à son point d'équilibre), puis `b`. À défaut, `z` au point d'équilibre puis
   `w` — valable seulement si la bascule est dans le plan du tangage ; si la carte
   est aussi vrillée en roulis, le pitch reste contaminé et `o` ne suffira pas.
3. Une fois « vertical ⇒ pitch ≈ 0 », affiner `o` par la méthode roues bloquées.

## Ce qui a été corrigé cette session (dans l'ordre)

1. **MPU monté à l'envers** (X≈−177°) : le gyro Y était OPPOSÉ à l'angle Y →
   terme D anti-amortisseur + fusion interne corrompue (angle traînant ~1 s).
   Fix : retournement physique de la puce (le logiciel ne suffisait pas : la
   fusion est interne à MPU6050_light). Depuis : X≈0, gyro cohérent, signal ±0,01°.
2. **Biais gyro thermique récurrent** (~+1 à +17°/s selon les cas) : avec d=35,
   1°/s de biais = équilibre décentré de ~2° + angle qui ment. Deux calibrations
   ratées à cause de mouvements pendant la mesure. Fixes :
   - commande `b` : calib gyro SEULE, pose libre (robot posé au sol, intouché)
   - **auto-apprentissage** : moteurs coupés + quasi-immobile ≥3 s → le résidu
     gyro est replié dans les offsets MPU automatiquement (Balance.cpp)
3. **Offsets accéléro corrompus** par une calib complète `c` faite en mouvement :
   `b` ne répare QUE le gyro. Une calib `c` propre exige immobile ET vertical →
   caler le robot contre un support, sans les mains.
4. **Ancrage de position** (nouveau) : à l'engagement, position steppers mémorisée,
   rappel doux (`q`, borné 100 mm/s) vers ce point. L'ancre SUIT le robot pendant
   un déplacement commandé et se re-capture à chaque ré-engagement (un rattrapage
   à la main = nouveau « chez lui », c'est voulu). Stream : champ `x=` (mm).
5. **Boucle vitesse** : v=0.05 saturait la consigne d'angle (±12°) → oscillation
   lente couplée. Descendu à 0.025 (0.015 essayé = trop mou, remonté).

## Pièges connus (à ne pas repayer)

- **`t` et `m` sont des BASCULES** : un script qui « allume » le stream peut
  l'éteindre. Toujours sonder (lire 1-2 s, chercher `pitch=`) avant de toggler.
  Les scripts de capture doivent apparier leurs `m` (arm/disarm).
- **Le stream se fige par rafales** (lignes identiques répétées, ~0,5 s) :
  starvation du commsTask. Cosmétique mais fausse les corrélations fines.
- **`c` exige la carte MPU À PLAT, pas « le robot vertical »** : `calcOffsets`
  accumule `accZ - 1.0` (source de la lib) — il suppose que **l'axe Z de la puce
  pointe vers le haut**. Lancer `c` alors que la carte est inclinée fige un vecteur
  gravité faux ; l'erreur d'angle qui en résulte est une **translation**, donc
  **dépendante de l'angle** : `o`/`z` (décalage constant) ne peuvent PAS la corriger.
  C'est probablement ce qui a produit les +17° du run 12. En cas de doute : reset
  (les offsets accéléro repartent à zéro) plutôt que refaire `c`.
- Régler par étapes SÉPARÉES : capteurs propres D'ABORD (bias, offset), gains
  ENSUITE. Un « mauvais gain » était deux fois un capteur sale.
- PowerShell : `-match` est insensible à la casse → `' Y='` matche `gy=`.
  Utiliser `-cmatch`.
- Port série : `DtrEnable=$false; RtsEnable=$false` sinon reset de l'ESP32.
  **Même piège en Web Serial** : Chrome affirme DTR/RTS à `open()` → carte muette
  (port « connecté » mais 0 octet). `port.setSignals({dataTerminalReady:false,
  requestToSend:false})` juste après l'ouverture (fait dans `src/tuning/dashboard.ts`).
- Après un flash, la NVS survit ; le boot refait une calib gyro (robot immobile).
- **🚨 GYRO ×2 — MPU6050 CLONE** (payé le 13/08, plusieurs jours de faux réglages).
  **Symptôme** : l'angle affiché est exagéré d'un facteur ~2 **quand on bouge le
  robot à la main**, mais redevient juste si on le laisse immobile ~1 minute.
  **Cause** : la lib demande ±500 °/s et divise par 65,5, mais beaucoup de MPU6050
  vendus sont des clones qui **ignorent `GYRO_CONFIG`** et restent à ±250
  (sensibilité 131). 131/65,5 = **exactement 2**.
  **Le test qui l'isole en 2 minutes** — il sépare l'accéléro du gyro :
  `y 0.95` (τ=0,1 s → accéléro seul, fiable) doit lire l'angle VRAI ;
  `y 0.9999` (τ=50 s → gyro seul) sur une bascule franche de 90° doit lire pareil.
  Si le second est double, c'est ça.
  **Correctif** : `mpu.begin(0, 0)` dans `main.cpp` demande explicitement le ±250
  (diviseur 131) — correct pour une puce authentique **comme** pour un clone
  bloqué. Filet supplémentaire : console **`G <val>`** (échelle gyro, persistée),
  à mettre à 0.5 si le clone est au contraire bloqué en ±500.
  ⚠️ **Ce défaut invalide tout réglage de gain fait avant sa correction** : le
  terme D voyait des vitesses doubles, et le filtre complémentaire intégrait une
  dérive double. Reprendre le tuning à zéro après ce correctif.
- **« commande inconnue `�` » en BLE = bruit sur RX0** (payé le 13/08). Robot sur
  accu, USB débranché : la broche RX0 flotte et capte le hachage des A4988, ce
  qui injecte des octets fantômes dans UART0. Tant que la console fusionnait les
  deux entrées, ces octets se collaient devant la commande BLE (`\xFFd 19.0`) →
  commande rejetée, **gain jamais appliqué**, alors que rien n'était cassé côté
  réglage. Corrigé dans `Console`/`Tuning` (file par source + entrée série
  neutralisée quand un client BLE écoute + octets non imprimables jetés).
  **Signature à reconnaître** : le caractère fautif est ≥ 0x80, or le dashboard
  n'envoie que de l'ASCII → l'octet ne peut pas venir du BLE. Même bruit, même
  cause que le `glt` qui s'envole dès que les moteurs sont armés.

## Se connecter : Bluetooth (défaut) ou USB

Le firmware sert **la même console texte sur les deux transports** en parallèle
(`firmware/src/Console.h`) : mêmes commandes, mêmes lignes de stream, mêmes
réponses. `tuning.html` offre donc deux boutons, et rien d'autre ne change.

**Bluetooth — le mode de réglage réel.** Le câble USB planté dans un pendule
inversé le retient et ajoute un couple parasite : tous les essais d'équilibre
sont faussés tant qu'il est branché. En BLE le robot est posé libre.

1. servir la page en **contexte sécurisé** — Web Bluetooth l'exige :
   `npm run dev:https` (ou `http://localhost`, qui compte comme sécurisé) ;
2. alimenter le robot **sur accu**, USB débranché ;
3. cliquer **« Connecter en Bluetooth »** et choisir `Mochi` dans le sélecteur.
   Le clic est obligatoire : le navigateur interdit d'ouvrir le sélecteur sans
   geste utilisateur.

Le badge affiche alors `connecté (BLE)`.

**USB / Web Serial — toujours là.** Nécessaire pour le flash, et c'est le seul
canal qui parle **avant** que le BLE soit prêt : les messages de boot, le
`status` du MPU6050 et une éventuelle erreur stepper n'arrivent QUE sur le
série. À garder pour diagnostiquer un robot qui ne démarre pas.

### Ce qu'il faut savoir

- **L'entrée série est neutralisée pendant une session BLE** (et purgée). C'est
  volontaire : USB débranché, RX0 flotte et fabrique des commandes fantômes (cf.
  Pièges). La **sortie** série, elle, continue — le moniteur reste utilisable en
  lecture. Débrancher le BLE rend le clavier série actif immédiatement.
- **Le firmware n'émet rien tant que personne n'est abonné** : la sortie console
  n'est bufferisée qu'une fois le client BLE connecté. Ce qui a été imprimé avant
  la connexion est perdu (c'est voulu — sinon le tampon déborderait en continu).
- **En cas de saturation du lien**, le tampon jette le **plus ancien** : on peut
  voir passer une ligne tronquée, que le dashboard ignore. L'affichage reste sur
  les valeurs fraîches plutôt que de prendre du retard.
- **À la déconnexion BLE, le `jog` est remis à 0** (`j`, roues en direct). C'est
  la seule commande qui laisse le robot en mouvement continu sans pilote.
  L'équilibre, lui, **n'est pas coupé** : désarmer un robot debout le ferait
  tomber. ⚠️ Corollaire : sortir de portée n'arrête PAS un robot en équilibre —
  garde un **interrupteur physique sur le 12 V** à portée de main.
- **Ne pas alimenter en USB + accu simultanément** tant que la protection de la
  carte d'extension n'est pas confirmée (cf. `docs/HARDWARE.md`). Pour un run
  BLE : 12 V sur le bornier du CNC Shield, jack de la carte d'extension branché,
  USB débranché.

## Protocoles qui marchent

- **Sens des roues** : désarmé, `j 40` → doit avancer. (`j 0` stop.)
- **Axe/signe pitch** : capture 30-90 s pendant des bascules avant/arrière lentes
  EN CONTINU (pas de timing à respecter), ou pose statique tenue (« penche-le
  en avant et tiens-le » → pitch doit être positif).
- **Offset** : roues bloquées contre un mur, pivoter le corps jusqu'au point
  d'équilibre physique, tenir 8 s → moyenne → `o (o_actuel + moyenne)` → `w`.
- **Remontage / réorientation du MPU** (désarmé, sur `tuning.html`).
  **RÉVISÉ 13/08 — la carte n'a plus besoin d'être à plat.** `Balance` calcule
  désormais l'angle lui-même (`atan2` sur les deux composantes accéléro signées du
  plan de tangage), plage ±180° continue : à plat, à 45° ou **à la verticale**,
  seul `o` change. Choisis donc le montage le plus RIGIDE, pas le plus horizontal.
  1. **une seule contrainte** : l'**essieu des roues** doit être parallèle à un axe
     de la puce (X, Y ou Z), et la carte ne doit pas être « de biais » dans les
     deux autres directions — sinon l'angle est atténué de `cos ψ` et pollué par le
     roulis, et **aucun réglage ne corrige** (le firmware prend un axe, il ne les
     combine pas). L'inclinaison AUTOUR de l'essieu, elle, est libre.
  2. `a x|y|z` (± pour le sens) pour que **pencher en avant donne pitch > 0** ;
  3. `k` pour que **`gy` soit positif** pendant ce même mouvement ;
  4. `z` au vrai point d'équilibre, puis `w`.
  ⚠️ La tuile **MPU brut X/Y** affiche toujours les angles de la lib, qui **se
  replient** hors montage à plat : ne t'en sers plus pour valider une orientation,
  regarde `pitch` directement. Et **jamais `c`** avec une carte inclinée
  (`calcOffsets` suppose Z vers le haut) — `b` seulement.
  ⚠️ Avec `p=0` (réglage `d 66`), le gyro EST tout le contrôleur : signe inversé =
  terme D anti-amortisseur = chute immédiate. Vérifier l'étape 4 avant d'armer.
- **Run d'essai** : robot posé 5 s (auto-bias) → armer + stream 45 s → l'utilisateur
  le relève ; engagement auto quand |pitch|<5° ET |gyro|<30°/s → lâcher.
  Longe/harnais obligatoire (il se détruit en chute libre). Désarmer en fin de script.

## Pistes suivantes (par ordre de priorité)

1. **`d 48` / `p 12`** (cf. Prochaine action) — puis itérer sur le ratio.
2. **Pollution accéléro par les accélérations de roue** : chaque correction forte
   (Δv ~5 m/s²) fausse l'angle de ~15-25° via la composante accéléro → sur-correction
   en cascade après un choc. Pistes : coef fusion 0.995 → 0.999 (le rendre réglable
   console), ou compenser l'angle accéléro avec l'accélération commandée connue.
3. **Monter le centre de masse** (levier sous-exploité, contre-intuitif) : le temps
   de chute vaut `τ = √(l/g)`, l = hauteur du CdM au-dessus de l'essieu — **la masse
   totale se simplifie**. Lester EN HAUT rallonge τ (5 cm → 71 ms, 10 cm → 100 ms,
   20 cm → 143 ms) donc **facilite** l'équilibre (principe du manche à balai).
   Limite : le couple des A4988. Trop lourd → **pas sautés**, invisibles en boucle
   ouverte (`x` ment, la correction n'a pas lieu) — piste pour le « mou puis fonce »
   du run 15. À tester une fois le zéro rétabli.
4. **Fils** : cause n°1 des perturbations en test (tirent, retiennent, faussent le
   ressenti). La batterie (dans des mois) réglera ; d'ici là maximiser le mou.
5. **Rigidifier le montage MPU** (scotch sur carton actuellement) — résonances,
   et suspect n°1 du zéro faux de 27° (cf. Découverte 23/07).
6. **TMC2209** à la place des A4988 (silence + douceur basse vitesse).
7. **Micro-oscillation résiduelle** possible des A4988 à très basse vitesse.
8. **Auto-trim du point d'équilibre θ₀ (auto-calibration en marche)** — idée à
   explorer, pas encore codée. Plutôt que de chasser le zéro à la main, laisser le
   robot le trouver : un robot qui équilibre autour d'un mauvais θ₀ **dérive en
   continu** (il roule pour rester sous son CdM). La **vitesse moyenne des roues**
   (ou la position, ou la commande moteur moyenne), filtrée passe-bas, est donc un
   **signal d'erreur direct sur θ₀** — plus propre et non destructif que les
   micro-chutes. Architecture = cascade :
   - boucle interne rapide = la boucle actuelle (garde l'angle) ;
   - **boucle externe TRÈS lente** : `θ₀ ← θ₀ + Kθ·(vitesse moyenne roues)`.
   Bonus : c'est aussi du **maintien de position** (recouvre en partie l'ancre `q`).
   ⚠️ Pièges à traiter le jour où on code :
   - **Séparation des échelles de temps** obligatoire (trim ≪ équilibre), sinon les
     deux boucles se battent → oscillation. Condition n°1.
   - **Ambiguïté poussée / pente / θ₀** : une force externe soutenue ou un sol
     incliné produit le MÊME signal qu'un θ₀ faux. Calibration sur sol plat, sans
     contact, uniquement.
   - Ce signal **mélange biais IMU et vrai décalage de CdM** (on ne récupère que le
     θ₀ *effectif* — suffisant, mais ne sépare pas les deux causes).
   - ⚠️ **Ne pas confondre avec `Ki·∫θ` (i, intégrale sur l'ANGLE)** : celle-ci ne
     corrige pas un θ₀ faux, elle l'**aggrave** (elle intègre l'erreur constante δ
     → commande de vitesse qui rampe → runaway). L'auto-trim doit porter sur la
     **vitesse/position**, pas sur l'angle. Deux intégrateurs de nature différente.
   - Variante « micro-chute » (déstabiliser puis rattraper, asymétrie gauche/droite)
     = possible en **calibration one-shot au boot**, mais plus agressive/bruitée et
     risque de vraie chute ; le trim continu reste préférable.
   Prérequis : zéro grossièrement rétabli + boucle interne décente (donc `p`
   réintroduit, cf. Découverte 23/07). Étape logique APRÈS les pistes 1-2.
9. À terme : reporter les gains finaux dans `config.h`, exposer la calibration
   via BLE (OP_CALIBRATE existe déjà côté protocole + `Op.CALIBRATE` côté web),
   tester le BLE avec l'app web (jamais fait).

## Historique des runs (45 s chacun)

| Run | Config | Résultat |
|---|---|---|
| 9 | post-retournement, o=1.70, v=0.05 | épisodes 2→13 s, tgt saturait |
| 10 | v=0.025 | 12 s max, équilibre décentré à −7° (biais gyro +5°/s) |
| 11 | + recalib gyro | **22 s**, phase parfaite 8,5 s, pitch moyen +0,6° |
| 12 | v=0.015, calib `c` RATÉE (mouvement) | jamais engagé (pitch mentait de +17°) |
| 13 | `b` gyro-only, ancre q=0.4 | ~1 m de dérive, pas de télémétrie (bug toggle `t`), accéléro encore corrompu |
| 14 | calib `c` propre + o=0.81 | 9 s max, mou (v=0.015) + biais revenu (−1,2°/s) |
| 15 | v=0.025, auto-bias | 13,5 s max, rappel d'ancre visible ±180 mm, mais « mou puis fonce » → d/p à rééquilibrer |
| 16 | d48/p12, auto-bias | **non exploitable** : ~15 timeouts I2C → gyro fantôme ±380°/s → runaway roues ±700 ; + artefacts longe (pitch -8° tenu, x > 1 m). Aucun équilibre franc. Révèle le bus I2C comme vrai bloqueur. |
| 17 | idem + I2C 100 kHz + gardes | **0 erreur I2C, 0 glitch** — le fix du bus est validé. ⚠️ Mais la « phase posée » de 4 s (pitch ±0,25°, roues à l'arrêt, x figé à 119 mm) est en fait le robot **pendu dans les longes** à la pose que le capteur appelle 0° : impossible au sol avec un zéro faux de 27°. Ne pas citer comme référence d'équilibre. |
| 18 | `d 66`, p=v=i=q=0 | **Meilleur à ce jour.** Contourne le zéro faux : sans `p`, l'offset absolu sort de la boucle (cf. section dédiée). Étage 1 seulement — fuite lente attendue. |

---

## 23/08 — La cause du « il tombe au point d'équilibre » : FastAccelStepper

**Symptôme, tenace depuis le début :** le robot tient en mouvement, se rapproche de
la verticale, et lâche là — « le cas le plus simple ». Souvent avec une rotation.

**Diagnostic.** Les événements `[DRV ]` ont donné la clé, à condition de lire les
états de rampe. Sur neuf événements consécutifs, la roue immobile était **à chaque
fois** en `RAMP_STATE_REVERSE` (76 = 64+12, 44 = 32+12), l'autre en `COAST`.
Commande 747 pas/s, roue réelle −2 pas/s.

Trois correctifs successifs, chacun rendant le suivant visible :

1. **Verrou d'inversion commun aux deux roues.** Le mécanisme est symétrique (mesure :
   gauche morte 3×, droite 3×, les deux 3×) — c'est une course dont l'issue dépend du
   remplissage de chaque file et de la phase de chaque rotor. Ce qui est asymétrique,
   c'est la **conséquence** : rien ne mesure le lacet, donc chaque pile ou face dépose
   une erreur de cap définitive. En gelant les deux roues ensemble, la perte
   d'autorité devient rectiligne. **→ la rotation à la chute disparaît.**
2. **Critère élargi au désaccord de sens.** Le test `== RAMP_STATE_REVERSE` était trop
   étroit : une fois la symétrie rétablie, les enlisements se présentaient en
   `DECELERATE` (68 = COUNT_DOWN|4). Le bon critère est « la rampe va-t-elle là où la
   consigne demande ? ».
3. **Plancher de vitesse à signe préservé (console `F`).** Le correctif décisif.

**Résultat au banc :** `F 16` → ne tombe plus (mais vibre). `F 4` → ne tombe plus,
avec un léger balancier. **Premier état où le robot ne tombe pas.**

**Ce que `F 4` enseigne.** 4 mm/s = 48 pas/s, donc une latence de file de 20 ms —
autant que sans plancher. La latence n'était donc **pas** la cause. La cause est
l'**état dégénéré à vitesse nulle** : le générateur de rampe doit décélérer depuis
zéro vers zéro et ne déclare jamais avoir fini. N'importe quel plancher non nul
l'évite ; monter plus haut n'apporte rien et injecte de la vibration.

**Pourquoi le point d'équilibre est le cas le PLUS dur.** Pour le contrôleur, oui,
c'est le plus simple : petite erreur, petite correction. Pour l'actionneur c'est
l'inverse — la consigne y traverse zéro (donc inversion), sa magnitude y est petite
(donc ordres de file longs), et la décélération part d'une vitesse déjà nulle (donc
elle ne se termine pas). **Plus le travail du contrôleur est facile, plus celui de
l'actionneur est difficile.**

**Ce que ce n'était pas.** Vref (0,77 vs 0,81 V, écart de 5 %), adhérence, couple
(1,1 kg → 10,2 m/s² disponibles pour ~5 nécessaires), tension d'alimentation (la
référence B-Robot tourne en 7,2 V), taille des roues (la référence en a de plus
grandes). Tout le matériel était sain.

### Géométrie mesurée (23/08)

| grandeur | valeur | conséquence |
|---|---|---|
| masse | 1,1 kg | `n_max` = 11,2 N / 1,1 × 12,126 ≈ **123 000 pas/s²** |
| CdM / sol | 8,5 cm | l = 8,5 − 4,2 = **4,3 cm** |
| τ = √(l/g) | **66 ms** | budget de retard total ≈ 6,6 ms, dont 5 pour la boucle |
| Δv nécessaire (10°) | a·τ ≈ **340 mm/s** | `V 900` est déjà large |

Fenêtre utile de `n` : **40 600** (écrêtage à d=33,5) → **123 000** (couple à 1,1 kg).
Réglé à 75 000.

### Nouveaux outils console

- `F <mm/s>` — plancher de vitesse à signe préservé. **4 est le bon réglage.**
- `B <deg>` — balancier volontaire sur la consigne d'angle, à `SWAY_HZ` (1,5 Hz,
  sous la fréquence propre du pendule à 2,4 Hz). `B ≈ F / kpAng`.
- `x` — remet les compteurs à zéro (ils dataient du boot : deux réglages n'étaient
  pas comparables sans reflasher).
- `g` affiche en plus `contresens max=…ms @cmd=…` (temps pendant lequel la rampe
  tourne à l'opposé de la consigne, sans seuil — le pendant basse vitesse de
  `drv_muet`, qui est aveugle sous 600 pas/s) et `inv_forcee`.

### Pièges rencontrés

- **`a y` / `a -y` retourne la polarité de TOUTE la boucle** (`pitchSign_` multiplie
  l'angle *et* le gyro). Un robot qui fonce dans le sens de sa chute, c'est ça.
- **`Z` sur un robot en difficulté grave sa détresse dans l'offset.** Deux fois :
  −2,96 → −9,37, puis −7,13 → −17,02. À n'utiliser qu'après un équilibre calme.
- **`l` et `r` inversent une roue immédiatement, sans confirmation.** À vérifier dans
  `g` au moindre comportement bizarre.
- **`j 0` coupe `/ENABLE`** : tester le couple à la main après un `j 0`, c'est tester
  des moteurs hors tension. Utiliser `j 1` (12 pas/s, sous tension) pour le couple
  statique — attendre ~570 gf à la jante à 1,0 A.
