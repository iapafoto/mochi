import type { IntentCall } from '../agent/intents';
import type { MotorEvent } from '../robot/transport';
import { RobotState, type Telemetry } from '../robot/bleProfile';
import { LIVE_VOICES, DEFAULT_VOICE, DEFAULT_PITCH, type LiveStatus } from '../agent/live';

export interface DevPanelHandlers {
  onIntent(call: IntentCall): void;
  onSend(text: string): void;
  onConnect(): void;
  /** Arme (true) ou désarme (false) les moteurs — le robot boote DÉSARMÉ. */
  onArm(on: boolean): void;
  /** Recalibre l'IMU (robot tenu VERTICAL et immobile ~2 s). */
  onCalibrate(): void;
  /** « La pose actuelle est le zéro » (console `z`). */
  onZeroHere(): void;
  /** Adopte le zéro que l'intégrale a convergé (console `Z`). */
  onZeroAdopt(): void;
  /** Persiste les réglages en NVS (console `w`). */
  onSave(): void;
  /** L'armement doit-il capturer le zéro au passage ? */
  onZeroOnArmChange(on: boolean): void;
  /** Anti-écho + réduction de bruit du micro (relance la conversation en cours). */
  onMicProcessingChange(on: boolean): void;
  /** Gain logiciel du micro, 1..8 (effet immédiat). */
  onMicGainChange(gain: number): void;
  onToggleMute(muted: boolean): void;
  /** Début d'écoute micro (pression du bouton push-to-talk). */
  onVoiceStart(): void;
  /** Fin d'écoute micro (relâchement). */
  onVoiceStop(): void;
  /** Applique un nouveau caractère (system prompt éditable). */
  onPersonaApply(text: string): void;
  /** Démarre/arrête la conversation vocale Live (vraie voix). */
  onLiveToggle(): void;
  /** Réflexe local « stop » : coupe la voix/les moteurs immédiatement. */
  onLiveStop(): void;
  /** Change la voix préfabriquée de Mochi. */
  onVoiceChange(name: string): void;
  /** Change la hauteur de la voix (1 = naturelle, >1 = plus aiguë/bébé). */
  onPitchChange(factor: number): void;
  /** Enregistre (ou efface, si vide) la clé Gemini de cet appareil. */
  onGeminiKeyChange(key: string): void;
}

/** Préférence mémorisée : capturer le zéro à chaque armement. */
const ZERO_ON_ARM_KEY = 'mochi.zeroOnArm';

/**
 * Préférence mémorisée : traitement téléphonie du micro.
 *
 * ⚠️ DÉFAUT = INACTIF — l'absence de clé vaut « décoché » (cf. le `=== '1'` plus
 * bas). Ce commentaire disait « défaut = actif », soit l'inverse exact du code
 * qu'il documente, et sur le seul réglage qui décide de la PORTÉE du micro :
 * coché, Mochi devient sourd au-delà de ~50 cm (cf. MicCapture.setProcessing).
 *
 * ⚠️ PERSISTANT : une fois cochée, la case le reste d'une session à l'autre —
 * c'est donc la première chose à vérifier devant un « il n'entend que de très
 * près ». Depuis le 29/08 le journal l'annonce à l'ouverture du micro, en lisant
 * ce que la piste applique VRAIMENT plutôt que l'état de la case.
 */
const MIC_PROCESSING_KEY = 'mochi.micProcessing';

/**
 * Préférence mémorisée : ouvrir la conversation dès le lancement (défaut = OUI,
 * d'où le test sur `!== '0'` — l'absence de clé vaut « coché »).
 *
 * Décocher n'est pas un caprice de réglage : la conversation Live ouvre le micro
 * ET une session facturée à CHAQUE chargement de page, rechargements de mise au
 * point compris. Au banc, où l'on recharge vingt fois par heure pour un réglage
 * moteur, c'est l'interrupteur qui rend l'app silencieuse et gratuite.
 */
const AUTO_START_KEY = 'mochi.autoStart';

/** Préférence mémorisée : gain logiciel du micro (défaut = 1×, donc sans effet). */
const MIC_GAIN_KEY = 'mochi.micGain';

/** Nombre de blocs de la jauge micro. Assez pour voir bouger, assez court pour tenir sur une ligne. */
const MIC_BARS = 12;

/** Boutons de test : libellé → IntentCall. */
const EMOTION_BTNS: [string, IntentCall][] = [
  ['😊 joy', { name: 'express', args: { emotion: 'joy', intensity: 1 } }],
  ['😢 sad', { name: 'express', args: { emotion: 'sadness', intensity: 1 } }],
  ['😮 surprise', { name: 'express', args: { emotion: 'surprise', intensity: 1 } }],
  ['🤔 curious', { name: 'express', args: { emotion: 'curiosity', intensity: 1 } }],
  ['😠 anger', { name: 'express', args: { emotion: 'anger', intensity: 1 } }],
  ['😐 neutral', { name: 'express', args: { emotion: 'neutral', intensity: 1 } }],
];

const ACTION_BTNS: [string, IntentCall][] = [
  ['blink', { name: 'blink', args: {} }],
  ['wink L', { name: 'wink', args: { side: 'left' } }],
  ['wink R', { name: 'wink', args: { side: 'right' } }],
  ['look ◀', { name: 'look', args: { dir: 'left' } }],
  ['look ▶', { name: 'look', args: { dir: 'right' } }],
  ['look ▲', { name: 'look', args: { dir: 'up' } }],
  ['look ▼', { name: 'look', args: { dir: 'down' } }],
  ['look ⦿', { name: 'look', args: { dir: 'center' } }],
];

const MOTOR_BTNS: [string, IntentCall][] = [
  ['forward 20', { name: 'forward', args: { cm: 20 } }],
  ['backward 20', { name: 'backward', args: { cm: 20 } }],
  ['turn +90', { name: 'turn', args: { deg: 90 } }],
  ['turn -90', { name: 'turn', args: { deg: -90 } }],
  ['○ rond 30 ↻', { name: 'circle', args: { radius_cm: 30, turns: 1, dir: 'right' } }],
  ['○ rond 30 ↺', { name: 'circle', args: { radius_cm: 30, turns: 1, dir: 'left' } }],
  ['○ rond 30 ↻ vite', { name: 'circle', args: { radius_cm: 30, turns: 1, dir: 'right', speed: 'fast' } }],
  ['nod', { name: 'nod', args: {} }],
  ['bow', { name: 'bow', args: {} }],
  ['wiggle', { name: 'wiggle', args: {} }],
];

const EMOTE_BTNS: [string, IntentCall][] = [
  ['💗 hearts', { name: 'emote', args: { kind: 'hearts' } }],
  ['✨ sparkles', { name: 'emote', args: { kind: 'sparkles' } }],
  ['🎵 notes', { name: 'emote', args: { kind: 'notes' } }],
  ['💧 sweat', { name: 'emote', args: { kind: 'sweat' } }],
  ['❓ question', { name: 'emote', args: { kind: 'question' } }],
  ['❗ exclaim', { name: 'emote', args: { kind: 'exclaim' } }],
  ['🌧 rain', { name: 'emote', args: { kind: 'rain' } }],
];

export class DevPanel {
  private logEl!: HTMLDivElement;
  private statusEl!: HTMLSpanElement;
  private micBtn!: HTMLButtonElement;
  private voiceHint!: HTMLSpanElement;
  private liveBtn!: HTMLButtonElement;
  private liveStopBtn!: HTMLButtonElement;
  private liveStatusEl!: HTMLSpanElement;
  private moodValFill!: HTMLElement;
  private moodAroFill!: HTMLElement;
  private personaSection!: HTMLElement;
  private personaEl!: HTMLTextAreaElement;
  private personaDefault = '';
  private armBtn!: HTMLButtonElement;
  private calibBtn!: HTMLButtonElement;
  private zeroBtns: HTMLButtonElement[] = [];
  private zeroOnArmBox!: HTMLInputElement;
  private micProcessingBox!: HTMLInputElement;
  private micGainInput!: HTMLInputElement;
  private micGainLabel!: HTMLElement;
  private fmtMicGain!: (v: number) => string;
  private autoStartBox!: HTMLInputElement;
  private micLevelEl!: HTMLSpanElement;
  /** Gain micro restauré du localStorage — lu par main.ts au démarrage. */
  micGain = 1;
  // États qui commandent tous deux la disponibilité de l'arrêt d'urgence.
  private connected = false;
  private liveActive = false;
  private fsBtn!: HTMLButtonElement;
  private telemetryEl!: HTMLSpanElement;
  private armed = false;
  private keyInput!: HTMLInputElement;
  private keyStatusEl!: HTMLSpanElement;
  private keyForgetBtn!: HTMLButtonElement;
  private buildEl!: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly h: DevPanelHandlers,
  ) {
    this.build();
  }

  private build(): void {
    this.root.innerHTML = '';

    // En-tête : plein écran + poignée de repli. Ces deux-là vivent ENSEMBLE parce
    // que sur téléphone l'en-tête est le bandeau qui reste visible tiroir fermé :
    // c'est le seul endroit où un bouton est atteignable sans rouvrir le panneau.
    const header = el('div', 'dp-section dp-header');
    this.fsBtn = button('⛶ Plein écran', () => void this.toggleFullscreen());
    this.fsBtn.className = 'dp-fs';
    if (!document.documentElement.requestFullscreen) this.fsBtn.style.display = 'none';
    const collapse = button('⟩', () => this.root.classList.toggle('collapsed'));
    collapse.className = 'dp-collapse';
    header.append(this.fsBtn, collapse);
    this.root.append(header);
    document.addEventListener('fullscreenchange', () => this.refreshFullscreenBtn());

    // Saisie IA.
    const aiSection = section('Parler à Mochi');
    const row = el('div', 'dp-row');
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'ex : fais un clin d\'œil…';
    const send = button('▶', () => {
      const t = input.value.trim();
      if (t) {
        this.h.onSend(t);
        input.value = '';
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send.click();
    });
    row.append(input, send);
    aiSection.append(row);

    // Micro « maintenir pour parler ».
    this.micBtn = button('🎤 Maintenir pour parler', () => {});
    this.micBtn.className = 'dp-mic';
    const startVoice = (e: Event) => {
      e.preventDefault();
      this.h.onVoiceStart();
    };
    const stopVoice = () => this.h.onVoiceStop();
    this.micBtn.addEventListener('pointerdown', startVoice);
    this.micBtn.addEventListener('pointerup', stopVoice);
    this.micBtn.addEventListener('pointerleave', stopVoice);
    this.micBtn.addEventListener('pointercancel', stopVoice);
    aiSection.append(this.micBtn);

    this.voiceHint = document.createElement('span');
    this.voiceHint.className = 'dp-status';
    aiSection.append(this.voiceHint);

    this.root.append(aiSection);

    // Conversation vocale Live (vraie voix streamée) — le mode « on l'entend ».
    const liveSection = section('Conversation vocale (Live)');
    this.liveBtn = button('🎙 Démarrer la conversation', () => this.h.onLiveToggle());
    this.liveBtn.className = 'dp-live';
    this.liveStopBtn = button('⏹ STOP', () => this.h.onLiveStop());
    this.liveStopBtn.className = 'dp-stop';
    this.liveStopBtn.disabled = true;

    // Choix de la voix (relance la session si elle tourne).
    const voiceRow = el('div', 'dp-row');
    const voiceLabel = el('span', 'dp-status');
    voiceLabel.textContent = 'Voix';
    const voiceSel = document.createElement('select');
    for (const v of LIVE_VOICES) {
      const opt = document.createElement('option');
      opt.value = v.name;
      opt.textContent = v.label;
      if (v.name === DEFAULT_VOICE) opt.selected = true;
      voiceSel.append(opt);
    }
    voiceSel.addEventListener('change', () => this.h.onVoiceChange(voiceSel.value));
    voiceRow.append(voiceLabel, voiceSel);

    // Hauteur de la voix : effet « bébé / animal » (aigu).
    const pitchRow = el('div', 'dp-row');
    const pitchLabel = el('span', 'dp-status');
    const fmtPitch = (v: number) => `Aigu ${v.toFixed(2)}×`;
    pitchLabel.textContent = fmtPitch(DEFAULT_PITCH);
    const pitch = document.createElement('input');
    pitch.type = 'range';
    pitch.min = '1';
    pitch.max = '1.4';
    pitch.step = '0.02';
    pitch.value = String(DEFAULT_PITCH);
    pitch.addEventListener('input', () => {
      const f = parseFloat(pitch.value);
      pitchLabel.textContent = fmtPitch(f);
      this.h.onPitchChange(f);
    });
    pitchRow.append(pitchLabel, pitch);

    // Niveau micro. Il vaut surtout par ce qu'il permet de DISTINGUER : une barre
    // qui bouge quand tu parles prouve que le micro te capte, et déplace la
    // question vers l'envoi ou le modèle. Une barre plate la garde ici.
    this.micLevelEl = document.createElement('span');
    this.micLevelEl.className = 'dp-status dp-miclevel';
    this.micLevelEl.textContent = '🎤 —';

    // Traitement téléphonie. DÉCOCHÉ PAR DÉFAUT depuis le 23/08 : coché, Mochi
    // devient sourd au-delà de ~50 cm (cf. MicCapture.setProcessing). Reste
    // accessible pour le cas inverse — téléphone tenu près de la bouche dans une
    // pièce bruyante, où le traitement redevient utile.
    const procLabel = document.createElement('label');
    procLabel.className = 'dp-check';
    const procBox = document.createElement('input');
    procBox.type = 'checkbox';
    procBox.checked = localStorage.getItem(MIC_PROCESSING_KEY) === '1';
    procBox.addEventListener('change', () => {
      localStorage.setItem(MIC_PROCESSING_KEY, procBox.checked ? '1' : '0');
      this.h.onMicProcessingChange(procBox.checked);
    });
    procLabel.append(procBox, document.createTextNode(' anti-écho + réduction de bruit'));
    this.micProcessingBox = procBox;

    // Gain micro. Défaut 1× : tant qu'on n'y touche pas, rien ne change.
    const gainRow = el('div', 'dp-row');
    const gainLabel = el('span', 'dp-status');
    const fmtGain = (v: number) => `Gain micro ${v.toFixed(1)}×`;
    const gain0 = parseFloat(localStorage.getItem(MIC_GAIN_KEY) ?? '1') || 1;
    gainLabel.textContent = fmtGain(gain0);
    const gain = document.createElement('input');
    gain.type = 'range';
    gain.min = '1';
    gain.max = '8';
    gain.step = '0.5';
    gain.value = String(gain0);
    gain.addEventListener('input', () => {
      const g = parseFloat(gain.value);
      gainLabel.textContent = fmtGain(g);
      localStorage.setItem(MIC_GAIN_KEY, String(g));
      this.h.onMicGainChange(g);
    });
    gainRow.append(gainLabel, gain);
    this.micGain = gain0;
    this.micGainInput = gain;
    this.micGainLabel = gainLabel;
    this.fmtMicGain = fmtGain;

    // Démarrage automatique au lancement (coché par défaut). Le changement ne
    // prend effet qu'au prochain chargement : décocher ne coupe pas la session en
    // cours — le bouton juste au-dessus est là pour ça.
    const autoLabel = document.createElement('label');
    autoLabel.className = 'dp-check';
    const autoBox = document.createElement('input');
    autoBox.type = 'checkbox';
    autoBox.checked = localStorage.getItem(AUTO_START_KEY) !== '0';
    autoBox.addEventListener('change', () =>
      localStorage.setItem(AUTO_START_KEY, autoBox.checked ? '1' : '0'),
    );
    autoLabel.append(autoBox, document.createTextNode(' démarrer au lancement'));
    this.autoStartBox = autoBox;

    this.liveStatusEl = document.createElement('span');
    this.liveStatusEl.className = 'dp-status';
    liveSection.append(
      this.liveBtn, this.liveStopBtn, voiceRow, pitchRow,
      procLabel, gainRow, autoLabel, this.micLevelEl, this.liveStatusEl,
    );
    this.root.append(liveSection);

    // Clé Gemini. Elle commande DEUX choses — la conversation Live et l'agent
    // texte — d'où sa propre section plutôt qu'un coin de celle du Live. Saisie
    // une fois, elle reste sur cet appareil (cf. agent/apiKey.ts) : c'est ce qui
    // permet de servir l'app depuis n'importe quel hébergement statique, sans
    // rien de secret dans le bundle.
    const keySection = section('Clé Gemini');
    const keyRow = el('div', 'dp-row');
    this.keyInput = document.createElement('input');
    // `password` : le panneau reste ouvert pendant les démos, et la clé se lit
    // par-dessus l'épaule aussi bien qu'un mot de passe.
    this.keyInput.type = 'password';
    this.keyInput.placeholder = 'coller la clé AI Studio…';
    this.keyInput.autocomplete = 'off';
    this.keyInput.spellcheck = false;
    const keySave = button('Enregistrer', () => {
      const v = this.keyInput.value.trim();
      if (v) this.h.onGeminiKeyChange(v);
    });
    this.keyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') keySave.click();
    });
    keyRow.append(this.keyInput, keySave);
    this.keyForgetBtn = button('Oublier la clé de cet appareil', () =>
      this.h.onGeminiKeyChange(''),
    );
    this.keyStatusEl = document.createElement('span');
    this.keyStatusEl.className = 'dp-status';
    keySection.append(keyRow, this.keyForgetBtn, this.keyStatusEl);
    this.root.append(keySection);

    // Personnalité (caractère éditable) — masquée tant que l'agent ne la gère pas.
    this.personaSection = section('Personnalité (IA)');
    this.personaSection.style.display = 'none';
    this.personaEl = document.createElement('textarea');
    this.personaEl.rows = 6;
    this.personaEl.spellcheck = false;
    const personaBtns = el('div', 'dp-grid');
    personaBtns.append(
      button('✓ Appliquer', () => this.h.onPersonaApply(this.personaEl.value)),
      button('↺ Défaut', () => {
        this.personaEl.value = this.personaDefault;
        this.h.onPersonaApply(this.personaDefault);
      }),
    );
    this.personaSection.append(this.personaEl, personaBtns);
    this.root.append(this.personaSection);

    // Émotions / actions / emotes / moteur.
    this.root.append(this.grid('Émotions', EMOTION_BTNS));
    this.root.append(this.grid('Actions', ACTION_BTNS));
    this.root.append(this.grid('Emotes (particules)', EMOTE_BTNS));
    this.root.append(this.grid('Déplacement (robot RÉEL)', MOTOR_BTNS));

    // Humeur (lecture) — valence & énergie.
    const moodSection = section('Humeur');
    this.moodValFill = this.moodBar(moodSection, 'valence');
    this.moodAroFill = this.moodBar(moodSection, 'énergie');
    this.root.append(moodSection);

    // Contrôles.
    const ctl = section('Contrôles');
    const ctlRow = el('div', 'dp-grid');
    const muteBtn = button('🔊 son', () => {
      const muted = muteBtn.dataset.muted === '1';
      const next = !muted;
      muteBtn.dataset.muted = next ? '1' : '0';
      muteBtn.textContent = next ? '🔇 son' : '🔊 son';
      this.h.onToggleMute(next);
    });
    muteBtn.dataset.muted = '0';
    const connectBtn = button('🤖 Connecter', () => this.h.onConnect());
    // Armement : le robot boote DÉSARMÉ (BOOT_ARMED = false). Sans ce bouton, une
    // commande part, le firmware l'accepte, et rien ne bouge — sans le moindre
    // message d'erreur. C'est le premier réflexe à avoir devant un robot muet.
    this.armBtn = button('⚡ Armer', () => this.h.onArm(!this.armed));
    this.armBtn.className = 'dp-arm';
    this.armBtn.disabled = true; // rien à armer tant qu'aucun robot n'est au bout
    // Calibration IMU. Le boot ne fait que le GYRO (`calcOffsets(true, false)` dans
    // main.cpp) : les offsets de l'ACCÉLÉROMÈTRE ne sont jamais pris, et c'est eux
    // qui ancrent l'angle fusionné à long terme. D'où un zéro effectif qui bouge
    // d'un démarrage à l'autre même avec un `o` juste en NVS.
    this.calibBtn = button('◎ Calibrer', () => this.h.onCalibrate());
    this.calibBtn.disabled = true;
    this.calibBtn.title = 'Tenir le robot VERTICAL et IMMOBILE pendant ~2 s';
    ctlRow.append(muteBtn, connectBtn, this.armBtn, this.calibBtn);
    ctl.append(ctlRow);
    this.statusEl = document.createElement('span');
    this.statusEl.className = 'dp-status';
    this.statusEl.textContent = 'robot : déconnecté';
    this.telemetryEl = document.createElement('span');
    this.telemetryEl.className = 'dp-status';
    ctl.append(this.statusEl, this.telemetryEl);
    this.root.append(ctl);

    // Zéro d'assiette. Trois gestes qui ne se valent pas, d'où les trois boutons
    // plutôt qu'un seul « calibrer » qui cacherait le compromis.
    const zeroSection = section("Zéro d'assiette");
    const zeroRow = el('div', 'dp-grid');
    const zeroHere = button('⌖ Zéro ici', () => this.h.onZeroHere());
    zeroHere.title = 'La pose actuelle devient 0°. Robot tenu DROIT en main. Dépannage : '
      + 'vaut ce que vaut la main (1 à 3°).';
    const zeroAuto = button('⊙ Zéro auto', () => this.h.onZeroAdopt());
    zeroAuto.title = "Adopte le zéro que le robot a mesuré lui-même. À faire après "
      + "~30 s d'équilibre CALME. C'est la méthode précise.";
    const saveBtn = button('💾 Enregistrer', () => this.h.onSave());
    saveBtn.title = 'Persiste en NVS. Sans ça, le zéro est perdu au prochain démarrage.';
    zeroRow.append(zeroHere, zeroAuto, saveBtn);
    this.zeroBtns = [zeroHere, zeroAuto, saveBtn];
    for (const b of this.zeroBtns) b.disabled = true;

    // Case à cocher mémorisée : le geste « je le tiens droit, j'arme, je le pose »
    // est naturel, mais il ÉCRASE un zéro précis par un zéro à la main. À activer
    // quand le zéro persisté ne sert plus, pas en régime établi.
    const zeroOnArm = document.createElement('label');
    zeroOnArm.className = 'dp-check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = localStorage.getItem(ZERO_ON_ARM_KEY) === '1';
    cb.addEventListener('change', () => {
      localStorage.setItem(ZERO_ON_ARM_KEY, cb.checked ? '1' : '0');
      this.h.onZeroOnArmChange(cb.checked);
    });
    zeroOnArm.append(cb, document.createTextNode(' capturer le zéro en armant'));
    this.zeroOnArmBox = cb;
    zeroSection.append(zeroRow, zeroOnArm);
    this.root.append(zeroSection);

    // Log.
    const logSection = section('Log intentions moteur');
    this.logEl = el('div') as HTMLDivElement;
    this.logEl.id = 'dp-log';
    logSection.append(this.logEl);
    this.root.append(logSection);

    // Tampon de build, EN DEHORS du log — parce que dans le log il défilerait,
    // et qu'on le cherche justement au moment où l'on doute que le nouveau code
    // soit arrivé (cf. la politique de mise à jour dans src/pwa.ts).
    this.buildEl = el('p', 'dp-build');
    this.root.append(this.buildEl);
  }

  /** Affiche la version qui tourne réellement. */
  setBuildId(id: string): void {
    this.buildEl.textContent = `build ${id}`;
  }

  /**
   * Reflète l'état de la clé. `stored` = saisie sur CET appareil ; `source` = d'où
   * vient celle qui sert vraiment — les deux diffèrent en dev, où `.env.local`
   * fait marcher Gemini alors que rien n'est stocké.
   */
  configureGeminiKey(stored: boolean, source: string): void {
    this.keyForgetBtn.style.display = stored ? '' : 'none';
    this.keyInput.placeholder = stored ? 'remplacer la clé…' : 'coller la clé AI Studio…';
    this.keyStatusEl.textContent = stored
      ? `✓ clé enregistrée sur cet appareil (active : ${source})`
      : source === 'aucune'
        ? '⚠ aucune clé — agent local (mots-clés), pas de voix Live'
        : `clé active : ${source} — rien n'est stocké sur cet appareil`;
  }

  private grid(title: string, btns: [string, IntentCall][]): HTMLElement {
    const s = section(title);
    const grid = el('div', 'dp-grid');
    for (const [label, call] of btns) {
      grid.append(button(label, () => this.h.onIntent(call)));
    }
    s.append(grid);
    return s;
  }

  /** Une ligne « libellé + barre » ; retourne l'élément de remplissage. */
  private moodBar(parent: HTMLElement, label: string): HTMLElement {
    const row = el('div', 'dp-row');
    const lab = el('span', 'dp-status');
    lab.textContent = label;
    const track = el('div', 'dp-bar');
    const fill = el('div', 'dp-bar-fill');
    track.append(fill);
    row.append(lab, track);
    parent.append(row);
    return fill;
  }

  /** Met à jour la lecture d'humeur (valence -1..1, arousal 0..1). */
  setMood(valence: number, arousal: number): void {
    this.moodValFill.style.width = `${((valence + 1) / 2) * 100}%`;
    this.moodAroFill.style.width = `${Math.max(0, Math.min(1, arousal)) * 100}%`;
  }

  logMotor(e: MotorEvent): void {
    const time = new Date(e.t).toLocaleTimeString();
    const hex = Array.from(e.bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join(' ');
    // `sent: false` = l'app a voulu émettre, le lien était coupé. Le distinguer
    // évite de chercher côté firmware un ordre qui n'est jamais parti.
    const prefix = e.sent ? '' : '⚠ (non émis) ';
    this.appendLog(
      `<span class="time">${time}</span> ${prefix}<span class="op">${e.name}</span> ${
        e.args.length ? e.args.join(', ') : ''
      } [${hex}]`,
    );
  }

  logLine(text: string): void {
    const time = new Date().toLocaleTimeString();
    this.appendLog(`<span class="time">${time}</span> ${escapeHtml(text)}`);
  }

  private appendLog(html: string): void {
    const line = document.createElement('div');
    line.innerHTML = html;
    this.logEl.append(line);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  /** Active l'éditeur de personnalité (seulement si l'agent le gère). */
  configurePersona(supported: boolean, current: string, defaultText: string): void {
    this.personaSection.style.display = supported ? '' : 'none';
    if (!supported) return;
    this.personaDefault = defaultText;
    this.personaEl.value = current;
  }

  /**
   * Bascule le plein écran du navigateur — la seule façon de faire disparaître la
   * barre d'URL et les boutons de Chrome sans installer l'app.
   *
   * ⚠️ Exige un GESTE UTILISATEUR : appelé depuis le clic, jamais au chargement,
   * sinon le navigateur rejette silencieusement.
   */
  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        // `navigationUI: 'hide'` demande à Chrome de masquer aussi sa barre de
        // navigation Android quand il le peut.
        await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
        // Le but du plein écran, c'est de voir le VISAGE : on replie le tiroir dans
        // la foulée plutôt que de faire cliquer deux fois.
        this.root.classList.add('collapsed');
      }
    } catch {
      // Safari iOS n'expose l'API que sur <video>. On le dit au lieu d'échouer en
      // silence, et on renvoie vers le seul chemin qui marche là-bas.
      this.logLine('⚠ plein écran refusé — passe par « Ajouter à l’écran d’accueil »');
    }
  }

  private refreshFullscreenBtn(): void {
    const on = !!document.fullscreenElement;
    this.fsBtn.textContent = on ? '⛶ Quitter' : '⛶ Plein écran';
    this.fsBtn.classList.toggle('on', on);
  }

  /** L'armement doit-il capturer le zéro ? (case à cocher mémorisée) */
  get zeroOnArm(): boolean {
    return this.zeroOnArmBox.checked;
  }

  /** Traitement téléphonie du micro demandé ? (case à cocher mémorisée) */
  get micProcessing(): boolean {
    return this.micProcessingBox.checked;
  }

  /** Tout démarrer au lancement (robot + conversation) ? (case mémorisée) */
  get autoStart(): boolean {
    return this.autoStartBox.checked;
  }

  /**
   * Jauge micro. `sending = false` est affiché DIFFÉREMMENT et pas masqué : voir
   * « ça capte fort, et c'est jeté » est l'information la plus utile du lot —
   * c'est le moment où Mochi parle et où il ne peut pas t'entendre, par choix.
   */
  /**
   * Règle le gain micro DEPUIS LE CODE (calibration automatique), curseur et
   * libellé compris. Sans ça l'écran afficherait « 1× » pendant que la capture
   * tourne à 4×, et le prochain glissement du doigt ramènerait brutalement le
   * gain à la valeur affichée — en annulant la calibration sans prévenir.
   */
  setMicGain(g: number): void {
    const v = Math.max(1, Math.min(8, Math.round(g * 2) / 2));
    this.micGain = v;
    this.micGainInput.value = String(v);
    this.micGainLabel.textContent = this.fmtMicGain(v);
    localStorage.setItem(MIC_GAIN_KEY, String(v));
  }

  setMicLevel(peak: number, sending: boolean): void {
    const filled = Math.min(MIC_BARS, Math.round(peak * MIC_BARS * 1.6)); // 0,6 ≈ pleine échelle
    const bar = '█'.repeat(filled) + '·'.repeat(MIC_BARS - filled);
    this.micLevelEl.textContent = `${sending ? '🎤' : '🔇'} ${bar} ${peak.toFixed(2)}${
      sending ? '' : ' (jeté — Mochi parle)'
    }`;
    this.micLevelEl.classList.toggle('on', sending && peak > 0.05);
  }

  /** Reflète l'état d'écoute micro sur le bouton. */
  setListening(on: boolean): void {
    this.micBtn.classList.toggle('listening', on);
    this.micBtn.textContent = on ? '🎙 Écoute…' : '🎤 Maintenir pour parler';
    if (on) this.voiceHint.textContent = '';
  }

  /** Affiche la transcription partielle pendant qu'on parle. */
  setPartial(text: string): void {
    this.voiceHint.textContent = text ? `« ${text} »` : '';
  }

  /** Désactive le micro si non supporté par le navigateur. */
  setVoiceSupported(supported: boolean): void {
    if (supported) return;
    this.micBtn.disabled = true;
    this.micBtn.classList.add('unsupported');
    this.micBtn.textContent = '🎤 micro non supporté';
    this.micBtn.title = 'Reconnaissance vocale indisponible (essaie Chrome/Edge)';
  }

  /** Active/désactive le push-to-talk (coupé pendant la conversation Live). */
  setVoiceEnabled(enabled: boolean): void {
    if (!this.micBtn.classList.contains('unsupported')) this.micBtn.disabled = !enabled;
  }

  /** Désactive la conversation Live si pas de clé Gemini. */
  setLiveSupported(supported: boolean): void {
    if (supported) return;
    this.liveBtn.disabled = true;
    this.liveBtn.textContent = '🎙 Live indisponible (pas de clé)';
    this.liveBtn.title = 'Colle ta clé dans la section « Clé Gemini » ci-dessous';
  }

  /** Reflète l'état actif/inactif de la conversation Live. */
  setLiveActive(active: boolean): void {
    this.liveActive = active;
    this.liveBtn.classList.toggle('on', active);
    this.liveBtn.textContent = active ? '⏹ Arrêter la conversation' : '🎙 Démarrer la conversation';
    this.refreshStopBtn();
    // Le push-to-talk et la conversation Live s'excluent (même micro).
    this.setVoiceEnabled(!active);
  }

  /**
   * L'arrêt d'urgence doit être dispo DÈS QU'UN ROBOT est au bout, pas seulement
   * pendant une conversation vocale. Il était grisé hors Live — hérité de l'époque
   * où il ne coupait que la voix, avant qu'il ne coupe aussi les roues. Un bouton
   * d'arrêt indisponible au moment où le robot part, c'est le pire des défauts.
   */
  private refreshStopBtn(): void {
    this.liveStopBtn.disabled = !this.connected && !this.liveActive;
  }

  /** Affiche l'état de la session Live (connexion / écoute / Mochi parle / erreur). */
  setLiveStatus(status: LiveStatus, detail?: string): void {
    const label: Record<LiveStatus, string> = {
      idle: '',
      connecting: '⏳ connexion…',
      listening: '🎧 je t\'écoute…',
      speaking: '🗣 Mochi parle…',
      error: `⚠ ${detail ?? 'erreur'}`,
    };
    this.liveStatusEl.textContent = label[status];
    this.liveStatusEl.classList.toggle('on', status === 'listening' || status === 'speaking');
  }

  setConnected(connected: boolean): void {
    this.connected = connected;
    this.refreshStopBtn();
    this.statusEl.textContent = connected ? 'robot : connecté' : 'robot : déconnecté';
    this.statusEl.classList.toggle('on', connected);
    this.armBtn.disabled = !connected;
    this.calibBtn.disabled = !connected;
    for (const b of this.zeroBtns) b.disabled = !connected;
    if (!connected) {
      this.setArmed(false);
      this.telemetryEl.textContent = '';
      this.telemetryEl.classList.remove('on');
    }
  }

  /**
   * Reflète l'armement. La source de vérité est la TÉLÉMÉTRIE, pas le clic : c'est
   * le robot qui désarme tout seul en tombant, et le bouton doit le dire.
   */
  setArmed(armed: boolean): void {
    this.armed = armed;
    this.armBtn.classList.toggle('on', armed);
    this.armBtn.textContent = armed ? '⚡ Désarmer' : '⚡ Armer';
  }

  /** Lecture de télémétrie (état, inclinaison, obstacle). */
  setTelemetry(t: Telemetry): void {
    const state =
      t.state === RobotState.BALANCING
        ? '⚖ en équilibre'
        : t.state === RobotState.FALLEN
          ? '💥 tombé'
          : '💤 au repos';
    const obstacle = t.obstacle ? ` ⚠ obstacle ${t.distanceMm} mm` : '';
    this.telemetryEl.textContent =
      `${state} — ${t.pitchDeg.toFixed(1)}°, ${t.wheelSpeedMmS} mm/s` +
      `${t.motorsEnabled ? '' : ' — moteurs coupés'}${obstacle}`;
    this.telemetryEl.classList.toggle('on', t.state === RobotState.BALANCING);
  }
}

// --- helpers DOM ---
function el(tag: string, cls?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function section(title: string): HTMLElement {
  const s = el('div', 'dp-section');
  const h = el('p', 'dp-title');
  h.textContent = title;
  s.append(h);
  return s;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c);
}
