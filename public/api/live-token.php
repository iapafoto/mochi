<?php
/**
 * Mochi — fabrique un jeton éphémère Gemini Live pour le navigateur.
 *
 * Le navigateur NE reçoit JAMAIS la vraie clé : il appelle cet endpoint, qui
 * crée côté serveur un jeton court (usage unique, ~10 min). Le client ouvre la
 * session Live avec ce jeton ; le flux audio reste direct navigateur ↔ Google
 * (donc la latence n'est pas dégradée).
 *
 * OÙ METTRE LA CLÉ (par ordre de préférence) :
 *  1. Variable d'environnement GEMINI_API_KEY.
 *  2. Un fichier .gemini-key (une clé par ligne, la 1re est utilisée) déposé
 *     AU-DESSUS du webroot → non téléchargeable en HTTP. Ce script tente
 *     automatiquement plusieurs emplacements et, s'il ne trouve rien, il AFFICHE
 *     la liste exacte des chemins essayés (ouvre l'URL du endpoint directement).
 *
 * Marche que l'app soit déployée à la racine du domaine ou dans un sous-dossier
 * (ex. /mochi/) : les emplacements testés sont calculés dynamiquement.
 */

header('Content-Type: text/plain; charset=utf-8');
header('Cache-Control: no-store');

// ── 1) Récupère la clé : env d'abord, sinon fichier hors webroot ────────────
$key = getenv('GEMINI_API_KEY');
$key = $key ? trim($key) : '';

$docroot = isset($_SERVER['DOCUMENT_ROOT']) ? rtrim($_SERVER['DOCUMENT_ROOT'], '/') : '';
$candidates = array_values(array_filter([
    $docroot ? dirname($docroot) . '/.gemini-key' : null, // au-dessus du webroot (RECOMMANDÉ, non servi)
    $docroot ? $docroot . '/.gemini-key' : null,          // racine du webroot
    __DIR__ . '/../../.gemini-key',                        // 2 crans au-dessus du .php
    __DIR__ . '/../../../.gemini-key',                     // 3 crans (déploiement en sous-dossier)
]));

$checked = [];
if ($key === '') {
    foreach ($candidates as $f) {
        $checked[] = $f;
        if (is_readable($f)) {
            $line = strtok(trim(file_get_contents($f)), "\n"); // 1re ligne non vide
            if ($line !== false && trim($line) !== '') { $key = trim($line); break; }
        }
    }
}

if ($key === '') {
    http_response_code(500);
    echo "cle Gemini absente cote serveur.\n";
    echo "Definis la variable d'env GEMINI_API_KEY, ou depose un fichier .gemini-key\n";
    echo "(ta cle sur la 1re ligne) a l'un de ces emplacements :\n";
    foreach ($checked as $c) echo "  - $c\n";
    echo "Le 1er de la liste (au-dessus du webroot) est le plus sur.\n";
    exit;
}

// ── 2) Crée un jeton éphémère (Gemini Developer API, v1alpha) ────────────────
$url = 'https://generativelanguage.googleapis.com/v1alpha/auth_tokens?key=' . urlencode($key);
$payload = json_encode([
    'uses'       => 1,                                       // usage unique
    'expireTime' => gmdate('Y-m-d\TH:i:s\Z', time() + 600), // valable 10 min
]);

$resp = false;
$code = 0;

if (function_exists('curl_init')) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
    ]);
    $resp = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
} else {
    // Fallback si l'extension cURL n'est pas activée sur l'hébergement.
    $ctx = stream_context_create(['http' => [
        'method'        => 'POST',
        'header'        => "Content-Type: application/json\r\n",
        'content'       => $payload,
        'timeout'       => 10,
        'ignore_errors' => true,
    ]]);
    $resp = @file_get_contents($url, false, $ctx);
    if (isset($http_response_header[0]) && preg_match('#\s(\d{3})\s#', $http_response_header[0], $m)) {
        $code = (int) $m[1];
    }
}

if ($resp === false || $code >= 400) {
    http_response_code(502);
    echo "echec creation du jeton (HTTP $code)\n";
    if (is_string($resp) && $resp !== '') echo substr($resp, 0, 400); // aide au diag (derriere Basic Auth)
    exit;
}

// ── 3) Renvoie le nom du jeton (ce que le client passe comme "apiKey") ───────
$json = json_decode($resp, true);
echo isset($json['name']) ? $json['name'] : '';
