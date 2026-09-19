'use strict';

import type { Response } from 'express';
import type { PublicBudget } from '../lib/pauseBudget';
import type { NextOpen } from '../lib/pauseWindows';

const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OFFER_CODE_RE = /^[A-Z0-9_-]{1,32}$/;

function newOfferCode(): string {
  return crypto.randomBytes(6).toString('hex').toUpperCase();
}

function apiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  fields?: Record<string, unknown>
) {
  const body: { error: { code: string; message: string; fields?: Record<string, unknown> } } = {
    error: { code, message },
  };
  if (fields) body.error.fields = fields;
  return res.status(status).json(body);
}

const Errors = {
  missingField: (res: Response, ...fieldNames: string[]) =>
    apiError(res, 400, 'MISSING_FIELD',
      `Champ(s) requis manquant(s): ${fieldNames.join(', ')}`,
      Object.fromEntries(fieldNames.map((f) => [f, 'requis']))),

  invalidUuid: (res: Response, field = 'agentId') =>
    apiError(res, 400, 'INVALID_UUID',
      `${field} doit être un UUID v4 valide`),

  invalidType: (res: Response, field: string, expected: string) =>
    apiError(res, 400, 'INVALID_TYPE',
      `${field} doit être de type ${expected}`),

  notFound: (res: Response, resource: string) =>
    apiError(res, 404, 'NOT_FOUND', `${resource} introuvable`),

  conflict: (res: Response, message: string) =>
    apiError(res, 409, 'CONFLICT', message),

  quotaReached: (res: Response, quota: number, active: number) =>
    apiError(res, 429, 'QUOTA_REACHED',
      `Quota de pauses atteint pour cette offre (${active}/${quota})`,
      { quota, active }),

  outsidePauseWindow: (res: Response, nextOpen?: NextOpen | null) => {
    let message = 'Hors plage de pause.';
    if (nextOpen && nextOpen.hhmm) {
      message = nextOpen.tomorrow
        ? `Hors plage. Prochaine ouverture demain à ${nextOpen.hhmm}.`
        : `Hors plage. Prochaine ouverture à ${nextOpen.hhmm}.`;
    }
    return apiError(res, 409, 'OUTSIDE_PAUSE_WINDOW', message, { nextOpen: nextOpen || null });
  },

  pauseLimitReached: (res: Response, message: string, pauseBudget: PublicBudget | null) =>
    apiError(res, 409, 'PAUSE_LIMIT_REACHED', message, { pauseBudget: pauseBudget || null }),

  unauthorized: (res: Response) =>
    apiError(res, 401, 'UNAUTHORIZED', 'Authentification requise'),

  forbidden: (res: Response) =>
    apiError(res, 403, 'FORBIDDEN', 'Accès refusé'),

  internal: (res: Response, err: unknown) => {
    console.error('[API Error]', err);
    return apiError(res, 500, 'INTERNAL_ERROR', 'Erreur serveur interne');
  },
};

function isValidUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function isValidOfferCode(v: unknown): v is string {
  return typeof v === 'string' && OFFER_CODE_RE.test(v);
}

function isPositiveInt(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 0;
}

function isPercent(v: unknown): v is number {
  return typeof v === 'number' && v >= 0 && v <= 100;
}

function sanitizeName(v: unknown): string {
  return typeof v === 'string' ? v.trim().slice(0, 100) : '';
}

module.exports = { apiError, Errors, isValidUuid, isValidOfferCode, newOfferCode, isPositiveInt, isPercent, sanitizeName };
