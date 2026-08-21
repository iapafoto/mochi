// dashboard.ts — banc de tuning Mochi : visualise EN DIRECT ce que le robot croit
// mesurer, pour le confronter à ce qu'on voit physiquement.
//
// Le firmware émet déjà tout sur la console de tuning (Tuning.cpp, 10 Hz) :
//   [tune] pitch=  +1.87 gy=   -9.3 (X= +11.08 Y=  -2.68) tgt= -0.78 v=  -13mm/s x= +111mm glt=0 BAL
//
// DEUX TRANSPORTS, un seul protocole. Le firmware sert la même console texte sur
// le port série ET sur BLE (cf. firmware/src/Console.h) — tout ce qui suit le
// point d'entrée `handleLine` / `send` ignore lequel est branché :
//   - USB / Web Serial : marche toujours, voit le boot, mais le câble TIRE sur le
//     robot et fausse les essais d'équilibre ;
//   - Bluetooth / Web Bluetooth : robot libre, c'est le mode de réglage réel.
//     Exige HTTPS (`npm run dev:https`) ou localhost, et un clic utilisateur.
//
// ⚠️ Le port série est EXCLUSIF : fermer les scripts PowerShell de capture avant
// de connecter ici (et inversement), sinon l'ouverture échoue.

import './dashboard.css';
import {
  MOCHI_DEVICE_NAME,
  MOCHI_SERVICE_UUID,
  MOCHI_CONSOLE_RX_UUID,
  MOCHI_CONSOLE_TX_UUID,
} from '../robot/bleProfile';

const BAUD = 115200;
// Conditions de ré-engagement — doivent rester alignées sur config.h
// (RECOVER_LIMIT_DEG / RECOVER_RATE_DEG_S).
const RECOVER_LIMIT_DEG = 5;
const RECOVER_RATE_DEG_S = 30;
// Seuil de la garde anti-emballement (RUNAWAY_LIMIT_MM), tracé sur la courbe x.
const RUNAWAY_LIMIT_MM = 400;

const HISTORY_S = 20;
const SAMPLE_HZ = 10;
const HISTORY_N = HISTORY_S * SAMPLE_HZ;

type Sample = {
  pitch: number; gy: number; tgt: number; v: number; x: number;
  rawX: number; rawY: number; glt: number; state: string; armed: boolean;
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ─────────────────────────────────────────────────────────────────────────
//  Parsing d'une ligne de stream
// ─────────────────────────────────────────────────────────────────────────
// Attention à la casse : `x=` (position) et `X=` (angle brut MPU) coexistent sur
// la ligne — les regex JS sont sensibles à la casse par défaut, on en profite.
const num = (re: RegExp, s: string): number | null => {
  const m = s.match(re);
  return m ? parseFloat(m[1]) : null;
};

function parseLine(line: string): Sample | null {
  if (!line.includes('pitch=')) return null;
  const pitch = num(/pitch=\s*([-+][\d.]+)/, line);
  const gy = num(/gy=\s*([-+][\d.]+)/, line);
  if (pitch === null || gy === null) return null;
  return {
    pitch,
    gy,
    tgt: num(/tgt=\s*([-+][\d.]+)/, line) ?? 0,
    v: num(/\sv=\s*([-+][\d.]+)mm\/s/, line) ?? 0,
    x: num(/\sx=\s*([-+][\d.]+)mm/, line) ?? 0,
    rawX: num(/\(X=\s*([-+][\d.]+)/, line) ?? 0,
    rawY: num(/Y=\s*([-+][\d.]+)\)/, line) ?? 0,
    glt: num(/glt=(\d+)/, line) ?? 0,
    state: (line.match(/\b(BAL|FALL|IDLE)\b/) ?? [, '—'])[1] as string,
    armed: !line.includes('(desarme)'),
  };
}

// ─────────────────────────────────────────────────────────────────────────
//  État
// ─────────────────────────────────────────────────────────────────────────
const hist: Sample[] = [];
let last: Sample | null = null;
let recording = false;
const recorded: string[] = [];

let port: any = null;
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
let keepReading = false;
// Diagnostic de flux : distinguer « rien n'arrive » de « ça arrive mais ça ne
// parse pas ». Sans ça l'UI affichait un 0.0 trompeur (cf. faux départ du 23/07).
let rxBytes = 0;
let lastTeleMs = 0;

// Transport actif. Tout le reste du fichier passe par `send()` et `handleLine()`
// et n'a pas à savoir lequel des deux est branché.
type LinkKind = 'serial' | 'ble';
let linkKind: LinkKind | null = null;
let bleWrite: ((bytes: Uint8Array) => Promise<void>) | null = null;

// ─────────────────────────────────────────────────────────────────────────
//  Découpage du flux en lignes — commun aux deux transports
// ─────────────────────────────────────────────────────────────────────────
// Ni le série ni le BLE ne garantissent qu'un morceau reçu = une ligne : le BLE
// fragmente selon le MTU, le série selon les tampons USB. On accumule et on ne
// traite que ce qui est terminé par un `\n`.
let lineBuf = '';
function feedChunk(text: string) {
  rxBytes += text.length;
  lineBuf += text;
  const lines = lineBuf.split(/\r?\n/);
  lineBuf = lines.pop() ?? '';
  for (const line of lines) handleLine(line);
}

// ─────────────────────────────────────────────────────────────────────────
//  Connexion série (USB)
// ─────────────────────────────────────────────────────────────────────────
async function connectSerial() {
  const serial = (navigator as any).serial;
  if (!serial) {
    logLine('❌ Web Serial indisponible. Utiliser Chrome/Edge, en http://localhost ou https.');
    return;
  }
  try {
    port = await serial.requestPort();
    await port.open({ baudRate: BAUD });
  } catch (e) {
    logLine('❌ ouverture impossible : ' + (e as Error).message +
            '\n   (un script PowerShell tient peut-être encore COM4)');
    return;
  }
  // ⚠️ Chrome affirme DTR/RTS à l'ouverture : sur le CP2102 ces broches pilotent
  // le circuit d'auto-reset de l'ESP32, qui reste alors muet (voir docs/TUNING.md,
  // même piège qu'en PowerShell). Il faut les relâcher explicitement.
  try {
    await port.setSignals({ dataTerminalReady: false, requestToSend: false });
  } catch (e) {
    logLine('⚠️ setSignals refusé (' + (e as Error).message + ') — l’ESP32 peut rester en reset.');
  }
  writer = port.writable.getWriter();
  linkKind = 'serial';
  afterConnect();
  keepReading = true;
  readLoop();
}

async function readLoop() {
  const decoder = new TextDecoderStream();
  port.readable.pipeTo(decoder.writable).catch(() => {});
  const reader = decoder.readable.getReader();
  while (keepReading) {
    let res;
    try { res = await reader.read(); } catch { break; }
    if (res.done) break;
    feedChunk(res.value);
  }
  linkKind = null;
  setLink(false);
}

// ─────────────────────────────────────────────────────────────────────────
//  Connexion Bluetooth (Web Bluetooth) — le mode de réglage réel
// ─────────────────────────────────────────────────────────────────────────
// Même console texte, transportée par deux caractéristiques GATT (cf.
// bleProfile.ts). Le firmware ne bufferise QUE si un client est abonné aux
// notifications : on s'abonne donc avant d'envoyer quoi que ce soit.
async function connectBle() {
  const bt = (navigator as any).bluetooth;
  if (!bt) {
    logLine('❌ Web Bluetooth indisponible.\n' +
            '   → Chrome/Edge, et une origine sécurisée : `npm run dev:https` ou http://localhost.');
    return;
  }
  let device: any;
  try {
    device = await bt.requestDevice({
      filters: [{ name: MOCHI_DEVICE_NAME }],
      optionalServices: [MOCHI_SERVICE_UUID],
    });
  } catch (e) {
    // Inclut le cas « l'utilisateur ferme le sélecteur » : pas une erreur.
    logLine('ℹ️ sélection annulée ou robot introuvable : ' + (e as Error).message);
    return;
  }

  try {
    const server = await device.gatt.connect();
    const svc = await server.getPrimaryService(MOCHI_SERVICE_UUID);
    const tx = await svc.getCharacteristic(MOCHI_CONSOLE_TX_UUID);
    const rx = await svc.getCharacteristic(MOCHI_CONSOLE_RX_UUID);

    const dec = new TextDecoder();
    tx.addEventListener('characteristicvaluechanged', (ev: any) => {
      feedChunk(dec.decode(ev.target.value));
    });
    await tx.startNotifications();

    // `writeValueWithoutResponse` n'existe pas sur les Chrome anciens.
    bleWrite = (bytes) =>
      rx.writeValueWithoutResponse ? rx.writeValueWithoutResponse(bytes) : rx.writeValue(bytes);

    device.addEventListener('gattserverdisconnected', () => {
      bleWrite = null;
      linkKind = null;
      setLink(false);
      logLine('⚠️ Bluetooth déconnecté (hors de portée, ou robot éteint).');
    });
  } catch (e) {
    logLine('❌ connexion BLE impossible : ' + (e as Error).message +
            '\n   (firmware à jour ? la console BLE date de la version avec Console.h)');
    try { device.gatt?.disconnect(); } catch { /* rien à sauver */ }
    return;
  }

  linkKind = 'ble';
  afterConnect();
}

// Amorçage commun aux deux transports.
function afterConnect() {
  rxBytes = 0;
  lineBuf = '';
  setLink(true);

  // `g` n'est pas une bascule : sans risque, et il peuple les réglages.
  window.setTimeout(() => send('g'), 400);

  // Sonder AVANT de basculer quoi que ce soit : `t` et `m` sont des bascules,
  // un envoi à l'aveugle peut ÉTEINDRE le stream au lieu de l'allumer.
  window.setTimeout(() => {
    if (last) return;
    if (rxBytes === 0) {
      logLine(linkKind === 'ble'
        ? '❌ 0 octet reçu en BLE. Le lien est ouvert mais rien ne remonte :\n' +
          '   → firmware trop ancien (pas de console BLE), ou abonnement refusé.'
        : '❌ 0 octet reçu. Le port est ouvert mais la carte ne parle pas :\n' +
          '   → mauvais port COM, ou ESP32 tenu en reset. Débranche/rebranche l’USB.');
    } else {
      logLine('ℹ️ La carte parle mais n’envoie pas de télémétrie : le stream est ÉTEINT.\n' +
              '   → clique « t — stream » pour l’allumer.');
    }
  }, 1500);
}

function handleLine(line: string) {
  if (recording) recorded.push(line);
  const s = parseLine(line);
  if (!s) {
    // Réponses de commandes, erreurs Wire, logs de boot : utiles à voir.
    parseGains(line);
    if (line.trim()) logLine(line);
    return;
  }
  last = s;
  lastTeleMs = performance.now();
  hist.push(s);
  if (hist.length > HISTORY_N) hist.shift();
}

async function send(cmd: string, quiet = false) {
  const bytes = new TextEncoder().encode(cmd + '\n');
  if (linkKind === 'ble' && bleWrite) {
    try {
      await bleWrite(bytes);
    } catch (e) {
      logLine('⚠️ envoi BLE échoué : ' + (e as Error).message);
      return;
    }
  } else if (linkKind === 'serial' && writer) {
    await writer.write(bytes);
  } else {
    logLine('⚠️ pas connecté');
    return;
  }
  if (!quiet) logLine('> ' + cmd); // le pad de téléguidage émet à 10 Hz
  // Ces commandes répondent par leur propre message, pas par un printState : sans
  // relecture, le panneau afficherait encore l'ancienne valeur. La casse compte côté
  // firmware (`g` = lecture d'état vs `G` = échelle gyro, `z` = zéro ici vs `Z` =
  // adopter le zéro suggéré par l'intégrale).
  const head = cmd.trim()[0];
  if ('zynGZVTDHFBxAPR'.includes(head)) {
    window.setTimeout(() => send('g'), 200);
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  Réglages en direct (les gains de Balance, via la console série)
// ─────────────────────────────────────────────────────────────────────────
// Le firmware répond à chaque `p`/`d`/`v`/`i`/`q`/`o` par un printState() complet :
// on s'en sert comme source de vérité plutôt que de tenir un état local qui
// divergerait. `z` est la seule commande qui ne l'imprime pas → on relit après.
type Gain = {
  cmd: string; label: string; hint: string;
  step: number; dec: number; min: number; max?: number;
};
const GAINS: Gain[] = [
  { cmd: 'd', label: 'Nervosité',        hint: 'angle → vitesse (Kp) : la raideur, le rattrapage immédiat', step: 1, dec: 1, min: 0 },
  { cmd: 'p', label: 'Insistance',       hint: '∫angle → vitesse (Ki) : TERME DOMINANT (~6.4×Kp) — à 0 le robot part et tombe', step: 5, dec: 1, min: 0 },
  { cmd: 'e', label: 'Amortissement',    hint: 'gyro θ̇ → vitesse (Kd) : freine le mouvement (terme ajouté)', step: 0.05, dec: 2, min: 0 },
  { cmd: 'v', label: 'Tenue de vitesse', hint: 'vitesse → angle de consigne (butée ±12°)',         step: 0.005,  dec: 4, min: 0 },
  { cmd: 'i', label: 'Anti-dérive',      hint: 'intégral lent de la boucle vitesse',               step: 0.0005, dec: 5, min: 0 },
  { cmd: 'q', label: 'Ancre position',   hint: 'rappel vers le point de départ (borné 100 mm/s)',  step: 0.05,   dec: 2, min: 0 },
  { cmd: 's', label: 'Auto-zéro',        hint: 'trim auto du point d\'équilibre (Brokking) : sol plat, sans contact', step: 0.0005, dec: 4, min: 0 },
  { cmd: 'o', label: 'Zéro',             hint: 'angle du point d\'équilibre (négatif possible)',   step: 0.1,    dec: 2, min: -90 },
  // Les deux réglages qui PLAFONNENT la nervosité — ils ne sont pas des gains du
  // PID, mais c'est souvent eux qui bloquent, pas les gains (cf. docs/TUNING.md).
  { cmd: 'y', label: 'Confiance gyro',   hint: 'filtre : haut = insensible aux secousses de roue, mais laisse dériver', step: 0.001, dec: 4, min: 0.9, max: 0.9999 },
  { cmd: 'n', label: 'Accél. driver',    hint: 'rampe steps/s² : trop haut = pas sautés, trop bas = mou', step: 50000, dec: 0, min: 50000, max: 1000000 },
  { cmd: 'G', label: 'Échelle gyro',     hint: 'clones MPU6050 : compare y 0.95 (accéléro, fiable) et y 0.9999 (gyro)', step: 0.05, dec: 3, min: 0.1, max: 10 },
  // Ajoutés le 21/08 avec la comparaison B-Robot (cf. docs/COMPARAISON.md).
  { cmd: 'V', label: 'Vitesse roue max', hint: 'autorité de rattrapage mm/s (B-Robot ~2160) : monter tant que les moteurs ne perdent pas de pas', step: 100, dec: 0, min: 100, max: 3000 },
  { cmd: 'T', label: 'Vitesse ⟵ gyro',   hint: 'v_robot = v_roue + k·θ̇ (0 = off, B-Robot ~1) : amortit en plus de `e`', step: 0.1, dec: 2, min: 0, max: 5 },
  { cmd: 'D', label: 'DLPF MPU',         hint: 'filtre matériel : 3 = 44 Hz, 4 = 21 Hz, 5 = 10 Hz (réglage B-Robot)', step: 1, dec: 0, min: 0, max: 6 },
  // Ajoutés le 23/08 — la cause racine était côté ACTIONNEUR, pas côté gains :
  // FastAccelStepper reste bloqué quand la consigne roue passe par zéro (il doit
  // décélérer depuis une vitesse déjà nulle et ne finit jamais). Cf. docs/TUNING.md.
  { cmd: 'F', label: "Plancher vitesse", hint: "mm/s : empêche la consigne roue de s'immobiliser au point zéro. LE correctif du « il tombe à la verticale » — 4 suffit, plus haut ne fait qu'ajouter de la vibration", step: 1, dec: 0, min: 0, max: 100 },
  { cmd: 'B', label: "Balancier",        hint: "degrés : oscillation volontaire de la consigne d'angle à 1,5 Hz. Même exigence que F, exprimée en amont (B ≈ F/Kp)", step: 0.1, dec: 2, min: 0, max: 5 },
  { cmd: 'H', label: "Dither",           hint: "mm/s : vibration de la consigne contre le JEU mécanique. Vérifier le jeu à la main avant de s'en servir", step: 5, dec: 0, min: 0, max: 100 },
  // Conduite — ce ne sont pas des gains, mais c'est ce qui plafonne le déplacement.
  { cmd: 'A', label: "Penche max",       hint: "degrés : inclinaison autorisée pour se déplacer = plafond d'accélération. Le monter si le robot « refuse » d'avancer (B-Robot : 14 normal, 26 pro)", step: 1, dec: 0, min: 1, max: 30 },
  { cmd: 'P', label: "Manette : vitesse",  hint: 'mm/s à fond de course, pour un pilote qui envoie des % (app, manette). Le pad ci-dessus a son propre curseur', step: 25, dec: 0, min: 0, max: 2000 },
  { cmd: 'R', label: "Manette : rotation", hint: '°/s à fond de course', step: 10, dec: 0, min: 0, max: 720 },
];

const gainVal: Record<string, number> = {};

// printState : "[tune] p=0.000 d=66.000 v=0.0250 i=0.00100 q=0.400 o=+0.81 e=0.000 axe=…"
// `e=` (amortissement Kd) est en fin de bloc → optionnel dans le regex (compat firmware ancien).
const RE_GAINS = /(?:^|\s)p=([\d.]+)\s+d=([\d.]+)\s+v=([\d.]+)\s+i=([\d.]+)\s+q=([\d.]+)\s+o=([-+][\d.]+)(?:\s+e=([\d.]+))?/;
// `s=`, `y=` et `acc=` sont plus loin dans la ligne printState (bloc télémétrie
// après le `|`) → captés à part, et tolérants à un firmware plus ancien.
const RE_TAIL: Record<string, RegExp> = {
  s: /\ss=([\d.]+)/,
  y: /\sy=([\d.]+)/,
  n: /\sacc=([\d.]+)/, // la commande est `n`, le champ imprimé s'appelle `acc`
  G: /\sgs=([\d.]+)/,  // échelle gyro (clones MPU6050)
  V: /\sV=([\d.]+)/,   // vitesse roue max (autorité de rattrapage)
  T: /\sT=([\d.]+)/,   // correction v_robot ← gyro
  D: /\sD=(\d+)/,      // DLPF matériel du MPU
  H: /\sH=([\d.]+)/,   // dither (jeu mécanique)
  F: /\sF=([\d.]+)/,   // plancher de vitesse roue
  B: /\sB=([\d.]+)/,   // balancier volontaire
  A: /\sA=([\d.]+)/,   // inclinaison max en déplacement
  P: /\sP=([\d.]+)/,   // fond de course vitesse (manette)
  R: /\sR=([\d.]+)/,   // fond de course rotation (manette)
};

function parseGains(line: string): void {
  const m = line.match(RE_GAINS);
  if (!m) return;
  ['p', 'd', 'v', 'i', 'q', 'o'].forEach((k, i) => { gainVal[k] = parseFloat(m[i + 1]); });
  if (m[7] !== undefined) gainVal['e'] = parseFloat(m[7]);
  for (const [k, re] of Object.entries(RE_TAIL)) {
    const mt = line.match(re);
    if (mt) gainVal[k] = parseFloat(mt[1]);
  }
  drawGains();
}

function drawGains() {
  for (const g of GAINS) {
    const v = gainVal[g.cmd];
    $('g-' + g.cmd).textContent = v === undefined ? '—' : v.toFixed(g.dec);
  }
  // Le ratio qui décrit le comportement est Ki/Kp = `p`/`d` : c'est l'inverse de
  // la constante de temps de l'action intégrale (s⁻¹). Le B-Robot tourne à 6.4 s⁻¹
  // (soit 0.16 s) — c'est la cible de référence, cf. docs/COMPARAISON.md §1.
  const { d, p } = gainVal;
  $('ratio').textContent =
    p === undefined || !d
      ? '—'
      : `Ki/Kp = ${(p / d).toFixed(1)} s⁻¹ (B-Robot : 6.4)`;
}

function bump(cmd: string, dir: number) {
  const g = GAINS.find((x) => x.cmd === cmd)!;
  const cur = gainVal[cmd];
  if (cur === undefined) { logLine('⚠️ valeurs inconnues — clique « Relire »'); return; }
  const next = Math.min(g.max ?? Infinity, Math.max(g.min, cur + dir * g.step));
  send(g.cmd + ' ' + next.toFixed(g.dec)); // la réponse printState remet l'UI à jour
}

function buildGains() {
  const host = $('gains');
  for (const g of GAINS) {
    const row = document.createElement('div');
    row.className = 'gain';
    row.innerHTML =
      `<label>${g.label}<em>${g.cmd} — ${g.hint}</em></label>` +
      `<button class="step" data-g="${g.cmd}" data-dir="-1">−</button>` +
      `<output id="g-${g.cmd}">—</output>` +
      `<button class="step" data-g="${g.cmd}" data-dir="1">+</button>`;
    host.appendChild(row);
  }
  host.querySelectorAll<HTMLButtonElement>('button.step').forEach((b) => {
    b.addEventListener('click', () => bump(b.dataset.g!, Number(b.dataset.dir)));
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  Téléguidage (pad du banc)
// ─────────────────────────────────────────────────────────────────────────
// Le firmware n'attend pas un ORDRE mais un ÉTAT : `u <mm/s> <deg/s>` vaut
// TELEOP_TTL_MS (500 ms) puis expire tout seul. On ré-émet donc à 10 Hz tant
// qu'une direction est tenue. Conséquence qui vaut d'être dite : il n'y a RIEN à
// couper en cas de pépin — onglet fermé, BLE tombé, PC en veille, le robot
// s'arrête de lui-même parce que plus personne ne rafraîchit.
const DRIVE_HZ = 10;
// Rampe côté PILOTE (pas côté robot) : une touche est tout ou rien, et demander
// 300 mm/s d'un bloc à un pendule inversé le fait se pencher en butée d'un coup.
// 0,45 s pour atteindre le fond de course : assez vif pour se sentir aux
// commandes, assez doux pour que la boucle externe suive.
const DRIVE_RAMP_S = 0.45;

type Dir = 'fwd' | 'back' | 'left' | 'right';
const held: Record<Dir, boolean> = { fwd: false, back: false, left: false, right: false };
let driveV = 0; // mm/s réellement commandés (après rampe)
let driveW = 0; // deg/s
let driveTimer = 0;
let driveBusy = false; // un envoi est en vol : ne pas en empiler un second

const driveMax = () => ({
  v: Number($<HTMLInputElement>('d-speed-in').value),
  w: Number($<HTMLInputElement>('d-turn-in').value),
});

function approach(cur: number, target: number, step: number): number {
  return cur < target ? Math.min(target, cur + step) : Math.max(target, cur - step);
}

function setDir(dir: Dir, on: boolean) {
  if (held[dir] === on) return;
  held[dir] = on;
  document.querySelector('.pad [data-dir="' + dir + '"]')?.classList.toggle('on', on);
  if (on) startDrive();
}

function stopDriveTimer() {
  if (!driveTimer) return;
  window.clearInterval(driveTimer);
  driveTimer = 0;
}

/** Relâche tout. `hard` = arrêt immédiat sans rampe (bouton stop, espace, perte de lien). */
function driveRelease(hard: boolean) {
  (Object.keys(held) as Dir[]).forEach((d) => setDir(d, false));
  if (!hard) return;
  driveV = 0;
  driveW = 0;
  stopDriveTimer();
  drawDrive();
  if (linkKind) send('u 0', true);
}

function startDrive() {
  if (driveTimer) return;
  driveTimer = window.setInterval(driveTick, 1000 / DRIVE_HZ);
  driveTick();
}

async function driveTick() {
  if (driveBusy) return; // un envoi traîne : sauter ce tour, ne pas faire la queue
  if (!linkKind) { driveRelease(true); return; }
  const max = driveMax();
  const tv = (held.fwd ? max.v : 0) - (held.back ? max.v : 0);
  const tw = (held.right ? max.w : 0) - (held.left ? max.w : 0);
  const k = 1 / (DRIVE_HZ * DRIVE_RAMP_S); // fraction du fond de course par tick
  driveV = approach(driveV, tv, max.v * k);
  driveW = approach(driveW, tw, max.w * k);
  drawDrive();
  driveBusy = true;
  try {
    await send('u ' + driveV.toFixed(0) + ' ' + driveW.toFixed(0), true);
  } finally {
    driveBusy = false;
  }
  // Plus rien de tenu et la rampe est revenue à zéro : on rend la main. Cesser
  // d'émettre est le comportement voulu — le robot n'a pas besoin qu'on lui
  // répète qu'il est à l'arrêt, l'expiration de la dernière commande suffit.
  if (!tv && !tw && driveV === 0 && driveW === 0) stopDriveTimer();
}

function drawDrive() {
  const el = $('d-live');
  const moving = driveV !== 0 || driveW !== 0;
  el.classList.toggle('on', moving);
  el.textContent = !linkKind
    ? 'pas connecté'
    : moving
      ? `v ${driveV > 0 ? '+' : ''}${driveV.toFixed(0)} mm/s · rot ${driveW > 0 ? '+' : ''}${driveW.toFixed(0)} °/s`
      : "à l'arrêt";
}

// Clavier. Volontairement derrière une case à cocher : sur cette page on tape des
// commandes et on règle des gains — une flèche qui fait partir le robot pendant
// qu'on cherche un champ serait une très mauvaise surprise.
// `e.code` = touche PHYSIQUE : ZQSD (AZERTY) et WASD (QWERTY) sont les mêmes
// touches, donc les deux marchent sans rien savoir de la disposition.
const DRIVE_KEYS: Record<string, Dir | 'stop'> = {
  ArrowUp: 'fwd', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'fwd', KeyS: 'back', KeyA: 'left', KeyD: 'right',
  Space: 'stop',
};

function driveKey(e: KeyboardEvent, down: boolean) {
  if (!($<HTMLInputElement>('d-kb').checked)) return;
  const t = e.target as HTMLElement | null;
  if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return; // on tape, on ne pilote pas
  const dir = DRIVE_KEYS[e.code];
  if (!dir) return;
  e.preventDefault(); // flèches = défilement, espace = clic du bouton qui a le focus
  if (dir === 'stop') { if (down) driveRelease(true); return; }
  setDir(dir, down);
}

// ─────────────────────────────────────────────────────────────────────────
//  Rendu — vue d'assiette
// ─────────────────────────────────────────────────────────────────────────
const attCanvas = $<HTMLCanvasElement>('attitude');
const attCtx = attCanvas.getContext('2d')!;

function drawAttitude() {
  const c = attCtx;
  const W = attCanvas.width, H = attCanvas.height;
  c.clearRect(0, 0, W, H);

  const cx = W / 2, cy = H * 0.72;   // centre de l'essieu
  const bodyLen = H * 0.46;
  const wheelR = 34;

  // --- Fenêtre d'engagement ±5° (le robot ne peut repartir que là-dedans) ---
  const inWindow = last ? Math.abs(last.pitch) < RECOVER_LIMIT_DEG : false;
  c.save();
  c.translate(cx, cy);
  c.beginPath();
  c.moveTo(0, 0);
  const wRad = (RECOVER_LIMIT_DEG * Math.PI) / 180;
  c.arc(0, 0, bodyLen * 1.06, -Math.PI / 2 - wRad, -Math.PI / 2 + wRad);
  c.closePath();
  c.fillStyle = inWindow ? 'rgba(80,220,140,0.22)' : 'rgba(120,140,200,0.12)';
  c.fill();
  c.restore();

  // --- Verticale = point d'équilibre (pitch 0) ---
  c.save();
  c.translate(cx, cy);
  c.setLineDash([6, 6]);
  c.strokeStyle = 'rgba(200,210,255,0.55)';
  c.lineWidth = 2;
  c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -bodyLen * 1.12); c.stroke();
  c.setLineDash([]);
  c.fillStyle = 'rgba(200,210,255,0.75)';
  c.font = '12px system-ui, sans-serif';
  c.textAlign = 'center';
  c.fillText('équilibre 0°', 0, -bodyLen * 1.16);
  c.restore();

  // --- Consigne tgt : ce que le contrôleur VEUT ---
  if (last) {
    c.save();
    c.translate(cx, cy);
    c.rotate((last.tgt * Math.PI) / 180);
    c.strokeStyle = 'rgba(255,190,90,0.85)';
    c.lineWidth = 2;
    c.setLineDash([4, 4]);
    c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -bodyLen * 0.95); c.stroke();
    c.setLineDash([]);
    c.restore();
  }

  // --- Le robot, incliné de `pitch` ---
  const pitch = last?.pitch ?? 0;
  c.save();
  c.translate(cx, cy);
  c.rotate((pitch * Math.PI) / 180);   // pitch > 0 = penché en AVANT (droite)
  const bodyW = 88;
  const grad = c.createLinearGradient(0, -bodyLen, 0, 0);
  grad.addColorStop(0, '#8f7bd8');
  grad.addColorStop(1, '#4d3f86');
  c.fillStyle = grad;
  c.strokeStyle = '#c9bcff';
  c.lineWidth = 2;
  roundRect(c, -bodyW / 2, -bodyLen, bodyW, bodyLen, 16);
  c.fill(); c.stroke();
  // « visage » pour lire l'orientation d'un coup d'œil
  c.fillStyle = '#1a1030';
  c.beginPath(); c.arc(-16, -bodyLen + 42, 7, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.arc(16, -bodyLen + 42, 7, 0, Math.PI * 2); c.fill();
  c.restore();

  // --- Roue (fixe : c'est l'axe de rotation) ---
  c.beginPath();
  c.arc(cx, cy, wheelR, 0, Math.PI * 2);
  c.fillStyle = '#241a44';
  c.strokeStyle = '#7d6cc4';
  c.lineWidth = 3;
  c.fill(); c.stroke();

  // --- Sol ---
  c.strokeStyle = 'rgba(180,190,230,0.35)';
  c.lineWidth = 2;
  c.beginPath();
  c.moveTo(40, cy + wheelR); c.lineTo(W - 40, cy + wheelR); c.stroke();

  // --- Valeur en gros ---
  // Sans données, afficher « — » : un 0.0 ferait croire à une mesure réelle.
  c.fillStyle = !last ? 'rgba(210,215,245,0.35)' : inWindow ? '#5fe0a0' : '#ffd479';
  c.font = 'bold 40px system-ui, sans-serif';
  c.textAlign = 'left';
  c.fillText(last ? fmt(pitch, 1) + '°' : '—', 18, 46);
  c.fillStyle = 'rgba(210,215,245,0.7)';
  c.font = '13px system-ui, sans-serif';
  c.fillText(last ? 'écart au point d\'équilibre' : 'aucune télémétrie reçue', 18, 66);
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// ─────────────────────────────────────────────────────────────────────────
//  Rendu — courbes
// ─────────────────────────────────────────────────────────────────────────
const chartCanvas = $<HTMLCanvasElement>('chart');
const chartCtx = chartCanvas.getContext('2d')!;

type Track = { key: keyof Sample; color: string; label: string; span: number };
const TRACKS: Track[] = [
  { key: 'pitch', color: '#7ee0ff', label: 'pitch (°)', span: 40 },
  { key: 'tgt',   color: '#ffbe5a', label: 'tgt (°)',   span: 40 },
  { key: 'gy',    color: '#ff8fb0', label: 'gyro (°/s)', span: 200 },
  { key: 'v',     color: '#a0ff9f', label: 'v (mm/s)',  span: 800 },
  { key: 'x',     color: '#d3b4ff', label: 'x (mm)',    span: 800 },
];

function drawChart() {
  const c = chartCtx;
  const W = chartCanvas.width, H = chartCanvas.height;
  c.clearRect(0, 0, W, H);
  const rows = TRACKS.length;
  const rowH = H / rows;

  TRACKS.forEach((tr, i) => {
    const top = i * rowH;
    const mid = top + rowH / 2;

    // ligne zéro
    c.strokeStyle = 'rgba(190,200,240,0.18)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(52, mid); c.lineTo(W - 6, mid); c.stroke();

    // repère ±400 mm pour la garde anti-emballement
    if (tr.key === 'x') {
      c.strokeStyle = 'rgba(255,120,120,0.35)';
      c.setLineDash([4, 4]);
      for (const s of [-1, 1]) {
        const y = mid - (s * RUNAWAY_LIMIT_MM / tr.span) * (rowH * 0.42) * 2;
        c.beginPath(); c.moveTo(52, y); c.lineTo(W - 6, y); c.stroke();
      }
      c.setLineDash([]);
    }

    // courbe
    c.strokeStyle = tr.color;
    c.lineWidth = 1.8;
    c.beginPath();
    hist.forEach((s, j) => {
      const x = 52 + (j / Math.max(1, HISTORY_N - 1)) * (W - 58);
      const val = s[tr.key] as number;
      const y = mid - (val / tr.span) * (rowH * 0.42) * 2;
      j === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    });
    c.stroke();

    // libellé + valeur courante
    c.fillStyle = tr.color;
    c.font = '11px system-ui, sans-serif';
    c.textAlign = 'left';
    c.fillText(tr.label, 6, top + 13);
    if (last) {
      c.textAlign = 'right';
      c.fillText(fmt(last[tr.key] as number, 1), W - 8, top + 13);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
//  Rendu — tuiles + verdict d'engagement
// ─────────────────────────────────────────────────────────────────────────
function drawTiles() {
  if (!last) return;
  $('t-pitch').textContent = fmt(last.pitch, 2);
  $('t-gy').textContent = fmt(last.gy, 1);
  $('t-tgt').textContent = fmt(last.tgt, 2);
  $('t-v').textContent = fmt(last.v, 0);
  $('t-x').textContent = fmt(last.x, 0);
  $('t-raw').textContent = fmt(last.rawX, 1) + ' / ' + fmt(last.rawY, 1);

  const st = $('state');
  st.textContent = last.state;
  st.className = 'badge ' + (last.state === 'BAL' ? 'ok' : last.state === 'FALL' ? 'warn' : '');
  const ar = $('armed');
  ar.textContent = last.armed ? 'ARMÉ' : 'désarmé';
  ar.className = 'badge ' + (last.armed ? 'danger' : '');
  const g = $('glt');
  g.textContent = 'glt ' + last.glt;
  g.className = 'badge ' + (last.glt > 0 ? 'warn' : 'ok');

  // Les deux conditions de ré-engagement, séparément : c'est ce qui permet de
  // voir LAQUELLE bloque (le run 17 : pitch à -31° alors qu'il paraissait droit).
  const okP = Math.abs(last.pitch) < RECOVER_LIMIT_DEG;
  const okG = Math.abs(last.gy) < RECOVER_RATE_DEG_S;
  setCond('cond-pitch', okP, fmt(last.pitch, 1) + '°');
  setCond('cond-gyro', okG, fmt(last.gy, 1) + '°/s');

  const v = $('verdict');
  if (last.state === 'BAL') {
    v.textContent = '⚖️ en équilibre';
    v.className = 'verdict ok';
  } else if (okP && okG) {
    v.textContent = '✅ prêt à s\'engager — lâche-le';
    v.className = 'verdict ok';
  } else {
    v.textContent = okP ? '⏳ trop de mouvement' : '⏳ trop incliné pour repartir';
    v.className = 'verdict wait';
  }
}

function setCond(id: string, ok: boolean, val: string) {
  const el = $(id);
  el.className = 'cond ' + (ok ? 'ok' : 'ko');
  (el.querySelector('span') as HTMLElement).textContent = val;
}

// ─────────────────────────────────────────────────────────────────────────
//  Divers
// ─────────────────────────────────────────────────────────────────────────
const fmt = (n: number, d: number) => (n >= 0 ? '+' : '') + n.toFixed(d);

function setLink(on: boolean) {
  const el = $('link');
  el.textContent = on ? (linkKind === 'ble' ? 'connecté (BLE)' : 'connecté (USB)') : 'déconnecté';
  el.className = 'badge ' + (on ? 'ok' : 'off');
  // Un seul transport à la fois : les deux boutons se verrouillent ensemble.
  ($('connect') as HTMLButtonElement).disabled = on;
  ($('connect-ble') as HTMLButtonElement).disabled = on;
}

function logLine(s: string) {
  const el = $('log');
  el.textContent = (el.textContent + '\n' + s).split('\n').slice(-160).join('\n');
  el.scrollTop = el.scrollHeight;
}

// Santé du flux : c'est LE témoin qui dit où ça coince quand rien ne bouge.
function drawRx() {
  const el = $('rx');
  if (!linkKind) { el.textContent = 'pas de lien'; el.className = 'badge off'; return; }
  const age = (performance.now() - lastTeleMs) / 1000;
  if (last && age < 1.5) {
    el.textContent = 'flux ok';
    el.className = 'badge ok';
  } else if (rxBytes > 0) {
    el.textContent = 'rx ' + rxBytes + ' o — stream éteint ?';
    el.className = 'badge warn';
  } else {
    el.textContent = 'rien reçu (0 o)';
    el.className = 'badge danger';
  }
}

function frame() {
  drawAttitude();
  drawChart();
  drawTiles();
  drawRx();
  drawDrive();
  requestAnimationFrame(frame);
}

// --- Câblage UI ---
$('connect').addEventListener('click', connectSerial);
$('connect-ble').addEventListener('click', connectBle);
$('cmdform').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('cmd');
  const v = input.value.trim();
  if (v) { send(v); input.value = ''; }
});
document.querySelectorAll<HTMLButtonElement>('button[data-cmd]').forEach((b) => {
  b.addEventListener('click', () => send(b.dataset.cmd!));
});
buildGains();
// --- Pad de téléguidage ---
document.querySelectorAll<HTMLButtonElement>('.pad .dir').forEach((b) => {
  const dir = b.dataset.dir as Dir | 'stop';
  if (dir === 'stop') {
    b.addEventListener('click', () => driveRelease(true));
    return;
  }
  const release = () => setDir(dir, false);
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // Capture du pointeur : sans elle, glisser le doigt hors du bouton avale le
    // `pointerup` et la direction resterait tenue — donc le robot partirait.
    b.setPointerCapture(e.pointerId);
    setDir(dir, true);
  });
  b.addEventListener('pointerup', release);
  b.addEventListener('pointercancel', release);
  b.addEventListener('lostpointercapture', release);
});
['d-speed', 'd-turn'].forEach((id) => {
  const input = $<HTMLInputElement>(id + '-in');
  const out = $(id);
  const show = () => { out.textContent = input.value; };
  input.addEventListener('input', show);
  show();
});
window.addEventListener('keydown', (e) => driveKey(e, true));
window.addEventListener('keyup', (e) => driveKey(e, false));
// Perdre le focus ou l'onglet, c'est perdre le `keyup` : sans ça, un Alt+Tab en
// plein virage laisserait la touche « tenue » côté page.
window.addEventListener('blur', () => driveRelease(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) driveRelease(true); });

$('record').addEventListener('click', () => {
  recording = !recording;
  $('record').textContent = recording ? '■ Arrêter' : '● Enregistrer';
  $('record').classList.toggle('rec', recording);
  if (recording) recorded.length = 0;
  ($('export') as HTMLButtonElement).disabled = recording || recorded.length === 0;
});
$('export').addEventListener('click', () => {
  const blob = new Blob([recorded.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mochi-run-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log';
  a.click();
  URL.revokeObjectURL(a.href);
});

// Crochet de mise au point : injecter des lignes de stream sans robot branché
// (utile pour revoir l'UI sans monopoliser le port série).
//   __mochiFeed('[tune] pitch=  +1.87 gy=   -9.3 (X= …) … BAL')
(window as any).__mochiFeed = handleLine;

frame();
