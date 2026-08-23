import './style.css';
import { FaceState, REST_FACE } from './face/faceState';
import { FaceRenderer } from './face/faceRenderer';
import { startAutoBlink } from './face/expressions';
import { SoundEngine } from './audio/sounds';
import { SpeechInput } from './audio/speech';
import { BleTransport } from './robot/bleTransport';
import { Op } from './robot/transport';
import { parseTelemetry, RobotState, type Telemetry } from './robot/bleProfile';
import { DriveLoop } from './robot/driveLoop';
import { Dispatcher } from './agent/dispatcher';
import { DevPanel } from './ui/devPanel';
import type { Agent } from './agent/agent';
import { createAgent } from './agent/agent';
import { LiveConversation, type LiveAccess } from './agent/live';
import { DEFAULT_PERSONA, buildSystemInstruction } from './agent/persona';
import { EmoteLayer } from './fx/emotes';
import { MoodEngine, ambientFromMood, restingFaceFromMood } from './affect/mood';

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
const dispatcher = new Dispatcher(face, sound, transport, mood, emotes, driveLoop);

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

// Conversation vocale Live (créée plus bas si une clé Gemini est présente).
// Référencée en différé par les handlers du panneau, comme `agent`.
let live: LiveConversation | null = null;

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
    if (mood.idleFor > 3.5 && flapTimer === null) {
      face.setTarget({ channels: restingFaceFromMood(m), tau: 0.9 });
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
    dispatcher.dispatch(call);
  },
  onSend: (text) => {
    void sound.unlock();
    panel.logLine(`🗣 « ${text} »`);
    mood.nudge(0.03, 0.06); // il aime qu'on lui parle
    void agent.send(text);
  },
  onConnect: async () => {
    try {
      await transport.connect();
      panel.setConnected(transport.connected);
      panel.logLine('🤖 connecté — pense à ARMER (le robot boote désarmé)');
      keepAwake();
    } catch (e) {
      // Sélection annulée, pas de HTTPS, robot éteint… ça se voit dans le message.
      panel.setConnected(false);
      panel.logLine(`⚠ connexion : ${(e as Error).message}`);
    }
  },
  onArm: (on) => {
    // On n'anticipe PAS l'affichage : c'est la télémétrie qui bascule le bouton, donc
    // il ne dit « armé » que si le robot l'a vraiment confirmé.
    if (!on) driveLoop.stop();
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
  onCalibrate: () => {
    // GARDE-FOU que la console n'a pas : la calibration coupe les moteurs et repasse
    // en IDLE pendant ~2 s. Lancée sur un robot DEBOUT, elle le fait tomber — et on
    // ne s'en rend compte qu'au bruit. Elle se fait robot en main, tenu vertical.
    if (lastTelemetry?.state === RobotState.BALANCING) {
      panel.logLine('⚠ calibration refusée : il est en équilibre. Le prendre en main d’abord.');
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
    void sound.unlock();
    if (live.active) {
      void live.stop();
    } else {
      // Le persona courant devient la voix/le caractère de la session.
      void live.start(buildSystemInstruction(agent.getPersona?.() ?? DEFAULT_PERSONA));
    }
  },
  onLiveStop: () => {
    live?.stopReflex();
    // L'ordre compte : couper le réémetteur AVANT le STOP. L'inverse enverrait le
    // STOP puis, 100 ms plus tard, la consigne suivante du rond — un bouton d'arrêt
    // qui n'arrête rien est pire que pas de bouton du tout.
    driveLoop.stop();
    transport.sendIntent(Op.STOP); // réflexe moteur (sécurité)
    panel.logLine('⏹ STOP (réflexe local)');
  },
  onVoiceChange: (name) => void live?.setVoice(name),
  onPitchChange: (factor) => live?.setPitch(factor),
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

// Clé Gemini brute : lue UNIQUEMENT en dev (localhost). En build de prod, on ne
// la référence pas → elle n'est jamais inlinée dans le bundle public. En prod, la
// voix Live passe par un jeton éphémère fabriqué côté serveur (voir plus bas).
const devKey = import.meta.env.DEV
  ? (import.meta.env.VITE_GEMINI_API_KEY as string | undefined)?.trim()
  : undefined;

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
  devKey,
);

// Conversation vocale Live (vraie voix streamée).
// - En dev : clé brute locale.
// - En prod : jeton éphémère fabriqué par /api/live-token.php (la clé reste serveur).
// Les sons kawaii sont coupés pendant la session pour ne pas parasiter la voix.
const liveAccess: LiveAccess | null = devKey
  ? { apiKey: devKey }
  : import.meta.env.PROD
    ? { tokenEndpoint: import.meta.env.BASE_URL + 'api/live-token.php' }
    : null;
if (liveAccess) {
  live = new LiveConversation(liveAccess, {
    onStatus: (status, detail) => {
      panel.setLiveStatus(status, detail);
      if (status === 'error' && detail) panel.logLine(`⚠ Live : ${detail}`);
      const running = status !== 'idle' && status !== 'error';
      panel.setLiveActive(running); // pilote le bouton depuis l'état réel (gère les relances)
      sound.setSuppressed(running);
      if (running) keepAwake();
      else stopMouthFlap();
    },
    onUserText: (t) => {
      panel.logLine(`🎤 « ${t} »`);
      mood.nudge(0.02, 0.05);
    },
    onMochiText: (t) => panel.logLine(`💬 Mochi : ${t}`),
    onSpeakingChange: (speaking) => (speaking ? startMouthFlap() : stopMouthFlap()),
    onLevel: (lvl) => (voiceLevel = lvl),
    dispatch: (call) => {
      const res = dispatcher.dispatch(call);
      if (!res.ok) panel.logLine(`⚠ ${res.name}: ${res.detail}`);
    },
  });
}
panel.setLiveSupported(!!live);

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
  lastTelemetry = t;
  panel.setTelemetry(t);
  panel.setArmed(t.armed);
});

// Perte de lien subie (robot éteint, hors de portée) : on cesse de piloter. Côté
// robot le TTL a déjà tout coupé — ici on évite juste que l'app continue de parler
// dans le vide et remplisse le journal de « non émis ».
transport.onConnectionChange((connected) => {
  if (connected) return;
  driveLoop.stop();
  panel.setConnected(false);
  panel.logLine('⚠ robot déconnecté');
});

// Débloque l'audio au premier geste, où qu'il soit.
window.addEventListener('pointerdown', () => void sound.unlock(), { once: true });

// Humeur : décroissance + pilotage de l'affichage (démarré une fois tout câblé).
startMoodLoop();

console.info('[Mochi] prêt.', agent.info);

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
