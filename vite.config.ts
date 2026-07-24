import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Le port peut être imposé par l'environnement (préview Claude avec autoPort :
// il fournit un port libre via PORT). Sinon, 5173 par défaut en local.
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

// En local, on FIGE le port sur 5173 pour que l'URL du téléphone ne change jamais
// (`https://<ip>:5173/mochi/`). Sans ça, si 5173 est occupé Vite glisse en 5174 et
// l'URL change. strictPort => si 5173 est déjà pris (vieux serveur resté ouvert),
// le lancement échoue avec un message clair au lieu de changer de port en silence.
// On ne force PAS le strict quand un PORT externe est fourni (preview Claude).
const strictPort = !process.env.PORT;

// HTTPS optionnel (certificat auto-signé) : nécessaire pour tester le MICRO sur
// un téléphone via le WiFi (getUserMedia exige un contexte sécurisé). Activé par
// `npm run dev:https`. Le `npm run dev` classique reste en HTTP (rapide).
const https = !!process.env.HTTPS;

export default defineConfig({
  // Chemin public sous lequel l'app est servie. En prod, Mochi est déployé dans
  // le sous-dossier /mochi/ (iapafoto.ovh/mochi/) → sans ça, les imports pointent
  // sur la racine (/assets/...) et donnent des 404. Adapter si le dossier change.
  // (En dev, Vite sert à la racine du serveur local, ce base est sans effet gênant.)
  base: '/mochi/',
  plugins: https ? [basicSsl()] : [],
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
