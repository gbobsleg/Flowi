const express = require('express');
const router  = express.Router();
const db      = require('../db/sqlite');
const { Errors, isValidOfferCode } = require('../middlewares/validate');

// ---------- helpers internes ----------

function normalize(name) {
  return name.trim().toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
}

function nowIso() {
  return new Date().toISOString();
}

/**
 * Calcule le quota effectif d'une offre selon la hiérarchie:
 *   1. fixed_quota (si non NULL)
 *   2. floor(present_count * allowed_percent / 100)
 *   3. offers.default_quota
 */
function effectiveQuota(offerId) {
  const rule = db.prepare(
    'SELECT qr.fixed_quota, qr.present_count, qr.allowed_percent, o.default_quota ' +
    'FROM offers o ' +
    'LEFT JOIN quota_rules qr ON qr.offer_id = o.id ' +
    'WHERE o.id = ?'
  ).get(offerId);

  if (!rule) return 0;
  if (rule.fixed_quota !== null && rule.fixed_quota !== undefined) return rule.fixed_quota;
  if (rule.present_count !== null && rule.allowed_percent !== null) {
    return Math.max(0, Math.floor((rule.present_count * rule.allowed_percent) / 100));
  }
  return rule.default_quota;
}

function countActivePauses(offerId) {
  const row = db.prepare(
    "SELECT COUNT(*) AS cnt FROM pauses WHERE offer_id = ? AND status = 'in_progress'"
  ).get(offerId);
  return row ? row.cnt : 0;
}

function offerByCode(code) {
  return db.prepare('SELECT * FROM offers WHERE code = ?').get(code);
}

function sanitizeText(v, max = 100) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function visibleOffersForAgent() {
  return db.prepare(
    'SELECT o.* FROM offers o ' +
    'WHERE o.is_active = 1 ' +
    "OR EXISTS (SELECT 1 FROM pauses p WHERE p.offer_id = o.id AND (p.status = 'in_progress' OR p.end_time IS NULL)) " +
    'ORDER BY o.code'
  ).all();
}

/**
 * Construit le snapshot complet des pauses en cours, groupé par offre.
 */
function buildSnapshot() {
  const offers = visibleOffersForAgent();
  return offers.map(offer => {
    const pauses = db.prepare(
      'SELECT p.id, p.agent_matricule, a.nom, a.prenom, p.start_time ' +
      'FROM pauses p JOIN agents a ON a.matricule = p.agent_matricule ' +
      "WHERE p.offer_id = ? AND p.status = 'in_progress' ORDER BY p.start_time"
    ).all(offer.id);
    const quota = effectiveQuota(offer.id);
    return {
      offer: {
        ...offer,
        is_active: offer.is_active === 1 ? 1 : 0,
      },
      pauses,
      effectiveQuota: quota,
      blocked: pauses.length >= quota,
    };
  });
}

/**
 * Émet les événements Socket.io liés à une offre après mutation.
 * Cible la room de l'offre ET le broadcast global (dashboard partagé).
 */
function emitOfferUpdate(io, offerCode, offerId) {
  const quota  = effectiveQuota(offerId);
  const active = countActivePauses(offerId);
  const blockPayload = {
    offerCode,
    canStartPause:    active < quota,
    effectiveQuota:   quota,
    currentPaused:    active,
    blockedForNewStarts: active >= quota,
    reason: active >= quota ? 'quota_reached' : null,
  };
  // Cibler la room de l'offre + broadcast global pour le dashboard
  io.to(`offer:${offerCode}`).emit('offer:block-status', blockPayload);
  io.emit('offer:block-status', blockPayload);
}

function normalizeQuotaValue(value) {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

function buildQuotasSnapshot() {
  const offers = visibleOffersForAgent();
  return offers.map(offer => {
    const computedQuota = effectiveQuota(offer.id);
    const quotaMax = normalizeQuotaValue(computedQuota);
    return {
      offre_id: offer.id,
      code: offer.code,
      nom: offer.label,
      color: offer.color ?? null,
      is_active: offer.is_active === 1 ? 1 : 0,
      quota_max: quotaMax,
      pauses_en_cours: countActivePauses(offer.id),
    };
  });
}

function emitQuotasUpdate(io) {
  io.emit('quotas:update', buildQuotasSnapshot());
}

// ---------- routes ----------

/**
 * GET /api/agent/bootstrap?agent_matricule=...
 */
router.get('/bootstrap', (req, res) => {
  try {
    const agentMatricule = sanitizeText(req.query.agent_matricule, 32);
    const agent = agentMatricule
      ? db.prepare('SELECT matricule, nom, prenom, is_active FROM agents WHERE matricule = ?').get(agentMatricule)
      : null;

    const activePause = agentMatricule
      ? db.prepare(
          'SELECT p.*, o.code AS offer_code, o.label AS offer_label ' +
          'FROM pauses p JOIN offers o ON o.id = p.offer_id ' +
          "WHERE p.agent_matricule = ? AND p.status = 'in_progress' LIMIT 1"
        ).get(agentMatricule)
      : null;

    const maintenanceRow = db.prepare("SELECT value FROM app_settings WHERE key = 'maintenance_mode'").get();
    const maintenanceMode = maintenanceRow ? maintenanceRow.value === '1' : false;

    const maxPauseRow = db.prepare("SELECT value FROM app_settings WHERE key = 'max_pause_minutes'").get();
    const maxPauseMinutes = maxPauseRow ? parseInt(maxPauseRow.value, 10) : 15;

    res.json({
      agent: agent || null,
      activePause: activePause || null,
      snapshot: buildSnapshot(),
      quotas: buildQuotasSnapshot(),
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
router.post('/identify', (req, res) => {
  try {
    const agentMatricule = sanitizeText(req.body.agent_matricule, 32);
    if (!agentMatricule) return Errors.missingField(res, 'agent_matricule');

    const agent = db.prepare(
      'SELECT matricule, nom, prenom, is_active FROM agents WHERE matricule = ?'
    ).get(agentMatricule);

    if (!agent) return Errors.forbidden(res);
    if (agent.is_active !== 1) return Errors.unauthorized(res);

    res.json({ agent });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * GET /api/agent/suggestions?query=...
 */
router.get('/suggestions', (req, res) => {
  try {
    const { query } = req.query;
    const trimmedQuery = sanitizeText(query);
    if (!trimmedQuery || trimmedQuery.length < 2) return res.json({ suggestions: [] });

    const normQuery = normalize(trimmedQuery);
    const rows = db.prepare(
      'SELECT matricule AS agent_matricule, nom, prenom FROM agents ' +
      'WHERE is_active = 1 AND (LOWER(nom) LIKE ? OR LOWER(prenom) LIKE ?) ' +
      'ORDER BY nom, prenom LIMIT 10'
    ).all(`${normQuery}%`, `${normQuery}%`);

    res.json({ suggestions: rows });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * POST /api/agent/pause/start
 * Body: { agent_matricule, offerCode }
 */
router.post('/pause/start', (req, res) => {
  try {
    const agentMatricule = sanitizeText(req.body.agent_matricule, 32);
    const offerCode = sanitizeText(req.body.offerCode, 32);

    // Validation
    const missing = [];
    if (!agentMatricule) missing.push('agent_matricule');
    if (!offerCode) missing.push('offerCode');
    if (missing.length) return Errors.missingField(res, ...missing);

    if (!isValidOfferCode(offerCode)) return Errors.invalidType(res, 'offerCode', 'code offre alphanumérique (ex: OFFRE_A)');

    const offer = offerByCode(offerCode);
    if (!offer) return Errors.notFound(res, `Offre "${offerCode}"`);
    if (offer.is_active !== 1) return Errors.conflict(res, `Offre "${offerCode}" désactivée`);

    const agent = db.prepare(
      'SELECT matricule, nom, prenom, is_active FROM agents WHERE matricule = ?'
    ).get(agentMatricule);
    if (!agent) return Errors.forbidden(res);
    if (agent.is_active !== 1) return Errors.unauthorized(res);

    // Vérification mode maintenance (prioritaire sur tout)
    const maintenanceRow = db.prepare("SELECT value FROM app_settings WHERE key = 'maintenance_mode'").get();
    if (maintenanceRow && maintenanceRow.value === '1') {
      return res.status(503).json({ error: { code: 'MAINTENANCE_ACTIVE', message: 'Départs en pause suspendus (Consigne Superviseur)' } });
    }

    const now = nowIso();

    // Transaction atomique: vérif quota + insertion pause
    const result = db.transaction(() => {
      // Vérifier pause active existante pour cet agent
      const existingPause = db.prepare(
        "SELECT id FROM pauses WHERE agent_matricule = ? AND status = 'in_progress' LIMIT 1"
      ).get(agentMatricule);
      if (existingPause) return { err: 'CONFLICT', message: 'Une pause est déjà en cours pour cet agent' };

      // Vérifier quota offre
      const quota  = effectiveQuota(offer.id);
      const active = countActivePauses(offer.id);
      if (active >= quota) return { err: 'QUOTA_REACHED', quota, active };

      // Créer la pause
      const info = db.prepare(
        "INSERT INTO pauses (agent_matricule, offer_id, start_time, status, created_at, updated_at) VALUES (?, ?, ?, 'in_progress', ?, ?)"
      ).run(agentMatricule, offer.id, now, now, now);

      return { pauseId: info.lastInsertRowid, startTime: now };
    })();

    // Erreurs métier issues de la transaction
    if (result.err === 'CONFLICT')     return Errors.conflict(res, result.message);
    if (result.err === 'QUOTA_REACHED') return Errors.quotaReached(res, result.quota, result.active);

    // --- Diffusions Socket.io ---
    const io = req.app.get('io');
    if (io) {
      const startedPayload = {
        pauseId:   result.pauseId,
        agent_matricule: agentMatricule,
        agentName: `${agent.prenom} ${agent.nom}`,
        offerCode,
        startTime: result.startTime,
      };
      // Diffuser à la room de l'offre + broadcast global
      io.to(`offer:${offerCode}`).emit('pause:started', startedPayload);
      io.emit('pause:started', startedPayload);

      emitOfferUpdate(io, offerCode, offer.id);
      emitQuotasUpdate(io);
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
router.post('/pause/stop', (req, res) => {
  try {
    const agentMatricule = sanitizeText(req.body.agent_matricule, 32);

    if (!agentMatricule) return Errors.missingField(res, 'agent_matricule');

    const now = nowIso();

    const result = db.transaction(() => {
      const pause = db.prepare(
        'SELECT p.*, o.code AS offer_code, o.id AS offer_id_val ' +
        'FROM pauses p JOIN offers o ON o.id = p.offer_id ' +
        "WHERE p.agent_matricule = ? AND p.status = 'in_progress' LIMIT 1"
      ).get(agentMatricule);

      if (!pause) return { err: 'NOT_FOUND' };

      const durationSeconds = Math.round((new Date(now) - new Date(pause.start_time)) / 1000);

      db.prepare(
        "UPDATE pauses SET status = 'ended', end_time = ?, end_reason = 'manual', duration_seconds = ?, updated_at = ? WHERE id = ?"
      ).run(now, durationSeconds, now, pause.id);

      return { pause, durationSeconds, endTime: now };
    })();

    if (result.err === 'NOT_FOUND') return Errors.notFound(res, 'Pause active pour cet agent');

    // --- Diffusions Socket.io ---
    const io = req.app.get('io');
    if (io) {
      const agent  = db.prepare('SELECT nom, prenom FROM agents WHERE matricule = ?').get(agentMatricule);
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

      emitOfferUpdate(io, offerCode, result.pause.offer_id_val);
      emitQuotasUpdate(io);
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
};
