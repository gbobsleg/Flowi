const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { Errors, isValidOfferCode } = require('../middlewares/validate');

// ---------- helpers internes ----------

function normalize(name) {
  return name.trim().toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
}

function nowIso() {
  return new Date().toISOString();
}

async function qOne(sql, params, client) {
  if (client) {
    const result = await client.query(sql, params);
    return result.rows[0];
  }
  return db.queryOne(sql, params);
}

async function qAll(sql, params, client) {
  if (client) {
    const result = await client.query(sql, params);
    return result.rows;
  }
  return db.queryAll(sql, params);
}

function getParisClock(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const g = (type) => parts.find((p) => p.type === type).value;
  const hour = Number(g('hour'));
  const minute = Number(g('minute'));
  return {
    day: `${g('year')}-${g('month')}-${g('day')}`,
    hour,
    minute,
    minutesOfDay: hour * 60 + minute,
    slotMinutes: hour * 60 + Math.floor(minute / 15) * 15,
  };
}

function hmToMinutes(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function parsePauseWindows(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function isInsidePauseWindows(minutesOfDay, windows) {
  if (!windows.length) return true;
  return windows.some((w) => {
    const start = hmToMinutes(w && w.start);
    const end = hmToMinutes(w && w.end);
    if (start == null || end == null) return false;
    return minutesOfDay >= start && minutesOfDay < end;
  });
}

/** floor(headcount × %) ; minimum 1 dès qu’il y a au moins une tête planifiée. */
function allowedFromHeadcount(headcount, percent) {
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
async function effectiveQuota(offerId, client) {
  const clock = getParisClock();
  const windowsRow = await qOne(
    "SELECT value FROM app_settings WHERE key = 'pause_windows'",
    [],
    client
  );
  const windows = parsePauseWindows(windowsRow && windowsRow.value);
  if (!isInsidePauseWindows(clock.minutesOfDay, windows)) return 0;

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

async function countActivePauses(offerId, client) {
  const row = await qOne(
    "SELECT COUNT(*) AS cnt FROM pauses WHERE offer_id = $1 AND status = 'in_progress'",
    [offerId],
    client
  );
  return row ? Number(row.cnt) : 0;
}

async function offerByCode(code) {
  return db.queryOne('SELECT * FROM offers WHERE code = $1', [code]);
}

function sanitizeText(v, max = 100) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

async function visibleOffersForAgent() {
  return db.queryAll(
    'SELECT o.* FROM offers o ' +
    'WHERE o.purge_requested_at IS NULL ' +
    'AND (o.is_active = true ' +
    "OR EXISTS (SELECT 1 FROM pauses p WHERE p.offer_id = o.id AND (p.status = 'in_progress' OR p.end_time IS NULL))) " +
    'ORDER BY o.code'
  );
}

/**
 * Construit le snapshot complet des pauses en cours, groupé par offre.
 */
async function buildSnapshot() {
  const offers = await visibleOffersForAgent();
  const snapshot = [];
  for (const offer of offers) {
    const pauses = await db.queryAll(
      'SELECT p.id, p.agent_matricule, a.nom, a.prenom, p.start_time ' +
      'FROM pauses p JOIN agents a ON a.matricule = p.agent_matricule ' +
      "WHERE p.offer_id = $1 AND p.status = 'in_progress' ORDER BY p.start_time",
      [offer.id]
    );
    const quota = await effectiveQuota(offer.id);
    snapshot.push({
      offer,
      pauses,
      effectiveQuota: quota,
      blocked: pauses.length >= quota,
    });
  }
  return snapshot;
}

/**
 * Émet les événements Socket.io liés à une offre après mutation.
 * Cible la room de l'offre ET le broadcast global (dashboard partagé).
 */
async function emitOfferUpdate(io, offerCode, offerId) {
  const quota  = await effectiveQuota(offerId);
  const active = await countActivePauses(offerId);
  const blockPayload = {
    offerCode,
    canStartPause:    active < quota,
    effectiveQuota:   quota,
    currentPaused:    active,
    blockedForNewStarts: active >= quota,
    reason: active >= quota ? 'quota_reached' : null,
  };
  io.to(`offer:${offerCode}`).emit('offer:block-status', blockPayload);
  io.emit('offer:block-status', blockPayload);
}

function normalizeQuotaValue(value) {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

async function buildQuotasSnapshot() {
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

async function emitQuotasUpdate(io) {
  io.emit('quotas:update', await buildQuotasSnapshot());
}

// ---------- routes ----------

/**
 * GET /api/agent/bootstrap?agent_matricule=...
 */
router.get('/bootstrap', async (req, res) => {
  try {
    const agentMatricule = sanitizeText(req.query.agent_matricule, 32);
    const agent = agentMatricule
      ? await db.queryOne(
          'SELECT matricule, nom, prenom, is_active FROM agents WHERE matricule = $1',
          [agentMatricule]
        )
      : null;

    const activePause = agentMatricule
      ? await db.queryOne(
          'SELECT p.*, o.code AS offer_code, o.label AS offer_label ' +
          'FROM pauses p JOIN offers o ON o.id = p.offer_id ' +
          "WHERE p.agent_matricule = $1 AND p.status = 'in_progress' LIMIT 1",
          [agentMatricule]
        )
      : null;

    const maintenanceRow = await db.queryOne(
      "SELECT value FROM app_settings WHERE key = 'maintenance_mode'"
    );
    const maintenanceMode = maintenanceRow ? maintenanceRow.value === '1' : false;

    const maxPauseRow = await db.queryOne(
      "SELECT value FROM app_settings WHERE key = 'max_pause_minutes'"
    );
    const maxPauseMinutes = maxPauseRow ? parseInt(maxPauseRow.value, 10) : 15;

    res.json({
      agent: agent || null,
      activePause: activePause || null,
      snapshot: await buildSnapshot(),
      quotas: await buildQuotasSnapshot(),
      maintenanceMode,
      maxPauseMinutes,
    });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * POST /api/agent/identify
 * Body: { agent_matricule }
 */
router.post('/identify', async (req, res) => {
  try {
    const agentMatricule = sanitizeText(req.body.agent_matricule, 32);
    if (!agentMatricule) return Errors.missingField(res, 'agent_matricule');

    const agent = await db.queryOne(
      'SELECT matricule, nom, prenom, is_active FROM agents WHERE matricule = $1',
      [agentMatricule]
    );

    if (!agent) return Errors.forbidden(res);
    if (!agent.is_active) return Errors.unauthorized(res);

    res.json({ agent });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * GET /api/agent/suggestions?query=...
 */
router.get('/suggestions', async (req, res) => {
  try {
    const { query } = req.query;
    const trimmedQuery = sanitizeText(query);
    if (!trimmedQuery || trimmedQuery.length < 2) return res.json({ suggestions: [] });

    const normQuery = normalize(trimmedQuery);
    const rows = await db.queryAll(
      'SELECT matricule AS agent_matricule, nom, prenom FROM agents ' +
      'WHERE is_active = true AND (LOWER(nom) LIKE $1 OR LOWER(prenom) LIKE $2) ' +
      'ORDER BY nom, prenom LIMIT 10',
      [`${normQuery}%`, `${normQuery}%`]
    );

    res.json({ suggestions: rows });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * POST /api/agent/pause/start
 * Body: { agent_matricule, offerCode }
 */
router.post('/pause/start', async (req, res) => {
  try {
    const agentMatricule = sanitizeText(req.body.agent_matricule, 32);
    const offerCode = sanitizeText(req.body.offerCode, 32);

    const missing = [];
    if (!agentMatricule) missing.push('agent_matricule');
    if (!offerCode) missing.push('offerCode');
    if (missing.length) return Errors.missingField(res, ...missing);

    if (!isValidOfferCode(offerCode)) return Errors.invalidType(res, 'offerCode', 'code offre alphanumérique (ex: OFFRE_A)');

    const offer = await offerByCode(offerCode);
    if (!offer || offer.purge_requested_at) return Errors.notFound(res, `Offre "${offerCode}"`);
    if (!offer.is_active) return Errors.conflict(res, `Offre "${offerCode}" désactivée`);

    const agent = await db.queryOne(
      'SELECT matricule, nom, prenom, is_active FROM agents WHERE matricule = $1',
      [agentMatricule]
    );
    if (!agent) return Errors.forbidden(res);
    if (!agent.is_active) return Errors.unauthorized(res);

    const maintenanceRow = await db.queryOne(
      "SELECT value FROM app_settings WHERE key = 'maintenance_mode'"
    );
    if (maintenanceRow && maintenanceRow.value === '1') {
      return res.status(503).json({ error: { code: 'MAINTENANCE_ACTIVE', message: 'Départs en pause suspendus (Consigne Superviseur)' } });
    }

    const now = nowIso();

    const result = await db.withTransaction(async (client) => {
      await client.query('SELECT id FROM offers WHERE id = $1 FOR UPDATE', [offer.id]);

      const existingPause = await qOne(
        "SELECT id FROM pauses WHERE agent_matricule = $1 AND status = 'in_progress' LIMIT 1",
        [agentMatricule],
        client
      );
      if (existingPause) return { err: 'CONFLICT', message: 'Une pause est déjà en cours pour cet agent' };

      const quota  = await effectiveQuota(offer.id, client);
      const active = await countActivePauses(offer.id, client);
      if (active >= quota) return { err: 'QUOTA_REACHED', quota, active };

      const inserted = await qOne(
        "INSERT INTO pauses (agent_matricule, offer_id, start_time, status, created_at, updated_at) " +
        "VALUES ($1, $2, $3, 'in_progress', $4, $5) RETURNING id",
        [agentMatricule, offer.id, now, now, now],
        client
      );

      return { pauseId: inserted.id, startTime: now };
    });

    if (result.err === 'CONFLICT')     return Errors.conflict(res, result.message);
    if (result.err === 'QUOTA_REACHED') return Errors.quotaReached(res, result.quota, result.active);

    const io = req.app.get('io');
    if (io) {
      const startedPayload = {
        pauseId:   result.pauseId,
        agent_matricule: agentMatricule,
        agentName: `${agent.prenom} ${agent.nom}`,
        offerCode,
        startTime: result.startTime,
      };
      io.to(`offer:${offerCode}`).emit('pause:started', startedPayload);
      io.emit('pause:started', startedPayload);

      await emitOfferUpdate(io, offerCode, offer.id);
      await emitQuotasUpdate(io);
    }

    res.status(201).json({ pauseId: result.pauseId, startTime: result.startTime });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * POST /api/agent/pause/stop
 * Body: { agent_matricule }
 */
router.post('/pause/stop', async (req, res) => {
  try {
    const agentMatricule = sanitizeText(req.body.agent_matricule, 32);

    if (!agentMatricule) return Errors.missingField(res, 'agent_matricule');

    const now = nowIso();

    const result = await db.withTransaction(async (client) => {
      const pause = await qOne(
        'SELECT p.*, o.code AS offer_code, o.id AS offer_id_val ' +
        'FROM pauses p JOIN offers o ON o.id = p.offer_id ' +
        "WHERE p.agent_matricule = $1 AND p.status = 'in_progress' LIMIT 1",
        [agentMatricule],
        client
      );

      if (!pause) return { err: 'NOT_FOUND' };

      const durationSeconds = Math.round((new Date(now) - new Date(pause.start_time)) / 1000);

      await client.query(
        "UPDATE pauses SET status = 'ended', end_time = $1, end_reason = 'manual', duration_seconds = $2, updated_at = $3 WHERE id = $4",
        [now, durationSeconds, now, pause.id]
      );

      return { pause, durationSeconds, endTime: now };
    });

    if (result.err === 'NOT_FOUND') return Errors.notFound(res, 'Pause active pour cet agent');

    const io = req.app.get('io');
    if (io) {
      const agent  = await db.queryOne('SELECT nom, prenom FROM agents WHERE matricule = $1', [agentMatricule]);
      const offerCode = result.pause.offer_code;

      const stoppedPayload = {
        pauseId:         result.pause.id,
        agent_matricule: agentMatricule,
        agentName:       agent ? `${agent.prenom} ${agent.nom}` : agentMatricule,
        offerCode,
        endTime:         result.endTime,
        durationSeconds: result.durationSeconds,
        endReason:       'manual',
      };
      io.to(`offer:${offerCode}`).emit('pause:stopped', stoppedPayload);
      io.emit('pause:stopped', stoppedPayload);

      await emitOfferUpdate(io, offerCode, result.pause.offer_id_val);
      await emitQuotasUpdate(io);
    }

    res.json({ endTime: result.endTime, durationSeconds: result.durationSeconds });
  } catch (err) {
    Errors.internal(res, err);
  }
});

module.exports = {
  router,
  effectiveQuota,
  countActivePauses,
  buildSnapshot,
  buildQuotasSnapshot,
  emitOfferUpdate,
  emitQuotasUpdate,
  getParisClock,
  allowedFromHeadcount,
};
