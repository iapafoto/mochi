// Le modèle sait-il appeler DEUX FOIS la même fonction dans un seul tour ?
// Lance : node scripts/test-multicall.mjs
//
// POURQUOI CE BANC EXISTE. Fusionner `forward`/`backward` en un `move(cm)` signé,
// et `nod`/`bow`/`wiggle` en un `gesture(kind)`, simplifie la liste d'outils —
// mais déplace une difficulté sur le modèle : ce qui demandait DEUX fonctions
// différentes (« avance puis recule ») demande désormais DEUX APPELS DE LA MÊME.
// Les modèles y sont moins spontanés, et l'échec serait silencieux : un seul
// mouvement au lieu de deux, sans erreur nulle part.
//
// On envoie donc les VRAIES déclarations de l'app (pas une maquette) et on compte
// les appels obtenus. Une régression ici annulerait l'enchaînement construit dans
// la file de déplacements — la fonctionnalité la plus visible du 30/08.

import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { build } from 'esbuild';

delete process.env.GOOGLE_API_KEY;
delete process.env.GEMINI_API_KEY;
const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const apiKey = env.match(/^VITE_GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!apiKey) throw new Error('VITE_GEMINI_API_KEY absent de .env.local');

// Les déclarations RÉELLES, converties comme le fait l'app.
const load = async (rel) => {
  const out = await build({
    entryPoints: [new URL(rel, import.meta.url).pathname.replace(/^\//, '')],
    bundle: true,
    format: 'esm',
    write: false,
    logLevel: 'error',
  });
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
};
const { toGeminiTools } = await load('../src/agent/gemini.ts');
const { DEFAULT_PERSONA, buildSystemInstruction } = await load('../src/agent/persona.ts');

const ai = new GoogleGenAI({ apiKey });
// ⚠️ LE MODELE DE TEXTE, PAS CELUI DU LIVE. `gemini-3.1-flash-live-preview` ne
// repond pas a generateContent — on ne peut donc pas l'interroger ainsi. C'est un
// PROXY : meme famille, memes declarations d'outils, mais rien ne garantit que le
// modele Live se comporte a l'identique. Un echec ici serait alarmant ; un succes
// est un bon signe, pas une preuve.
const MODEL = 'gemini-2.5-flash';
const tools = toGeminiTools();

// L'app accroche l'etat du corps au prompt (cf. startLive). Le banc doit envoyer
// EXACTEMENT ce que le modele recevra, sinon on mesure un prompt fictif.
const SYS = `${buildSystemInstruction(DEFAULT_PERSONA)}

À cet instant : ton corps est connecté, ses moteurs sont ALLUMÉS, et tu es debout.`;

// ⚠️ CE QUE CE BANC PEUT ET NE PEUT PAS DIRE. Il interroge le modele de TEXTE, seul
// joignable par generateContent ; le vrai chemin est le modele Live, qui a son
// propre comportement d'appel d'outils. Un echec ici merite d'etre regarde, un
// succes ne prouve rien sur la conversation reelle. Et le free tier est limite au
// tour par minute ET au tour par jour : la liste reste donc COURTE, sur les seuls
// cas ou une regression serait invisible autrement.
const CAS = [
  // [demande, fonction attendue, nombre d'appels attendus]
  // Les deux fusions : une distance signee, et un enum de gestes.
  ['Avance de 40 cm.', 'move', 1],
  ['Recule de 25 cm.', 'move', 1],
  ['Fais une reverence.', 'gesture', 1],
  // Repeter LA MEME fonction dans un tour — ce que la fusion a rendu necessaire.
  ['Hoche la tete, puis fais une reverence.', 'gesture', 2],
];

// ⚠️ CADENCE VOLONTAIREMENT PRUDENTE. Le plafond exact du free tier bouge avec les
// ajustements de Google (la doc annonce 15 requetes/minute pour la famille Flash,
// plus un plafond journalier) : on ne le code donc pas en dur, on reste largement
// dessous. 13 s = ~4,6 requetes/minute, sur la bonne rive quel que soit le chiffre
// du jour. Sans pause, la moitie du banc revient en 429 et on lit un quota epuise
// comme un echec du modele — le faux diagnostic qu'un banc doit rendre impossible.
//
// ⚠️ ET CE PLAFOND-LA NE CONCERNE QUE CE BANC. Il interroge generateContent, une
// requete HTTP par cas. Le vrai Mochi parle par ai.live.connect : UNE socket
// ouverte, et chaque phrase y transite sans etre une requete de plus. Un quota
// « par requete » ne peut donc pas expliquer un silence en pleine conversation.
const PAUSE_MS = 13000;
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

let echecs = 0;
let mesures = 0;
let premier = true;
for (const [demande, fn, attendu] of CAS) {
  if (!premier) await dormir(PAUSE_MS);
  premier = false;
  // ⚠️ REPRENDRE SUR 503/429. Sans ca on lit « modele surcharge » ou « quota
  // epuise » comme un refus du modele — c'est-a-dire qu'on tire une conclusion sur
  // le prompt a partir d'un incident d'infrastructure. Exactement le faux
  // diagnostic qu'un banc doit rendre impossible.
  let appels = null;
  for (let essai = 0; essai < 3 && appels === null; essai++) {
    try {
      const r = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: 'user', parts: [{ text: demande }] }],
        config: { tools, systemInstruction: SYS },
      });
      appels = r.functionCalls ?? [];
    } catch (e) {
      const transitoire = /503|429|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(e.message);
      if (!transitoire || essai === 2) {
        console.log(`INDISPONIBLE « ${demande} » -> ${transitoire ? 'API indisponible' : e.message}`);
        break;
      }
      await dormir(PAUSE_MS);
    }
  }
  if (appels === null) continue; // ni succes ni echec : on ne conclut rien
  mesures++;
  const cibles = appels.filter((c) => c.name === fn);
  const ok = cibles.length >= attendu;
  if (!ok) echecs++;
  const resume = appels.map((c) => `${c.name}(${JSON.stringify(c.args)})`).join(' + ') || '(aucun)';
  console.log(`${ok ? 'OK   ' : 'ECHEC'} « ${demande} »`);
  console.log(`        attendu ${attendu}x ${fn} · obtenu ${cibles.length}x · ${resume}`);
}

// ⚠️ « Aucun échec » n'est PAS « tout va bien » quand rien n'a pu tourner. Un banc
// qui annonce le succès sur zéro mesure est pire qu'un banc absent : il rassure.
if (mesures === 0) {
  console.log('\nAUCUNE MESURE — API indisponible. Le banc ne dit rien, ni dans un sens ni dans l’autre.');
  process.exit(2);
}
console.log(
  echecs === 0
    ? `\nTOUS LES CAS PASSENT (${mesures}/${CAS.length} mesures)`
    : `\n${echecs} CAS EN ECHEC sur ${mesures} mesures`,
);
process.exit(echecs === 0 ? 0 : 1);
