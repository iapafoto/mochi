#version 300 es
precision highp float;

// -------------------------------------------------------------------------
// Visage procédural de MOCHI 2.0 - Le Petit Robot Équilibriste Kawaii
// Conçu pour l'expressivité et l'identité robotique.
// -------------------------------------------------------------------------

uniform vec2 uRes;
uniform float uTime;
uniform vec3 uAmbient; // Teinte d'ambiance (0 = neutre)

// Canaux FaceState (0.0 à 1.0, sauf Gaze et Tilt qui sont -1.0 à 1.0)
uniform float uEyelidL;
uniform float uEyelidR;
uniform float uGazeX;
uniform float uGazeY;
uniform float uPupil;      // 0 = focus, 1 = surprise
uniform float uBrowL;      // Levée sourcil gauche
uniform float uBrowR;      // Levée sourcil droit
uniform float uFurrow;     // Froncement sourcils
uniform float uMouthOpen;  // Ouverture de la bouche
uniform float uMouthCurve; // Courbe (1 = sourire, -1 = moue)
uniform float uHeadTilt;   // Inclinaison de la tête (-1 à 1)

out vec4 fragColor;

// --- Couleurs Mochi ---
const vec3 EYE_BASE_COL = vec3(0.3, 0.9, 1.0);  // Cyan vibrant
const vec3 EYE_ACCENT_COL = vec3(0.05, 0.6, 0.8); // Bleu plus profond
const vec3 SHINE_COL = vec3(1.0);               // Blanc pur
const vec3 PINK_ACCENT = vec3(1.0, 0.45, 0.7);  // Rose chaud pour sourcils/bouche
const vec3 BLUSH_COL = vec3(1.0, 0.6, 0.65);    // Rose doux pour les joues

// --- Utilitaires Math ---
#define PI 3.14159265359

float sdCircle(vec2 p, float r) { return length(p) - r; }

// Capsule (segment épais) entre a et b, rayon r.
float sdSegment(vec2 p, vec2 a, vec2 b, float r) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
}

// Remplissage anti-aliasé : ~1 à l'intérieur (d<0), 0 dehors.
float fill(float d) {
    float e = fwidth(d) * 1.5;
    return smoothstep(e, -e, d);
}

// Halo doux au-delà du bord, pour l'effet lumineux.
float glow(float d, float width) {
    return smoothstep(width, 0.0, max(d, 0.0));
}

// Texture d'iris robotique procédurale (rayures + micro-motifs)
float irisPattern(vec2 p, float t) {
    float ang = atan(p.y, p.x);
    float d = length(p);
    
    // Rayures radiales (iridiscence)
    float rays = sin(ang * 16.0 + t * 0.5) * 0.5 + 0.5;
    
    // Micro-hexagones pour l'aspect technologique (subtil)
    vec2 st = p * 40.0;
    st.x += st.y * 0.5;
    vec2 grid = fract(st) - 0.5;
    float hex = 1.0 - smoothstep(0.2, 0.3, length(grid));

    return mix(rays, hex, 0.3);
}

// --- Éléments de Dessin ---

// Dessine un œil robotique expressif.
vec3 eye(vec2 p, vec2 center, float eyelid, vec2 gaze, float pupil) {
    vec2 e = p - center;
    float r = 0.16; // Rayon de base de l'œil

    // Regard : décale le contenu de l'œil.
    vec2 g = gaze * vec2(0.04, 0.035);

    // --- Structure de l'iris ---
    float irisD = sdCircle(e - g, r * 1.15);
    float irisM = fill(irisD);
    
    // Couleur d'iris avec texture
    vec3 irisCol = mix(EYE_ACCENT_COL, EYE_BASE_COL, irisPattern(e - g, uTime * 0.2));
    
    // --- Corps de l'œil (SDF principale) découpé par la paupière ---
    float bodyD = sdCircle(e, r);
    float topLineY = r * (1.1 - 2.3 * eyelid); // Descend pour fermer
    float eyeD = max(bodyD, e.y - topLineY);
    float eyeMask = fill(eyeD);

    // --- Cœur brillant (Pupille) ---
    // S'élargit avec uPupil (peur/curiosité).
    float coreR = mix(0.045, 0.09, pupil); 
    float coreD = sdCircle(e - g, coreR);
    float coreFill = fill(coreD);
    
    // Ajout d'une lueur interne (glow) pour l'effet "allumé"
    float coreGlow = glow(coreD, 0.1);

    // --- Reflet (Shine) ---
    // Placé pour le "kawaii-pop", s'ajuste au regard.
    vec2 shinePos = e - g - vec2(0.05, 0.055);
    float shine = fill(sdCircle(shinePos, 0.03));
    
    // --- Composition finale de l'œil ---
    vec3 col = vec3(0.0);
    
    // Structure interne robotique subtile (anneaux)
    col += vec3(0.1, 0.2, 0.25) * fill(abs(sdCircle(e, r * 1.22)) - 0.005) * eyeMask;
    
    // Iris texturé
    col += irisCol * eyeMask;
    
    // Pupille avec bloom intense
    col += (EYE_BASE_COL * 0.6 + SHINE_COL * 0.4) * coreFill * eyeMask;
    col += EYE_BASE_COL * coreGlow * 1.5 * eyeMask; // Lueur de la pupille
    
    // Reflet kawaii (au-dessus de tout)
    col += SHINE_COL * shine * eyeMask * 0.95;
    
    // Halo extérieur doux (ambiance de l'unité optique)
    col += EYE_BASE_COL * glow(eyeD, 0.08) * 0.25;

    return col;
}

// Sourcil modernisé : segment légèrement courbé, réactif.
// sign = +1 œil droit (x>0), -1 gauche.
vec3 brow(vec2 p, float cx, float sign, float raise, float furrow) {
    float baseY = 0.32 + raise * 0.06 - furrow * 0.04;
    float w = 0.1;
    
    // Courbure subtile (kawaii)
    float curve = furrow * 0.04 - raise * 0.01;
    
    // Extrémité intérieure (baisse avec le froncement).
    vec2 inner = vec2(cx - sign * w, baseY - furrow * 0.07 + raise * 0.02 + curve);
    vec2 outer = vec2(cx + sign * w, baseY + raise * 0.03 - curve);
    
    float d = sdSegment(p, inner, outer, 0.017);
    
    // Couleur et lueur
    vec3 col = PINK_ACCENT * (fill(d) * 0.9 + glow(d, 0.045) * 0.3);
    
    // Ligne de détail robotique subtile au-dessus
    col += vec3(0.3, 0.4, 0.4) * fill(d + 0.025) * 0.5;

    return col;
}

// Joues Blush réactives. Activées par uHeadTilt (simule mignonnerie/stress).
// cx = position x du centre de l'œil
vec3 blush(vec2 p, float cx) {
    float tiltFactor = abs(uHeadTilt);
    
    // S'activent de base + avec l'inclinaison
    float intensity = 0.1 + tiltFactor * 0.65;
    
    // Positionnées sous les yeux
    vec2 bPos = p - vec2(cx, -0.15);
    
    // Forme d'ellipse aplatie
    float d = sdCircle(bPos / vec2(1.2, 0.7), 0.045);
    
    // Lueur très douce et diffuse
    float f = smoothstep(0.09, 0.0, d);
    
    return BLUSH_COL * f * intensity * 0.8;
}

// Bouche Émotive et lumineuse.
vec3 mouth(vec2 p) {
    float w = 0.16;
    float x_rel = clamp(p.x, -w, w);
    
    // La position Y de base change avec la courbe (uMouthCurve).
    // Sourire = remonte les bords ; Moue = descend les bords.
    float y_offset = -0.25;
    float mouth_shape = uMouthCurve * 0.12 * pow(abs(x_rel / w), 1.6);
    float lineY = y_offset + mouth_shape;
    
    // L'ouverture change l'épaisseur et la forme de la bouche
    // Plus ouvert = forme de "D" pour le sourire, fente verticale pour l'effroi.
    float thick = 0.01 + uMouthOpen * 0.06;
    float aspect = mix(1.0, 0.4, uMouthOpen); // S'étire verticalement
    
    float d = abs(p.y - lineY) / aspect;
    d = max(d, abs(p.x) - w);
    
    d -= thick;
    
    // Ajout d'une structure interne (subtile fente si ouvert)
    if (uMouthOpen > 0.1) {
        d = max(d, -(abs(p.y - lineY) - 0.01));
    }
    
    // Couleur lumineuse
    return PINK_ACCENT * (fill(d) * 0.9 + glow(d, 0.045) * 0.3);
}

// --- Main Shader ---

void main() {
    // Coordonnées centrées, Y vers le haut, corrigées pour l'aspect ratio
    vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

    // Inclinaison de la tête.
    float a = uHeadTilt * 0.28; // Légèrement accentuée
    float c = cos(a), s = sin(a);
    p = mat2(c, -s, s, c) * p;

    // --- Arrière-plan "Peau de Mochi" ---
    // Léger dégradé radial, teinté par uAmbient.
    float vign = 1.0 - 0.7 * length(p);
    
    // Couleurs de base métallisées/composites douces
    vec3 shellLo = vec3(0.06, 0.03, 0.14) + uAmbient * 0.3;
    vec3 shellHi = vec3(0.12, 0.07, 0.24) + uAmbient * 0.8;
    vec3 col = mix(shellLo, shellHi, vign);
    
    // --- Éléments Robotiques du Fond ---
    // Lignes de panneaux subtiles sur le "front"
    float panels = fill(abs(sdCircle(p - vec2(0.0, 0.4), 0.3)) - 0.002);
    panels += fill(abs(p.x) - 0.0015) * smoothstep(0.4, 0.5, p.y);
    col += vec3(0.2, 0.25, 0.3) * panels * 0.5;

    // --- Éléments du Visage ---
    vec2 gaze = vec2(uGazeX, uGazeY);
    
    float eyeX = 0.25;
    float eyeY = 0.06;

    // Yeux (avec lueur propre)
    col += eye(p, vec2(-eyeX, eyeY), uEyelidL, gaze, uPupil);
    col += eye(p, vec2(eyeX, eyeY), uEyelidR, gaze, uPupil);
    
    // Joues Blush (sous les yeux, réactives)
    col += blush(p, -eyeX);
    col += blush(p, eyeX);
    
    // Sourcils
    col += brow(p, -eyeX, -1.0, uBrowL, uFurrow);
    col += brow(p, eyeX, 1.0, uBrowR, uFurrow);
    
    // Bouche
    col += mouth(p);

    // --- Tone Mapping final ---
    // Adoucit les hautes lumières pour le look kawaii/bloom.
    col = col / (col + 0.6);
    // Un peu de contraste
    col = pow(col, vec3(0.9));
    
    fragColor = vec4(col, 1.0);
}