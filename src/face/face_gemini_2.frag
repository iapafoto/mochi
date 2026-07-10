#version 300 es
precision highp float;

// Uniforms originaux conservés
uniform vec2 uRes;
uniform float uTime;
uniform vec3 uAmbient; 
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

// --- Palette de Couleurs Kawaii ---
const vec3 PHOSPHOR = vec3(0.0, 0.9, 0.8);    // Cyan écran
const vec3 BLUSH    = vec3(1.0, 0.2, 0.5);    // Rose joues
const vec3 ROBOT_BG = vec3(0.85, 0.88, 0.92); // Coque blanche/grise
const vec3 DARK_UI  = vec3(0.08, 0.05, 0.12); // Fond d'écran

// --- Fonctions SDF basiques ---
float sdCircle(vec2 p, float r) { return length(p) - r; }

float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdSegment(vec2 p, vec2 a, vec2 b, float r) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
}

// --- Outils de rendu Demoscene ---
float fill(float d) { return smoothstep(fwidth(d) * 1.5, 0.0, d); }
float glow(float d, float w) { return exp(-max(d, 0.0) / w); }
float hash(float n) { return fract(sin(n) * 43758.5453123); }

// --- Rendu des Éléments du Visage ---
vec3 drawEye(vec2 p, vec2 center, float eyelid, vec2 gaze, float pupil, float furrow, float curve) {
    vec2 uv = p - center;
    
    // Expression Kawaii : Les yeux se courbent selon le sourire (^_^ ou v_v)
    uv.y -= uv.x * uv.x * curve * 1.5; 
    
    // Forme digitale style écran LCD
    float rX = 0.12 + pupil * 0.03;
    float rY = 0.18 - eyelid * 0.15;
    
    float d = sdBox(uv, vec2(rX, rY)) - 0.04;
    
    // Découpe de la paupière (froncement)
    float lidCut = sdBox(uv - vec2(0.0, 0.22 - eyelid*0.2 - furrow*0.05), vec2(0.3));
    d = max(d, -lidCut);

    // Pupille interne (regard)
    float pd = sdBox(uv - gaze * 0.06, vec2(rX*0.35, rY*0.4)) - 0.02;

    float m = fill(d);
    float pm = fill(pd);

    return PHOSPHOR * m * 0.4 + vec3(1.0) * pm + PHOSPHOR * glow(d, 0.06);
}

vec3 drawMouth(vec2 p) {
    float w = 0.12;
    float curve = uMouthCurve * 0.15;
    float lineY = curve * (p.x/w) * (p.x/w);
    
    vec2 mp = p;
    mp.y -= lineY - 0.15;
    
    float thick = 0.015 + uMouthOpen * 0.06;
    float d = sdSegment(mp, vec2(-w, 0.0), vec2(w, 0.0), thick);

    // Fossettes pour accentuer la mignonnerie
    float dimples = sdCircle(vec2(abs(p.x) - w - 0.04, p.y + 0.15 - curve), 0.015);
    d = min(d, dimples);

    return BLUSH * fill(d) + BLUSH * glow(d, 0.05);
}

// Fonction centrale pour le RGB split
vec3 renderScreenFace(vec2 p) {
    vec3 col = vec3(0.0);
    vec2 gaze = vec2(uGazeX, uGazeY);

    col += drawEye(p, vec2(-0.25, 0.05), uEyelidL, gaze, uPupil, uFurrow, uMouthCurve);
    col += drawEye(p, vec2( 0.25, 0.05), uEyelidR, gaze, uPupil, uFurrow, uMouthCurve);
    col += drawMouth(p);

    // Joues rougissantes permanentes
    float cheek = sdCircle(vec2(abs(p.x) - 0.38, p.y + 0.1), 0.07);
    col += BLUSH * glow(cheek, 0.05) * 0.7;

    return col;
}

void main() {
    vec2 uv = gl_FragCoord.xy / uRes.xy;
    vec2 p = (gl_FragCoord.xy - 0.5 * uRes.xy) / uRes.y;

    // --- Animation & Mouvement ---
    // Petit flottement (idle animation) et inclinaison
    float idle = sin(uTime * 2.0) * 0.02;
    float tilt = uHeadTilt * 0.35 + idle;
    float c = cos(tilt), s = sin(tilt);
    vec2 hp = mat2(c, -s, s, c) * p; // hp = coordonnées du robot

    // Glitch temporel pour le style vidéo/CRT
    float noise = hash(floor(uTime * 12.0));
    float glitch = step(0.96, noise) * 0.04 * sin(p.y * 40.0);
    
    // --- Géométrie du Robot ---
    float screenD = sdBox(hp - vec2(0.0, 0.1), vec2(0.55, 0.40)) - 0.1;
    float bodyD   = sdBox(hp - vec2(0.0, 0.1), vec2(0.65, 0.50)) - 0.15;
    
    // Roue d'équilibriste au sol
    float wheelD  = sdCircle(hp - vec2(0.0, -0.7), 0.18);
    float axeD    = sdSegment(hp, vec2(0.0, -0.4), vec2(0.0, -0.7), 0.04);
    
    // Antenne avec petite boule lumineuse
    float antD    = sdSegment(hp, vec2(0.0, 0.75), vec2(0.0, 0.95), 0.015);
    float antBall = sdCircle(hp - vec2(0.0, 0.95), 0.04);

    // --- Rendu ---
    vec3 col = DARK_UI * 0.3 + uAmbient * 0.1; // Fond de la scène

    if(screenD < 0.0) {
        // Intérieur de l'écran Tamagotchi
        vec2 sp = hp - vec2(0.0, 0.1); 
        sp.x += glitch; // On n'applique le glitch qu'à l'écran !

        // Aberration Chromatique
        float offset = 0.01 + glitch * 0.5;
        vec3 faceCol = vec3(0.0);
        faceCol.r = renderScreenFace(sp + vec2(offset, 0.0)).r;
        faceCol.g = renderScreenFace(sp).g;
        faceCol.b = renderScreenFace(sp - vec2(offset, 0.0)).b;

        // Scanlines & Vignette
        float scan = 0.85 + 0.15 * sin(uv.y * uRes.y * 1.5 - uTime * 6.0);
        float vig = 1.0 - 0.4 * dot(sp, sp);
        
        col = faceCol * scan * vig;
        col += DARK_UI; // Couleur de base de l'écran éteint
    } else {
        // Extérieur : Corps du Robot
        vec3 chassisCol = ROBOT_BG * (1.0 - glow(screenD, 0.05)); // Ombre de l'écran
        col = mix(col, chassisCol, fill(bodyD));
        
        // Mécanique (Roue et Axe)
        col = mix(col, vec3(0.2), fill(axeD));
        col = mix(col, vec3(0.15), fill(wheelD));
        
        // Moyeu de la roue
        col = mix(col, vec3(0.8), fill(sdCircle(hp - vec2(0.0, -0.7), 0.05)));

        // Antenne
        col = mix(col, vec3(0.5), fill(antD));
        
        // Boule d'antenne clignotante (indicatrice d'humeur/état)
        float blink = 0.5 + 0.5 * sin(uTime * 5.0);
        vec3 antGlow = vec3(1.0, 0.3, 0.1) * blink;
        col += antGlow * fill(antBall);
        col += antGlow * glow(antBall, 0.1) * 0.6;
    }

    // --- Post-Processing : ACES Filmic Tone Mapping ---
    // Essentiel dans la scène demoscene moderne pour des couleurs vibrantes
    col = (col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14);
    
    // Correction Gamma
    fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}