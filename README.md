# Mochi 🤖

Tête cognitive et expressive d'un petit robot équilibriste **kawaii**. App web (Vite + TypeScript),
visage procédural WebGL2, sons mignons synthétisés, et interaction IA via **Gemini** (function calling).

Voir [PLAN.md](PLAN.md) pour l'architecture complète et les jalons.

## Ce qui marche dans cette beta

- **Visage procédural** (shader SDF plein écran) piloté par un `FaceState` lissé : yeux, sourcils,
  bouche, regard, clignements. Transitions douces (easing exponentiel par canal) → visage « vivant ».
- **Émotions** : `joy`, `sadness`, `surprise`, `curiosity`, `anger`, `neutral` (presets modulés par une intensité).
- **Sons kawaii** : synthèse WebAudio procédurale (chirps/blips « petit animal »), une signature par
  émotion + un *babil* pendant que Mochi « parle ». Aucun fichier audio.
- **Vocabulaire d'intentions typé** → dispatché vers le visage (réel), le son, et le transport moteur (mocké).
- **Interaction IA** : agent Gemini (`gemini-3.1-flash-lite`, `generateContent` + function calling) qui
  traduit une phrase en intentions. **Fallback local** (règles par mots-clés) si aucune clé n'est
  configurée, pour tout tester sans réseau.
- **Micro (push-to-talk)** : bouton « Maintenir pour parler » → reconnaissance vocale du navigateur
  (Web Speech API, fr-FR) → texte → même boucle Gemini. Chrome/Edge uniquement, demande l'autorisation
  micro. Mochi répond toujours en sons kawaii (pas de TTS).
  > Note : le **Live API** (`gemini-3.1-flash-live-preview`) est réservé au jalon micro/voix (v1b) — il
  > ne supporte que l'audio, pas une réponse texte seule. Pour l'usage actuel (texte + sons kawaii),
  > `generateContent` est le bon outil.
- **Panneau debug** : saisie texte, boutons de test (émotions / actions / moteur), log horodaté des
  intentions moteur (avec octets du protocole fil), toggle son, bouton « Connecter » (mock).

## Lancer

```bash
npm install
npm run dev        # http://localhost:5173
```

Cliquer une fois dans la page pour débloquer l'audio (politique navigateur).

## Activer l'IA Gemini (optionnel)

```bash
cp .env.local.example .env.local
# puis renseigner la clé (Google AI Studio) :
# VITE_GEMINI_API_KEY=xxxxxxxx
```

Sans clé, l'app utilise l'agent local (mots-clés FR : « fais un clin d'œil », « avance de 20 cm »,
« tu as l'air content », « regarde à droite »…). Avec clé, la même chaîne passe par Gemini.

> ⚠️ La clé est exposée côté client — OK pour du dev perso local uniquement. Prévoir un proxy avant
> tout déploiement (TODO signalé dans `agent/gemini.ts`).

## Structure

```
src/
  face/        FaceState + easing, shader SDF, renderer WebGL2, presets d'émotion
  audio/       moteur de sons kawaii (WebAudio procédural)
  agent/       intents (vocabulaire), gemini (seul point réseau), agent (factory + fallback), dispatcher
  robot/       transport (interface + protocole), mockTransport (v1), bleTransport (stub v2)
  ui/          devPanel
```

## Hors périmètre (voir PLAN.md)

Streaming micro (v1b), caméra/vision (v1c), transport BLE réel + firmware ESP32 (v2), et **toute
logique d'équilibre** (jamais dans ce dépôt).
