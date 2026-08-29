// Banc de la détection de parole locale (src/audio/vad.ts), hors navigateur.
// Lance : node scripts/test-vad.mjs
//
// POURQUOI CE BANC EXISTE. Ce détecteur tourne dans un téléphone posé sur un
// robot : impossible d'y observer quoi que ce soit, et ses deux pannes se
// ressemblent trait pour trait vues du fauteuil — « il ne réagit pas » peut
// vouloir dire « il n'entend rien » comme « il croit que tout est de la parole ».
// Il a déjà attrapé DEUX erreurs de conception que la lecture n'avait pas vues :
//   1. un plancher de bruit en MOYENNE, que l'AGC faisait monter jusqu'au niveau
//      de la voix → détecteur muet ;
//   2. un plancher mis à jour SEULEMENT hors parole → dans une pièce bruyante il
//      n'est jamais mis à jour, puisqu'on n'est jamais « hors parole ».
//
// HORLOGE VIRTUELLE : on remplace Date.now() et on avance de 40 ms par paquet
// (la cadence du worklet). Le banc est donc instantané ET déterministe — un test
// qui dépend de vrais minuteurs passe une fois sur deux et ne prouve rien.

import { build } from 'esbuild';

let clock = 1_000_000;
Date.now = () => clock;

// Le module est en TypeScript : on le transpile en mémoire plutôt que d'ajouter
// une étape de build à retenir.
const bundle = await build({
  entryPoints: [new URL('../src/audio/vad.ts', import.meta.url).pathname.replace(/^\//, '')],
  bundle: true,
  format: 'esm',
  write: false,
  logLevel: 'error',
});
const { LocalVad } = await import(
  'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64')
);

// Générateur reproductible : un banc aléatoire qui passe une fois sur deux ment.
let seed = 42;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

function scenario(nom, fond, voix, { secFond = 4, secVoix = 1, secApres = 2 } = {}) {
  const ev = [];
  const vad = new LocalVad({
    onSpeechStart: () => ev.push('DEBUT'),
    onSpeechEnd: (d) => ev.push(`FIN(${Math.round(d)}ms)`),
  });
  const frames = (n, gen) => {
    for (let i = 0; i < n; i++) {
      vad.push(gen());
      clock += 40;
    }
  };
  frames(secFond * 25, fond);
  const avant = vad.debug();
  if (voix) frames(secVoix * 25, voix);
  frames(secApres * 25, fond);
  return { nom, vad, plancher: +avant.floor.toFixed(4), seuil: +avant.onThreshold.toFixed(4), ev };
}

// Niveaux = crête 0..1 APRÈS le gain micro (MicCapture insère son boost avant le
// worklet, donc les seuils du détecteur vivent dans cette échelle-là).
const calme = () => 0.004 + rnd() * 0.004; // pièce silencieuse
const pompe = () => 0.02 + rnd() * 0.04; // AGC qui remonte le bruit entre les mots
const fortBruit = () => 0.05 + rnd() * 0.05; // pièce franchement bruyante

const cas = [
  ['A. voix faible + AGC qui pompe', pompe, () => 0.1 + rnd() * 0.05, true],
  ['B. voix faible, pièce calme', calme, () => 0.06 + rnd() * 0.03, true],
  ['C. voix normale', calme, () => 0.35 + rnd() * 0.2, true],
  ['D. bruit qui pompe, AUCUNE parole', pompe, null, false],
  ['E. silence total', calme, null, false],
  ['F. pièce bruyante, AUCUNE parole', fortBruit, null, false],
  ['G. pièce bruyante + voix forte', fortBruit, () => 0.4 + rnd() * 0.2, true],
];

let echecs = 0;
for (const [nom, fond, voix, attendParole] of cas) {
  const r = scenario(nom, fond, voix);
  const trace = r.ev.join(' > ') || '(rien)';
  const ok = attendParole
    ? trace.includes('DEBUT') && trace.includes('FIN')
    : !trace.includes('DEBUT');
  if (!ok) echecs++;
  console.log(
    `${ok ? 'OK   ' : 'ECHEC'} ${nom.padEnd(36)} plancher=${String(r.plancher).padEnd(7)} seuil=${String(r.seuil).padEnd(7)} -> ${trace}`,
  );
}

// Auto-réparation : un bruit continu FORT ouvre forcément la détection (il
// ressemble à de la parole), mais elle ne doit pas y rester bloquée — sinon le
// visage garde son air attentif pour toujours et plus aucune fin de phrase n'est
// vue. Après la fermeture d'office, le plancher se recale sur ce bruit, qui
// redevient donc du bruit : UNE seule fermeture est le bon résultat, pas un cycle.
{
  const ev = [];
  const vad = new LocalVad({ onSpeechStart: () => ev.push('DEBUT'), onSpeechEnd: () => ev.push('FIN') });
  for (let i = 0; i < 100; i++) {
    vad.push(calme());
    clock += 40;
  }
  for (let i = 0; i < 25 * 30; i++) {
    vad.push(0.3 + rnd() * 0.2);
    clock += 40;
  }
  const ok = ev.includes('FIN') && !vad.speaking;
  if (!ok) echecs++;
  console.log(
    `${ok ? 'OK   ' : 'ECHEC'} ${'H. bruit continu 30 s (auto-réparation)'.padEnd(36)} -> ${ev.join(' > ')} | écoute=${vad.speaking}`,
  );
}

console.log(echecs === 0 ? '\nTOUS LES CAS PASSENT' : `\n${echecs} CAS EN ECHEC`);
process.exit(echecs === 0 ? 0 : 1);
