#version 300 es
precision highp float;

// Uniforms du robot et de l'écran
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uAmbient; 
uniform float uEyelidL;
uniform float uEyelidR;
uniform float uGazeX; // Non utilisé pour cette expression triste
uniform float uGazeY; // Non utilisé pour cette expression triste
uniform float uPupil;
uniform float uBrowL; // Non utilisé pour cette expression triste
uniform float uBrowR; // Non utilisé pour cette expression triste
uniform float uFurrow;
uniform float uMouthOpen; // Non utilisé pour cette expression triste
uniform float uMouthCurve; // Pour contrôler l'intensité du sourire W
uniform float uHeadTilt; // Pour contrôler l'inclinaison de l'écran

out vec4 fragColor;

// --- Palette de Couleurs "Tristesse Mignonne" ---
const vec3 PHOSPHOR = vec3(0.1, 0.95, 0.85); // Cyan vibrant
const vec3 BLUSH = vec3(1.0, 0.3, 0.6); // Rose bonbon
const vec3 ROBOT_BG = vec3(0.9, 0.9, 0.95); // Coque nacrée
const vec3 DARK_UI = vec3(0.02, 0.0, 0.05); // Fond d'écran très sombre

// --- Fonctions SDF basiques ---
float sdCircle(vec2 p, float r) { return length(p) - r; }

// SDF de boîte très arrondie pour les yeux en amande
float sdBox(vec2 p, vec2 b, float r) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

// SDF de courbe de Bézier simple pour le sourire W
// Points de contrôle A, B, C pour une courbe quadratique
float sdBezier(vec2 p, vec2 A, vec2 B, vec2 C) {
    vec2 a = B - A;
    vec2 b = A - 2.0*B + C;
    vec2 c = a * 2.0;
    vec2 d = A - p;
    float g = dot(b,b);
    float h = dot(c,b);
    float i = dot(c,c) + dot(d,b);
    float j = dot(d,c);
    float k = (g*3.0);
    float l = (h*2.0);
    float m = i;
    float n = j;
    float p1 = l*l - 3.0*g*m;
    float p2 = 2.0*l*l*l - 9.0*g*l*m + 27.0*g*g*n;
    float p3 = p2*p2 - 4.0*p1*p1*p1;
    if (p3 > 0.0) {
        float r3 = sqrt(p3);
        float s = (p2+r3)>0.0 ? pow((p2+r3)/2.0, 1.0/3.0) : -pow(abs((p2+r3)/2.0), 1.0/3.0);
        float t = (p2-r3)>0.0 ? pow((p2-r3)/2.0, 1.0/3.0) : -pow(abs((p2-r3)/2.0), 1.0/3.0);
        float u = clamp((s+t-l)/k, 0.0, 1.0);
        return length(d + c*u + b*u*u);
    } else {
        float ac = acos(p2 / (2.0*sqrt(p1*p1*p1)));
        float r = 2.0*sqrt(p1);
        float t1 = clamp((r*cos(ac/3.0) - l)/k, 0.0, 1.0);
        float t2 = clamp((r*cos((ac+2.0*3.14159)/3.0) - l)/k, 0.0, 1.0);
        float t3 = clamp((r*cos((ac+4.0*3.14159)/3.0) - l)/k, 0.0, 1.0);
        float d1 = length(d + c*t1 + b*t1*t1);
        float d2 = length(d + c*t2 + b*t2*t2);
        float d3 = length(d + c*t3 + b*t3*t3);
        return min(d1, min(d2, d3));
    }
}

// --- Outils de rendu ---
float fill(float d, float w) { return smoothstep(w, 0.0, d); }
float glow(float d, float w) { return exp(-max(d, 0.0) / w); }
float hash(float n) { return fract(sin(n) * 43758.5453123); }

// --- Visage Kawaii : Yeux Tristes et Complexés (Anime Style) ---
vec3 drawEye(vec2 p, vec2 center, float eyelid, float curve) {
    vec2 uv = p - center;
    
    // Réduire la courbure joyeuse pour l'effet triste, mais garder les yeux plissés
    uv.y -= uv.x * uv.x * curve * 0.5; 
    
    // Forme d'amande très arrondie ("oreiller")
    float d = sdBox(uv, vec2(0.18, 0.22), 0.08); // Boîte très arrondie
    
    // Iris central plus sombre (déplacé vers le bas)
    float irD = sdCircle(uv - vec2(0.0, -0.05), 0.12);
    
    // Deux reflets blancs complexes (Catchlights)
    float s1D = sdCircle(uv - vec2(0.08, 0.08), 0.05); // Grand reflet haut-droite
    float s2D = sdCircle(uv - vec2(-0.06, -0.08), 0.025); // Petit reflet bas-gauche
    
    // Masques
    float mask = fill(d, 0.02);
    float irMask = fill(irD, 0.02);
    float s1Mask = fill(s1D, 0.015);
    float s2Mask = fill(s2D, 0.015);

    // Composition des couleurs de l'œil
    vec3 col = PHOSPHOR * mask * 0.8;                     // Base lumineuse
    col = mix(col, vec3(0.02, 0.1, 0.15), irMask * mask);  // Assombrir l'iris central
    col = mix(col, vec3(1.0), s1Mask * mask);             // Reflet 1 pur blanc
    col = mix(col, vec3(1.0), s2Mask * mask);             // Reflet 2 pur blanc

    // Halo lumineux intense
    return col + PHOSPHOR * glow(d, 0.15) * 0.7;
}

// --- Visage Kawaii : Bouche de Chat (:3) ou Sourire W Triste ---
vec3 drawMouth(vec2 p, float curve) {
    vec2 uv = p + vec2(0.0, 0.2); // Positionner la bouche

    // On dessine un "w" cursif large et doux
    // Points de contrôle pour une courbe "w" simple
    float W = 0.25;
    float H = 0.12 * abs(curve);
    float d = sdBezier(uv, vec2(-W, 0.0), vec2(-W*0.5, H), vec2(0.0, 0.0));
    d = min(d, sdBezier(uv, vec2(0.0, 0.0), vec2(W*0.5, H), vec2(W, 0.0)));
    
    // Épaisseur dynamique
    float thick = 0.018;
    d -= thick;
    
    // Halo et blush subtil autour de la bouche
    return BLUSH * fill(d, 0.015) + BLUSH * glow(d, 0.1) * 0.6;
}

// --- Rendu complet de l'écran en gros plan ---
vec3 renderScreenFace(vec2 p) {
    vec3 col = vec3(0.0);
    // gaze n'est plus utilisé pour cette expression

    // Dessiner les yeux tristes/plissés
    col += drawEye(p, vec2(-0.35, 0.0), uEyelidL, uMouthCurve);
    col += drawEye(p, vec2(0.35, 0.0), uEyelidR, uMouthCurve);
    // Dessiner le sourire W large
    col += drawMouth(p, uMouthCurve);

    // Joues rougissantes plus douces mais présentes
    float cheek = sdCircle(vec2(abs(p.x) - 0.45, p.y + 0.1), 0.06);
    col += BLUSH * glow(cheek, 0.08) * 0.7;

    return col;
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes.xy;
    vec2 p = (gl_FragCoord.xy - 0.5 * uRes.xy) / uRes.y;

    // Composition de gros plan de l'écran incliné
    // Remplacer le robot gyroscopique par un moniteur d'ordinateur incliné
    float angle = -uHeadTilt * 0.2 + 0.1; // Inclinaison de l'écran
    float ca = cos(angle), sa = sin(angle);
    vec2 screenP = mat2(ca, -sa, sa, ca) * p - vec2(0.0, 0.15); // Centre de l'écran décalé

    // Glitch vidéo plus prononcé et intermittent pour l'effet Demoscene
    float noise = hash(floor(uTime * 18.0));
    float glitch = step(0.95, noise) * 0.1 * sin(p.y * 60.0);
    
    // SDF de l'écran d'ordinateur incliné
    float screenD = sdBox(screenP, vec2(1.0, 0.75), 0.12);
    
    // Fond de la scène
    vec3 col = DARK_UI * 0.8 + uAmbient * 0.15;

    // Rendu de l'écran
    if (screenD < 0.0) {
        // Intérieur Écran
        vec2 faceP = screenP;
        faceP.x += glitch;

        // Aberration Chromatique intense pour correspondre à l'image de référence
        float offset = 0.02 + glitch * 0.6;
        vec3 faceCol = vec3(0.0);
        
        // Split RVB renforcé pour tous les éléments du visage
        // Les yeux et la bouche sont dessinés avec un RVB Split pour intensifier l'aberration
        faceCol.r = (drawEye(faceP + vec2(offset, 0.0), vec2(-0.35, 0.0), uEyelidL, uMouthCurve) + drawMouth(faceP + vec2(offset, 0.0), uMouthCurve)).r;
        faceCol.g = (drawEye(faceP, vec2(-0.35, 0.0), uEyelidL, uMouthCurve) + drawMouth(faceP, uMouthCurve)).g;
        faceCol.b = (drawEye(faceP - vec2(offset, 0.0), vec2(-0.35, 0.0), uEyelidL, uMouthCurve) + drawMouth(faceP - vec2(offset, 0.0), uMouthCurve)).b;
        
        faceCol.r += (drawEye(faceP + vec2(offset, 0.0), vec2(0.35, 0.0), uEyelidR, uMouthCurve)).r;
        faceCol.g += (drawEye(faceP, vec2(0.35, 0.0), uEyelidR, uMouthCurve)).g;
        faceCol.b += (drawEye(faceP - vec2(offset, 0.0), vec2(0.35, 0.0), uEyelidR, uMouthCurve)).b;

        // Scanlines fortes et vignette CRT pour l'effet rétro
        float scan = 0.75 + 0.25 * sin(uv.y * uRes.y * 3.0 - uTime * 10.0);
        float vig = 1.0 - 0.7 * dot(faceP, faceP);
        
        col = faceCol * scan * vig;
        col += DARK_UI * 0.4; // Écran sombre par défaut
    } else {
        // Extérieur : Moniteur incliné sur support
        // Coque
        vec3 chassisCol = vec3(0.9, 0.9, 0.95);
        col = mix(col, chassisCol, fill(sdBox(screenP, vec2(1.1, 0.85), 0.15), 0.02));
        
        // Support d'ordinateur simple (comme on le voit dans l'image de référence)
        float standD = sdBezier(p, vec2(-0.2, -0.6), vec2(-0.15, -0.9), vec2(0.0, -0.8));
        standD = min(standD, sdBezier(p, vec2(0.2, -0.6), vec2(0.15, -0.9), vec2(0.0, -0.8)));
        float standThick = 0.06;
        standD -= standThick;
        col = mix(col, vec3(0.8), fill(standD, 0.02));

        // Antenne clignotante décalée
        vec2 antP = screenP - vec2(0.0, 0.85);
        float antBallD = sdCircle(antP, 0.08);
        float blink = 0.5 + 0.5 * sin(uTime * 8.0);
        vec3 antGlow = mix(vec3(0.2, 0.8, 1.0), BLUSH, 1.0) * blink;
        col += antGlow * fill(antBallD, 0.02);
        col += antGlow * glow(antBallD, 0.15) * 0.8;
    }

    // Post-Processing (ACES Tonemapping simplifié)
    col = pow(col, vec3(1.0 / 2.2)); // Correction Gamma
    fragColor = vec4(col, 1.0);
}