// Banc des tracés SVG : chemin → programme de conduite → forme réellement décrite.
// Lance : node scripts/test-path.mjs
//
// LE PRINCIPE, et c'est ce qui rend ce banc utile plutôt que décoratif : on ne
// vérifie pas que le planificateur « rend des nombres ». On REJOUE le programme
// qu'il produit — intégration de (v, ω) pas à pas, exactement ce que fera le
// robot — et on compare la trajectoire obtenue à la forme demandée. Un plan qui
// respecterait tous les plafonds en dessinant autre chose serait attrapé ici, et
// nulle part ailleurs : sur le vrai robot, une forme fausse ressemble à de la
// dérive mécanique, et on irait chercher dans le firmware.
//
// Le contrôle porte sur des invariants de FORME (fermeture, encombrement,
// virage total), pas sur des coordonnées exactes : le lissage du cap arrondit
// délibérément les angles, et l'exiger au millimètre reviendrait à tester que le
// lissage n'a pas lieu.

import { build } from 'esbuild';

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

const { parseSvgPath, scaleAndResample } = await load('../src/robot/svgPath.ts');
const { planPath, PATH_DS_MM } = await load('../src/robot/pathPlan.ts');

const REFRESH_HZ = 10;
const MAX_SPEED = 300;
const MAX_TURN = 120;

/** Rejoue le programme comme le fera le robot : x,y,θ intégrés à 10 Hz. */
function replay(frames) {
  const dt = 1 / REFRESH_HZ;
  let x = 0, y = 0, th = 0, len = 0, maxTurn = 0, maxSpeed = 0;
  const pts = [{ x, y }];
  for (const f of frames) {
    const w = (f.turnDegS * Math.PI) / 180;
    // Le cap tourne pendant le pas : on intègre au milieu, sinon les courbes
    // serrées se ferment mal et on accuserait le planificateur à tort.
    th += w * dt * 0.5;
    x += f.speedMmS * dt * Math.cos(th);
    y += f.speedMmS * dt * Math.sin(th);
    th += w * dt * 0.5;
    len += f.speedMmS * dt;
    maxTurn = Math.max(maxTurn, Math.abs(f.turnDegS));
    maxSpeed = Math.max(maxSpeed, Math.abs(f.speedMmS));
    pts.push({ x, y });
  }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return {
    pts, len, maxTurn, maxSpeed,
    largeur: Math.max(...xs) - Math.min(...xs),
    hauteur: Math.max(...ys) - Math.min(...ys),
    capTotalDeg: (th * 180) / Math.PI,
    ecartFermeture: Math.hypot(x - pts[0].x, y - pts[0].y),
  };
}

function tracer(nom, d, sizeCm, attendu) {
  const flat = parseSvgPath(d);
  const points = scaleAndResample(flat, sizeCm * 10, PATH_DS_MM);
  const plan = planPath(points, { cruiseMmS: MAX_SPEED * 0.75, maxTurnDegS: MAX_TURN, refreshHz: REFRESH_HZ });
  const r = replay(plan.frames);

  const problemes = [];
  // 1. Les plafonds physiques du robot, jamais depasses.
  if (r.maxTurn > MAX_TURN + 0.5) problemes.push(`rotation ${r.maxTurn.toFixed(0)} > ${MAX_TURN} deg/s`);
  if (r.maxSpeed > MAX_SPEED + 0.5) problemes.push(`vitesse ${r.maxSpeed.toFixed(0)} > ${MAX_SPEED} mm/s`);
  // 2. Le programme part de l'arret et y revient (sinon le robot se cabre).
  if (plan.frames[0].speedMmS > 1) problemes.push('ne demarre pas a l arret');
  if (plan.frames[plan.frames.length - 1].speedMmS > 60) problemes.push('ne finit pas ralenti');
  // 3. Encombrement : la forme fait bien la taille demandee (tolerance large,
  //    l'arrondi des angles rogne un peu).
  const grand = Math.max(r.largeur, r.hauteur) / 10;
  if (Math.abs(grand - sizeCm) > sizeCm * 0.25) problemes.push(`taille ${grand.toFixed(0)} cm au lieu de ${sizeCm}`);
  // 4. Invariants propres a la forme.
  if (attendu.ferme !== undefined) {
    const seuil = sizeCm * 10 * 0.2;
    const ferme = r.ecartFermeture < seuil;
    if (ferme !== attendu.ferme) problemes.push(`fermeture ${r.ecartFermeture.toFixed(0)} mm (attendu ${attendu.ferme ? 'fermee' : 'ouverte'})`);
  }
  if (attendu.capDeg !== undefined && Math.abs(r.capTotalDeg - attendu.capDeg) > 45) {
    problemes.push(`cap total ${r.capTotalDeg.toFixed(0)} au lieu de ~${attendu.capDeg}`);
  }

  const ok = problemes.length === 0;
  console.log(
    `${ok ? 'OK   ' : 'ECHEC'} ${nom.padEnd(22)} ${(plan.lengthMm / 10).toFixed(0).padStart(3)} cm en ${(plan.durationMs / 1000).toFixed(1).padStart(4)} s ` +
      `| ${r.maxSpeed.toFixed(0).padStart(3)} mm/s ${r.maxTurn.toFixed(0).padStart(3)} deg/s ` +
      `| Rmin ${Number.isFinite(plan.minRadiusMm) ? plan.minRadiusMm.toFixed(0).padStart(4) + ' mm' : ' droit'} ` +
      `| ${(r.largeur / 10).toFixed(0)}x${(r.hauteur / 10).toFixed(0)} cm` +
      (ok ? '' : `\n      -> ${problemes.join(' ; ')}`),
  );
  return ok;
}

let echecs = 0;
const t = (...a) => { if (!tracer(...a)) echecs++; };

// Un carre : ferme. ATTENTION au cap cumule -- parcouru UNE fois depuis un sommet,
// il ne compte que TROIS virages : on arrive au quatrieme, on n'y tourne pas.
// (Ma premiere attente disait 360 et c'est le TEST qui avait tort, pas le code.)
t('carre', 'M0,0 L100,0 L100,100 L0,100 Z', 50, { ferme: true, capDeg: -270 });
// Un cercle par deux arcs : ferme, un tour complet.
t('cercle', 'M0,50 A50,50 0 1 1 100,50 A50,50 0 1 1 0,50', 50, { ferme: true, capDeg: -360 });
// Un huit : revient au depart, mais cap cumule nul (les deux boucles s'annulent).
t('huit', 'M50,0 C100,0 100,50 50,50 C0,50 0,100 50,100 C100,100 100,50 50,50 C0,50 0,0 50,0', 50,
  { ferme: true, capDeg: 0 });
// Une vague de TROIS bosses : ouverte, et elle ne revient PAS au cap initial --
// chaque bosse fait +/-116 deg et le compte est impair. Attente verifiee a la main
// sur les tangentes des quadratiques ; j'avais ecrit 0 par reflexe.
t('vague', 'M0,0 q25,-40 50,0 t50,0 t50,0', 60, { ferme: false, capDeg: -116 });
// Un triangle : ferme.
t('triangle', 'M0,0 L100,0 L50,86 Z', 40, { ferme: true, capDeg: -240 });
// Une ligne droite : aucune rotation.
t('ligne droite', 'M0,0 L100,0', 40, { ferme: false, capDeg: 0 });
// Une spirale : longue, ouverte, plusieurs tours.
t('spirale', 'M50,50 A10,10 0 1 1 60,50 A20,20 0 1 0 40,50 A30,30 0 1 1 70,50', 40, { ferme: false });

// --- Refus attendus : un `d` illisible ne doit pas produire un tracé au hasard ---
for (const [nom, d] of [['vide', ''], ['sans commande', '10 20 30'], ['commande inconnue', 'M0,0 X50']]) {
  let leve = false;
  try { scaleAndResample(parseSvgPath(d), 400, PATH_DS_MM); } catch { leve = true; }
  if (!leve) { echecs++; console.log(`ECHEC refus ${nom} : accepte alors qu'il ne devrait pas`); }
  else console.log(`OK    refus ${nom}`);
}

console.log(echecs === 0 ? '\nTOUS LES TRACES PASSENT' : `\n${echecs} TRACE(S) EN ECHEC`);
process.exit(echecs === 0 ? 0 : 1);
