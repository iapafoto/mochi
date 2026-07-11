import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Le port peut être imposé par l'environnement (préview Claude avec autoPort :
// il fournit un port libre via PORT). Sinon, 5173 par défaut en local.
const port = process.env.PORT ? Number(process.env.PORT) : 5173;

// HTTPS optionnel (certificat auto-signé) : nécessaire pour tester le MICRO sur
// un téléphone via le WiFi (getUserMedia exige un contexte sécurisé). Activé par
// `npm run dev:https`. Le `npm run dev` classique reste en HTTP (rapide).
const https = !!process.env.HTTPS;

export default defineConfig({
  plugins: https ? [basicSsl()] : [],
  server: {
    port,
    host: true,
    // Le navigateur du pane de preview met en cache les modules ES sans
    // revalider : on désactive tout cache en dev pour toujours servir le code frais.
    headers: { 'Cache-Control': 'no-store' },
  },
  // Import de fichiers .frag/.vert comme chaînes brutes (shaders WebGL).
  assetsInclude: ['**/*.frag', '**/*.vert'],
});
