/**
 * Où vit la clé Gemini — et pourquoi elle vit là.
 *
 * Elle est stockée dans le `localStorage` DU TÉLÉPHONE, saisie une fois dans le
 * panneau debug. Ça ressemble à un recul par rapport à un jeton éphémère fabriqué
 * côté serveur (ce que faisait le déploiement OVH, retiré depuis), ça n'en est
 * pas un :
 *
 *  - le `localStorage` est cloisonné par ORIGINE et par APPAREIL. Un visiteur de
 *    la page publique reçoit une app sans clé, qui lui en demande une ; la tienne
 *    n'a jamais été déployée nulle part.
 *  - elle est donc exactement aussi exposée que le `.env.local` du PC — c'est-à-
 *    dire pas — alors qu'une clé mise en dur dans un binaire distribué (APK,
 *    bundle public) se lit en trente secondes.
 *  - et surtout : plus besoin de PHP, donc l'app peut être posée sur n'importe
 *    quel hébergement statique. C'est ce qui la rend autonome.
 *
 * ⚠️ Contrepartie honnête : tout JS tournant sur cette origine peut la lire. Un
 * plafond de quota côté Google Cloud borne les dégâts si un jour un build
 * compromis part en ligne. Pour une clé de robot perso, c'est proportionné.
 *
 * C'est désormais le SEUL accès à Gemini : sans clé saisie, la voix Live est
 * indisponible et l'agent texte retombe sur les mots-clés locaux.
 */

const STORAGE_KEY = 'mochi.geminiKey';

/** D'où vient la clé qu'on utilise — pour le dire à l'écran plutôt que le deviner. */
export type KeySource = 'stockée' | '.env.local' | 'aucune';

/**
 * La clé courante, et sa provenance.
 *
 * Le `localStorage` PASSE AVANT `.env.local` : saisir une clé dans le panneau est
 * un geste explicite, il doit gagner. Comme les deux peuvent coexister sur le PC
 * de dev, la provenance est journalisée au démarrage — sinon « ce n'est pas la
 * clé que je crois » est indétectable.
 */
export function loadGeminiKey(): { key?: string; source: KeySource } {
  const stored = read();
  if (stored) return { key: stored, source: 'stockée' };

  // Confort de dev conservé tel quel : `.env.local` continue de marcher sans
  // rien saisir. Jamais référencé en build de prod, donc jamais inliné.
  if (import.meta.env.DEV) {
    const fromEnv = (import.meta.env.VITE_GEMINI_API_KEY as string | undefined)?.trim();
    if (fromEnv) return { key: fromEnv, source: '.env.local' };
  }
  return { source: 'aucune' };
}

/** Y a-t-il une clé saisie sur CET appareil ? (indépendant de `.env.local`) */
export function hasStoredKey(): boolean {
  return !!read();
}

/** Enregistre (ou efface, si vide) la clé sur cet appareil. */
export function saveGeminiKey(key: string): void {
  const clean = key.trim();
  try {
    if (clean) localStorage.setItem(STORAGE_KEY, clean);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Stockage refusé (navigation privée) : on ne casse pas l'app pour ça.
  }
}

function read(): string | undefined {
  try {
    return localStorage.getItem(STORAGE_KEY)?.trim() || undefined;
  } catch {
    return undefined;
  }
}
