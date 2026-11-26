'use strict';

/**
 * Génère le script servi sur GET /fixi-loader.js.
 *
 * Les pages de Flowi sont statiques : elles ne peuvent pas recevoir la clé Fixi côté serveur.
 * Ce petit script crée la balise du widget Fixi avec la configuration du .env.
 * Il définit toujours window.fixiSetUser(name) : sans configuration, la fonction ne fait rien,
 * et les pages l'appellent sans test préalable.
 */

type FixiLoaderOptions = {
  widgetUrl: string;
  apiKey: string;
  version: string;
};

/** Clés caviardées par le widget dans les URL, corps et réponses (comparaison exacte, sans casse). */
const REDACT_KEYS = 'query,agent_matricule,matricule,nom,prenom';

/**
 * Littéral JavaScript sûr dans un <script> : JSON.stringify échappe les guillemets,
 * puis chaque « < » devient < pour qu'aucune valeur ne puisse écrire </script>.
 * Exemple : '</script>' → "</script>"
 */
function jsString(value: string): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function buildFixiLoader({ widgetUrl, apiKey, version }: FixiLoaderOptions): string {
  const url = typeof widgetUrl === 'string' ? widgetUrl.trim() : '';
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';

  if (!url || !key) {
    return [
      '// Fixi désactivé : FIXI_WIDGET_URL ou FIXI_API_KEY absent.',
      'window.fixiSetUser = function () {};',
      '',
    ].join('\n');
  }

  return `(function () {
  var s = document.createElement('script');
  s.src = ${jsString(url)};
  s.setAttribute('data-app', 'flowi');
  s.setAttribute('data-api-key', ${jsString(key)});
  s.setAttribute('data-version', ${jsString(version)});
  s.setAttribute('data-redact-keys', ${jsString(REDACT_KEYS)});
  document.head.appendChild(s);
  window.fixiSetUser = function (name) {
    if (name) s.setAttribute('data-user', String(name));
    else s.removeAttribute('data-user');
  };
})();
`;
}

module.exports = { buildFixiLoader, REDACT_KEYS };
