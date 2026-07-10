<?php
/**
 * Mochi — fabrique un jeton éphémère Gemini Live pour le navigateur.
 *
 * Le navigateur NE reçoit JAMAIS la vraie clé : il appelle cet endpoint, qui
 * crée côté serveur un jeton court (usage unique, ~10 min). Le client ouvre la
 * session Live avec ce jeton ; le flux audio reste direct navigateur ↔ Google
 * (donc la latence n'est pas dégradée).
 *
 * DÉPLOIEMENT (OVH mutualisé) :
 *  1. `npm run build` → copie le contenu de `dist/` dans ton `www/`.
 *     Cet endpoint se retrouve alors à `www/api/live-token.php`.
 *  2. Mets ta VRAIE clé Gemini dans un fichier HORS de `www/`, une clé par
 *     ligne, p.ex. `~/.gemini-key` (au-dessus de www → non servi en HTTP).
 *     Ou définis la variable d'environnement GEMINI_API_KEY.
 *  3. Ne mets JAMAIS la clé dans .env.local au moment du build : le bundle prod
 *     n'en a pas besoin (il passe par ce jeton).
 */

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');

// 1) Récupère la clé : variable d'env d'abord, sinon fichier hors webroot.
$key = getenv('GEMINI_API_KEY');
if (!$key) {
    $keyFile = __DIR__ . '/../../.gemini-key'; // au-dessus de www/ (adapte si besoin)
    if (is_readable($keyFile)) {
        $key = trim(file_get_contents($keyFile));
    }
}
if (!$key) {
    http_response_code(500);
    echo 'cle Gemini absente cote serveur';
    exit;
}

// 2) Crée un jeton éphémère (Gemini Developer API, v1alpha).
$payload = json_encode([
    'uses'       => 1,                                       // usage unique
    'expireTime' => gmdate('Y-m-d\TH:i:s\Z', time() + 600), // valable 10 min
]);

$ch = curl_init('https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=' . urlencode($key));
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $payload,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 10,
]);
$resp = curl_exec($ch);
$code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($resp === false || $code >= 400) {
    http_response_code(502);
    echo 'echec creation du jeton';
    exit;
}

// 3) Renvoie le nom du jeton (ce que le client passe comme "apiKey").
$json = json_decode($resp, true);
echo isset($json['name']) ? $json['name'] : '';
