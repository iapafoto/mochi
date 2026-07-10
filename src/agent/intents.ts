// Vocabulaire d'intentions — défini UNE fois, exposé à Gemini comme
// functionDeclarations, dispatché vers visage (réel) / son / transport (mock v1).
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
    description: 'Oriente le regard de Mochi dans une direction.',
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
  // --- Mouvement (mocké en v1, BLE en v2) ---
  {
    name: 'forward',
    description: 'Avance de N centimètres (mouvement mocké en v1).',
    parameters: {
      type: 'object',
      properties: { cm: { type: 'integer', description: 'Distance en cm.' } },
      required: ['cm'],
    },
  },
  {
    name: 'backward',
    description: 'Recule de N centimètres.',
    parameters: {
      type: 'object',
      properties: { cm: { type: 'integer', description: 'Distance en cm.' } },
      required: ['cm'],
    },
  },
  {
    name: 'turn',
    description: 'Pivote de N degrés (positif = droite, négatif = gauche).',
    parameters: {
      type: 'object',
      properties: { deg: { type: 'integer', description: 'Angle en degrés.' } },
      required: ['deg'],
    },
  },
  { name: 'nod', description: 'Hoche la tête (oui) — geste numéro de cirque.' },
  { name: 'bow', description: 'Fait une révérence.' },
  { name: 'wiggle', description: 'Se dandine (frétille) de façon rigolote.' },
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
