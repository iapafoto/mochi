// Vocabulaire d'intentions — défini UNE fois, exposé à Gemini comme
// functionDeclarations, dispatché vers visage / son / transport (robot réel).
//
// ⚠️ DEUX FAMILLES, et la distinction n'est pas cosmétique :
//   — EXPRESSION (express, blink, wink, look, emote) : écran et haut-parleur. Gratuit,
//     réversible, appelable à chaque réplique.
//   — DÉPLACEMENT (forward, backward, turn, circle, nod, bow, wiggle) : ça fait ROULER
//     un pendule inversé de 1,1 kg dans une vraie pièce, avec une vraie table dont il
//     peut tomber. Les descriptions le disent au modèle, et persona.ts le répète dans
//     les règles : on ne bouge que si l'humain l'a demandé.
//
// Le format des déclarations est volontairement neutre (OpenAPI-ish) ; gemini.ts
// l'adapte au SDK courant. Ne pas y mettre de détail réseau.

/** Schéma de paramètre neutre (sous-ensemble OpenAPI utilisé par Gemini). */
export interface ParamSchema {
  type: 'string' | 'number' | 'integer' | 'boolean';
  description?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
}

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters?: {
    type: 'object';
    properties: Record<string, ParamSchema>;
    required?: string[];
  };
}

/** Un appel d'intention résolu (nom + arguments). */
export interface IntentCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Allure des déplacements mesurés — le MÊME paramètre pour forward/backward/turn,
 * défini une fois (cf. MOVE_SPEEDS dans robot/driveLoop.ts pour les valeurs).
 *
 * Il est OPTIONNEL, et c'est le point important : ne rien dire n'est pas un oubli
 * à corriger, c'est le cas normal — Mochi se déplace alors à l'allure de son
 * humeur. Le paramètre sert à en sortir sur demande (« vite ! », « tout doux »),
 * pas à être rempli à chaque appel.
 */
const MOVE_SPEED_PARAM: ParamSchema = {
  type: 'string',
  enum: ['slow', 'normal', 'fast'],
  description:
    "Allure, seulement si on te la demande ou si la situation l'appelle : fast = vite, "
    + "pour frimer ou quand tu es tout excité ; slow = tout doux, prudent ; normal = ton "
    + "allure ordinaire. Omets ce paramètre le reste du temps.",
};

export const INTENT_DECLARATIONS: FunctionDeclaration[] = [
  // --- Expression (visage réel en v1) ---
  {
    name: 'express',
    description:
      "Affiche une émotion sur le visage de Mochi. À utiliser dès que la réponse a une couleur émotionnelle.",
    parameters: {
      type: 'object',
      properties: {
        emotion: {
          type: 'string',
          enum: ['joy', 'sadness', 'surprise', 'curiosity', 'anger', 'neutral'],
          description: "L'émotion à exprimer.",
        },
        intensity: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description: "Intensité de 0 à 1 (défaut 0.8).",
        },
      },
      required: ['emotion'],
    },
  },
  {
    name: 'blink',
    description: 'Fait cligner des yeux Mochi (petit clignement mignon).',
  },
  {
    name: 'wink',
    description: "Fait un clin d'œil complice.",
    parameters: {
      type: 'object',
      properties: {
        side: { type: 'string', enum: ['left', 'right'], description: "Œil du clin d'œil." },
      },
      required: ['side'],
    },
  },
  {
    name: 'look',
    description:
      'Oriente le REGARD de Mochi (les yeux seulement, le corps ne bouge pas).',
    parameters: {
      type: 'object',
      properties: {
        dir: {
          type: 'string',
          enum: ['left', 'right', 'up', 'down', 'center'],
          description: 'Direction du regard.',
        },
      },
      required: ['dir'],
    },
  },
  // --- Déplacement RÉEL (BLE → ESP32) ---
  {
    name: 'forward',
    description:
      'DÉPLACEMENT RÉEL : avance de N centimètres. À n’appeler que si on demande de bouger.',
    parameters: {
      type: 'object',
      properties: { cm: { type: 'integer', description: 'Distance en cm.' }, speed: MOVE_SPEED_PARAM },
      required: ['cm'],
    },
  },
  {
    name: 'backward',
    description:
      'DÉPLACEMENT RÉEL : recule de N centimètres. À n’appeler que si on demande de bouger.',
    parameters: {
      type: 'object',
      properties: { cm: { type: 'integer', description: 'Distance en cm.' }, speed: MOVE_SPEED_PARAM },
      required: ['cm'],
    },
  },
  {
    name: 'turn',
    description:
      'DÉPLACEMENT RÉEL : pivote sur place de N degrés (positif = droite, négatif = gauche).',
    parameters: {
      type: 'object',
      properties: { deg: { type: 'integer', description: 'Angle en degrés.' }, speed: MOVE_SPEED_PARAM },
      required: ['deg'],
    },
  },
  {
    name: 'circle',
    description:
      'DÉPLACEMENT RÉEL : roule en rond. Le numéro dont Mochi est le plus fier. '
      + "À n'appeler que si on demande un rond, un cercle, ou de tourner autour de quelque chose.",
    parameters: {
      type: 'object',
      properties: {
        radius_cm: {
          type: 'integer',
          minimum: 10,
          maximum: 100,
          description: 'Rayon du rond en cm (10 = tout petit, 100 = large).',
        },
        turns: {
          type: 'number',
          minimum: 0.25,
          maximum: 3,
          description: 'Nombre de tours (1 = un rond complet, défaut 1).',
        },
        dir: { type: 'string', enum: ['left', 'right'], description: 'Sens du rond.' },
        speed: {
          type: 'string',
          enum: ['slow', 'normal', 'fast'],
          description:
            "Allure. normal par défaut ; fast = à fond, pour frimer ; slow = tout doux.",
        },
      },
      required: ['radius_cm', 'dir'],
    },
  },
  {
    name: 'nod',
    description: 'DÉPLACEMENT RÉEL : hoche la tête (oui) en basculant sur ses roues.',
  },
  { name: 'bow', description: 'DÉPLACEMENT RÉEL : fait une révérence.' },
  { name: 'wiggle', description: 'DÉPLACEMENT RÉEL : se dandine (frétille) de façon rigolote.' },
  // --- Emotes (petites particules expressives autour de Mochi) ---
  {
    name: 'emote',
    description:
      "Fait jaillir de petites particules autour de Mochi pour souligner une émotion FORTE. À utiliser avec parcimonie, sur les moments marquants (pas à chaque phrase).",
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['hearts', 'sparkles', 'notes', 'sweat', 'question', 'exclaim', 'rain'],
          description:
            "hearts=amour/adoration, sparkles=fierté/joie, notes=chantonne/joueur, sweat=gêné, question=perplexe, exclaim=surprise, rain=tout triste.",
        },
      },
      required: ['kind'],
    },
  },
];
