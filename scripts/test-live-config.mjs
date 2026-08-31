// Le serveur ACCEPTE-T-IL la config Live que l'application envoie ?
// Lance : node scripts/test-live-config.mjs
//
// POURQUOI CE BANC EXISTE. La config part au serveur au moment du `connect` :
// s'il refuse un champ, la session ne s'ouvre PAS. Pas de dégradation, pas de
// repli — Mochi est simplement muet, sur le téléphone, hors de portée du
// débogueur. C'est le seul réglage de tout le projet dont une erreur casse
// l'application entière, et il ne se voit qu'à l'exécution : TypeScript valide la
// FORME (le SDK connaît le champ), pas le fait que le service l'accepte pour ce
// modèle-là. `contextWindowCompression` est arrivé comme ça — ajouté sur la foi
// de la doc, sans qu'aucun typage ne puisse dire s'il passerait.
//
// Ce banc envoie le bloc RÉEL (cf. src/agent/liveConfig.ts, extrait de live.ts
// pour cette raison), attend `setupComplete`, et repart. Une poignée de secondes.

import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { build } from 'esbuild';

delete process.env.GOOGLE_API_KEY;
delete process.env.GEMINI_API_KEY;
const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
const apiKey = env.match(/^VITE_GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!apiKey) throw new Error('VITE_GEMINI_API_KEY absent de .env.local');

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
const { LIVE_MODEL, liveSessionConfig } = await load('../src/agent/liveConfig.ts');
const { toGeminiTools } = await load('../src/agent/gemini.ts');
const { DEFAULT_PERSONA, buildSystemInstruction } = await load('../src/agent/persona.ts');

const config = liveSessionConfig(buildSystemInstruction(DEFAULT_PERSONA), 'Zephyr', toGeminiTools());

console.log(`modèle   ${LIVE_MODEL}`);
console.log(`champs   ${Object.keys(config).join(', ')}`);
console.log(
  `compression ${config.contextWindowCompression ? JSON.stringify(config.contextWindowCompression) : '(ABSENTE)'}`,
);

// ⚠️ ON ATTEND UN SIGNAL POSITIF, PAS L'ABSENCE D'ERREUR. `connect` peut très bien
// rendre un objet session puis voir la socket se fermer un instant plus tard, côté
// serveur, sur un champ refusé. Sans attendre `setupComplete`, ce banc afficherait
// « OK » sur une session mort-née — précisément le genre de faux vert qui rend un
// banc pire qu'inutile.
let regler;
const verdict = new Promise((r) => (regler = r));
const minuteur = setTimeout(() => regler({ ok: false, why: 'aucun setupComplete en 20 s' }), 20000);

let session = null;
try {
  session = await new GoogleGenAI({ apiKey }).live.connect({
    model: LIVE_MODEL,
    callbacks: {
      onmessage: (m) => {
        if (m.setupComplete) regler({ ok: true });
      },
      onerror: (e) => regler({ ok: false, why: e.message || 'erreur de session' }),
      onclose: (e) =>
        regler({ ok: false, why: `fermée par le serveur (${[e?.code, e?.reason].filter(Boolean).join(' ')})` }),
    },
    config,
  });
} catch (e) {
  regler({ ok: false, why: `connexion refusée : ${e.message}` });
}

const { ok, why } = await verdict;
clearTimeout(minuteur);
try {
  session?.close();
} catch {
  /* déjà fermée */
}

console.log(ok ? '\nOK — le serveur accepte la config.' : `\nREFUSÉE — ${why}`);
process.exit(ok ? 0 : 1);
