#version 300 es
precision highp float;

// Visage procédural SDF de Mochi.
// Un seul quad plein écran ; toute la géométrie (yeux, sourcils, bouche) est
// dessinée à partir des uniforms de FaceState. Aucun sprite.
//
// Géométrie : réactive aux émotions (yeux/paupières/regard/pupille, sourcils,
// bouche, inclinaison de la tête).
// Style : rendu « demoscene » CRT — phosphore, halo exponentiel, aberration
// chromatique (split RVB), glitch, scanlines et vignette.

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uAmbient; // teinte d'ambiance pilotée par l'humeur (0 = neutre)

// Canaux FaceState (voir faceState.ts).
uniform float uEyelidL;
uniform float uEyelidR;
uniform float uGazeX;
uniform float uGazeY;
uniform float uPupil;
uniform float uBrowL;
uniform float uBrowR;
uniform float uFurrow;
uniform float uMouthOpen;
uniform float uMouthCurve;
uniform float uHeadTilt;

out vec4 fragColor;

// --- Palette phosphore / néon ---
const vec3 EYE_COL = vec3(0.35, 0.95, 1.0);  // cyan phosphore
const vec3 SHINE = vec3(1.0);
const vec3 ACCENT = vec3(1.0); //, 0.35, 0.72);   // rose néon (sourcils / bouche)

float sdCircle(vec2 p, float r) { return length(p) - r; }

// Disque tronqué par une ligne horizontale à la hauteur h (le haut est coupé).
// h = r : disque complet ; h = 0 : moitié basse ; h = -r : disque vide.
// Donne un bord de paupière net et courbe (au lieu d'un max() dur).
float sdCutDisk(in vec2 p, in float r, in float h) {
  float w = sqrt(r*r - h*h); // constante pour une forme donnée
  p.x = abs(p.x);
  float s = max((h-r)*p.x*p.x + w*w*(h+r-2.0*p.y), h*p.x - w*p.y);
  return (s < 0.0) ? length(p) - r :
         (p.x < w) ? h - p.y       :
                     length(p - vec2(w, h));
}

// Capsule (segment épais) entre a et b, rayon r.
float sdSegment(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}
float dot2(in vec2 v) { return dot(v, v); }

// Bézier quadratique (Inigo Quilez) : renvoie vec2(distance, t) où t ∈ [0,1]
// est le paramètre du point le plus proche sur la courbe. `t` permet de moduler
// l'épaisseur le long du tracé (0 = extrémité A, 1 = extrémité C).
vec2 sdBezierT( in vec2 pos, in vec2 A, in vec2 B, in vec2 C )
{
    vec2 a = B - A;
    vec2 b = A - 2.0*B + C;
    vec2 c = a * 2.0;
    vec2 d = A - pos;
    float kk = 1.0/dot(b,b);
    float kx = kk * dot(a,b);
    float ky = kk * (2.0*dot(a,a)+dot(d,b)) / 3.0;
    float kz = kk * dot(d,a);
    float res = 0.0;
    float tRes = 0.0;
    float p = ky - kx*kx;
    float p3 = p*p*p;
    float q = kx*(2.0*kx*kx-3.0*ky) + kz;
    float h = q*q + 4.0*p3;
    if( h >= 0.0)
    {
        h = sqrt(h);
        vec2 x = (vec2(h,-h)-q)/2.0;
        vec2 uv = sign(x)*pow(abs(x), vec2(1.0/3.0));
        float t = clamp( uv.x+uv.y-kx, 0.0, 1.0 );
        res = dot2(d + (c + b*t)*t);
        tRes = t;
    }
    else
    {
        float z = sqrt(-p);
        float v = acos( q/(p*z*2.0) ) / 3.0;
        float m = cos(v);
        float n = sin(v)*1.732050808;
        vec3  t = clamp(vec3(m+m,-n-m,n-m)*z-kx,0.0,1.0);
        float d1 = dot2(d+(c+b*t.x)*t.x);
        float d2 = dot2(d+(c+b*t.y)*t.y);
        // On garde la racine la plus proche ET son t (la 3e ne peut pas gagner).
        if (d1 < d2) { res = d1; tRes = t.x; }
        else         { res = d2; tRes = t.y; }
    }
    return vec2( sqrt(res), tRes );
}

// Distance signée seule (délègue à sdBezierT).
float sdBezier( in vec2 pos, in vec2 A, in vec2 B, in vec2 C )
{
    return sdBezierT(pos, A, B, C).x;
}
// Remplissage anti-aliasé : ~1 à l'intérieur (d<0), 0 dehors.
float fill(float d) {
  float e = fwidth(d) * 1.2;
  return smoothstep(e, -e, d);
}

// Halo phosphore exponentiel au-delà du bord (style demoscene).
float glow(float d, float width) {
  return exp(-max(d, 0.0) / width);
}

float hash(float n) { return fract(sin(n) * 43758.5453123); }

// Bruit 2D pseudo-aléatoire (pour les bandes / blocs de glitch).
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float sdBox( in vec2 p, in vec2 b )
{
    vec2 d = abs(p)-b;
    return length(max(d,0.0)) + min(max(d.x,d.y),0.0);
}

mat2 rot(float a) {
	return mat2(cos(a), -sin(a), sin(a), cos(a));
}

// Dessine un œil. Retourne l'accumulation couleur ajoutée.
vec3 eye(vec2 p, vec2 center, float eyelid, vec2 gaze, float pupil) {
  vec2 e = p - center;
  e *= rot(sign(p.x)*uAmbient.x);
  float r = 0.155;

  // Corps de l'œil : disque tronqué par la paupière supérieure.
  // h descend de r (ouvert) à -r (fermé) quand la paupière tombe.
  float h = clamp(r * (1.0 - 2.0 * eyelid), -r, r);
  
  float eyeD = sdBox( e + vec2(0,0), vec2(r,min(r,h+h))-r*.4) - r*.4;
  //float eyeD = sdCutDisk(-e, r, -h);
  float mask = fill(eyeD);

  // Regard : décale le contenu de l'œil.
  vec2 g = gaze * vec2(0.05, 0.045);

  // Cœur brillant (dilatation = curiosité/surprise).
  float coreR = mix(0.05, 0.095, pupil);
  float core = fill(sdCircle(e - g, coreR));

  // Reflet (shine) en haut à droite.
  float shine = fill(sdCircle(e - g - vec2(0.045, 0.05), 0.028));

  vec3 col = vec3(0.0);
  col += EYE_COL * mask * 0.8;
  col -= 1.5*EYE_COL * core * 0.55;              // surbrillance interne
  col += SHINE * shine * mask * 0.9;
  col += EYE_COL * glow(eyeD, 0.08) * 0.255;  // halo phosphore
  return clamp(col, vec3(0), vec3(1));
}

// Sourcil : courbe de Bézier au-dessus de l'œil. sign = +1 œil droit (x>0), -1 gauche.
vec3 brow(vec2 p, float cx, float sign, float raise, float furrow) {
  float baseY = 0.30 + raise * 0.055 - furrow * 0.035;
  float w = 0.11;
  // Extrémités : l'intérieur (vers le centre) baisse avec le froncement.
  vec2 inner = vec2(cx - sign * w, baseY - furrow * 0.06 + raise * 0.01+.05);
  vec2 outer = vec2(cx + sign * w, baseY + raise * 0.02);

  // Point de contrôle central : légèrement bombé vers le HAUT au repos (arche
  // douce ∩), qui s'INVERSE vers le bas (∪) quand le froncement monte
  // (colère / crainte) → sourcil « fâché ».
  vec2 mid = 0.5 * (inner + outer);
  float bow = 0.035 - furrow * 0.09;   // >0 arqué, <0 inversé
  vec2 B = mid + vec2(0.0, bow);

  // t ∈ [0,1] le long du sourcil (0 = intérieur, 1 = queue extérieure).
  // Épaisseur effilée : plein côté intérieur, fin vers la queue.
  vec2 dt = sdBezierT(p, inner, B, outer);
  float thick = mix(0.02, 0.01, dt.y);
  float d = dt.x - thick;
  return ACCENT * (fill(d) * 0.9 + glow(d, 0.015) * 0.35);
}

vec3 mouth(vec2 p) {
  float w = 0.15 * (1. - uMouthOpen*.2);          // demi-largeur (position des coins)
  float y0 = -0.22-.05;     // hauteur des coins

  // Courbe de Bézier quadratique : coins fixes, point de contrôle central
  // qui descend pour un sourire (curve>0) et remonte pour une moue (curve<0).
  vec2 A = vec2(-w, y0);
  vec2 B = vec2(0.0, y0 - uMouthCurve * 0.16-.03);
  vec2 C = vec2( w, y0);
  float d = sdBezier(p, A, B, C);

  // Épaisseur = f(|x|) : lèvres plus pleines au centre, effilées aux coins.
  // uMouthOpen épaissit l'ensemble (bouche ouverte).
  float tx = clamp(abs(p.x) / w, 0.0, 1.0);
  float thick = 0.01 + (0.010 + uMouthOpen * 0.045) * (1.0 - tx * tx);
  d -= thick;

  return ACCENT * (fill(d) * 0.9 + glow(d, 0.015) * 0.35);
}

vec3 mouthOld(vec2 p) {
  float w = 0.15;
  float x = clamp(p.x, -w, w);
  // Courbe : bords relevés pour un sourire (curve>0), abaissés pour une moue.
  float lineY = -0.24 + uMouthCurve * 0.09 * (x / w) * (x / w);
  float d = abs(p.y - lineY);
  d = max(d, abs(p.x) - w);
  float thick = 0.014 + uMouthOpen * 0.07;
  d -= thick;
  return ACCENT * (fill(d) * 0.9 + glow(d, 0.05) * 0.35);
}


// Couche « visage » (yeux + sourcils + bouche), sans fond ni post-traitement.
// Appelée avec de légers décalages pour l'aberration chromatique.
vec3 faceLayer(vec2 p) {
  vec3 col = vec3(0.0);
  vec2 gaze = vec2(uGazeX, uGazeY);
  col += eye(p, vec2(-0.24, 0.06), uEyelidL, gaze, uPupil);
  col += eye(p, vec2(0.24, 0.06), uEyelidR, gaze, uPupil);
  col += brow(p, -0.24, -1.0, uBrowL, uFurrow);
  col += brow(p, 0.24, 1.0, uBrowR, uFurrow);
  col += mouth(p);
  return col;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes.xy;
  // Centré, cadré sur la plus PETITE dimension : le visage tient toujours à
  // l'écran, même en portrait (téléphone vertical), sans rogner les côtés.
  float m = min(uRes.x, uRes.y);
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / m;

  // En portrait (hauteur > largeur), remonter le visage vers le premier tiers
  // (laisse la place à l'UI en bas). En paysage : aucun décalage.
  float portrait = max(0.0, uRes.y / uRes.x - 1.0);
  p.y -= min(portrait * 0.5, 0.25);

  // Inclinaison de la tête.
  float a = uHeadTilt * 0.25;
  float c = cos(a), s = sin(a);
  p = mat2(c, -s, s, c) * p;

  // --- Glitch numérique : déchirure par bandes ---
  // Le glitch survient par courtes rafales (bursts) espacées, pas en continu.
  float t = uTime;
  float burst = smoothstep(0.90, 0.99, hash(floor(t * 2.2)));   // rafales rares
  float seed = floor(t * 24.0);                                 // graine qui change ~24 fps

  // Déchirure par bandes : bandes horizontales ancrées sur l'espace VISAGE
  // (p.y, centré et normalisé sur la petite dimension) — elles couvrent donc
  // le visage de la même façon en paysage (PC) et en portrait (téléphone),
  // au lieu de tomber dans le fond noir. Seules quelques-unes glissent, d'une
  // amplitude et d'un signe aléatoires (datamosh).
  float band = floor(p.y * 14.0);
  float bandActive = step(0.75, hash21(vec2(band, seed)));
  float tear = bandActive * (hash21(vec2(band * 1.7, seed)) - 0.5) * burst * 0.18;
  p.x += tear;

  // Fond : écran sombre + dégradé radial teinté par l'humeur (uAmbient).
  float vign = 1.0 - 0.5 * length(p);
  vec3 col = vec3(0.02, 0.01, 0.05);
  col += uAmbient * 0.5 * vign;

  // Aberration chromatique : split RVB, exacerbé sur les bandes déchirées.
  float offset = 0.004 + abs(tear) * 0.6 + length(p) * 0.004;
  vec3 f;
  f.r = faceLayer(p + vec2(offset, 0.0)).r;
  f.g = faceLayer(p).g;
  f.b = faceLayer(p - vec2(offset, 0.0)).b;
  col += f;

  // Scanlines CRT (phase perturbée par les rafales).
  float scan = 0.85 + 0.15 * sin(uv.y * uRes.y * 1.5 - uTime * 8.0 + burst * 6.28);
  col *= scan;

  // Vignette CRT.
  col *= 1.0 - 0.55 * dot(p, p);

  // Tone mapping doux + correction gamma.
  col = col / (col + 0.7);
  col = pow(col, vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}
