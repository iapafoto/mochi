// Chemin SVG → polyligne, dans le plan du sol.
//
// POURQUOI DU SVG PLUTÔT QU'UN VOCABULAIRE MAISON. Ce n'est pas une coquetterie :
// c'est la notation de forme que les modèles écrivent le mieux, de très loin. Leur
// demander « M0,0 C40,0 40,60 0,60 Z » donne une courbe juste du premier coup, là
// où une liste d'arcs en degrés et millimètres se remplit d'à-peu-près.
//
// ⚠️ CE QUE LE CHEMIN DÉCRIT ICI, C'EST UNE FORME, PAS UNE POSITION. Le robot n'a
// aucun moyen de savoir où il est : l'odométrie ne vaut qu'à l'arrêt et debout (cf.
// Balance.h), et en courbe elle dérive. On trace donc la forme À PARTIR D'OÙ IL EST
// ET DANS LA DIRECTION OÙ IL REGARDE — le point de départ et l'orientation du
// chemin sont ignorés. Promettre du XY absolu serait promettre une précision que
// cette machine ne peut pas tenir, et la trahison serait silencieuse.
//
// Sous-ensemble accepté : M/m L/l H/h V/v C/c S/s Q/q T/t A/a Z/z. Assez pour tout
// ce qu'on veut dessiner par terre ; le reste (courbes de niveau, remplissages)
// n'a aucun sens pour un robot.

export interface Point {
  x: number;
  y: number;
}

/** Résultat de la lecture d'un `d` : la forme échantillonnée, en unités SVG. */
export interface FlatPath {
  points: Point[];
  /** Le chemin se referme-t-il (Z) ? Utile pour lisser le cap en boucle. */
  closed: boolean;
}

/** Nombre de points par courbe, rapporté à sa taille (cf. flatten). */
const SAMPLES_PER_DIAGONAL = 500;

/**
 * Lit un attribut `d` et rend la polyligne correspondante.
 *
 * Lève une erreur sur commande inconnue plutôt que de l'ignorer : un `d` mal
 * compris tracerait une forme fausse en silence, et sur un robot qui roule
 * vraiment on préfère un refus explicite.
 */
export function parseSvgPath(d: string): FlatPath {
  const tokens = tokenize(d);
  if (tokens.length === 0) throw new Error('chemin vide');

  // Passe 1 : diagonale approchée, pour choisir une finesse d'échantillonnage
  // proportionnée à la forme (les unités d'un `d` sont arbitraires).
  const diag = roughDiagonal(tokens);
  const step = Math.max(1e-6, diag / SAMPLES_PER_DIAGONAL);

  const pts: Point[] = [];
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  // Dernier point de contrôle, pour les formes abrégées S et T (qui reflètent le
  // précédent). Deux mémoires distinctes : S reflète un contrôle cubique, T un
  // quadratique, et les mélanger donnerait des courbes subtilement fausses.
  let lastCubicCtrl: Point | null = null;
  let lastQuadCtrl: Point | null = null;
  let closed = false;

  const push = (p: Point) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) pts.push(p);
  };

  let i = 0;
  let cmd = '';
  while (i < tokens.length) {
    const t = tokens[i];
    if (typeof t === 'string') {
      cmd = t;
      i++;
    } else if (!cmd) {
      throw new Error('le chemin doit commencer par une commande (M)');
    }
    // Une commande peut être suivie de plusieurs jeux de paramètres ; après un M
    // implicite, les suivants sont des L (règle SVG).
    const rel = cmd === cmd.toLowerCase();
    const num = (): number => {
      const v = tokens[i++];
      if (typeof v !== 'number') throw new Error(`paramètre manquant pour « ${cmd} »`);
      return v;
    };
    const abs = (x: number, y: number): Point => (rel ? { x: cur.x + x, y: cur.y + y } : { x, y });

    switch (cmd.toUpperCase()) {
      case 'M': {
        cur = abs(num(), num());
        start = cur;
        push(cur);
        cmd = rel ? 'l' : 'L'; // paramètres suivants = lignes
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case 'L': {
        cur = abs(num(), num());
        push(cur);
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case 'H': {
        const x = num();
        cur = rel ? { x: cur.x + x, y: cur.y } : { x, y: cur.y };
        push(cur);
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case 'V': {
        const y = num();
        cur = rel ? { x: cur.x, y: cur.y + y } : { x: cur.x, y };
        push(cur);
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case 'C': {
        const c1 = abs(num(), num());
        const c2 = abs(num(), num());
        const end = abs(num(), num());
        sampleCubic(cur, c1, c2, end, step, push);
        lastCubicCtrl = c2;
        lastQuadCtrl = null;
        cur = end;
        break;
      }
      case 'S': {
        const c1 = lastCubicCtrl ? reflect(lastCubicCtrl, cur) : cur;
        const c2 = abs(num(), num());
        const end = abs(num(), num());
        sampleCubic(cur, c1, c2, end, step, push);
        lastCubicCtrl = c2;
        lastQuadCtrl = null;
        cur = end;
        break;
      }
      case 'Q': {
        const c = abs(num(), num());
        const end = abs(num(), num());
        sampleQuad(cur, c, end, step, push);
        lastQuadCtrl = c;
        lastCubicCtrl = null;
        cur = end;
        break;
      }
      case 'T': {
        // Annoté : `c` se lit depuis `lastQuadCtrl`, à qui on l'assigne deux lignes
        // plus bas. Sans le type explicite, l'inférence tourne en rond et retombe
        // sur `any` — silencieusement, donc en désactivant tout contrôle ici.
        const c: Point = lastQuadCtrl ? reflect(lastQuadCtrl, cur) : cur;
        const end = abs(num(), num());
        sampleQuad(cur, c, end, step, push);
        lastQuadCtrl = c;
        lastCubicCtrl = null;
        cur = end;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const end = abs(num(), num());
        sampleArc(cur, rx, ry, rot, large, sweep, end, step, push);
        cur = end;
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      case 'Z': {
        push(start);
        cur = start;
        closed = true;
        lastCubicCtrl = lastQuadCtrl = null;
        break;
      }
      default:
        throw new Error(`commande « ${cmd} » non gérée`);
    }
  }

  if (pts.length < 2) throw new Error('chemin trop court (il faut au moins un trait)');
  return { points: pts, closed };
}

/** Découpe un `d` en commandes (lettres) et nombres. */
function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) out.push(m[1] ?? parseFloat(m[2]));
  return out;
}

/** Diagonale grossière depuis TOUS les nombres du chemin (points et contrôles). */
function roughDiagonal(tokens: (string | number)[]): number {
  // Les nombres arrivent par couples (x, y) sauf pour H/V/A ; c'est approximatif
  // et ça suffit — on ne cherche qu'un ordre de grandeur pour la finesse.
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of tokens) {
    if (typeof t !== 'number') continue;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const span = hi - lo;
  return Number.isFinite(span) && span > 0 ? span * Math.SQRT2 : 1;
}

function reflect(ctrl: Point, about: Point): Point {
  return { x: 2 * about.x - ctrl.x, y: 2 * about.y - ctrl.y };
}

/** Nombre d'échantillons pour une courbe, d'après son polygone de contrôle. */
function countFor(step: number, ...pts: Point[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return Math.max(4, Math.min(2000, Math.ceil(len / step)));
}

function sampleCubic(p0: Point, c1: Point, c2: Point, p1: Point, step: number, push: (p: Point) => void): void {
  const n = countFor(step, p0, c1, c2, p1);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p1.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p1.y,
    });
  }
}

function sampleQuad(p0: Point, c: Point, p1: Point, step: number, push: (p: Point) => void): void {
  const n = countFor(step, p0, c, p1);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    push({
      x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
      y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
    });
  }
}

/**
 * Arc elliptique SVG : passage de la forme « point d'arrivée » à la forme
 * « centre », puis échantillonnage. C'est l'algorithme de l'annexe F.6.5 de la
 * spec SVG — recopié, pas inventé.
 */
function sampleArc(
  p0: Point,
  rx: number,
  ry: number,
  rotDeg: number,
  large: boolean,
  sweep: boolean,
  p1: Point,
  step: number,
  push: (p: Point) => void,
): void {
  // Rayon nul = simple segment (règle de la spec).
  if (rx === 0 || ry === 0) {
    push(p1);
    return;
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx2 = (p0.x - p1.x) / 2;
  const dy2 = (p0.y - p1.y) / 2;
  const x1 = cosP * dx2 + sinP * dy2;
  const y1 = -sinP * dx2 + cosP * dy2;

  // Rayons trop petits pour joindre les deux points : on les agrandit (spec).
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const sign = large === sweep ? -1 : 1;
  const num = Math.max(0, rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1);
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = sign * Math.sqrt(den === 0 ? 0 : num / den);
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cosP * cx1 - sinP * cy1 + (p0.x + p1.x) / 2;
  const cy = sinP * cx1 + cosP * cy1 + (p0.y + p1.y) / 2;

  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, len === 0 ? 1 : dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta0 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let sweepAngle = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  else if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

  const n = Math.max(4, Math.min(2000, Math.ceil((Math.abs(sweepAngle) * Math.max(rx, ry)) / step)));
  for (let i = 1; i <= n; i++) {
    const th = theta0 + (sweepAngle * i) / n;
    const ct = Math.cos(th);
    const st = Math.sin(th);
    push({
      x: cosP * rx * ct - sinP * ry * st + cx,
      y: sinP * rx * ct + cosP * ry * st + cy,
    });
  }
}

/**
 * Met la forme à l'échelle voulue (plus grande dimension = `sizeMm`) et la
 * rééchantillonne à pas d'abscisse curviligne constant.
 *
 * Le pas constant n'est pas cosmétique : tout ce qui suit (cap, courbure, profil
 * de vitesse) suppose des points régulièrement espacés. Une polyligne issue d'un
 * aplatissement ne l'est pas — les courbes y sont denses et les droites creuses —
 * et la courbure calculée dessus serait fausse là où elle compte le plus.
 */
export function scaleAndResample(path: FlatPath, sizeMm: number, dsMm: number): Point[] {
  const xs = path.points.map((p) => p.x);
  const ys = path.points.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const span = Math.max(w, h);
  if (!(span > 0)) throw new Error('chemin de taille nulle');
  const k = sizeMm / span;
  // ⚠️ L'axe Y est INVERSÉ. En SVG il descend ; au sol on veut que « vers le haut
  // du dessin » soit « vers l'avant du robot ». Sans ça toutes les formes sont
  // tracées en miroir, ce qui ne se voit sur aucune forme symétrique — donc pas
  // sur le carré ni le cercle qu'on essaie en premier.
  const scaled = path.points.map((p) => ({ x: p.x * k, y: -p.y * k }));

  const out: Point[] = [scaled[0]];
  let carry = 0;
  for (let i = 1; i < scaled.length; i++) {
    const a = scaled[i - 1];
    const b = scaled[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (seg <= 0) continue;
    let d = dsMm - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      d += dsMm;
    }
    carry = seg - (d - dsMm);
  }
  const last = scaled[scaled.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > dsMm * 0.5) out.push(last);
  if (out.length < 3) throw new Error('chemin trop court une fois à l’échelle');
  return out;
}
