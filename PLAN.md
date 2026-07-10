# Robot équilibriste expressif « Mochi » — Plan (web / Gemini)

> Brief exécutable en Claude Code. Travailler **jalon par jalon**, valider chaque critère d'acceptation dans Chrome desktop avant de passer au suivant.

---

## 0. Avancement & décisions (mise à jour 2026-07-10)

**Fait (beta, vérifié dans Chrome) :**
- **M0→M3 + sons** : visage WebGL2 lissé, presets d'émotion, **sons kawaii** (synthèse WebAudio procédurale — ajout hors plan initial), vocabulaire d'intentions + dispatcher, transport mocké, panneau debug.
- **Agent texte** : `agent/gemini.ts` via **`generateContent` + function calling**. Modèle **`gemini-2.5-flash`** (free tier). Fallback local (mots-clés) sans clé.
- **Micro desktop (push-to-talk)** : `audio/speech.ts` via **Web Speech API** (navigateur) → texte → boucle Gemini. ⚠️ **Béquille phase dev** : inadaptée au robot (pas d'écran à toucher).
- **Personnalité** : centralisée dans `agent/persona.ts` (caractère éditable + règles fixes), et **éditable à chaud** dans le panneau (section « Personnalité (IA) » → Appliquer/Défaut). Mochi **parle** (courte phrase) en plus des function calls.
- **⚠️ Choix modèle texte** : `gemini-3.1-flash-lite` et `gemini-3-flash-preview` sont **« function-only »** avec des tools (aucun texte renvoyé) → inutilisables pour un personnage qui parle. `gemini-2.5-flash` renvoie **texte + function calls ensemble** → retenu. (Le Live audio `gemini-3.1-flash-live-preview`, lui, produit bien voix + function calls.)

**Décisions actées (corrigent le plan d'origine) :**
- **Le Live API ne fait PAS de modalité TEXT** (`gemini-3.1-flash-live-preview` refuse TEXT) → pour le texte on reste sur `generateContent`. Le Live est réservé à l'**audio**.
- **Interaction robot = Live API audio streaming** (`gemini-3.1-flash-live-preview`). **Coût non bloquant** pour un robot de **démo ponctuelle** (audio in ~0,005 $/min, out ~0,018 $/min, + free tier → ~0,25 $ pour 30 min). **Wake-word optionnel** (charme, pas nécessité de gating).
- **Mochi parle** (option retenue) : voix de **petit personnage** (rôle, ton mignon), en plus des function calls. On jugera sur les tests s'il le joue bien. Sortie audio 24 kHz PCM.
- **Réflexe local « stop »** hors cloud (sécurité équilibriste) — à garder quel que soit le canal.

**Prototype Live audio validé** (`scripts/test-live.mjs`, Node isolé) :
- ✅ session + **function calling en modalité AUDIO** (`express`, `wiggle`), ✅ **voix décodée** (PCM 24 kHz → WAV lisible, ~2,5 s, non silencieux), ✅ transcription + personnage (« Ouiii ! Trop content ! »).
- ⚠️ **À traiter à l'intégration navigateur** : ordre audio ↔ tool calls **non déterministe** ; répondre au `toolCall` pendant que Mochi parle peut **tronquer l'audio** ; signaux `turnComplete`/`generationComplete` à fiabiliser. Gérer proprement l'enchaînement tour/outil/reprise.

**Idée future (télémétrie dans la réflexion) :** remonter vitesse/position depuis l'ESP32 et l'injecter dans le raisonnement de Mochi, **à côté du flux audio** — soit comme **contexte périodique** poussé dans la session Live (`sendClientContent` texte discret), soit en **retour de function call**. À spécifier plus tard.

**Piste ouverte — deux régimes d'interaction, à trancher par les tests (2026-07-10) :**
- **Conversation** : Mochi parle (voix de personnage), riche. `gemini-2.5-flash` en texte / Live audio sur le robot, `functionCallingConfig.mode: AUTO` (texte + function calls).
- **Contrôle / sans parole** : Mochi n'émet QUE des actions, aucun texte — via `toolConfig.functionCallingConfig.mode: ANY` (forcé function-only, déterministe, rapide, sans blabla ; `allowedFunctionNames` pour restreindre). Idéal pour un **routeur de commandes rapides** et les **réflexes locaux** (« stop », « avance »).
  > NB : `mode: ANY` = vrai réglage documenté. À part ça, on a observé que `gemini-3.1-flash-lite`/`gemini-3-flash-preview` **penchent** vers le function-only même en `AUTO` (biais de ces flash récents), là où `gemini-2.5-flash` inclut du texte.
- **Hypothèse séduisante : un mode SANS PAROLE pourrait être *plus* attachant** (façon WALL-E / BB-8) — Mochi s'exprime uniquement par **gestes + visage + sons kawaii**. Se marie naturellement avec `mode: ANY`. **Pré-requis : enrichir le vocabulaire non-verbal** — oui = `nod` (existe), **non = hochement latéral `shake` (À AJOUTER, absent aujourd'hui)**, question/curiosité = `headTilt`/`express('curiosity')`, acquiescement, etc. Choix conversation vs sans-parole (ou bascule des deux) à départager sur les tests.

**Piège build (résolu) :** `tsc` sans `noEmit` émettait des `.js` dans `src/` que **Vite sert avant les `.ts`** → code obsolète servi silencieusement. Corrigé (`noEmit: true`). Vérifier `find src -name '*.js'` (doit être vide) si un comportement « fantôme » réapparaît.

---

## 1. Contexte & intention

On construit la **tête cognitive et expressive** d'un petit robot équilibriste. Architecture finale en 3 couches, façon système nerveux :

- **Cortex (déporté)** : Gemini (multimodal, function-calling) — raisonnement + langage.
- **Sensorium + chef d'orchestre** : le téléphone (écran = visage, micro = oreilles, caméra = yeux). C'est **ce que couvre ce dépôt**, sous forme d'app web (dev dans Chrome desktop, déploiement PWA Android plus tard).
- **Moelle épinière (embarquée, hors périmètre)** : un ESP32 qui tient seul la boucle d'équilibre temps réel. **Aucune ligne d'équilibre ici.** Cette app n'émet que des *intentions* de haut niveau.

**Principe directeur** : le vocabulaire d'expression et de mouvement est défini **une seule fois**. Une intention comme `look('right')` pilote en v1 le regard du visage (réel) et, en v2, la rotation de la base (via BLE). En v1 tous les actionneurs moteur sont **mockés** (log console + panneau debug) derrière une interface `sendIntent()` ; le visage, lui, est réel.

---

## 2. Périmètre v1

**Dans le périmètre**
- Visage procédural WebGL2 (shader) piloté par un `FaceState` lissé.
- Vocabulaire d'intentions typé + déclarations de fonctions Gemini.
- Harnais Gemini : texte → function calls → intentions dispatchées (visage réel, moteur mocké).
- Panneau debug : saisie texte, boutons de test d'intentions, log des intentions moteur, bouton « Connecter le robot » (stub).

**Hors périmètre v1** (seams à préparer, pas à implémenter)
- Streaming micro (Live API) → v1b.
- Capture caméra → vision Gemini → v1c.
- Transport Web Bluetooth réel + firmware ESP32 → v2.
- Toute logique d'équilibre → jamais dans ce dépôt.

---

## 3. Stack & contraintes (décisions verrouillées)

- **Build** : Vite + TypeScript. HMR indispensable pour itérer sur le shader. TS justifié par le contrat d'intentions typé ↔ function declarations Gemini.
- **Rendu visage** : WebGL2, un **fragment shader plein écran** (quad), dessin **SDF** des yeux / sourcils / bouche à partir d'uniforms. Pas de sprites, pas de lib externe de rendu.
- **Pas de framework UI** : le panneau debug est du DOM/TS minimal. (Pas de React.)
- **Transport actionneur derrière une interface** (`Transport.sendIntent`) : impl `mockTransport` en v1, `bleTransport` en v2. Le reste du code ne connaît que l'interface.
- **Protocole fil défini dès maintenant** (opcodes ci-dessous) pour que mock et futur ESP32 s'accordent, même si le mock ne fait que logguer.
- **Clé API Gemini** : `VITE_GEMINI_API_KEY` dans `.env.local` pour le dev (exposée côté client — acceptable en usage perso local). Prévoir un commentaire « // TODO: proxy pour cacher la clé » ; ne pas monter le proxy en v1.
- **Gemini (résolu, cf. §0)** : SDK **`@google/genai`**. Texte → `ai.models.generateContent` avec `config.tools = [{ functionDeclarations }]`, réponse dans `response.functionCalls`. Modèle texte **`gemini-2.5-flash`** (renvoie texte + function calls ; les `3.1-flash-lite`/`3-flash-preview` sont function-only). Audio (robot) → `ai.live.connect` en modalité **AUDIO**, modèle **`gemini-3.1-flash-live-preview`** (⚠️ ne supporte pas TEXT). Tout l'appel réseau reste isolé dans `agent/gemini.ts`.
- **`tsconfig` : `noEmit: true`** obligatoire — sinon `tsc` sème des `.js` dans `src/` que Vite sert à la place des `.ts`.

---

## 4. Architecture logicielle

```
robot-face/
  index.html
  package.json
  vite.config.ts
  tsconfig.json
  .env.local                 # VITE_GEMINI_API_KEY=...
  src/
    main.ts                  # bootstrap : câble renderer + agent + transport + devPanel
    face/
      face.frag              # fragment shader WebGL2 (SDF du visage)
      faceRenderer.ts        # setup GL2, upload uniforms, boucle RAF
      faceState.ts           # type FaceState + easing courant→cible par canal
      expressions.ts         # presets d'émotion → FaceState cible ; transients (blink/wink)
    agent/
      gemini.ts              # SEUL point réseau Gemini (isole les détails d'API)
      intents.ts             # vocabulaire d'intentions + functionDeclarations Gemini
      dispatcher.ts          # functionCall Gemini → intention → face | transport
    robot/
      transport.ts           # interface Transport + protocole (opcodes, encodage)
      mockTransport.ts       # log console + événement pour le panneau debug
      bleTransport.ts        # STUB v2 (throw NotImplemented)
    ui/
      devPanel.ts            # saisie texte, boutons test, log intentions, bouton Connecter (stub)
```

---

## 5. Contrats de conception (ne PAS improviser)

### 5.1 FaceState

Tous les canaux sont normalisés et **lissés** (le renderer fait tendre `current` → `target` à chaque frame, lissage exponentiel avec un `tau` par canal ; c'est ce lissage qui rend le visage « vivant »). `blink`/`wink` sont des **transients scriptés** (fermeture rapide puis réouverture), pas de simples cibles statiques.

| Canal            | Domaine   | Sens                                             |
|------------------|-----------|--------------------------------------------------|
| `eyelidL/eyelidR`| 0..1      | fermeture paupière (0 ouvert, 1 fermé)           |
| `gazeX/gazeY`    | -1..1     | direction du regard                              |
| `pupil`          | 0..1      | dilatation (surprise/curiosité)                  |
| `browRaiseL/R`   | -1..1     | sourcils haut/bas                                |
| `browFurrow`     | 0..1      | froncement (colère/concentration)                |
| `mouthOpen`      | 0..1      | ouverture                                        |
| `mouthCurve`     | -1..1     | -1 moue … +1 sourire                             |
| `headTilt`       | -1..1     | inclinaison 2D de la tête (curiosité)            |

### 5.2 Vocabulaire d'intentions

Défini **une fois** dans `intents.ts`, exposé à Gemini comme `functionDeclarations`, dispatché vers le visage (réel) ou le transport (mock v1).

**Expression (visage réel en v1)**
- `blink()` — clignement.
- `wink(side: 'left'|'right')` — clin d'œil.
- `look(dir: 'left'|'right'|'up'|'down'|'center')` — regard. *(v2 : pilote aussi la rotation de base.)*
- `express(emotion: 'joy'|'sadness'|'surprise'|'curiosity'|'neutral', intensity: 0..1)` — applique un preset (voir 5.3).

**Mouvement (mocké en v1, BLE en v2)**
- `forward(cm)`, `backward(cm)`, `turn(deg)`
- `nod()`, `bow()` (révérence), `wiggle()` — gestes « numéro de cirque ».

### 5.3 Presets d'émotion (`expressions.ts`)

Cibles indicatives à affiner visuellement (intensité module l'amplitude) :
- **joy** : `mouthCurve`↑, `browRaise`↑ léger, paupières légèrement plissées, `tau` court (vif).
- **sadness** : `mouthCurve`↓, sourcils intérieurs relevés, `gazeY`↓, `tau` long (lent).
- **surprise** : paupières grand ouvertes, `browRaise`↑↑, `mouthOpen`↑, `pupil`↑.
- **curiosity** : `headTilt`≠0, un sourcil relevé (asymétrie), `pupil`↑.
- **neutral** : reset doux vers repos.

### 5.4 Protocole transport (`transport.ts`)

Message compact = **1 octet opcode + params** (pas de JSON ; MTU BLE réduit en v2). En v1 le mock logue `{op, args}`.

| Opcode | Intention   | Params            |
|--------|-------------|-------------------|
| 0x00   | STOP        | —                 |
| 0x01   | FORWARD     | int16 cm          |
| 0x02   | BACKWARD    | int16 cm          |
| 0x03   | TURN        | int16 deg         |
| 0x10   | NOD         | —                 |
| 0x11   | BOW         | —                 |
| 0x12   | WIGGLE      | —                 |
| 0x20   | LOOK        | int8 dir          |

Interface :
```ts
interface Transport {
  connect(): Promise<void>;         // v1 mock: no-op ; v2: Web Bluetooth
  sendIntent(op: number, ...args: number[]): void;
  onTelemetry(cb: (state: DataView) => void): void; // v2
}
```

---

## 6. Jalons & critères d'acceptation

### M0 — Scaffold
Projet Vite+TS, `npm run dev` sert une page avec un canvas WebGL2 plein écran (fond uni) et un panneau debug vide.
**OK si** : dev server tourne, canvas visible, zéro erreur console.

### M1 — Visage lissé
`faceRenderer` + `FaceState` + easing par canal ; shader SDF dessinant deux yeux, sourcils, bouche. Boutons debug pour forcer des états (blink, wink L/R, look, mouthCurve).
**OK si** : les transitions sont **lissées** (pas de saut) ; `blink`/`wink` jouent un transient crédible ; `look` déplace le regard.

### M2 — Intentions + dispatcher
`intents.ts` (vocabulaire), `dispatcher.ts` (intention → visage | transport), `mockTransport`. Boutons debug déclenchant chaque intention.
**OK si** : intentions visage → réaction visuelle ; intentions moteur → log `{op,args}` dans le panneau ; `express('joy',1)` applique le preset.

### M3 — Harnais Gemini
`gemini.ts` (isole l'API — **vérifier le modèle/API courant d'abord**) + saisie texte dans le panneau. Le texte part avec les `functionDeclarations` ; les `functionCall` renvoyés sont dispatchés.
**OK si** : « fais un clin d'œil » → `wink` ; « regarde à droite » → `look('right')` ; « avance de 20 cm » → log FORWARD 20 ; « aie l'air surpris » → `express('surprise',…)`. Chaîne texte → Gemini → intention → visage/log fonctionnelle de bout en bout.

### M4 — Panneau debug consolidé
Saisie texte, grille de boutons de test, log horodaté des intentions moteur, bouton « Connecter le robot » (appelle `transport.connect()`, no-op en mock). Screen Wake Lock activé.
**OK si** : tout pilotable au clavier/souris sans toucher au code ; état clair de ce que « ferait » le robot.

### M5 — Voix mains-libres (Live audio) — prochain jalon
Passer du push-to-talk desktop à la **conversation vocale Live** pour le mode robot. Faisabilité déjà validée (§0, `scripts/test-live.mjs`). À faire :
- Capture micro `getUserMedia` (avec `echoCancellation`) → **AudioWorklet** → PCM 16 kHz → `session.sendRealtimeInput({ audio })`.
- Lecture de l'**audio de sortie** (PCM 24 kHz) → Mochi parle (voix de personnage) ; en parallèle, dispatch des `functionCall` vers le visage/moteur.
- **Gérer l'enchaînement tour/outil** : ordre audio↔toolCall non déterministe, éviter de tronquer l'audio en répondant au `toolCall`, fiabiliser fin de tour (`turnComplete`/`generationComplete`/`interrupted`).
- **Ne pas écouter pendant que Mochi parle** (anti larsen : babil + moteurs dans son micro).
- **Réflexe local `stop`** hors cloud (sécurité équilibriste). Wake-word « Mochi » **optionnel** (charme).
**OK si** : on parle à Mochi sans rien toucher, il répond en voix de personnage + réactions visuelles, et « stop » l'arrête instantanément.

### Esquisses (plus tard)
- **v1c** — caméra : `getUserMedia` → capture sur intention → **redimensionner ~1024 px / JPEG q80** → Gemini vision.
- **v2** — `bleTransport` (Web Bluetooth, GATT : characteristic `command` write-without-response + `telemetry` notify), reconnexion via `gattserverdisconnected`, firmware ESP32 (NimBLE). Basculer `main.ts` de `mockTransport` à `bleTransport` : rien d'autre ne bouge.

---

## 7. Risques & points à vérifier

- **API Gemini** : modèle et forme du function-calling à confirmer sur la doc à jour (voir §3). Tout confiner dans `gemini.ts`.
- **Clé API côté client** : OK pour dev perso ; laisser un TODO proxy.
- **Web Bluetooth (v2)** : persistance d'autorisation entre sessions (`getDevices()`) encore jeune sur Chrome Android — à valider sur le Samsung, éventuellement derrière un flag. Absent d'iOS (sans objet, cible Android).
- **Coexistence radios (v2)** : le tél garde WiFi/5G vers Gemini *et* BLE vers l'ESP32 simultanément — c'est l'argument qui justifie BLE plutôt que WiFi pour l'actionneur.

---

## 8. Lancer en Claude Code

1. Placer ce fichier à la racine du dépôt (ou le renommer `CLAUDE.md`).
2. Démarrer par **M0**, puis avancer **un jalon à la fois** ; à chaque jalon, lancer `npm run dev`, ouvrir Chrome et vérifier le critère d'acceptation avant de continuer.
3. M0→M3 + sons + micro desktop **faits** (§0). **Prochain jalon = M5** (voix mains-libres Live audio).
4. Ne pas implémenter v1c (caméra) / v2 (BLE) pour l'instant, ni quoi que ce soit lié à l'équilibre (reste sur l'ESP32, hors dépôt).
