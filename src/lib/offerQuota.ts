'use strict';

const db = require('../db');
const {
  qOne,
  getParisClock,
  loadPauseWindowStatus,
} = require('./pauseCredits');

type QueryResult = { rows: unknown[] };
type QueryClient = { query: (sql: string, params?: unknown[]) => Promise<QueryResult> };

type OfferIo = {
  emit: (event: string, payload: unknown) => void;
  to: (room: string) => { emit: (event: string, payload: unknown) => void };
};

/** floor(headcount × %) ; minimum 1 dès qu’il y a au moins une tête planifiée. */
function allowedFromHeadcount(headcount: unknown, percent: unknown): number {
  const n = Number(headcount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const p = Number(percent);
  if (!Number.isFinite(p) || p < 0) return 0;
  return Math.max(1, Math.floor((n * p) / 100));
}

/**
 * Quota effectif:
 *   1. hors fenêtres de pause (si configurées) → 0
 *   2. fixed_quota (override) si NOT NULL
 *   3. slot planning du jour : max(1, floor(headcount × %)) si headcount > 0 ; 0 si headcount = 0 ; default_quota si % NULL
 *   4. offers.default_quota
 */
async function effectiveQuota(offerId: unknown, client?: QueryClient | null): Promise<number> {
  const clock = getParisClock();
  const windowStatus = await loadPauseWindowStatus(client);
  if (!windowStatus.open) return 0;

  const rule = await qOne(
    'SELECT qr.fixed_quota, qr.allowed_percent, o.default_quota ' +
    'FROM offers o ' +
    'LEFT JOIN quota_rules qr ON qr.offer_id = o.id ' +
    'WHERE o.id = $1',
    [offerId],
    client
  );

  if (!rule) return 0;
  if (rule.fixed_quota !== null && rule.fixed_quota !== undefined) {
    return Number(rule.fixed_quota);
  }

  const slot = await qOne(
    'SELECT headcount FROM planning_slots ' +
    'WHERE offer_id = $1 AND day = $2::date AND slot_minutes = $3',
    [offerId, clock.day, clock.slotMinutes],
    client
  );

  if (slot) {
    if (rule.allowed_percent === null || rule.allowed_percent === undefined) {
      return Number(rule.default_quota);
    }
    return allowedFromHeadcount(slot.headcount, rule.allowed_percent);
  }

  return Number(rule.default_quota);
}

async function countActivePauses(offerId: unknown, client?: QueryClient | null): Promise<number> {
  const row = await qOne(
    "SELECT COUNT(*) AS cnt FROM pauses WHERE offer_id = $1 AND status = 'in_progress'",
    [offerId],
    client
  );
  return row ? Number(row.cnt) : 0;
}

async function visibleOffersForAgent(): Promise<any[]> {
  return db.queryAll(
    'SELECT o.* FROM offers o ' +
    'WHERE o.purge_requested_at IS NULL ' +
    'AND (o.is_active = true ' +
    "OR EXISTS (SELECT 1 FROM pauses p WHERE p.offer_id = o.id AND (p.status = 'in_progress' OR p.end_time IS NULL))) " +
    'ORDER BY o.code'
  );
}

function normalizeQuotaValue(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

async function buildQuotasSnapshot(): Promise<any[]> {
  const offers = await visibleOffersForAgent();
  const quotas = [];
  for (const offer of offers) {
    const computedQuota = await effectiveQuota(offer.id);
    const quotaMax = normalizeQuotaValue(computedQuota);
    quotas.push({
      offre_id: offer.id,
      code: offer.code,
      nom: offer.label,
      color: offer.color ?? null,
      is_active: offer.is_active,
      quota_max: quotaMax,
      pauses_en_cours: await countActivePauses(offer.id),
    });
  }
  return quotas;
}

async function emitOfferUpdate(io: OfferIo | null | undefined, offerCode: string, offerId: unknown): Promise<void> {
  if (!io || typeof io.to !== 'function' || typeof io.emit !== 'function') return;
  const quota = await effectiveQuota(offerId);
  const active = await countActivePauses(offerId);
  const windowStatus = await loadPauseWindowStatus();
  let reason: string | null = null;
  if (!windowStatus.open) reason = 'outside_window';
  else if (active >= quota) reason = 'quota_reached';
  const blockPayload = {
    offerCode,
    canStartPause: active < quota,
    effectiveQuota: quota,
    currentPaused: active,
    blockedForNewStarts: active >= quota,
    reason,
  };
  io.to(`offer:${offerCode}`).emit('offer:block-status', blockPayload);
  io.emit('offer:block-status', blockPayload);
}

async function emitQuotasUpdate(io: OfferIo | null | undefined): Promise<void> {
  if (!io || typeof io.emit !== 'function') return;
  io.emit('quotas:update', await buildQuotasSnapshot());
}

module.exports = {
  allowedFromHeadcount,
  effectiveQuota,
  countActivePauses,
  visibleOffersForAgent,
  buildQuotasSnapshot,
  emitOfferUpdate,
  emitQuotasUpdate,
};
