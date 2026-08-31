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
 * D'où le réglage retenu : appliquer TOUT DE SUITE, mais jamais pendant que
 * Mochi est occupé. Un rechargement au milieu d'une conversation couperait la
 * session Live ET le lien BLE — Mochi qui s'éteint en pleine phrase.
 *
 * Si l'occasion ne se présente jamais, on ne perd rien : le service worker en
 * attente s'activera de lui-même au prochain lancement à froid, ce qui est
 * exactement le rythme d'usage (le téléphone est posé sur Mochi le temps d'une
 * démo, puis l'app est refermée).
 */
export interface PwaHooks {
  /** Mochi est-il en train de parler ou de rouler ? Si oui, on ne recharge pas. */
  busy(): boolean;
  log(line: string): void;
}

/** Fréquence de la seconde chance quand la mise à jour est arrivée en pleine démo. */
const RETRY_MS = 5000;

/**
 * Délai au-delà duquel on applique la mise à jour MÊME SI Mochi paraît occupé.
 *
 * ⚠️ FILET CONTRE LA PANNE QU'ON VIENT DE SUBIR. `busy()` est une heuristique, et
 * une heuristique peut rester vraie pour toujours : le démarrage automatique
 * ouvrait la conversation dès le lancement, donc « occupé » ne redevenait jamais
 * faux, et un téléphone est resté bloqué TROIS versions en arrière sans que rien
 * ne l'explique. Le commentaire au-dessus pariait sur « le prochain lancement à
 * froid » — pari perdu : sur Android, refermer l'appli ne libère pas forcément le
 * client, et le service worker en attente attend encore.
 *
 * Corriger `busy()` était nécessaire mais pas suffisant : la prochaine condition
 * qu'on oubliera de relâcher produirait la même panne muette. Une échéance ferme,
 * elle, garantit qu'aucune version ne peut rester coincée — au pire on recharge à
 * un moment un peu impoli, ce qui est infiniment moins grave que de tester
 * pendant une heure un correctif qui n'est pas là.
 */
const FORCE_AFTER_MS = 120000;

export function setupPwa(hooks: PwaHooks): void {
  // Pas de service worker en dev (cf. `devOptions` dans vite.config.ts). On sort
  // AVANT la demande de stockage durable : au banc il n'y a ni cache à protéger
  // ni clé stockée (elle vient de .env.local), donc l'avertissement n'aurait
  // aucune suite possible — et une ligne inutile répétée à chaque rechargement
  // est exactement ce qui apprend à ne plus lire le journal.
  if (!import.meta.env.PROD) return;

  void requestPersistentStorage(hooks.log);

  let pending = false;
  let announced = false;
  let pendingSince = 0;

  const updateSW = registerSW({
    onNeedRefresh() {
      pending = true;
      pendingSince = Date.now();
      tryApply();
    },
    onOfflineReady() {
      hooks.log('📦 app en cache — elle démarrera même sans réseau');
    },
    onRegisterError(err: unknown) {
      hooks.log(`⚠ service worker non enregistré : ${(err as Error).message}`);
    },
  });

  function tryApply(): void {
    if (!pending) return;
    const forced = Date.now() - pendingSince >= FORCE_AFTER_MS;
    if (hooks.busy() && !forced) {
      // Une SEULE annonce, puis on retente en silence : répéter la ligne toutes
      // les 5 s noierait le journal pendant toute la démo.
      if (!announced) {
        announced = true;
        hooks.log('⬆ mise à jour prête — elle s\'appliquera dès que Mochi sera au repos');
      }
      setTimeout(tryApply, RETRY_MS);
      return;
    }
    pending = false;
    hooks.log(forced ? '⬆ mise à jour forcée après 2 min : rechargement…' : '⬆ mise à jour : rechargement…');
    void updateSW(true); // skipWaiting + reload
  }
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
