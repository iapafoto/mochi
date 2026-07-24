# Comparaison de stabilisation — Mochi vs rekomerio/self-balancing-robot

> Analyse comparative avec [rekomerio/self-balancing-robot](https://github.com/rekomerio/self-balancing-robot),
> réputé « très stable », pour identifier ce qui manque à Mochi côté équilibre — en vue d'un
> châssis plus lourd (bois + accu) qui remplacera le carton.
>
> Conclusion en une phrase : **l'architecture de Mochi est la bonne**, il lui manque surtout
> **un terme d'amortissement `θ̇` direct** dans la commande de vitesse (voir Diff n°1). Le reste
> tient au réglage et au montage physique.

## 0. Ce qui est identique (rien à « copier » côté structure)

| | Mochi | rekomerio |
|---|---|---|
| Type | pendule inversé sur 2 roues | idem |
| Actionneurs | 2× stepper NEMA 17 | 2× stepper NEMA 17 |
| Capteur | MPU6050 (accéléro + gyro) | MPU6050 |
| Estimation d'angle | filtre complémentaire | filtre complémentaire |
| Contrôle | cascade PID **angle → vitesse → position** | cascade PID **angle → vitesse → position** |
| Détection de chute | `FALL_LIMIT_DEG = 40°` | `MAX_ANGLE = 40°` |
| µC | ESP32 (FreeRTOS, 2 cœurs) | Arduino Nano |

Les deux robots sont conceptuellement le même robot. Les différences ci-dessous sont des
**détails de loi de commande** et de **hardware**, pas d'architecture.

## 1. Diff n°1 — le terme d'amortissement `θ̇` manquant (le point central)

C'est **structurel**, pas une histoire de valeur de gain.

| | Sortie de la boucle interne | Commande de vitesse roue effective |
|---|---|---|
| **rekomerio** | `vitesse = PID(θ)` → la sortie **EST** la vitesse | `v = Kp·θ + Ki·∫θ + Kd·θ̇` |
| **Mochi** (`firmware/src/Balance.cpp:232-235`) | `accel = kp·θ + kd·θ̇`, puis `v += accel·dt` | `v = kd·θ + kp·∫θ` |

En intégrant l'accélération, Mochi **décale d'un cran** l'effet de chaque gain (∫θ̇ = θ) :

- `kdStab·θ̇` intégré → devient `kd·θ` (vitesse ∝ angle) = équivaut au **P** de rekomerio ;
- `kpStab·θ` intégré → devient `kp·∫θ` (vitesse ∝ intégrale) = équivaut au **I** de rekomerio ;
- **… et il ne reste aucun terme en `θ̇`** (vitesse ∝ vitesse angulaire).

Or `Kd·θ̇` (=30 chez rekomerio) est **l'amortisseur immédiat** : il freine dès que ça bouge, avant
même que l'angle ne se soit constitué. La loi de Mochi n'atteint que le sous-espace **{θ, ∫θ}** ;
celle de rekomerio atteint **{θ, ∫θ, θ̇}** (c'est essentiellement le retour d'état complet d'un
pendule sur roues).

**Ça explique le meilleur réglage empirique `d=66` seul** (TUNING.md run 18) : sans terme
d'amortissement réel, on est obligé de cranker à fond l'unique gain proportionnel-sur-angle, et on
obtient un **oscillateur marginalement amorti** → d'où la « fuite lente inévitable » notée.

### Effets secondaires de la formulation accélération
1. **Un intégrateur de plus dans la boucle** (entre loi de commande et actionneur) = **+90° de
   retard de phase** → moins de marge → plus enclin à osciller.
2. **Un biais gyro devient une dérive de vitesse.** `v += kd·gyroRate·dt` intègre le gyro **brut** :
   un biais constant `b` produit un terme `kd·b·t` qui **rampe**. Chez rekomerio, `Kd·θ̇` avec le
   même biais ne donne qu'un **offset de vitesse constant** (inoffensif). → **Toute la machinerie
   d'auto-apprentissage du biais** (`biasEstX_`, calib `b`) **compense un symptôme de cette
   formulation.**
3. **Avantage inverse :** intégrer l'accélération produit une vitesse **lisse, sans à-coups**
   (doux pour les steppers, moins de pas sautés).

**Point de fond :** « accélération = PID(θ) » est naturel pour un balancier à **moteurs DC**
(PWM ≈ couple ≈ accélération). Mochi a des **steppers = actionneurs de vitesse** → c'est plutôt la
forme vitesse (rekomerio) qui colle. → **décision : refactor de la boucle interne en forme vitesse**
(cf. `docs/TUNING.md` et le firmware).

## 2. Diff n°2 — la référence amortit AUSSI ses boucles externes

| Boucle | rekomerio | Mochi (`config.h:86-92`) |
|---|---|---|
| Vitesse → angle | P=0.0165, **D=0.00425** | KP_SPEED=0.025, KI_SPEED=0.001, **pas de D** |
| Position | P=0.3, **D=9.0** (fort) | KP_POS=0.4 **seul** |

rekomerio met du **D partout** → tout est amorti → « très stable » au ressenti. Mochi n'a de D
nulle part (et son unique D est « mangé » par l'intégration, cf. n°1). Piste secondaire : ajouter
un D sur la boucle vitesse et/ou position.

## 3. Diff n°3 — la rampe d'accélération du stepper ajoute du retard

- **rekomerio** écrit la fréquence de pas **instantanément** (`OCR1A` dans l'ISR Timer1).
- **Mochi** passe par FastAccelStepper avec `MAX_ACCEL_STEPS_S2 = 56000` (`config.h:132`) →
  inverser 700 → −700 mm/s prend **~0,3 s** de rampe. Pour une boucle à 5 ms et une chute à
  τ ≈ 120 ms, c'est du **lag pur** dans l'actionneur.

Mineurs : 250 Hz (rekomerio) vs 200 Hz (Mochi) ; rekomerio lit l'accéléro/gyro **brut** et calcule
son angle lui-même, Mochi délègue à la fusion interne de `MPU6050_light` (`getAngleX/Y`).

## 4. Politique de calage du zéro (pourquoi le montage vertical ne gêne pas rekomerio)

Politique de **rekomerio** (dans son `setup()` / `computeAngle()`) :
- **Calibration du gyro SEUL** (moyenne sur `CALIBRATION_ROUNDS = 50`). **Aucune** calib accéléro.
- **Angle amorcé depuis l'accéléro** au boot (`setInitialAngle`, atan2 maison) → ne part pas de 0,
  pas d'attente de convergence.
- **`CG`** = **une seule constante** compile-time soustraite à l'angle accéléro (au boot *et* à
  chaque tick). C'est **exactement le rôle du `BALANCE_OFFSET_DEG` / `offsetDeg_` de Mochi**.
  Dans le repo, `CG = 0`.
- **`targetAngle = 0`**, ajusté uniquement par le PID de vitesse.

→ Politique **agnostique à l'orientation** : l'atan2 est écrit à la main pour matcher le montage,
et **aucune hypothèse « Z vers le haut »** puisque l'accéléro n'est jamais calibré. D'où : montage
**vertical** parfaitement OK.

Côté **Mochi**, le problème historique du faux-zéro venait de `MPU6050_light::calcOffsets()`, qui
**suppose la carte à plat** (accumule `accZ − 1.0`) : lancer la calib `c` carte inclinée fige un
vecteur gravité faux, non corrigeable par un simple offset.

> **Reco : adopter la politique de rekomerio.** Ne faire **que** la calib gyro (`b`), **ne jamais**
> relancer la calib accéléro `c`, et absorber le **résiduel de ~6°** par le trim `o` (méthode roues
> bloquées). Ces 6° ne sont plus un bloqueur — juste un `CG` à régler.

## 5. Hauteur du MPU — ça compte (dynamiquement), et à l'opposé de la masse

L'accéléro mesure la **force spécifique** = `a_capteur − g` ; on ne veut que `g`. Un capteur monté
à hauteur `h` au-dessus de l'essieu subit, quand le corps tourne (`ω = θ̇`, `α = θ̈`), **en plus de
la gravité** :
- une composante **tangentielle `h·α`**,
- une composante **centripète `h·ω²`**,

toutes deux **proportionnelles à `h`**. En **chute**, `α` grimpe → `h·α` grimpe → **l'angle accéléro
est d'autant plus faux que le MPU est monté HAUT** (c'est la « pollution accéléro » de
`docs/TUNING.md`, piste 2). Le **gyro, lui, est indépendant de `h`** (la vitesse angulaire est
identique partout sur un solide) — d'où le fait que le gyro reste fiable (`d=66` seul marche).

**Deux optimums opposés :**

| Objet | Position optimale | Pourquoi |
|---|---|---|
| **Centre de masse** | le plus **HAUT** possible | `τ = √(l/g)` plus long → chute plus lente → plus facile (principe du manche à balai) |
| **Le MPU** | le plus **BAS** possible, près de l'axe des roues | annule `h·α` et `h·ω²` → angle absolu propre pendant les corrections |

Sur le châssis bois : **accu en haut, MPU au ras de l'essieu et centré**. Ce n'est pas
contradictoire — ce sont deux objets différents.

⚠️ Les **6° au repos** ne viennent **pas** de la hauteur (à l'arrêt `ω = α = 0` → aucune pollution) :
c'est un pur **offset statique** → trim `o`. La hauteur dégrade la précision **dynamique**
(pendant chutes/corrections), pas le zéro statique.

## 6. Hardware — d'où vient sûrement l'essentiel du « très stable »

| | rekomerio | Mochi |
|---|---|---|
| Drivers | **DRV8825** (~2,2 A) | A4988 (~1,5 A, **2 déjà HS**) |
| Alimentation | **LiPo 3S embarquée** → **sans fil** | tétheré (les fils = perturbateur n°1 selon TUNING.md) |
| Montage IMU | rigide | scotch/carton (source du faux-zéro) |

**Châssis plus lourd (bois + accu) :** la masse **ne change pas** `τ = √(l/g)` (seule la hauteur du
centre de masse compte). Mais elle **augmente le couple** nécessaire → les A4988 déjà limites →
risque accru de **pas sautés** (`config.h:125-132`), qui rendent le contrôleur **aveugle** (la
vitesse réelle décroche de la commande). Leviers pour le « lourd » :
- **DRV8825** (ou **TMC2209** : silence + douceur basse vitesse) à la place des A4988 ;
- **Vref** réglé correctement, éventuellement tension moteur plus haute ;
- **accu monté haut** (relève le centre de masse → `τ` plus long → plus facile).

## 7. Recommandations, par ordre de priorité

1. **Trimmer les ~6° résiduels** via `o` (calib gyro `b` uniquement, **jamais** `c`). Préalable.
2. **Fiabilité mécanique** pour le châssis lourd : DRV8825/TMC2209, montage IMU rigide, **MPU bas /
   masse haute**.
3. **Refactor de la boucle interne en forme vitesse** `v = Kp·θ + Ki·∫θ + Kd·θ̇` (ajoute le terme
   `θ̇` manquant). Démarrer au comportement connu-bon (`Kp = 66, Ki = 0, Kd = 0` ≡ run 18), puis
   **monter `Kd`** — on s'attend à réduire le tremblement HF et la fuite, et à pouvoir baisser `Kp`.
4. (Optionnel) **D sur les boucles vitesse/position** (Diff n°2).
