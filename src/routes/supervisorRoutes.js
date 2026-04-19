const express = require('express');
const router  = express.Router();
const db      = require('../db/sqlite');
const { createSession, validatePin, requireSupervisor } = require('../middlewares/supervisorAuth');
const { effectiveQuota, countActivePauses, emitOfferUpdate, emitQuotasUpdate } = require('./agentRoutes');
const { Errors, apiError, isValidOfferCode, isPositiveInt, isPercent } = require('../middlewares/validate');

function nowIso() { return new Date().toISOString(); }

const SUPERVISOR_PIN_RE = /^\d{4,6}$/;

/** Normalise propriétaire / nom de dépôt (bords + espaces internes). */
function normalizeGithubOwnerRepo(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ');
}

function parseOfferColorInput(rawColor) {
  if (rawColor === undefined || rawColor === null) return null;
  if (typeof rawColor !== 'string') return { error: 'color doit être une chaîne ou null' };
  const trimmed = rawColor.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(normalized)) {
    return { error: 'color doit respecter le format #rrggbb' };
  }
  return normalized;
}

// ---------- Authentification ----------

/**
 * POST /api/supervisor/auth
 * Body: { pin }
 */
router.post('/auth', (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin)               return Errors.missingField(res, 'pin');
    if (typeof pin !== 'string') return Errors.invalidType(res, 'pin', 'string');

    if (!validatePin(pin.trim())) return Errors.unauthorized(res);

    const token = createSession();
    res.cookie('sv_token', token, { httpOnly: true, sameSite: 'strict', maxAge: 8 * 60 * 60 * 1000 });
    res.json({ token, expiresIn: '8h' });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * POST /api/supervisor/logout
 */
router.post('/logout', requireSupervisor, (req, res) => {
  try {
    const { revokeToken } = require('../middlewares/supervisorAuth');
    const token =
      (req.cookies && req.cookies.sv_token) ||
      (req.headers.authorization && req.headers.authorization.replace('Bearer ', ''));
    revokeToken(token);
    res.clearCookie('sv_token');
    res.json({ ok: true });
  } catch (err) {
    Errors.internal(res, err);
  }
});

// ---------- Quotas ----------

/**
 * GET /api/supervisor/offers
 */
router.get('/offers', requireSupervisor, (req, res) => {
  try {
    const offers = db.prepare(
      'SELECT id, code, label, default_quota, color, is_active, created_at FROM offers ORDER BY code ASC'
    ).all();
    res.json({ offers });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * POST /api/supervisor/offers
 * Body: { code, label, default_quota?, color? }
 */
router.post('/offers', requireSupervisor, (req, res) => {
  try {
    const code = typeof req.body.code === 'string' ? req.body.code.trim() : '';
    const label = typeof req.body.label === 'string' ? req.body.label.trim() : '';
    const defaultQuotaRaw = req.body.default_quota;
    const defaultQuota = defaultQuotaRaw === undefined ? 2 : parseInt(defaultQuotaRaw, 10);
    const parsedColor = parseOfferColorInput(req.body.color);
    if (!code) return Errors.missingField(res, 'code');
    if (!label) return Errors.missingField(res, 'label');
    if (!isValidOfferCode(code)) {
      return Errors.invalidType(res, 'code', 'code offre alphanumérique (ex: OFFRE_A)');
    }
    if (!Number.isInteger(defaultQuota) || defaultQuota < 0) {
      return Errors.invalidType(res, 'default_quota', 'entier >= 0');
    }
    if (parsedColor && typeof parsedColor === 'object' && parsedColor.error) {
      return res.status(400).json({ error: { code: 'INVALID_COLOR', message: parsedColor.error } });
    }

    const now = nowIso();
    try {
      const info = db.prepare(
        'INSERT INTO offers (code, label, default_quota, color, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)'
      ).run(code, label, defaultQuota, parsedColor, now);
      const offer = db.prepare(
        'SELECT id, code, label, default_quota, color, is_active, created_at FROM offers WHERE id = ?'
      ).get(info.lastInsertRowid);

      const io = req.app.get('io');
      if (io) emitQuotasUpdate(io);

      return res.status(201).json({ offer });
    } catch (err) {
      if (String(err.message || '').includes('UNIQUE constraint failed')) {
        return Errors.conflict(res, `Offre "${code}" déjà existante`);
      }
      throw err;
    }
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PUT /api/supervisor/offers/:offerCode
 * Body: { label?, default_quota?, color? }
 */
router.put('/offers/:offerCode', requireSupervisor, (req, res) => {
  try {
    const offerCode = typeof req.params.offerCode === 'string' ? req.params.offerCode.trim() : '';
    if (!isValidOfferCode(offerCode)) {
      return Errors.invalidType(res, 'offerCode', 'code offre alphanumérique (ex: OFFRE_A)');
    }
    const existing = db.prepare('SELECT id FROM offers WHERE code = ?').get(offerCode);
    if (!existing) return Errors.notFound(res, `Offre "${offerCode}"`);

    const hasLabel = req.body.label !== undefined;
    const hasDefaultQuota = req.body.default_quota !== undefined;
    const hasColor = req.body.color !== undefined;
    if (!hasLabel && !hasDefaultQuota && !hasColor) {
      return Errors.missingField(res, 'label | default_quota | color');
    }

    const nextLabel = hasLabel ? (typeof req.body.label === 'string' ? req.body.label.trim() : '') : null;
    if (hasLabel && !nextLabel) return Errors.missingField(res, 'label');

    let nextDefaultQuota = null;
    if (hasDefaultQuota) {
      nextDefaultQuota = parseInt(req.body.default_quota, 10);
      if (!Number.isInteger(nextDefaultQuota) || nextDefaultQuota < 0) {
        return Errors.invalidType(res, 'default_quota', 'entier >= 0');
      }
    }

    let nextColor = null;
    if (hasColor) {
      const parsedColor = parseOfferColorInput(req.body.color);
      if (parsedColor && typeof parsedColor === 'object' && parsedColor.error) {
        return res.status(400).json({ error: { code: 'INVALID_COLOR', message: parsedColor.error } });
      }
      nextColor = parsedColor;
    }

    db.prepare(
      'UPDATE offers SET ' +
      'label = CASE WHEN ? = 1 THEN ? ELSE label END, ' +
      'default_quota = CASE WHEN ? = 1 THEN ? ELSE default_quota END, ' +
      'color = CASE WHEN ? = 1 THEN ? ELSE color END ' +
      'WHERE code = ?'
    ).run(
      hasLabel ? 1 : 0, hasLabel ? nextLabel : null,
      hasDefaultQuota ? 1 : 0, hasDefaultQuota ? nextDefaultQuota : null,
      hasColor ? 1 : 0, hasColor ? nextColor : null,
      offerCode
    );

    const offer = db.prepare(
      'SELECT id, code, label, default_quota, color, is_active, created_at FROM offers WHERE code = ?'
    ).get(offerCode);

    const io = req.app.get('io');
    if (io) emitQuotasUpdate(io);

    res.json({ offer });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * DELETE /api/supervisor/offers/:offerCode
 * Suppression logique: bascule l'offre en inactif.
 */
router.delete('/offers/:offerCode', requireSupervisor, (req, res) => {
  try {
    const offerCode = typeof req.params.offerCode === 'string' ? req.params.offerCode.trim() : '';
    if (!isValidOfferCode(offerCode)) {
      return Errors.invalidType(res, 'offerCode', 'code offre alphanumérique (ex: OFFRE_A)');
    }

    const existing = db.prepare(
      'SELECT id, code, label, default_quota, color, is_active, created_at FROM offers WHERE code = ?'
    ).get(offerCode);
    if (!existing) return Errors.notFound(res, `Offre "${offerCode}"`);
    if (existing.is_active === 0) {
      return res.json({ offer: existing, changed: false, message: 'Offre déjà désactivée.' });
    }

    db.prepare('UPDATE offers SET is_active = 0 WHERE code = ?').run(offerCode);
    const offer = db.prepare(
      'SELECT id, code, label, default_quota, color, is_active, created_at FROM offers WHERE code = ?'
    ).get(offerCode);

    const io = req.app.get('io');
    if (io) emitQuotasUpdate(io);

    res.json({ offer, changed: true, message: 'Offre désactivée.' });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PATCH /api/supervisor/offers/:offerCode/activate
 * Réactivation logique: is_active = 1 (+ diffusion quotas pour les agents).
 */
router.patch('/offers/:offerCode/activate', requireSupervisor, (req, res) => {
  try {
    const offerCode = typeof req.params.offerCode === 'string' ? req.params.offerCode.trim() : '';
    if (!isValidOfferCode(offerCode)) {
      return Errors.invalidType(res, 'offerCode', 'code offre alphanumérique (ex: OFFRE_A)');
    }

    const existing = db.prepare(
      'SELECT id, code, label, default_quota, color, is_active, created_at FROM offers WHERE code = ?'
    ).get(offerCode);
    if (!existing) return Errors.notFound(res, `Offre "${offerCode}"`);
    if (existing.is_active === 1) {
      return res.json({ offer: existing, changed: false, message: 'Offre déjà active.' });
    }

    db.prepare('UPDATE offers SET is_active = 1 WHERE code = ?').run(offerCode);
    const offer = db.prepare(
      'SELECT id, code, label, default_quota, color, is_active, created_at FROM offers WHERE code = ?'
    ).get(offerCode);

    const io = req.app.get('io');
    if (io) emitQuotasUpdate(io);

    res.json({ offer, changed: true, message: 'Offre réactivée.' });
  } catch (err) {
    Errors.internal(res, err);
  }
});

// ---------- Annuaire agents (superviseur) ----------

/**
 * GET /api/supervisor/agents?status=active|inactive
 */
router.get('/agents', requireSupervisor, (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : '';
    const sessionRegistry = req.app.get('sessionRegistry');
    const hasActiveSession = typeof sessionRegistry?.hasActiveSession === 'function'
      ? sessionRegistry.hasActiveSession
      : () => false;
    let rows;

    if (!status) {
      rows = db.prepare(
        'SELECT matricule, nom, prenom, is_active FROM agents ORDER BY nom ASC, prenom ASC, matricule ASC'
      ).all();
    } else if (status === 'active') {
      rows = db.prepare(
        'SELECT matricule, nom, prenom, is_active FROM agents WHERE is_active = 1 ORDER BY nom ASC, prenom ASC, matricule ASC'
      ).all();
    } else if (status === 'inactive') {
      rows = db.prepare(
        'SELECT matricule, nom, prenom, is_active FROM agents WHERE is_active = 0 ORDER BY nom ASC, prenom ASC, matricule ASC'
      ).all();
    } else {
      return Errors.invalidType(res, 'status', 'active|inactive');
    }

    const enrichedRows = rows.map(agent => ({
      ...agent,
      isOnline: hasActiveSession(agent.matricule),
    }));

    res.json({ agents: enrichedRows });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * POST /api/supervisor/agents
 * Body: { matricule, nom, prenom }
 */
router.post('/agents', requireSupervisor, (req, res) => {
  try {
    const matricule = typeof req.body.matricule === 'string' ? req.body.matricule.trim() : '';
    const nom = typeof req.body.nom === 'string' ? req.body.nom.trim() : '';
    const prenom = typeof req.body.prenom === 'string' ? req.body.prenom.trim() : '';

    const missing = [];
    if (!matricule) missing.push('matricule');
    if (!nom) missing.push('nom');
    if (!prenom) missing.push('prenom');
    if (missing.length > 0) return Errors.missingField(res, ...missing);

    const existing = db.prepare('SELECT matricule FROM agents WHERE matricule = ?').get(matricule);
    if (existing) return Errors.conflict(res, `Matricule "${matricule}" déjà existant`);

    db.prepare(
      'INSERT INTO agents (matricule, nom, prenom, is_active) VALUES (?, ?, ?, 1)'
    ).run(matricule, nom, prenom);

    res.status(201).json({ agent: { matricule, nom, prenom, is_active: 1 } });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PATCH /api/supervisor/agents/:matricule/activate
 */
router.patch('/agents/:matricule/activate', requireSupervisor, (req, res) => {
  try {
    const matricule = typeof req.params.matricule === 'string' ? req.params.matricule.trim() : '';
    if (!matricule) return Errors.missingField(res, 'matricule');

    const result = db.prepare('UPDATE agents SET is_active = 1 WHERE matricule = ?').run(matricule);
    if (result.changes === 0) return Errors.notFound(res, `Agent "${matricule}"`);

    const agent = db.prepare('SELECT matricule, nom, prenom, is_active FROM agents WHERE matricule = ?').get(matricule);
    res.json({ agent });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PATCH /api/supervisor/agents/:matricule/deactivate
 */
router.patch('/agents/:matricule/deactivate', requireSupervisor, (req, res) => {
  try {
    const matricule = typeof req.params.matricule === 'string' ? req.params.matricule.trim() : '';
    if (!matricule) return Errors.missingField(res, 'matricule');

    const result = db.prepare('UPDATE agents SET is_active = 0 WHERE matricule = ?').run(matricule);
    if (result.changes === 0) return Errors.notFound(res, `Agent "${matricule}"`);

    const agent = db.prepare('SELECT matricule, nom, prenom, is_active FROM agents WHERE matricule = ?').get(matricule);
    res.json({ agent });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * DELETE interdit : désactivation logique uniquement.
 */
router.delete('/agents', requireSupervisor, (req, res) =>
  res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Suppression physique interdite. Utiliser la désactivation.' } })
);
router.delete('/agents/:matricule', requireSupervisor, (req, res) =>
  res.status(405).json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Suppression physique interdite. Utiliser la désactivation.' } })
);

/**
 * GET /api/supervisor/quotas
 */
router.get('/quotas', requireSupervisor, (req, res) => {
  try {
    const offers = db.prepare('SELECT * FROM offers ORDER BY code').all();
    const data = offers.map(offer => {
      const rule   = db.prepare('SELECT * FROM quota_rules WHERE offer_id = ?').get(offer.id) || {};
      const quota  = effectiveQuota(offer.id);
      const active = countActivePauses(offer.id);
      return {
        offer,
        rule: {
          fixedQuota:     rule.fixed_quota    ?? null,
          presentCount:   rule.present_count  ?? null,
          allowedPercent: rule.allowed_percent ?? null,
          updatedBy:      rule.updated_by     ?? null,
          updatedAt:      rule.updated_at     ?? null,
        },
        effectiveQuota: quota,
        currentPaused:  active,
        blocked:        active >= quota,
      };
    });
    res.json({ quotas: data });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PUT /api/supervisor/quotas/:offerCode
 * Body: { fixedQuota?, presentCount?, allowedPercent? }
 *
 * Règles de validation:
 *   - Au moins un champ de quota fourni.
 *   - fixedQuota: entier >= 0 ou null (efface le quota fixe).
 *   - presentCount: entier >= 0.
 *   - allowedPercent: float [0, 100].
 *   - Si presentCount fourni, allowedPercent doit l'être aussi (et vice-versa).
 */
router.put('/quotas/:offerCode', requireSupervisor, (req, res) => {
  try {
    const { offerCode } = req.params;
    if (!isValidOfferCode(offerCode)) return Errors.notFound(res, `Offre "${offerCode}"`);

    const offer = db.prepare('SELECT * FROM offers WHERE code = ?').get(offerCode);
    if (!offer) return Errors.notFound(res, `Offre "${offerCode}"`);

    const { fixedQuota, presentCount, allowedPercent } = req.body;
    const hasFixed   = fixedQuota     !== undefined;
    const hasCount   = presentCount   !== undefined;
    const hasPercent = allowedPercent !== undefined;

    // Au moins un champ requis
    if (!hasFixed && !hasCount && !hasPercent) {
      return Errors.missingField(res, 'fixedQuota | presentCount | allowedPercent');
    }

    // Validation des types
    if (hasFixed && fixedQuota !== null && !isPositiveInt(fixedQuota)) {
      return Errors.invalidType(res, 'fixedQuota', 'entier >= 0 ou null');
    }
    if (hasCount && !isPositiveInt(presentCount)) {
      return Errors.invalidType(res, 'presentCount', 'entier >= 0');
    }
    if (hasPercent && !isPercent(allowedPercent)) {
      return Errors.invalidType(res, 'allowedPercent', 'nombre entre 0 et 100');
    }
    // Cohérence: presentCount et allowedPercent doivent aller ensemble
    if ((hasCount && !hasPercent) || (!hasCount && hasPercent)) {
      return Errors.invalidType(res, 'presentCount+allowedPercent',
        'doivent être fournis ensemble pour le calcul par pourcentage');
    }

    const now      = nowIso();
    const existing = db.prepare('SELECT id FROM quota_rules WHERE offer_id = ?').get(offer.id);

    // Résoudre les valeurs à persister
    // Si fixedQuota est explicitement envoyé (même null), on l'applique.
    // Si non envoyé, on conserve l'ancienne valeur (COALESCE côté SQL pour UPDATE).
    if (existing) {
      db.prepare(
        'UPDATE quota_rules SET ' +
        'fixed_quota     = CASE WHEN ? = 1 THEN ? ELSE fixed_quota END, ' +
        'present_count   = CASE WHEN ? = 1 THEN ? ELSE present_count END, ' +
        'allowed_percent = CASE WHEN ? = 1 THEN ? ELSE allowed_percent END, ' +
        'updated_at = ? WHERE offer_id = ?'
      ).run(
        hasFixed   ? 1 : 0, hasFixed   ? fixedQuota     : null,
        hasCount   ? 1 : 0, hasCount   ? presentCount   : null,
        hasPercent ? 1 : 0, hasPercent ? allowedPercent : null,
        now, offer.id
      );
    } else {
      db.prepare(
        'INSERT INTO quota_rules (offer_id, fixed_quota, present_count, allowed_percent, updated_at) VALUES (?, ?, ?, ?, ?)'
      ).run(offer.id,
        hasFixed   ? fixedQuota     : null,
        hasCount   ? presentCount   : null,
        hasPercent ? allowedPercent : null,
        now
      );
    }

    const quota  = effectiveQuota(offer.id);
    const active = countActivePauses(offer.id);

    // --- Diffusions Socket.io ---
    const io = req.app.get('io');
    if (io) {
      const quotaPayload = { offerCode, effectiveQuota: quota, currentPaused: active, blockedForNewStarts: active >= quota };
      // Cibler la room de l'offre ET broadcast global
      io.to(`offer:${offerCode}`).emit('quota:updated', quotaPayload);
      io.emit('quota:updated', quotaPayload);

      emitOfferUpdate(io, offerCode, offer.id);
    }

    res.json({ offerCode, effectiveQuota: quota, currentPaused: active, blocked: active >= quota });
  } catch (err) {
    Errors.internal(res, err);
  }
});

// ---------- Supervision Live : retour forcé ----------

/**
 * POST /api/supervisor/pause/force-stop
 * Clôture immédiatement la pause active d'un agent avec le motif 'supervisor_forced'.
 * Body: { agent_matricule }
 */
router.post('/pause/force-stop', requireSupervisor, (req, res) => {
  try {
    const agentMatricule = typeof req.body.agent_matricule === 'string' ? req.body.agent_matricule.trim() : '';
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
        "UPDATE pauses SET status = 'ended', end_time = ?, end_reason = 'supervisor_forced', duration_seconds = ?, updated_at = ? WHERE id = ?"
      ).run(now, durationSeconds, now, pause.id);

      return { pause, durationSeconds, endTime: now };
    })();

    if (result.err === 'NOT_FOUND') return Errors.notFound(res, 'Pause active pour cet agent');

    const io = req.app.get('io');
    if (io) {
      const agent     = db.prepare('SELECT nom, prenom FROM agents WHERE matricule = ?').get(agentMatricule);
      const offerCode = result.pause.offer_code;

      const payload = {
        pauseId:         result.pause.id,
        agent_matricule: agentMatricule,
        nom:             agent ? agent.nom : '',
        prenom:          agent ? agent.prenom : '',
        agentName:       agent ? `${agent.prenom} ${agent.nom}` : agentMatricule,
        offerCode,
        endTime:         result.endTime,
        durationSeconds: result.durationSeconds,
        endReason:       'supervisor_forced',
      };
      io.to(`offer:${offerCode}`).emit('pause:stopped', payload);
      io.emit('pause:stopped', payload);
      emitOfferUpdate(io, offerCode, result.pause.offer_id_val);
      emitQuotasUpdate(io);
    }

    res.json({ endTime: result.endTime, durationSeconds: result.durationSeconds });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * POST /api/supervisor/sessions/release
 * Body: { agent_matricule }
 * Libère manuellement une session socket active pour un agent.
 */
router.post('/sessions/release', requireSupervisor, (req, res) => {
  try {
    const agentMatricule = typeof req.body.agent_matricule === 'string' ? req.body.agent_matricule.trim() : '';
    if (!agentMatricule) return Errors.missingField(res, 'agent_matricule');

    const sessionRegistry = req.app.get('sessionRegistry');
    if (!sessionRegistry || typeof sessionRegistry.releaseSessionByMatricule !== 'function') {
      return Errors.internal(res, new Error('Session registry indisponible'));
    }

    const result = sessionRegistry.releaseSessionByMatricule(agentMatricule);
    res.json({
      agent_matricule: agentMatricule,
      released: !!result.released,
      kicked: !!result.kicked,
      reason: result.reason || null,
    });
  } catch (err) {
    Errors.internal(res, err);
  }
});

// ---------- Historique ----------

/**
 * GET /api/supervisor/history?offerCode=&from=&to=&page=&limit=
 */
router.get('/history', requireSupervisor, (req, res) => {
  try {
    const { offerCode, from, to } = req.query;
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    // Validation optionnelle des filtres
    if (offerCode && !isValidOfferCode(offerCode)) {
      return Errors.invalidType(res, 'offerCode', 'code offre alphanumérique');
    }
    if (from && isNaN(Date.parse(from))) return Errors.invalidType(res, 'from', 'date ISO 8601');
    if (to   && isNaN(Date.parse(to)))   return Errors.invalidType(res, 'to',   'date ISO 8601');

    const where = ["p.status = 'ended'"];
    const args  = [];

    if (offerCode) { where.push('o.code = ?');       args.push(offerCode); }
    if (from)      { where.push('p.start_time >= ?'); args.push(from); }
    if (to)        { where.push('p.start_time <= ?'); args.push(to); }

    const whereClause = 'WHERE ' + where.join(' AND ');

    const rows = db.prepare(
      `SELECT p.id, p.agent_matricule, a.nom, a.prenom, o.code AS offer_code, o.label AS offer_label,
              p.start_time, p.end_time, p.end_reason, p.duration_seconds, p.max_minutes_at_end
       FROM pauses p
       JOIN agents a ON a.matricule = p.agent_matricule
       JOIN offers o ON o.id = p.offer_id
       ${whereClause}
       ORDER BY p.start_time DESC
       LIMIT ? OFFSET ?`
    ).all(...args, limit, offset);

    const { total } = db.prepare(
      `SELECT COUNT(*) AS total FROM pauses p JOIN offers o ON o.id = p.offer_id ${whereClause}`
    ).get(...args);

    res.json({ rows, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    Errors.internal(res, err);
  }
});

// ---------- Paramètres ----------

/**
 * GET /api/supervisor/settings
 * Ne renvoie jamais github_token ni supervisor_pin en clair ;
 * indicateurs *_configured uniquement.
 */
router.get('/settings', requireSupervisor, (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM app_settings').all();
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    const rawToken = settings.github_token;
    delete settings.github_token;
    if (typeof rawToken === 'string' && rawToken.trim() !== '') {
      settings.github_token_configured = true;
    }
    const rawSupervisorPin = settings.supervisor_pin;
    delete settings.supervisor_pin;
    if (typeof rawSupervisorPin === 'string' && rawSupervisorPin.trim() !== '') {
      settings.supervisor_pin_configured = true;
    }
    res.json({ settings });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PUT /api/supervisor/settings
 * Body (snake_case): { github_owner?, github_repo?, github_token?, supervisor_pin? }
 * github_token : clé absente → inchangé ; "" → effacement ; chaîne non vide → remplacement.
 * supervisor_pin : clé absente → inchangé ; si présent → doit être /^\d{4,6}$/ (pas vide).
 */
router.put('/settings', requireSupervisor, (req, res) => {
  try {
    const body = req.body || {};

    if (body.github_owner !== undefined) {
      if (typeof body.github_owner !== 'string') {
        return Errors.invalidType(res, 'github_owner', 'chaîne');
      }
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('github_owner', ?)")
        .run(normalizeGithubOwnerRepo(body.github_owner));
    }

    if (body.github_repo !== undefined) {
      if (typeof body.github_repo !== 'string') {
        return Errors.invalidType(res, 'github_repo', 'chaîne');
      }
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('github_repo', ?)")
        .run(normalizeGithubOwnerRepo(body.github_repo));
    }

    if (Object.prototype.hasOwnProperty.call(body, 'github_token')) {
      const t = body.github_token;
      if (t !== undefined && t !== null && typeof t !== 'string') {
        return Errors.invalidType(res, 'github_token', 'chaîne ou chaîne vide');
      }
      const tokenVal = typeof t === 'string' ? t : '';
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('github_token', ?)").run(tokenVal);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'supervisor_pin')) {
      const p = body.supervisor_pin;
      if (typeof p !== 'string') {
        return Errors.invalidType(res, 'supervisor_pin', 'chaîne');
      }
      const trimmed = p.trim();
      if (trimmed === '') {
        return apiError(res, 400, 'INVALID_PIN', 'Le code PIN ne peut pas être vide.');
      }
      if (!SUPERVISOR_PIN_RE.test(trimmed)) {
        return apiError(res, 400, 'INVALID_PIN', 'Le code PIN doit contenir entre 4 et 6 chiffres.');
      }
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('supervisor_pin', ?)").run(trimmed);
    }

    res.json({ ok: true });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PUT /api/supervisor/settings/maintenance-mode
 * Body: { active: true|false }
 * Active ou désactive le mode urgence.
 * Diffuse system:maintenance-mode à tous les clients via Socket.io.
 */
router.put('/settings/maintenance-mode', requireSupervisor, (req, res) => {
  try {
    const { active } = req.body;
    if (active === undefined) return Errors.missingField(res, 'active');
    if (typeof active !== 'boolean') return Errors.invalidType(res, 'active', 'boolean');

    const value = active ? '1' : '0';
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('maintenance_mode', ?)").run(value);

    const io = req.app.get('io');
    if (io) io.emit('system:maintenance-mode', { active });

    res.json({ maintenanceMode: active });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * GET /api/supervisor/settings/maintenance-mode
 * Retourne l'état courant du mode urgence.
 */
router.get('/settings/maintenance-mode', requireSupervisor, (req, res) => {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'maintenance_mode'").get();
    res.json({ maintenanceMode: row ? row.value === '1' : false });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PUT /api/supervisor/settings/history-retention-days
 * Body: { days }
 */
router.put('/settings/history-retention-days', requireSupervisor, (req, res) => {
  try {
    const { days } = req.body;
    if (days === undefined)       return Errors.missingField(res, 'days');
    if (!Number.isInteger(days) || days < 1) {
      return Errors.invalidType(res, 'days', 'entier >= 1');
    }

    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('history_retention_days', ?)").run(String(days));
    res.json({ historyRetentionDays: days });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PUT /api/supervisor/settings/max-pause-minutes
 * Body: { minutes }
 * Modifie la durée maximale d'une pause. Prise en effet immédiate (scheduler dynamique).
 * Diffuse system:settings-updated { maxPauseMinutes } via Socket.io.
 */
router.put('/settings/max-pause-minutes', requireSupervisor, (req, res) => {
  try {
    const { minutes } = req.body;
    if (minutes === undefined) return Errors.missingField(res, 'minutes');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
      return Errors.invalidType(res, 'minutes', 'entier entre 1 et 120');
    }

    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('max_pause_minutes', ?)").run(String(minutes));

    const io = req.app.get('io');
    if (io) io.emit('system:settings-updated', { maxPauseMinutes: minutes });

    res.json({ maxPauseMinutes: minutes });
  } catch (err) {
    Errors.internal(res, err);
  }
});

module.exports = router;
