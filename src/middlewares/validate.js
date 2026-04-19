/**
 * Utilitaires de validation et format d'erreur standardisé.
 *
 * Format d'erreur JSON uniforme :
 * {
 *   "error": {
 *     "code":    "VALIDATION_ERROR",   // constante machine
 *     "message": "Description lisible",
 *     "fields":  { "name": "requis" }  // optionnel, détail par champ
 *   }
 * }
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFER_CODE_RE = /^[A-Z0-9_-]{1,32}$/;

/** Construit une réponse d'erreur standardisée. */
function apiError(res, status, code, message, fields = undefined) {
  const body = { error: { code, message } };
  if (fields) body.error.fields = fields;
  return res.status(status).json(body);
}

/** Erreurs prédéfinies fréquentes. */
const Errors = {
  missingField: (res, ...fieldNames) =>
    apiError(res, 400, 'MISSING_FIELD',
      `Champ(s) requis manquant(s): ${fieldNames.join(', ')}`,
      Object.fromEntries(fieldNames.map(f => [f, 'requis']))),

  invalidUuid: (res, field = 'agentId') =>
    apiError(res, 400, 'INVALID_UUID',
      `${field} doit être un UUID v4 valide`),

  invalidType: (res, field, expected) =>
    apiError(res, 400, 'INVALID_TYPE',
      `${field} doit être de type ${expected}`),

  notFound: (res, resource) =>
    apiError(res, 404, 'NOT_FOUND', `${resource} introuvable`),

  conflict: (res, message) =>
    apiError(res, 409, 'CONFLICT', message),

  quotaReached: (res, quota, active) =>
    apiError(res, 429, 'QUOTA_REACHED',
      `Quota de pauses atteint pour cette offre (${active}/${quota})`,
      { quota, active }),

  unauthorized: (res) =>
    apiError(res, 401, 'UNAUTHORIZED', 'Authentification requise'),

  forbidden: (res) =>
    apiError(res, 403, 'FORBIDDEN', 'Accès refusé'),

  internal: (res, err) => {
    console.error('[API Error]', err);
    return apiError(res, 500, 'INTERNAL_ERROR', 'Erreur serveur interne');
  },
};

/** Valide qu'une valeur est un UUID v4. */
function isValidUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Valide qu'un code offre respecte le format attendu. */
function isValidOfferCode(v) {
  return typeof v === 'string' && OFFER_CODE_RE.test(v);
}

/** Valide qu'une valeur est un entier positif ou nul. */
function isPositiveInt(v) {
  return Number.isInteger(v) && v >= 0;
}

/** Valide qu'une valeur est un float entre 0 et 100. */
function isPercent(v) {
  return typeof v === 'number' && v >= 0 && v <= 100;
}

/** Tronque et nettoie un nom saisi. */
function sanitizeName(v) {
  return typeof v === 'string' ? v.trim().slice(0, 100) : '';
}

module.exports = { apiError, Errors, isValidUuid, isValidOfferCode, isPositiveInt, isPercent, sanitizeName };
