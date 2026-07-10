import type { IntentCall } from '../agent/intents';
import type { MotorEvent } from '../robot/mockTransport';
import { LIVE_VOICES, DEFAULT_VOICE, DEFAULT_PITCH, type LiveStatus } from '../agent/live';

export interface DevPanelHandlers {
  onIntent(call: IntentCall): void;
  onSend(text: string): void;
  onConnect(): void;
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
}

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

  constructor(
    private readonly root: HTMLElement,
    private readonly h: DevPanelHandlers,
  ) {
    this.build();
  }

  private build(): void {
    this.root.innerHTML = '';

    // En-tête + collapse.
    const header = el('div', 'dp-section');
    const collapse = button('⟩', () => this.root.classList.toggle('collapsed'));
    collapse.className = 'dp-collapse';
    header.append(collapse);
    this.root.append(header);

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

    this.liveStatusEl = document.createElement('span');
    this.liveStatusEl.className = 'dp-status';
    liveSection.append(this.liveBtn, this.liveStopBtn, voiceRow, pitchRow, this.liveStatusEl);
    this.root.append(liveSection);

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
    this.root.append(this.grid('Moteur (mocké)', MOTOR_BTNS));

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
    ctlRow.append(muteBtn, connectBtn);
    ctl.append(ctlRow);
    this.statusEl = document.createElement('span');
    this.statusEl.className = 'dp-status';
    this.statusEl.textContent = 'robot : déconnecté (mock)';
    ctl.append(this.statusEl);
    this.root.append(ctl);

    // Log.
    const logSection = section('Log intentions moteur');
    this.logEl = el('div') as HTMLDivElement;
    this.logEl.id = 'dp-log';
    logSection.append(this.logEl);
    this.root.append(logSection);
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
    this.appendLog(
      `<span class="time">${time}</span> <span class="op">${e.name}</span> ${
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
    this.liveBtn.title = 'Renseigne VITE_GEMINI_API_KEY dans .env.local';
  }

  /** Reflète l'état actif/inactif de la conversation Live. */
  setLiveActive(active: boolean): void {
    this.liveBtn.classList.toggle('on', active);
    this.liveBtn.textContent = active ? '⏹ Arrêter la conversation' : '🎙 Démarrer la conversation';
    this.liveStopBtn.disabled = !active;
    // Le push-to-talk et la conversation Live s'excluent (même micro).
    this.setVoiceEnabled(!active);
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
    this.statusEl.textContent = connected
      ? 'robot : connecté (mock)'
      : 'robot : déconnecté (mock)';
    this.statusEl.classList.toggle('on', connected);
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
