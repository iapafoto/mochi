// Réglages de la session Gemini Live — SANS aucune dépendance navigateur.
//
// ⚠️ POURQUOI CE FICHIER EXISTE SÉPARÉMENT DE live.ts. Ce bloc de config part au
// serveur au moment du `connect`, et le serveur peut le REFUSER : un champ qu'il
// n'accepte pas, et la session ne s'ouvre pas du tout — Mochi muet, sur le
// téléphone, sans recours. C'est donc exactement le genre de chose qu'on veut
// pouvoir vérifier avant de déployer.
//
// Or `live.ts` importe le micro et le lecteur audio, donc `window` et
// `AudioContext` : impossible à charger depuis Node. Un banc devrait recopier la
// config… et testerait alors une copie, qui dérive au premier réglage changé ici.
// D'où l'extraction : `scripts/test-live-config.mjs` envoie CE bloc-ci, celui que
// l'application envoie vraiment.

import {
  Modality,
  StartSensitivity,
  EndSensitivity,
  type LiveConnectConfig,
  type ToolListUnion,
} from '@google/genai';

export const LIVE_MODEL = 'gemini-3.1-flash-live-preview';

// Réactivité (détection de fin de parole). Plus `silenceDurationMs` est court,
// plus Mochi rebondit vite quand tu t'arrêtes (spontanéité), au risque de te
// couper si tu marques une pause.
/**
 * ⚠️ 350 ms ÉTAIT TROP COURT POUR UNE INSTRUCTION, et c'est probablement la
 * première cause de « il ne comprend pas ce que je lui demande ». Le serveur clôt
 * ton tour dès qu'il voit ce silence-là : une hésitation ordinaire au milieu d'une
 * phrase — « avance de… trente centimètres » — la coupe en deux, et Gemini répond
 * à la moitié. Plus la demande est longue, plus elle a de pauses, donc plus elle
 * risque d'être tronçonnée : exactement le symptôme décrit.
 *
 * On peut se permettre d'être patient DEPUIS qu'il existe une détection locale :
 * le « mmh ? » part à 240 ms de silence et occupe le temps d'attente, donc
 * allonger ce seuil ne se paie plus par un robot qui a l'air lent. C'est
 * précisément ce que la réactivité locale a acheté.
 */
export const VAD_SILENCE_MS = 650;
/** Durée de parole avant de committer le début de tour. */
export const VAD_PREFIX_MS = 50;

/**
 * Construit la config envoyée à `ai.live.connect`.
 *
 * @param systemInstruction persona + règles + état du corps (cf. persona.ts)
 * @param voiceName voix préfabriquée du modèle (cf. LIVE_VOICES)
 * @param tools déclarations d'outils déjà converties (cf. gemini.ts)
 */
export function liveSessionConfig(
  systemInstruction: string,
  voiceName: string,
  tools: ToolListUnion,
): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction,
    tools,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
    /**
     * ⚠️ SANS ÇA, LA SESSION A UNE DURÉE DE VIE MAXIMALE. Le serveur ferme quand
     * le contexte est plein — au milieu d'une phrase, sans prévenir. C'est le
     * candidat le plus sérieux pour les silences pris pour de la surdité : plus
     * la conversation dure, plus la fin approche.
     *
     * La fenêtre glissante jette les plus vieux tours au lieu de fermer. On perd
     * donc le début des longues conversations — assumé : c'est un robot de jeu,
     * pas un carnet de notes.
     *
     * Ce qu'on NE perd PAS : les instructions système. Elles restent en tête de
     * contexte, hors fenêtre glissante. Le personnage de Mochi survit donc à la
     * compression — sans quoi il cesserait d'être Mochi au bout d'un moment, ce
     * qui serait pire que la coupure qu'on répare ici.
     *
     * Ce qu'on PEUT perdre : les didascalies [[…]], qui sont des tours
     * utilisateur. Après compression, Mochi peut avoir oublié que son corps
     * s'est connecté. Ça se rattrape tout seul — le moindre changement d'état le
     * renotifie (cf. notifyBody dans main.ts), et un déplacement refusé lui
     * revient avec sa raison.
     */
    contextWindowCompression: { slidingWindow: {} },
    // VAD réactif : Mochi répond dès que tu marques un court silence.
    realtimeInputConfig: {
      automaticActivityDetection: {
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_HIGH,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
        prefixPaddingMs: VAD_PREFIX_MS,
        silenceDurationMs: VAD_SILENCE_MS,
      },
    },
  };
}
