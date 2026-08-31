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
    description:
      "Cligne des yeux. Sans `side` : un petit clignement mignon. Avec `side` : un CLIN D'ŒIL "
      + 'complice, sur cet œil-là — la nuance est dans l’intention, pas dans le mécanisme.',
    parameters: {
      type: 'object',
      properties: {
        side: {
          type: 'string',
          enum: ['left', 'right'],
          description: "Un seul œil = clin d'œil complice. Omets-le pour un clignement ordinaire.",
        },
      },
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
  // --- Mise en route du corps -------------------------------------------------
  //
  // ⚠️ CES DEUX-LÀ SONT TOUJOURS EXPOSÉES, alors qu'elles n'ont de sens que dans un
  // état précis. L'idée d'une liste d'outils qui change avec l'état est bonne, mais
  // les outils sont figés à l'ouverture de la session Live : en changer voudrait
  // dire reconnecter, donc perdre le fil de la conversation. Elle est de toute
  // façon devenue inutile — Mochi SAIT en permanence où en est son corps (canal
  // [[…]]) et un refus lui revient avec sa raison. La liste n'a plus à encoder la
  // machine à états.
  {
    name: 'arm',
    description:
      "Met le corps sous tension (ou le coupe). TANT QUE CE N'EST PAS FAIT, AUCUN DÉPLACEMENT "
      + "N'A LIEU — le robot démarre toujours désarmé. Appelle-la dès qu'on te demande de te mettre "
      + 'debout, de te réveiller, de démarrer, ou quand on te demande de bouger alors qu’on vient de '
      + 'te dire que tu es désarmé. Désarmer le fait s’asseoir : à faire quand on te dit de te reposer.',
    parameters: {
      type: 'object',
      properties: {
        on: { type: 'boolean', description: 'true = sous tension, false = au repos.' },
      },
      required: ['on'],
    },
  },
  {
    name: 'set_zero',
    description:
      "Règle le point d'équilibre : la position dans laquelle on te tient DEVIENT ta verticale. "
      + "Ne se fait que robot TENU EN MAIN et bien droit — dis-le à voix haute avant, et attends "
      + "qu'on te tienne. À proposer si tu penches toujours du même côté ou si tu n'arrives plus à "
      + 'tenir debout ; sinon, n’y touche pas, un réglage inutile ne peut que le dégrader.',
  },
  // --- Déplacement RÉEL (BLE → ESP32) ---
  {
    name: 'stop',
    description:
      "ARRÊT IMMÉDIAT de tout déplacement en cours (il reste debout). Appelle-la dès qu'on te dit "
      + "« stop », « arrête », « attends », ou dès que quelque chose semble mal tourner. "
      + "Elle ne coûte rien et n'a aucun effet s'il ne bouge pas : dans le doute, appelle-la.",
  },
  {
    // `forward` et `backward` étaient deux fonctions pour un seul mouvement. Une
    // distance SIGNÉE suffit — et `turn` le faisait déjà avec un angle signé, donc
    // la paire était en plus incohérente avec sa voisine.
    name: 'move',
    description:
      'DÉPLACEMENT RÉEL, MESURÉ : parcourt N centimètres et s’arrête à la bonne distance '
      + '(positif = avance, négatif = recule). À n’appeler que si on demande de bouger.',
    parameters: {
      type: 'object',
      properties: {
        cm: { type: 'integer', description: 'Distance en cm ; négatif pour reculer.' },
        speed: MOVE_SPEED_PARAM,
      },
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
    name: 'path',
    description:
      "DÉPLACEMENT RÉEL : trace une FORME au sol, d'un seul mouvement fluide, décrite par un chemin "
      + "SVG. C'est ce qu'il faut pour un huit, une spirale, un cœur, un zigzag, une boucle — tout ce "
      + "qu'une suite d'avances et de virages rendrait saccadé. "
      + "La forme est tracée DEPUIS l'endroit où il se trouve et DANS LA DIRECTION où il regarde : le "
      + "point de départ du chemin et son orientation n'ont pas d'importance, seule compte la forme. "
      + "Dans le dessin, le haut = devant lui. À n'appeler que si on demande de bouger ou de faire un numéro.",
    parameters: {
      type: 'object',
      properties: {
        d: {
          type: 'string',
          description:
            "Chemin SVG (attribut d). Commandes acceptées : M L H V C S Q T A Z, absolues ou relatives. "
            + "Exemples : un carré « M0,0 L100,0 L100,100 L0,100 Z » ; un huit "
            + "« M50,0 C100,0 100,50 50,50 C0,50 0,100 50,100 » ; une vague « M0,0 q25,-40 50,0 t50,0 ».",
        },
        size_cm: {
          type: 'integer',
          minimum: 20,
          maximum: 200,
          description:
            'Taille de la forme au sol : sa plus grande dimension, en cm. Défaut 50. '
            + "Vois grand si on te demande une grande figure — la longueur du tracé n'est pas rationnée, "
            + "on peut t'arrêter à tout moment.",
        },
        speed: {
          type: 'string',
          enum: ['slow', 'normal', 'fast'],
          description: "Allure du tracé. normal par défaut ; fast pour frimer, slow pour être précis.",
        },
      },
      required: ['d'],
    },
  },
  {
    // `nod`, `bow` et `wiggle` etaient trois fonctions sans parametre pour la meme
    // chose : declencher un geste scripte du firmware. Un enum, comme `emote`.
    name: 'gesture',
    description:
      'DÉPLACEMENT RÉEL : un petit geste du corps, sur place. À n’appeler que si on demande de bouger '
      + 'ou de réagir physiquement.',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['nod', 'bow', 'wiggle'],
          description: 'nod = hoche la tête (oui), bow = révérence, wiggle = se dandine.',
        },
      },
      required: ['kind'],
    },
  },
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
