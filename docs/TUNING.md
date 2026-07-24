# Journal de tuning équilibre — état et pistes

> Session du 22-23/07/2026. Objectif : tenir en équilibre sur place.
> Meilleur résultat à date : **22 s d'équilibre continu** (run 11), avec une
> phase parfaitement posée de 8,5 s (pitch ±2°, roues quasi immobiles).

## État actuel (sauvé en NVS, rechargé au boot)

| Gain | Valeur | Rôle dans CETTE architecture |
|---|---|---|
| `p` (KP_STAB) | 15.0 | angle → accél. roue. Intégré en vitesse ⇒ agit comme un **intégral** (empile de la vitesse tant que ça penche) |
| `d` (KD_STAB) | 35.0 | gyro → accél. roue. Intégré ⇒ **vraie raideur** (vitesse ∝ angle). C'est LE gain de rattrapage immédiat |
| `v` (KP_SPEED) | 0.025 | boucle vitesse → angle de consigne. 0.05 = claque en butée ±12°, 0.015 = trop mou (laisse filer). 0.025 = le bon ordre de grandeur |
| `i` (KI_SPEED) | 0.001 | anti-dérive lent |
| `q` (KP_POS) | 0.4 | rappel vers l'ancre de position (mm/s par mm d'écart, borné ±100 mm/s) |
| `o` (offset) | +0.81° | méthode roues bloquées (voir Protocoles) |
| axe | `-y` | MPU remonté À L'ENDROIT, penché avant = pitch > 0 |
| roues | invL=0 invR=1 | validé par jog : +40 mm/s = avance |

`config.h` est aligné sur ces valeurs (défauts usine = état courant).

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

## Protocoles qui marchent

- **Sens des roues** : désarmé, `j 40` → doit avancer. (`j 0` stop.)
- **Axe/signe pitch** : capture 30-90 s pendant des bascules avant/arrière lentes
  EN CONTINU (pas de timing à respecter), ou pose statique tenue (« penche-le
  en avant et tiens-le » → pitch doit être positif).
- **Offset** : roues bloquées contre un mur, pivoter le corps jusqu'au point
  d'équilibre physique, tenir 8 s → moyenne → `o (o_actuel + moyenne)` → `w`.
- **Remontage / réorientation du MPU** (désarmé, sur `tuning.html`) :
  1. carte **à plat** au point d'équilibre → `pitch` doit lire ≈ 0 ;
  2. pencher en avant ~45° et lire la tuile **MPU brut X/Y** : un seul axe doit
     bouger (rotation à 90° près, OK) ; si les deux bougent ensemble, la carte est
     de biais dans son plan → l'angle est atténué de `cos ψ` et pollué par le
     roulis, **aucun réglage ne corrige** (le firmware choisit un axe, il ne les
     combine pas) → réaligner mécaniquement ;
  3. `a x|-x|y|-y` pour que **pencher en avant donne pitch > 0** ;
  4. `k` pour que **`gy` soit positif** pendant ce même mouvement ;
  5. `w`.
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
8. À terme : reporter les gains finaux dans `config.h`, exposer la calibration
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
