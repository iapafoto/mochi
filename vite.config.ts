import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// Tampon de build affiché dans le panneau debug. C'est la même leçon que
// `strictPort` plus bas : après un déploiement, « est-ce que ma version est
// passée ? » doit se répondre d'un COUP D'ŒIL. Sans ce tampon, un service worker
// qui sert encore l'ancien cache est indiscernable d'un build cassé — et on
// cherche une demi-heure du côté du code alors que tout va bien.
function buildId(): string {
  let hash = 'sans-git';
  try {
    hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // Pas de dépôt (archive, CI minimale) : l'horodatage suffit à trancher.
  }
  return `${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${hash}`;
}

// PORT CANONIQUE DU PROJET : 5174. C'est l'adresse enregistrée sur le téléphone
// (`https://<ip>:5174/mochi/`), là où s'affiche le visage de Mochi — elle ne doit
// donc jamais bouger. Un PORT dans l'environnement reste prioritaire (preview).
const port = process.env.PORT ? Number(process.env.PORT) : 5174;

// strictPort TOUJOURS, y compris quand le port vient de l'environnement.
// ⚠️ Le défaut de Vite est de GLISSER sur le port suivant quand le sien est pris.
// C'est exactement ce qui fait qu'on se retrouve un jour à servir sur 5175 pendant
// que le téléphone interroge 5174 et affiche une page blanche — sans rien dans les
// logs, puisque de son point de vue tout va bien. Échouer au lancement avec
// « port is already in use » coûte dix secondes ; l'URL qui bouge en silence coûte
// une demi-heure. Si ça refuse de démarrer : un vieux serveur traîne encore.
const strictPort = true;

// HTTPS optionnel (certificat auto-signé) : nécessaire pour tester le MICRO sur
// un téléphone via le WiFi (getUserMedia exige un contexte sécurisé). Activé par
// `npm run dev:https`. Le `npm run dev` classique reste en HTTP (rapide).
const https = !!process.env.HTTPS;

export default defineConfig({
  // Chemin public sous lequel l'app est servie. En prod, Mochi vit dans le
  // sous-dossier /mochi/ → sans ça, les imports pointent sur la racine
  // (/assets/...) et donnent des 404.
  //
  // ⚠️ UNE SEULE VALEUR POUR LES DEUX CIBLES, et c'est délibéré :
  //   • OVH            → iapafoto.ovh/mochi/
  //   • GitHub Pages   → iapafoto.github.io/mochi/
  // Ça n'est vrai que parce que le DÉPÔT s'appelle `mochi` EN MINUSCULES : Pages
  // sert sous le nom du dépôt et github.io est sensible à la casse. Un dépôt
  // nommé `Mochi` obligerait à faire varier ce chemin selon la cible — deux
  // valeurs à tenir, et un déploiement qui « réussit » en servant des 404
  // partout. Si tu renommes le dépôt, renomme-le en minuscules.
  // (En dev, Vite sert à la racine du serveur local : sans effet gênant.)
  base: '/mochi/',
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  plugins: [
    ...(https ? [basicSsl()] : []),
    // Service worker : ce qui rend l'app installable et surtout indépendante du
    // réseau AU MOMENT DE LA DÉMO. Une démo se fait ailleurs, sur le wifi de
    // quelqu'un d'autre : sans cache, un réseau capricieux et la page ne charge
    // pas du tout. Avec, le visage, le BLE et l'agent local démarrent quoi qu'il
    // arrive — seule la voix Gemini, qui a vraiment besoin d'Internet, tombe.
    VitePWA({
      // ⚠️ 'prompt' ne veut PAS dire « affiche une bannière » : ça veut dire
      // « ne bascule pas tout seul, rends-moi la main ». C'est main.ts qui
      // décide QUAND appliquer, et il attend que Mochi soit au repos — un
      // rechargement au milieu d'une conversation couperait la session Live et
      // le lien BLE, c'est-à-dire Mochi qui s'éteint en pleine phrase.
      registerType: 'prompt',
      injectRegister: null, // on enregistre à la main (cf. src/pwa.ts)
      // Le manifeste est écrit à la main dans public/ et référencé par
      // index.html : pas question d'en laisser générer un second qui entrerait
      // en concurrence avec lui.
      manifest: false,
      workbox: {
        // Le shader (?raw) et le worklet audio (data: URL) sont inlinés dans le
        // bundle par Vite : il n'y a rien d'autre à précacher que ces quatre-là.
        globPatterns: ['**/*.{js,css,html,svg,webmanifest}'],
        globIgnores: ['**/api/**', '**/.ht*'], // jamais le PHP ni les fichiers Apache
        navigateFallback: 'index.html',
      },
      // Surtout pas de service worker en dev : il servirait un cache pendant
      // qu'on édite, ce que le `Cache-Control: no-store` ci-dessous cherche
      // précisément à éviter.
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port,
    strictPort,
    host: true,
    // Le navigateur du pane de preview met en cache les modules ES sans
    // revalider : on désactive tout cache en dev pour toujours servir le code frais.
    headers: { 'Cache-Control': 'no-store' },
  },
  // Import de fichiers .frag/.vert comme chaînes brutes (shaders WebGL).
  assetsInclude: ['**/*.frag', '**/*.vert'],
});
