import './style.css';
import { FaceState, REST_FACE } from './face/faceState';
import { FaceRenderer } from './face/faceRenderer';
import { startAutoBlink, express } from './face/expressions';
import { SoundEngine } from './audio/sounds';
import { SpeechInput } from './audio/speech';
import { BleTransport } from './robot/bleTransport';
import { Op } from './robot/transport';
import { parseTelemetry, RobotState, type RobotStateValue, type Telemetry } from './robot/bleProfile';
import { DriveLoop } from './robot/driveLoop';
import { MoveQueue } from './robot/moveQueue';
import { Dispatcher } from './agent/dispatcher';
import { DevPanel } from './ui/devPanel';
import type { Agent } from './agent/agent';
import { createAgent } from './agent/agent';
import { LiveConversation } from './agent/live';
import { loadGeminiKey, saveGeminiKey, hasStoredKey } from './agent/apiKey';
import { setupPwa } from './pwa';
import { DEFAULT_PERSONA, buildSystemInstruction } from './agent/persona';
import { EmoteLayer } from './fx/emotes';
import { MoodEngine, ambientFromMood, restingFaceFromMood } from './affect/mood';
import { LocalVad } from './audio/vad';
import { Backchannel } from './affect/backchannel';

// --- Câblage des couches ---
const canvas = document.getElementById('face') as HTMLCanvasElement;
const fxCanvas = document.getElementById('fx') as HTMLCanvasElement;
const panelRoot = document.getElementById('dev-panel') as HTMLElement;

const face = new FaceState();
const sound = new SoundEngine();
// Lien réel vers l'ESP32 (Web Bluetooth). Rien ne part tant qu'on n'a pas cliqué
// « Connecter » : `requestDevice` exige un geste utilisateur et du HTTPS/localhost.
const transport = new BleTransport();
const emotes = new EmoteLayer(fxCanvas);
const mood = new MoodEngine();
// Trajectoires continues (ronds) : OP_DRIVE réémis à 10 Hz. Le robot les oublie
// tout seul si l'app se tait (homme mort côté firmware).
const driveLoop = new DriveLoop(transport, (completed) =>
  panel.logLine(completed ? '○ rond terminé' : '○ rond interrompu'),
);
// File des déplacements mesurés : c'est elle qui rend « avance vite, puis recule
// lentement » possible. Les deux ordres arrivent ensemble ; sans elle, le second
// écrase le premier côté firmware, en silence (cf. robot/moveQueue.ts).
const moveQueue = new MoveQueue(transport, {
  // `null` = on ne sait pas : pas de robot au bout, ou pas encore de télémétrie.
  isMoving: () => (transport.connected && lastTelemetry ? lastTelemetry.moving : null),
  gate: () => moveGate(),
  log: (line) => panel.logLine(line),
});
const dispatcher = new Dispatcher(
  face,
  sound,
  transport,
  mood,
  emotes,
  driveLoop,
  moveGate,
  moveQueue,
);

const renderer = new FaceRenderer(canvas, face);
renderer.start();
startAutoBlink(face);

// L'agent est assigné juste après le panneau (il en dépend pour logguer).
// `onSend` le référence en différé — appelé seulement sur interaction.
let agent: Agent;

// Dernier état connu du robot. Sert de garde-fou aux actions qui n'ont de sens que
// dans une posture précise (calibration et capture du zéro, robot en main).
let lastTelemetry: Telemetry | null = null;

/** Doit rester aligné sur ZERO_CAPTURE_MAX_DEG (firmware/include/config.h). */
const ZERO_CAPTURE_MAX_DEG = 45;

/**
 * Inclinaison max tolérée pour lancer une calibration IMU.
 *
 * Plus SERRÉ que la capture de zéro, et ce n'est pas une inconséquence : un zéro
 * faux se rattrape d'un `z`, une référence accéléro fausse contamine tout ce qui
 * lit un angle. Le prix d'un refus abusif est de tenir le robot un peu plus droit.
 *
 * ⚠️ Ce test n'a de sens que si la référence est ENCORE bonne — il lit `pitchDeg`,
 * qui en dépend. Quand elle est déjà cassée, il refusera la calibration qui la
 * réparerait : c'est la console `c` qui sert alors de sortie de secours, sans
 * garde-fou, pour l'humain qui sait ce qu'il fait.
 */
const CALIB_MAX_TILT_DEG = 20;

// Conversation vocale Live (créée plus bas si une clé Gemini est présente).
// Référencée en différé par les handlers du panneau, comme `agent`.
let live: LiveConversation | null = null;

// --- Écoute active -----------------------------------------------------------
//
// Ce que Mochi fait PENDANT que tu parles, et dans les ~300 ms qui suivent — le
// seul registre expressif qui ne passe ni par le réseau ni par le modèle, donc le
// seul qui soit vraiment instantané. Cf. affect/backchannel.ts et audio/vad.ts.
const backchannel = new Backchannel(face, {
  playHum: () => sound.play('backchannel'),
});

/** Anti-répétition du « mmh ? » : il perdrait tout s'il tombait à chaque phrase. */
let lastThinkingMs = 0;
const THINKING_COOLDOWN_MS = 6000;
/** Une phrase plus courte que ça est un bruit, pas un tour de parole. */
const THINKING_MIN_TURN_MS = 700;

const vad = new LocalVad({
  onSpeechStart: () => backchannel.start(),
  onSpeechEnd: (durationMs) => {
    backchannel.stop();
    // LE son qui comble le trou : joué ICI, à la fin de TA phrase, donc avant que
    // le modèle ait produit quoi que ce soit. C'est tout l'intérêt d'une détection
    // locale — la session, elle, n'a même pas encore décidé que ton tour est fini.
    const now = Date.now();
    if (durationMs < THINKING_MIN_TURN_MS) return;
    if (now - lastThinkingMs < THINKING_COOLDOWN_MS) return;
    lastThinkingMs = now;
    sound.play('thinking');
    face.setTarget({ channels: { gazeY: 0.3, gazeX: 0.22, pupil: 0.7 }, tau: 0.16 });
  },
});

// Anime la bouche pendant que Mochi parle (piloté par l'amplitude de la voix).
let voiceLevel = 0;
let flapTimer: number | null = null;
function startMouthFlap(): void {
  if (flapTimer !== null) return;
  flapTimer = window.setInterval(() => {
    const amp = Math.min(1, voiceLevel * 1.6);
    const v = 0.1 + amp * 0.5 * (0.55 + Math.random() * 0.45);
    face.setChannel('mouthOpen', v, 0.05);
  }, 90);
}
function stopMouthFlap(): void {
  if (flapTimer !== null) {
    clearInterval(flapTimer);
    flapTimer = null;
  }
  face.setChannel('mouthOpen', REST_FACE.mouthOpen, 0.14);
}

// Boucle d'humeur : décroissance vers la baseline + pilotage de l'affichage
// (teinte d'ambiance, visage au repos, emotes automatiques) + lecture panneau.
let wasHappy = false;
let wasSad = false;
let lastAutoEmote = 0;
function startMoodLoop(): void {
  const TICK = 0.1;
  window.setInterval(() => {
    mood.step(TICK);
    const m = mood.mood;
    renderer.setAmbient(ambientFromMood(m));
    panel.setMood(m.valence, m.arousal);

    // Le visage au repos reflète l'humeur quand aucune émotion récente (le
    // flap de bouche pendant que Mochi parle a priorité → on n'y touche pas).
    // L'écoute active aussi : elle écrit les mêmes canaux 25 fois par seconde,
    // et cette boucle-ci, qui tourne à 10 Hz, gagnerait une fois sur deux — le
    // visage attentif se ferait effacer en plein milieu d'une phrase.
    if (mood.idleFor > 3.5 && flapTimer === null && !backchannel.active) {
      face.setTarget({ channels: restingFaceFromMood(m), tau: 0.9 });
    }

    // Tant qu'il est COUCHÉ, il reste triste. Sans cette relance, l'humeur
    // remonterait toute seule vers sa baseline joyeuse (τ = 22 s) et on aurait un
    // robot ravi, le nez sur la moquette, incapable de se relever.
    if (lastTelemetry?.state === RobotState.FALLEN && Date.now() - lastWhimperMs > WHIMPER_PERIOD_MS) {
      lastWhimperMs = Date.now();
      mood.nudge(-0.25, -0.05);
      sound.play('sadness');
    }

    // Emotes automatiques sur bascule d'humeur (anti-spam par cooldown).
    const now = performance.now() / 1000;
    const happy = m.valence > 0.6 && m.arousal > 0.48;
    const sad = m.valence < -0.55;
    if (happy && !wasHappy && now - lastAutoEmote > 3) {
      emotes.spawn(Math.random() < 0.5 ? 'hearts' : 'sparkles');
      lastAutoEmote = now;
    } else if (sad && !wasSad && now - lastAutoEmote > 3) {
      emotes.spawn('rain');
      lastAutoEmote = now;
    }
    wasHappy = happy;
    wasSad = sad;
  }, 100);
}

const panel = new DevPanel(panelRoot, {
  onIntent: (call) => {
    void sound.unlock();
    // Les boutons de banc méritent le même retour que l'IA : c'est ICI qu'on
    // essaie un déplacement en premier, donc ici qu'un refus muet coûte le plus.
    const res = dispatcher.dispatch(call);
    if (!res.ok) panel.logLine(`⚠ ${res.name}: ${res.detail}`);
  },
  onSend: (text) => {
    void sound.unlock();
    panel.logLine(`🗣 « ${text} »`);
    mood.nudge(0.03, 0.06); // il aime qu'on lui parle
    void agent.send(text);
  },
  onConnect: () => void connectRobot(),
  onArm: (on) => {
    // On n'anticipe PAS l'affichage : c'est la télémétrie qui bascule le bouton, donc
    // il ne dit « armé » que si le robot l'a vraiment confirmé.
    if (!on) {
      moveQueue.clear();
      driveLoop.stop();
    }
    // Le zéro se capture AVANT l'armement : après, le robot corrige déjà et la pose
    // qu'on lui désignerait ne serait plus celle de la main.
    if (on && panel.zeroOnArm) captureZero('⌖ zéro capturé en armant');
    transport.sendIntent(Op.ARM, on ? 1 : 0);
    panel.logLine(on ? '⚡ armement demandé' : '⚡ désarmement demandé');
  },
  onZeroHere: () => captureZero('⌖ zéro capturé'),
  onZeroAdopt: () => {
    // Adopter le zéro suggéré n'a de sens QUE sur un robot qui équilibre : c'est ce
    // que ∫θ compense en ce moment qu'on recopie. Robot à l'arrêt, l'intégrale est un
    // reste de la dernière fois — on graverait un chiffre périmé.
    if (lastTelemetry?.state !== RobotState.BALANCING) {
      panel.logLine('⚠ zéro auto : il doit être EN ÉQUILIBRE, et l’avoir été ~30 s au calme.');
      return;
    }
    transport.sendIntent(Op.ZERO_ADOPT);
    panel.logLine('⊙ zéro auto adopté — « Enregistrer » pour le garder au reboot');
  },
  onSave: () => {
    transport.sendIntent(Op.SAVE);
    panel.logLine('💾 réglages enregistrés en NVS');
  },
  onZeroOnArmChange: (on) =>
    panel.logLine(on ? '⌖ le zéro sera capturé à chaque armement' : '⌖ capture à l’armement désactivée'),
  onMicProcessingChange: (on) => {
    panel.logLine(
      on
        ? '🎙 micro : anti-écho + réduction de bruit ACTIFS (réglage téléphone-contre-la-bouche)'
        : '🎙 micro : capture BRUTE — à essayer téléphone posé à distance',
    );
    void live?.setMicProcessing(on);
  },
  onMicGainChange: (g) => live?.setMicGain(g),
  onCalibrate: () => {
    // GARDE-FOU que la console n'a pas : la calibration coupe les moteurs et repasse
    // en IDLE pendant ~2 s. Lancée sur un robot DEBOUT, elle le fait tomber — et on
    // ne s'en rend compte qu'au bruit. Elle se fait robot en main, tenu vertical.
    if (lastTelemetry?.state === RobotState.BALANCING) {
      panel.logLine('⚠ calibration refusée : il est en équilibre. Le prendre en main d’abord.');
      return;
    }
    // ⚠️ LE GARDE-FOU QUI MANQUAIT, ET QUI A COÛTÉ UNE SÉANCE (23/08).
    // `calcOffsets(gyro, accel)` grave la pose du moment comme référence « az = 1 g ».
    // Lancée robot COUCHÉ SUR LA TABLE — la position la plus naturelle du monde pour
    // cliquer un bouton — elle grave « couché = 0° » : le robot lit alors ~90° debout,
    // ne se voit plus jamais vertical, et les moteurs ne s'engagent plus. Aucun message
    // ne parle d'IMU, on cherche ailleurs pendant une heure.
    // Le test précédent ne protégeait QUE le cas inverse (robot debout qu'on fait
    // tomber) : il laissait passer celui qui casse la référence.
    const tilt = lastTelemetry?.pitchDeg;
    if (tilt !== undefined && Math.abs(tilt) > CALIB_MAX_TILT_DEG) {
      panel.logLine(
        `⚠ calibration refusée : ${tilt.toFixed(0)}° de la verticale. La tenir DROIT en main — ` +
          'cette pose devient la référence de TOUT le reste.',
      );
      return;
    }
    transport.sendIntent(Op.CALIBRATE);
    panel.logLine('◎ calibration IMU — tenir VERTICAL et IMMOBILE ~2 s');
  },
  onToggleMute: (muted) => sound.setMuted(muted),
  onVoiceStart: () => {
    void sound.unlock();
    speech.start();
  },
  onVoiceStop: () => speech.stop(),
  onPersonaApply: (text) => {
    agent.setPersona?.(text);
    panel.logLine('🎭 personnalité mise à jour');
  },
  onLiveToggle: () => {
    if (!live) return;
    if (live.active) void live.stop();
    else startLive();
  },
  onLiveStop: () => {
    live?.stopReflex();
    // L'ordre compte : couper le réémetteur AVANT le STOP. L'inverse enverrait le
    // STOP puis, 100 ms plus tard, la consigne suivante du rond — un bouton d'arrêt
    // qui n'arrête rien est pire que pas de bouton du tout. Même raison pour la
    // file : un STOP qui laisserait repartir le déplacement suivant trois secondes
    // plus tard serait exactement le même bug, avec un délai.
    moveQueue.clear();
    driveLoop.stop();
    transport.sendIntent(Op.STOP); // réflexe moteur (sécurité)
    panel.logLine('⏹ STOP (réflexe local)');
  },
  onVoiceChange: (name) => void live?.setVoice(name),
  onPitchChange: (factor) => live?.setPitch(factor),
  // L'agent et la session Live sont construits UNE FOIS au démarrage, à partir
  // de la clé : la seule façon honnête de la changer à chaud est de repartir de
  // zéro. Recharger est aussi ce qui évite de laisser tourner une session Live
  // ouverte avec l'ancienne clé.
  onGeminiKeyChange: (key) => {
    saveGeminiKey(key);
    location.reload();
  },
});

// Entrée vocale (push-to-talk) → même chemin que la saisie texte.
const speech = new SpeechInput({
  onState: (listening) => panel.setListening(listening),
  onPartial: (text) => panel.setPartial(text),
  onFinal: (text) => {
    panel.logLine(`🎤 « ${text} »`);
    mood.nudge(0.03, 0.06);
    void agent.send(text);
  },
  onError: (msg) => {
    panel.setListening(false);
    panel.logLine(`⚠ ${msg}`);
  },
});
panel.setVoiceSupported(speech.supported);

// Clé Gemini : saisie une fois dans le panneau et gardée sur CET appareil, avec
// repli sur `.env.local` en dev (cf. agent/apiKey.ts pour le pourquoi). Elle
// n'est jamais inlinée dans le bundle : rien n'empêche donc de poser l'app sur
// n'importe quel hébergement statique.
const { key: geminiKey, source: keySource } = loadGeminiKey();

// L'agent (Gemini si clé présente, sinon règles locales) traduit le texte en
// intentions et appelle dispatch pour chacune, plus un babil pendant qu'il « parle ».
agent = createAgent(
  {
    dispatch: (call) => {
      const res = dispatcher.dispatch(call);
      if (!res.ok) panel.logLine(`⚠ ${res.name}: ${res.detail}`);
    },
    babble: (ms, mood) => sound.babble(ms, mood),
    log: (line) => panel.logLine(line),
  },
  geminiKey,
);

// Conversation vocale Live (vraie voix streamée). Sans clé, pas de Live : le
// bouton se grise et le panneau renvoie vers la section « Clé Gemini ».
// Les sons kawaii sont coupés pendant la session pour ne pas parasiter la voix.
if (geminiKey) {
  live = new LiveConversation(geminiKey, {
    onStatus: (status, detail) => {
      panel.setLiveStatus(status, detail);
      if (status === 'error' && detail) panel.logLine(`⚠ Live : ${detail}`);
      const running = status !== 'idle' && status !== 'error';
      panel.setLiveActive(running); // pilote le bouton depuis l'état réel (gère les relances)
      sound.setVoiceMode(running);
      if (running) keepAwake();
      else {
        stopMouthFlap();
        backchannel.stop();
        vad.reset();
      }
    },
    onUserText: (t) => {
      panel.logLine(`🎤 « ${t} »`);
      mood.nudge(0.02, 0.05);
    },
    onMochiText: (t) => panel.logLine(`💬 Mochi : ${t}`),
    onSpeakingChange: (speaking) => {
      if (speaking) {
        startMouthFlap();
        // Il prend la parole : l'écoute s'arrête, et la détection repart de zéro.
        // Sans ce reset, sa propre voix — que le micro entend malgré tout — laisse
        // le détecteur en état « ça parle », et le tour suivant démarre déjà ouvert.
        backchannel.stop();
        vad.reset();
      } else {
        stopMouthFlap();
      }
    },
    onLevel: (lvl) => (voiceLevel = lvl),
    onMicFrame: (peak) => {
      vad.push(peak);
      backchannel.push(vad.level, vad.speakingForMs(), vad.pauseMs());
    },
    // Le seul moyen de savoir, DEPUIS LE TÉLÉPHONE, pourquoi Mochi parle bas :
    // sur Android le repli sort au volume d'APPEL, et il ne se signale nulle part.
    onRoute: (viaElement, detail) =>
      panel.logLine(
        viaElement
          ? `🔊 ${detail}`
          : `⚠ 🔈 ${detail} — sur Android c'est le volume d'APPEL, donc faible`,
      ),
    onMicLevel: (peak, sending) => panel.setMicLevel(peak, sending),
    dispatch: (call) => {
      const res = dispatcher.dispatch(call);
      if (!res.ok) panel.logLine(`⚠ ${res.name}: ${res.detail}`);
    },
  });
}
// Le portillon micro : chaque blip kawaii rend le micro sourd le temps qu'il dure,
// pour ne pas revenir dans la session (cf. SoundEngine.setVoiceMode). C'est CE
// branchement qui rend les sons jouables pendant une conversation — sans lui, il
// fallait tous les couper, et c'est ce qu'on faisait.
sound.onWillPlay((ms) => live?.gateMicFor(ms));
panel.setLiveSupported(!!live);
// État de la clé : « saisie sur cet appareil » ne se déduit pas de « une clé est
// active » — en dev, `.env.local` fait marcher Gemini sans que rien ne soit
// stocké, et c'est précisément l'écart qui rend le champ incompréhensible.
panel.configureGeminiKey(hasStoredKey(), keySource);
// La case est restaurée du localStorage à la construction du panneau ; le micro,
// lui, démarre sur son défaut. Sans cette ligne, un réglage décoché réapparaît
// coché au rechargement côté capture uniquement — l'écran dit une chose, le micro
// en fait une autre, et on cherche pourquoi le réglage « ne marche pas ».
void live?.setMicProcessing(panel.micProcessing);
live?.setMicGain(panel.micGain);

// Éditeur de personnalité (seulement si l'agent gère un system prompt = Gemini).
panel.configurePersona(!!agent.setPersona, agent.getPersona?.() ?? DEFAULT_PERSONA, DEFAULT_PERSONA);

// Log des intentions moteur dans le panneau.
transport.onMotorEvent((e) => panel.logMotor(e));

// Télémétrie : la seule chose qui dise si Mochi est debout, armé, ou en train de
// tomber. Sans elle, une commande qui ne fait rien ne se distingue pas d'un robot
// qu'on aurait oublié d'armer.
transport.onTelemetry((dv) => {
  const t = parseTelemetry(dv);
  if (!t) return;
  const previous = lastTelemetry?.state;
  lastTelemetry = t;
  panel.setTelemetry(t);
  panel.setArmed(t.armed);
  if (previous !== undefined && previous !== t.state) reactToState(previous, t.state);
});

// Lien BLE : le SEUL endroit qui décide de ce qu'affiche le bouton « Connecter ».
// Il doit l'être, parce que le lien s'ouvre désormais aussi tout seul — au
// démarrage et à chaque reprise après une coupure. Un état affiché depuis le
// chemin du clic ne verrait pas passer ces deux-là.
transport.onConnectionChange((connected) => {
  panel.setConnected(connected);
  if (connected) {
    panel.logLine('🤖 connecté — pense à ARMER (le robot boote désarmé)');
    keepAwake();
    return;
  }
  // Perte de lien subie (robot éteint, hors de portée) : on cesse de piloter. Côté
  // robot le TTL a déjà tout coupé — ici on évite juste que l'app continue de parler
  // dans le vide et remplisse le journal de « non émis ».
  moveQueue.clear();
  driveLoop.stop();
  panel.logLine('⚠ robot déconnecté — reprise automatique en cours');
});

// Premier contact avec l'écran (voir « Démarrage automatique » plus bas).
window.addEventListener('pointerdown', onFirstGesture, { once: true, capture: true });

// Humeur : décroissance + pilotage de l'affichage (démarré une fois tout câblé).
startMoodLoop();

// Service worker : cache durable + politique de mise à jour. `busy()` est ce qui
// empêche un rechargement de tomber au milieu d'une démo — voir src/pwa.ts.
setupPwa({
  busy: () => !!live?.active || transport.connected,
  log: (line) => panel.logLine(line),
});

// Lancer l'app, c'est vouloir parler à Mochi : on tente les deux clics tout seul.
void autoStart();

// Quelle version tourne, et avec quelle clé. Ces deux lignes existent pour la même
// raison : après un déploiement, l'app peut servir l'ancien cache et lire une clé
// qu'on ne croyait plus là — deux choses invisibles qui font chercher au mauvais
// endroit. Le tampon est aussi affiché en bas du panneau, où il ne défile pas.
panel.setBuildId(__BUILD_ID__);
panel.logLine(`ℹ build ${__BUILD_ID__} — clé Gemini : ${keySource}`);

console.info('[Mochi] prêt.', agent.info, '| build', __BUILD_ID__);

// --- Réflexes de posture -----------------------------------------------------
//
// Tomber et être relevé sont les deux choses les plus marquantes qui arrivent à ce
// robot, et jusqu'ici elles ne se lisaient que dans une ligne de journal. Or la
// donnée est déjà là, dix fois par seconde, dans la télémétrie.
//
// C'est un RÉFLEXE, pas une réaction du modèle : il part en ~100 ms (le temps
// d'une notification BLE), sans réseau ni tokens. Un être vivant sursaute d'abord
// et commente ensuite ; ici, pour l'instant, il ne fait que sursauter.

/** Dernière relance de tristesse pendant qu'il est couché (cf. startMoodLoop). */
let lastWhimperMs = 0;
const WHIMPER_PERIOD_MS = 6000;

function reactToState(previous: RobotStateValue, next: RobotStateValue): void {
  if (next === RobotState.FALLEN) {
    express(face, 'sadness', 0.9);
    sound.play('fall');
    emotes.spawn('rain');
    mood.nudge(-0.6, -0.15);
    lastWhimperMs = Date.now();
    panel.logLine('💔 il est tombé…');
    return;
  }
  // On ne se réjouit QUE si on revient de la chute. Le premier armement passe
  // aussi par IDLE → BALANCING, et fêter ça donnerait une explosion de joie à
  // chaque mise en route — la même que celle du sauvetage, donc plus aucune des
  // deux ne voudrait dire quoi que ce soit.
  if (next === RobotState.BALANCING && previous === RobotState.FALLEN) {
    express(face, 'joy', 0.95);
    sound.play('recover');
    emotes.spawn('sparkles');
    mood.nudge(0.7, 0.3);
    panel.logLine('✨ le revoilà debout !');
  }
}

/**
 * Un déplacement est-il possible en ce moment ? Rend la raison du refus, sinon
 * null. Déclarée en `function` (donc hoistée) pour pouvoir être passée au
 * Dispatcher tout en haut du fichier, comme `captureZero` plus bas.
 *
 * ⚠️ Ce n'est PAS une redite du firmware, qui refuse déjà tout déplacement hors
 * équilibre : lui protège, elle explique. Et l'explication est ce qui manque le
 * plus ici — depuis le 23/08 un « avance de 30 cm » se termine sur l'ODOMÉTRIE,
 * donc un robot couché n'a aucun moyen d'atteindre sa cible : l'ordre serait
 * simplement avalé.
 */
function moveGate(): string | null {
  // ⚠️ ON NE REFUSE QUE CE QU'ON SAIT REFUSÉ. Sans robot au bout (ou avant la
  // première télémétrie), l'intention PASSE : le transport la journalise alors
  // avec « (non émis) » et sa trame hexa — la trace qui permet de vérifier le
  // protocole sans matériel, et de trancher « l'app n'a rien envoyé » / « l'app a
  // envoyé, le robot n'a rien fait ». La remplacer par un refus ferait perdre
  // l'octet, c'est-à-dire précisément ce que le journal a été fait pour montrer.
  if (!transport.connected || !lastTelemetry) return null;
  if (!lastTelemetry.armed) return 'robot désarmé — cliquer « ⚡ Armer »';
  if (lastTelemetry.state === RobotState.FALLEN) {
    return 'il est tombé — le relever droit et attendre « ⚖ en équilibre »';
  }
  if (lastTelemetry.state !== RobotState.BALANCING) {
    return "il n'est pas en équilibre — le poser droit et attendre « ⚖ »";
  }
  return null;
}

/**
 * Capture « la pose actuelle = 0° », avec la même garde que le firmware.
 *
 * Le double contrôle n'est pas une redite : le firmware PROTÈGE (il refuse en
 * silence, c'est son rôle), l'app EXPLIQUE. Sans le message ici, un clic refusé
 * ressemblerait trait pour trait à un clic réussi.
 */
function captureZero(okMessage: string): void {
  const pitch = lastTelemetry?.pitchDeg;
  if (pitch === undefined) {
    panel.logLine('⚠ zéro : pas de télémétrie, le robot est-il connecté ?');
    return;
  }
  if (Math.abs(pitch) > ZERO_CAPTURE_MAX_DEG) {
    panel.logLine(
      `⚠ zéro refusé : ${pitch.toFixed(0)}° de la verticale. Le tenir DROIT en main.`,
    );
    return;
  }
  transport.sendIntent(Op.ZERO_HERE);
  // L'assiette doit retomber à ~0° à la prochaine télémétrie : c'est la confirmation
  // visuelle, et elle vaut mieux qu'un accusé de réception dans le protocole.
  panel.logLine(`${okMessage} (était à ${pitch.toFixed(1)}°) — « Enregistrer » pour le garder`);
}

// --- Démarrage automatique ---------------------------------------------------
//
// LE PRINCIPE : lancer l'app, c'est vouloir parler à Mochi. Les deux clics
// (« Connecter », puis « Démarrer la conversation ») sont donc tentés tout seuls.
//
// CE QUE LE NAVIGATEUR LAISSE PASSER SANS GESTE, ET CE QU'IL REFUSE — la liste
// compte, parce que chaque « non » se manifeste par un silence, pas par une
// erreur, et qu'on le prendrait pour une panne :
//   • le lien BLE      → oui, mais vers un robot DÉJÀ appairé, et seulement là où
//     `getDevices()` existe (cf. BleTransport.tryAutoConnect). Sinon, un geste.
//   • le MICRO         → oui si l'autorisation a déjà été accordée à cette origine.
//     Tant qu'elle est à « demander », la demander sans geste tombe dans le vide.
//   • la VOIX de Mochi → NON par défaut : la politique d'autoplay garde tout
//     AudioContext en veille tant que la page n'a pas été touchée. L'EXCEPTION qui
//     nous sauve : une app INSTALLÉE (ajoutée à l'écran d'accueil) y échappe —
//     c'est exactement ce que décrit le manifeste de ce projet. Ouverte comme un
//     onglet ordinaire, la même page réclamera un doigt.
//
// D'où la règle : on ne démarre en silence que si les trois sont acquis. Sinon on
// affiche une invite, et le PREMIER contact avec l'écran — n'importe où — fait
// tout. Un geste au lieu de deux clics, et jamais un geste de plus qu'obligé.

/** Ouvre la conversation vocale avec le caractère courant. Sans effet si elle tourne. */
function startLive(): void {
  if (!live || live.active) return;
  void sound.unlock();
  // Le persona courant devient la voix/le caractère de la session.
  void live.start(buildSystemInstruction(agent.getPersona?.() ?? DEFAULT_PERSONA));
}

/**
 * Connexion au robot PAR LE SÉLECTEUR (geste utilisateur obligatoire). C'est le
 * chemin du bouton « Connecter » et celui du premier lancement.
 */
async function connectRobot(): Promise<void> {
  try {
    await transport.connect(); // le succès passe par onConnectionChange
  } catch (e) {
    // Sélection annulée, pas de HTTPS, robot éteint… ça se voit dans le message.
    panel.logLine(`⚠ connexion : ${(e as Error).message}`);
  }
}

async function autoStart(): Promise<void> {
  // Le lien radio d'abord, et SANS CONDITION : il ne demande rien, n'affiche
  // rien, ne coûte rien — retrouver le robot tout seul reste utile même quand on
  // ne veut pas parler. Sans l'attendre non plus : `gatt.connect()` sur un robot
  // éteint peut mettre longtemps à renoncer, et la voix n'a pas à en dépendre.
  void transport.tryAutoConnect();

  // Tout ce qui suit peut faire APPARAÎTRE quelque chose (invite, demande de
  // permission, sélecteur) : c'est ce que la case à cocher gouverne.
  if (!panel.autoStart || !live) return;
  if (audioAllowed() && (await micGranted())) {
    startLive();
    keepAwake();
    return;
  }
  wakeHint(true);
}

/**
 * Premier contact avec l'écran : il débloque l'audio, et c'est la seule fenêtre
 * où le sélecteur BLE peut s'ouvrir. En capture, pour passer avant les boutons.
 */
function onFirstGesture(ev: Event): void {
  wakeHint(false);
  void sound.unlock();
  if (!panel.autoStart) return;
  startLive();
  // ⚠️ `requestDevice` ne s'ouvre que DANS le geste : c'est celui-ci, ou aucun.
  // On s'en abstient si le doigt visait le panneau (son bouton fait déjà ce
  // travail, et deux sélecteurs d'affilée valent un bug) ou si le robot est déjà
  // connu — la boucle de reprise le retrouvera sans rien demander à personne.
  const onPanel = ev.target instanceof Node && panelRoot.contains(ev.target);
  if (!onPanel && !transport.connected && !transport.paired) void connectRobot();
}

/** Invite « touche l'écran » — affichée seulement quand le navigateur l'impose. */
function wakeHint(show: boolean): void {
  const hint = document.getElementById('wake');
  if (hint) hint.hidden = !show;
}

/**
 * L'autoplay autorise-t-il déjà le son ? Un navigateur qui ne sait pas répondre
 * est traité comme un refus : une invite de trop se voit et se répare d'un doigt,
 * alors qu'un Mochi qui écoute mais ne répond pas ne se diagnostique pas.
 */
function audioAllowed(): boolean {
  const nav = navigator as Navigator & {
    getAutoplayPolicy?(type: string): 'allowed' | 'allowed-muted' | 'disallowed';
  };
  return nav.getAutoplayPolicy?.('audiocontext') === 'allowed';
}

/** Le micro est-il DÉJÀ autorisé ? (« prompt » compte comme non : cf. plus haut.) */
async function micGranted(): Promise<boolean> {
  const st = await navigator.permissions
    ?.query({ name: 'microphone' as PermissionName })
    .catch(() => null);
  return st?.state === 'granted';
}

/** Screen Wake Lock — évite la mise en veille pendant l'usage (M4). */
async function keepAwake(): Promise<void> {
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: string): Promise<unknown> } }).wakeLock?.request(
      'screen',
    );
  } catch {
    /* non critique */
  }
}
