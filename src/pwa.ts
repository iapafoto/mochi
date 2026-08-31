import { registerSW } from 'virtual:pwa-register';

/**
 * Service worker : installation, cache durable, et surtout POLITIQUE DE MISE À
 * JOUR — c'est-à-dire le moment où l'on bascule sur le nouveau code.
 *
 * Le piège, si on ne fait rien : un nouveau service worker s'installe en tâche
 * de fond puis passe en « waiting » et s'arrête là, parce qu'il refuse de prendre
 * la main tant qu'un client de l'ancien tourne. L'app continue donc de servir
 * L'ANCIEN CODE, sans rien signaler. On pousse, on relance, on voit l'ancienne
 * version, et on conclut que le build est cassé. C'est la même panne silencieuse
 * que le port qui glisse de 5174 à 5175 (cf. vite.config.ts) : de son point de
 * vue tout va bien, et c'est bien ça qui coûte la demi-heure.
 *
 * LA RÈGLE, ET ELLE TIENT EN UNE LIGNE : on applique dès que c'est disponible.
 *
 * ⚠️ IL Y AVAIT ICI TOUTE UNE MÉCANIQUE — un test « Mochi est-il occupé ? », une
 * reprise toutes les 5 s, une échéance de forçage — pour éviter de recharger au
 * milieu d'une phrase. Elle a produit exactement la panne qu'elle prétendait
 * empêcher : le démarrage automatique ouvre la conversation dès le lancement,
 * donc « occupé » était vrai en PERMANENCE, et un téléphone est resté bloqué
 * trois versions en arrière sans que rien ne l'explique. La garde a coûté
 * infiniment plus cher que ce qu'elle protégeait.
 *
 * Ce qu'elle protégeait, d'ailleurs, n'existe presque pas : le service worker
 * signale la mise à jour dans les secondes qui suivent le chargement — donc au
 * lancement, quand il ne se passe encore rien. Et si un rechargement tombe malgré
 * tout pendant une démo, on perd deux secondes et l'app rouvre la conversation
 * toute seule. C'est le rythme d'usage : le téléphone est posé sur Mochi le temps
 * d'une démo, et on relance l'appli à ce moment-là.
 */
export interface PwaHooks {
  log(line: string): void;
}

export function setupPwa(hooks: PwaHooks): void {
  // Pas de service worker en dev (cf. `devOptions` dans vite.config.ts). On sort
  // AVANT la demande de stockage durable : au banc il n'y a ni cache à protéger
  // ni clé stockée (elle vient de .env.local), donc l'avertissement n'aurait
  // aucune suite possible — et une ligne inutile répétée à chaque rechargement
  // est exactement ce qui apprend à ne plus lire le journal.
  if (!import.meta.env.PROD) return;

  void requestPersistentStorage(hooks.log);

  const updateSW = registerSW({
    onNeedRefresh() {
      hooks.log('⬆ mise à jour : rechargement…');
      void updateSW(true); // skipWaiting + reload
    },
    onOfflineReady() {
      hooks.log('📦 app en cache — elle démarrera même sans réseau');
    },
    onRegisterError(err: unknown) {
      hooks.log(`⚠ service worker non enregistré : ${(err as Error).message}`);
    },
  });
}

/**
 * Demande un stockage DURABLE.
 *
 * Sans ça, Chrome peut évincer le cache sous pression de stockage — et sur un
 * téléphone du quotidien, plein de photos et d'applis, ça arrive vraiment. Deux
 * choses partent ensemble ce jour-là : l'app (qui redevient dépendante du réseau)
 * et la clé Gemini du `localStorage`, qu'il faut retaper. Autant un soir de démo.
 *
 * Une PWA installée l'obtient en général sans rien demander ; l'appel ne coûte
 * rien et couvre le cas où elle ne l'est pas encore.
 */
async function requestPersistentStorage(log: (line: string) => void): Promise<void> {
  if (!navigator.storage?.persist) return;
  try {
    if (await navigator.storage.persisted()) return;
    const granted = await navigator.storage.persist();
    if (!granted) log('ℹ stockage non durable — le cache et la clé peuvent être évincés');
  } catch {
    // API refusée ou indisponible : sans conséquence, on n'en parle pas.
  }
}
