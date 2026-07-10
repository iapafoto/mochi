#version 300 es
precision highp float;

// Visage procédural SDF de Mochi.
// Un seul quad plein écran ; toute la géométrie (yeux, sourcils, bouche) est
// dessinée à partir des uniforms de FaceState. Aucun sprite.

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

const vec3 EYE_COL = vec3(0.55, 0.85, 1.0);   // cyan lumineux
const vec3 SHINE = vec3(1.0);
const vec3 ACCENT = vec3(1.0, 0.56, 0.82);    // rose (sourcils / bouche)

float sdCircle(vec2 p, float r) { return length(p) - r; }

// Capsule (segment épais) entre a et b, rayon r.
float sdSegment(vec2 p, vec2 a, vec2 b, float r) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Remplissage anti-aliasé : ~1 à l'intérieur (d<0), 0 dehors.
float fill(float d) {
  float e = fwidth(d) * 1.2;
  return smoothstep(e, -e, d);
}

// Halo doux au-delà du bord, pour l'effet lumineux kawaii.
float glow(float d, float width) {
  return smoothstep(width, 0.0, max(d, 0.0));
}

// Dessine un œil. Retourne l'accumulation couleur ajoutée.
vec3 eye(vec2 p, vec2 center, float eyelid, vec2 gaze, float pupil) {
  vec2 e = p - center;
  float r = 0.155;

  // Corps de l'œil découpé par la paupière supérieure.
  float body = sdCircle(e, r);
  float topLine = r * (1.0 - 2.0 * eyelid);   // descend quand l'œil se ferme
  float eyeD = max(body, e.y - topLine);
  float mask = fill(eyeD);

  // Regard : décale le contenu de l'œil.
  vec2 g = gaze * vec2(0.05, 0.045);

  // Cœur brillant (dilatation = curiosité/surprise).
  float coreR = mix(0.05, 0.095, pupil);
  float core = fill(sdCircle(e - g, coreR));

  // Reflet (shine) en haut à droite.
  float shine = fill(sdCircle(e - g - vec2(0.045, 0.05), 0.028));

  vec3 col = vec3(0.0);
  col += EYE_COL * mask * 0.85;
  col += EYE_COL * core * 0.6;               // surbrillance interne
  col += SHINE * shine * mask * 0.9;
  col += EYE_COL * glow(eyeD, 0.06) * 0.35;  // halo
  return col;
}

// Sourcil : capsule au-dessus de l'œil. sign = +1 œil droit (x>0), -1 gauche.
vec3 brow(vec2 p, float cx, float sign, float raise, float furrow) {
  float baseY = 0.30 + raise * 0.055 - furrow * 0.035;
  float w = 0.11;
  // extrémité intérieure (vers le centre) baisse avec le froncement.
  vec2 inner = vec2(cx - sign * w, baseY - furrow * 0.06 + raise * 0.01);
  vec2 outer = vec2(cx + sign * w, baseY + raise * 0.02);
  float d = sdSegment(p, inner, outer, 0.018);
  return ACCENT * (fill(d) * 0.9 + glow(d, 0.04) * 0.25);
}

vec3 mouth(vec2 p) {
  float w = 0.15;
  float x = clamp(p.x, -w, w);
  // Courbe : bords relevés pour un sourire (curve>0), abaissés pour une moue.
  float lineY = -0.24 + uMouthCurve * 0.09 * (x / w) * (x / w);
  float d = abs(p.y - lineY);
  d = max(d, abs(p.x) - w);
  float thick = 0.014 + uMouthOpen * 0.07;
  d -= thick;
  return ACCENT * (fill(d) * 0.9 + glow(d, 0.04) * 0.25);
}

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y; // centré, y vers le haut

  // Inclinaison de la tête.
  float a = uHeadTilt * 0.25;
  float c = cos(a), s = sin(a);
  p = mat2(c, -s, s, c) * p;

  // Fond : léger dégradé radial violet, teinté par l'humeur (uAmbient).
  float vign = 1.0 - 0.5 * length(p);
  vec3 bgLo = vec3(0.06, 0.03, 0.12) + uAmbient * 0.35;
  vec3 bgHi = vec3(0.12, 0.07, 0.22) + uAmbient * 0.8;
  vec3 col = mix(bgLo, bgHi, vign);

  vec2 gaze = vec2(uGazeX, uGazeY);
  col += eye(p, vec2(-0.24, 0.06), uEyelidL, gaze, uPupil);
  col += eye(p, vec2(0.24, 0.06), uEyelidR, gaze, uPupil);
  col += brow(p, -0.24, -1.0, uBrowL, uFurrow);
  col += brow(p, 0.24, 1.0, uBrowR, uFurrow);
  col += mouth(p);

  // Tone mapping doux.
  col = col / (col + 0.6);
  col = pow(col, vec3(0.85));
  fragColor = vec4(col, 1.0);
}
