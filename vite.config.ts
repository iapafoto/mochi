import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

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
