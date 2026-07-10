import './style.css';
import { FaceState, REST_FACE } from './face/faceState';
import { FaceRenderer } from './face/faceRenderer';
import { startAutoBlink } from './face/expressions';
import { SoundEngine } from './audio/sounds';
import { SpeechInput } from './audio/speech';
import { MockTransport } from './robot/mockTransport';
import { Op } from './robot/transport';
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
const transport = new MockTransport();
const emotes = new EmoteLayer(fxCanvas);
const mood = new MoodEngine();
const dispatcher = new Dispatcher(face, sound, transport, mood, emotes);

const renderer = new FaceRenderer(canvas, face);
renderer.start();
startAutoBlink(face);

// L'agent est assigné juste après le panneau (il en dépend pour logguer).
// `onSend` le référence en différé — appelé seulement sur interaction.
let agent: Agent;

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
    await transport.connect();
    panel.setConnected(transport.connected);
    keepAwake();
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
    transport.sendIntent(Op.STOP); // réflexe moteur local (sécurité)
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
    ? { tokenEndpoint: '/api/live-token.php' }
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

// Débloque l'audio au premier geste, où qu'il soit.
window.addEventListener('pointerdown', () => void sound.unlock(), { once: true });

// Humeur : décroissance + pilotage de l'affichage (démarré une fois tout câblé).
startMoodLoop();

console.info('[Mochi] prêt.', agent.info);

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
