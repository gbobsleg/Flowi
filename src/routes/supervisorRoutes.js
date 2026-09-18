const express = require('express');
const multer  = require('multer');
const router  = express.Router();
const db      = require('../db');
const { createSession, validatePin, requireSupervisor } = require('../middlewares/supervisorAuth');
const { effectiveQuota, countActivePauses, emitOfferUpdate, emitQuotasUpdate, allowedFromHeadcount, getParisClock } = require('./agentRoutes');
const { Errors, apiError, isValidOfferCode, newOfferCode, isPositiveInt, isPercent } = require('../middlewares/validate');
const { importGenesysBuffer, analyseGenesysBuffer, GenesysImportError, canonicalWfmLabel, slotsByDay } = require('../services/genesysPlanningImport');
const { pauseWindowStatus } = require('../lib/pauseWindows');

function nowIso() { return new Date().toISOString(); }

const SUPERVISOR_PIN_RE = /^\d{4,6}$/;

const UPSERT_SETTING =
  'INSERT INTO app_settings (key, value) VALUES ($1, $2) ' +
  'ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value';

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

const OFFER_COLUMNS =
  'id, code, label, default_quota, color, is_active, purge_requested_at, created_at';

async function hardDeleteOffer(client, offerId) {
  await client.query('DELETE FROM quota_rules WHERE offer_id = $1', [offerId]);
  await client.query('UPDATE wfm_activity_mappings SET offer_id = NULL WHERE offer_id = $1', [offerId]);
  await client.query('DELETE FROM planning_slots WHERE offer_id = $1', [offerId]);
  await client.query('DELETE FROM offers WHERE id = $1', [offerId]);
}

// ---------- Authentification ----------

/**
 * POST /api/supervisor/auth
 * Body: { pin }
 */
router.post('/auth', async (req, res) => {
  try {
    const { pin } = req.body;
    if (!pin)               return Errors.missingField(res, 'pin');
    if (typeof pin !== 'string') return Errors.invalidType(res, 'pin', 'string');

    if (!(await validatePin(pin.trim()))) return Errors.unauthorized(res);

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
 * Exclut les offres en file de suppression définitive.
 */
router.get('/offers', requireSupervisor, async (req, res) => {
  try {
    const offers = await db.queryAll(
      `SELECT ${OFFER_COLUMNS} FROM offers WHERE purge_requested_at IS NULL ORDER BY code ASC`
    );
    res.json({ offers });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * POST /api/supervisor/offers
 * Body: { label, default_quota?, color? } — le code client est ignoré.
 */
router.post('/offers', requireSupervisor, async (req, res) => {
  try {
    const label = typeof req.body.label === 'string' ? req.body.label.trim() : '';
    const defaultQuotaRaw = req.body.default_quota;
    const defaultQuota = defaultQuotaRaw === undefined ? 2 : parseInt(defaultQuotaRaw, 10);
    const parsedColor = parseOfferColorInput(req.body.color);
    if (!label) return Errors.missingField(res, 'label');
    if (!Number.isInteger(defaultQuota) || defaultQuota < 0) {
      return Errors.invalidType(res, 'default_quota', 'entier >= 0');
    }
    if (parsedColor && typeof parsedColor === 'object' && parsedColor.error) {
      return res.status(400).json({ error: { code: 'INVALID_COLOR', message: parsedColor.error } });
    }

    const now = nowIso();
    const maxAttempts = 3;
    let offer = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const code = newOfferCode();
      try {
        offer = await db.queryOne(
          'INSERT INTO offers (code, label, default_quota, color, is_active, created_at) ' +
          `VALUES ($1, $2, $3, $4, true, $5) RETURNING ${OFFER_COLUMNS}`,
          [code, label, defaultQuota, parsedColor, now]
        );
        break;
      } catch (err) {
        if (err.code === '23505' && attempt < maxAttempts - 1) continue;
        if (err.code === '23505') {
          return Errors.conflict(res, 'Impossible d’attribuer un code interne unique');
        }
        throw err;
      }
    }

    const io = req.app.get('io');
    if (io) await emitQuotasUpdate(io);

    return res.status(201).json({ offer });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PUT /api/supervisor/offers/:offerCode
 * Body: { label?, default_quota?, color?, is_active? }
 */
router.put('/offers/:offerCode', requireSupervisor, async (req, res) => {
  try {
    const offerCode = typeof req.params.offerCode === 'string' ? req.params.offerCode.trim() : '';
    if (!isValidOfferCode(offerCode)) {
      return Errors.invalidType(res, 'offerCode', 'code offre alphanumérique (ex: OFFRE_A)');
    }
    const existing = await db.queryOne(
      `SELECT ${OFFER_COLUMNS} FROM offers WHERE code = $1`,
      [offerCode]
    );
    if (!existing || existing.purge_requested_at) {
      return Errors.notFound(res, `Offre "${offerCode}"`);
    }

    const hasLabel = req.body.label !== undefined;
    const hasDefaultQuota = req.body.default_quota !== undefined;
    const hasColor = req.body.color !== undefined;
    const hasActive = req.body.is_active !== undefined;
    if (!hasLabel && !hasDefaultQuota && !hasColor && !hasActive) {
      return Errors.missingField(res, 'label | default_quota | color | is_active');
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

    let nextActive = null;
    if (hasActive) {
      if (typeof req.body.is_active !== 'boolean') {
        return Errors.invalidType(res, 'is_active', 'booléen');
      }
      nextActive = req.body.is_active;
    }

    await db.query(
      'UPDATE offers SET ' +
      'label = CASE WHEN $1 THEN $2 ELSE label END, ' +
      'default_quota = CASE WHEN $3 THEN $4 ELSE default_quota END, ' +
      'color = CASE WHEN $5 THEN $6 ELSE color END, ' +
      'is_active = CASE WHEN $7 THEN $8 ELSE is_active END ' +
      'WHERE code = $9',
      [
        hasLabel, hasLabel ? nextLabel : null,
        hasDefaultQuota, hasDefaultQuota ? nextDefaultQuota : null,
        hasColor, hasColor ? nextColor : null,
        hasActive, hasActive ? nextActive : null,
        offerCode,
      ]
    );

    const offer = await db.queryOne(
      `SELECT ${OFFER_COLUMNS} FROM offers WHERE code = $1`,
      [offerCode]
    );

    const io = req.app.get('io');
    if (io) await emitQuotasUpdate(io);

    res.json({ offer });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * DELETE /api/supervisor/offers/:offerCode
 * Suppression définitive : SQL immédiat si aucune pause, sinon file d'attente.
 */
router.delete('/offers/:offerCode', requireSupervisor, async (req, res) => {
  try {
    const offerCode = typeof req.params.offerCode === 'string' ? req.params.offerCode.trim() : '';
    if (!isValidOfferCode(offerCode)) {
      return Errors.invalidType(res, 'offerCode', 'code offre alphanumérique (ex: OFFRE_A)');
    }

    const existing = await db.queryOne(
      `SELECT ${OFFER_COLUMNS} FROM offers WHERE code = $1`,
      [offerCode]
    );
    if (!existing || existing.purge_requested_at) {
      return Errors.notFound(res, `Offre "${offerCode}"`);
    }

    const inProgress = await db.queryOne(
      "SELECT COUNT(*) AS cnt FROM pauses WHERE offer_id = $1 AND status = 'in_progress'",
      [existing.id]
    );
    if (Number(inProgress.cnt) > 0) {
      return Errors.conflict(res, 'Impossible de supprimer : des agents sont encore en pause sur cette offre.');
    }

    const remaining = await db.queryOne(
      'SELECT COUNT(*) AS cnt FROM pauses WHERE offer_id = $1',
      [existing.id]
    );
    const historyCount = Number(remaining.cnt);

    if (historyCount === 0) {
      await db.withTransaction(async (client) => {
        await hardDeleteOffer(client, existing.id);
      });

      const io = req.app.get('io');
      if (io) await emitQuotasUpdate(io);

      return res.json({ deleted: true, offer: null, message: 'Offre supprimée.' });
    }

    const offer = await db.queryOne(
      `UPDATE offers SET is_active = false, purge_requested_at = $2
       WHERE id = $1
       RETURNING ${OFFER_COLUMNS}`,
      [existing.id, nowIso()]
    );

    const io = req.app.get('io');
    if (io) await emitQuotasUpdate(io);

    res.json({
      deleted: false,
      queued: true,
      offer,
      message: 'Offre retirée. Suppression définitive après disparition de l’historique.',
    });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PATCH /api/supervisor/offers/:offerCode/activate
 * Alias de PUT { is_active: true }.
 */
router.patch('/offers/:offerCode/activate', requireSupervisor, async (req, res) => {
  try {
    const offerCode = typeof req.params.offerCode === 'string' ? req.params.offerCode.trim() : '';
    if (!isValidOfferCode(offerCode)) {
      return Errors.invalidType(res, 'offerCode', 'code offre alphanumérique (ex: OFFRE_A)');
    }

    const existing = await db.queryOne(
      `SELECT ${OFFER_COLUMNS} FROM offers WHERE code = $1`,
      [offerCode]
    );
    if (!existing || existing.purge_requested_at) {
      return Errors.notFound(res, `Offre "${offerCode}"`);
    }
    if (existing.is_active) {
      return res.json({ offer: existing, changed: false, message: 'Offre déjà active.' });
    }

    await db.query('UPDATE offers SET is_active = true WHERE code = $1', [offerCode]);
    const offer = await db.queryOne(
      `SELECT ${OFFER_COLUMNS} FROM offers WHERE code = $1`,
      [offerCode]
    );

    const io = req.app.get('io');
    if (io) await emitQuotasUpdate(io);

    res.json({ offer, changed: true, message: 'Offre réactivée.' });
  } catch (err) {
    Errors.internal(res, err);
  }
});

// ---------- Annuaire agents (superviseur) ----------

/**
 * GET /api/supervisor/agents?status=active|inactive
 */
router.get('/agents', requireSupervisor, async (req, res) => {
  try {
    const status = typeof req.query.status === 'string' ? req.query.status.trim().toLowerCase() : '';
    const sessionRegistry = req.app.get('sessionRegistry');
    const hasActiveSession = typeof sessionRegistry?.hasActiveSession === 'function'
      ? sessionRegistry.hasActiveSession
      : () => false;
    let rows;

    if (!status) {
      rows = await db.queryAll(
        'SELECT matricule, nom, prenom, is_active FROM agents ORDER BY nom ASC, prenom ASC, matricule ASC'
      );
    } else if (status === 'active') {
      rows = await db.queryAll(
        'SELECT matricule, nom, prenom, is_active FROM agents WHERE is_active = true ORDER BY nom ASC, prenom ASC, matricule ASC'
      );
    } else if (status === 'inactive') {
      rows = await db.queryAll(
        'SELECT matricule, nom, prenom, is_active FROM agents WHERE is_active = false ORDER BY nom ASC, prenom ASC, matricule ASC'
      );
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
router.post('/agents', requireSupervisor, async (req, res) => {
  try {
    const matricule = typeof req.body.matricule === 'string' ? req.body.matricule.trim() : '';
    const nom = typeof req.body.nom === 'string' ? req.body.nom.trim() : '';
    const prenom = typeof req.body.prenom === 'string' ? req.body.prenom.trim() : '';

    const missing = [];
    if (!matricule) missing.push('matricule');
    if (!nom) missing.push('nom');
    if (!prenom) missing.push('prenom');
    if (missing.length > 0) return Errors.missingField(res, ...missing);

    const existing = await db.queryOne('SELECT matricule FROM agents WHERE matricule = $1', [matricule]);
    if (existing) return Errors.conflict(res, `Matricule "${matricule}" déjà existant`);

    await db.query(
      'INSERT INTO agents (matricule, nom, prenom, is_active) VALUES ($1, $2, $3, true)',
      [matricule, nom, prenom]
    );

    res.status(201).json({ agent: { matricule, nom, prenom, is_active: true } });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PATCH /api/supervisor/agents/:matricule/activate
 */
router.patch('/agents/:matricule/activate', requireSupervisor, async (req, res) => {
  try {
    const matricule = typeof req.params.matricule === 'string' ? req.params.matricule.trim() : '';
    if (!matricule) return Errors.missingField(res, 'matricule');

    const result = await db.query('UPDATE agents SET is_active = true WHERE matricule = $1', [matricule]);
    if (result.rowCount === 0) return Errors.notFound(res, `Agent "${matricule}"`);

    const agent = await db.queryOne(
      'SELECT matricule, nom, prenom, is_active FROM agents WHERE matricule = $1',
      [matricule]
    );
    res.json({ agent });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PATCH /api/supervisor/agents/:matricule/deactivate
 */
router.patch('/agents/:matricule/deactivate', requireSupervisor, async (req, res) => {
  try {
    const matricule = typeof req.params.matricule === 'string' ? req.params.matricule.trim() : '';
    if (!matricule) return Errors.missingField(res, 'matricule');

    const result = await db.query('UPDATE agents SET is_active = false WHERE matricule = $1', [matricule]);
    if (result.rowCount === 0) return Errors.notFound(res, `Agent "${matricule}"`);

    const agent = await db.queryOne(
      'SELECT matricule, nom, prenom, is_active FROM agents WHERE matricule = $1',
      [matricule]
    );
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
router.get('/quotas', requireSupervisor, async (req, res) => {
  try {
    const offers = await db.queryAll(
      'SELECT * FROM offers WHERE purge_requested_at IS NULL ORDER BY code'
    );
    const data = [];
    for (const offer of offers) {
      const rule   = await db.queryOne('SELECT * FROM quota_rules WHERE offer_id = $1', [offer.id]) || {};
      const quota  = await effectiveQuota(offer.id);
      const active = await countActivePauses(offer.id);
      data.push({
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
      });
    }
    res.json({ quotas: data });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PUT /api/supervisor/quotas/:offerCode
 * Body: { fixedQuota?, allowedPercent? }
 */
router.put('/quotas/:offerCode', requireSupervisor, async (req, res) => {
  try {
    const { offerCode } = req.params;
    if (!isValidOfferCode(offerCode)) return Errors.notFound(res, `Offre "${offerCode}"`);

    const offer = await db.queryOne(
      'SELECT * FROM offers WHERE code = $1 AND purge_requested_at IS NULL',
      [offerCode]
    );
    if (!offer) return Errors.notFound(res, `Offre "${offerCode}"`);

    const { fixedQuota, allowedPercent } = req.body;
    const hasFixed   = fixedQuota     !== undefined;
    const hasPercent = allowedPercent !== undefined;

    if (!hasFixed && !hasPercent) {
      return Errors.missingField(res, 'fixedQuota | allowedPercent');
    }

    if (hasFixed && fixedQuota !== null && !isPositiveInt(fixedQuota)) {
      return Errors.invalidType(res, 'fixedQuota', 'entier >= 0 ou null');
    }
    if (hasPercent && allowedPercent !== null && !isPercent(allowedPercent)) {
      return Errors.invalidType(res, 'allowedPercent', 'nombre entre 0 et 100 ou null');
    }

    const now      = nowIso();
    const existing = await db.queryOne('SELECT id FROM quota_rules WHERE offer_id = $1', [offer.id]);

    if (existing) {
      await db.query(
        'UPDATE quota_rules SET ' +
        'fixed_quota     = CASE WHEN $1 THEN $2 ELSE fixed_quota END, ' +
        'allowed_percent = CASE WHEN $3 THEN $4 ELSE allowed_percent END, ' +
        'updated_at = $5 WHERE offer_id = $6',
        [
          hasFixed, hasFixed ? fixedQuota : null,
          hasPercent, hasPercent ? allowedPercent : null,
          now, offer.id,
        ]
      );
    } else {
      await db.query(
        'INSERT INTO quota_rules (offer_id, fixed_quota, present_count, allowed_percent, updated_at) VALUES ($1, $2, NULL, $3, $4)',
        [
          offer.id,
          hasFixed   ? fixedQuota     : null,
          hasPercent ? allowedPercent : null,
          now,
        ]
      );
    }

    const quota  = await effectiveQuota(offer.id);
    const active = await countActivePauses(offer.id);

    const io = req.app.get('io');
    if (io) {
      const quotaPayload = { offerCode, effectiveQuota: quota, currentPaused: active, blockedForNewStarts: active >= quota };
      io.to(`offer:${offerCode}`).emit('quota:updated', quotaPayload);
      io.emit('quota:updated', quotaPayload);

      await emitOfferUpdate(io, offerCode, offer.id);
    }

    res.json({ offerCode, effectiveQuota: quota, currentPaused: active, blocked: active >= quota });
  } catch (err) {
    Errors.internal(res, err);
  }
});

const uploadPlanning = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
}).single('file');

function parseHmSetting(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { hhmm: `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`, minutes: h * 60 + min };
}

/**
 * GET /api/supervisor/planning/mapping
 * Union des libellés déjà mappés et de ceux vus dans planning_activities.
 */
router.get('/planning/mapping', requireSupervisor, async (req, res) => {
  try {
    const offers = await db.queryAll(
      'SELECT id, code FROM offers WHERE purge_requested_at IS NULL'
    );
    const codeById = new Map(offers.map((o) => [o.id, o.code]));

    const mapped = await db.queryAll(
      'SELECT label, offer_id FROM wfm_activity_mappings ORDER BY label'
    );
    const activityLabels = await db.queryAll(
      'SELECT DISTINCT wfm_label AS label FROM planning_activities ORDER BY 1'
    );

    const byLabel = new Map();
    const remember = (rawLabel, offerId, fromMapping) => {
      const label = canonicalWfmLabel(rawLabel);
      if (!label) return;
      const existing = byLabel.get(label);
      const nextOfferId = offerId == null ? null : offerId;
      if (!existing) {
        byLabel.set(label, {
          label,
          offerId: nextOfferId,
          offerCode: nextOfferId == null ? null : (codeById.get(nextOfferId) ?? null),
          ignored: fromMapping && nextOfferId == null,
          unmapped: nextOfferId == null,
        });
        return;
      }
      if (existing.offerId == null && nextOfferId != null) {
        existing.offerId = nextOfferId;
        existing.offerCode = codeById.get(nextOfferId) ?? null;
        existing.ignored = false;
        existing.unmapped = false;
      } else if (fromMapping && existing.offerId == null && nextOfferId == null) {
        existing.ignored = true;
        existing.unmapped = true;
      }
    };
    for (const row of mapped) remember(row.label, row.offer_id, true);
    for (const row of activityLabels) remember(row.label, null, false);

    const mappings = [...byLabel.values()].sort((a, b) =>
      a.label.localeCompare(b.label, 'fr')
    );
    res.json({ mappings });
  } catch (err) {
    Errors.internal(res, err);
  }
});

function handlePlanningUpload(req, res, next) {
  uploadPlanning(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return apiError(res, 400, 'FILE_TOO_LARGE', 'Fichier trop volumineux (max 5 Mo)');
    }
    return Errors.invalidType(res, 'file', 'fichier CSV');
  });
}

/**
 * POST /api/supervisor/planning/import/preview
 * Parse le CSV sans écrire. multipart field: file
 */
router.post('/planning/import/preview', requireSupervisor, handlePlanningUpload, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return Errors.missingField(res, 'file');
    const payload = await db.withTransaction(async (client) => {
      const analysed = await analyseGenesysBuffer(req.file.buffer, client);
      const offerRes = await client.query(
        `SELECT o.id, o.code, o.label, o.default_quota, o.color, o.is_active,
                qr.allowed_percent, qr.fixed_quota
         FROM offers o
         LEFT JOIN quota_rules qr ON qr.offer_id = o.id
         WHERE o.purge_requested_at IS NULL
         ORDER BY o.code`
      );
      const offers = offerRes.rows.map((row) => ({
        offerId: row.id,
        offerCode: row.code,
        label: row.label,
        color: row.color,
        isActive: row.is_active === true,
        defaultQuota: row.default_quota,
        allowedPercent: row.allowed_percent == null ? null : Number(row.allowed_percent),
        fixedQuota: row.fixed_quota == null ? null : Number(row.fixed_quota),
      }));
      return {
        ...analysed.summary,
        offersByDay: slotsByDay(analysed.activityRows, analysed.mappingRows, offers),
      };
    });
    res.json(payload);
  } catch (err) {
    if (err instanceof GenesysImportError || err.code === 'FORMAT') {
      return apiError(res, 400, err.code || 'FORMAT', err.message);
    }
    Errors.internal(res, err);
  }
});

/**
 * POST /api/supervisor/planning/import
 * multipart field: file
 */
router.post('/planning/import', requireSupervisor, handlePlanningUpload, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return Errors.missingField(res, 'file');
    const result = await importGenesysBuffer(req.file.buffer);
    const io = req.app.get('io');
    if (io) await emitQuotasUpdate(io);
    res.json(result);
  } catch (err) {
    if (err instanceof GenesysImportError || err.code === 'FORMAT') {
      return apiError(res, 400, err.code || 'FORMAT', err.message);
    }
    Errors.internal(res, err);
  }
});

/**
 * PUT /api/supervisor/planning/mapping
 * Body: { mappings: [{ label, offerCode|null }] }
 */
router.put('/planning/mapping', requireSupervisor, async (req, res) => {
  try {
    const mappings = req.body && req.body.mappings;
    if (!Array.isArray(mappings)) {
      return Errors.invalidType(res, 'mappings', 'tableau { label, offerCode }');
    }

    const offers = await db.queryAll(
      'SELECT id, code FROM offers WHERE purge_requested_at IS NULL'
    );
    const offerByCode = new Map(offers.map((o) => [o.code, o.id]));

    const byCanon = new Map();
    for (const item of mappings) {
      const raw = typeof item?.label === 'string' ? item.label : '';
      const label = canonicalWfmLabel(raw);
      if (!label) return Errors.invalidType(res, 'mappings.label', 'chaîne non vide');
      const rawCode = item.offerCode;
      if (rawCode !== undefined && rawCode !== null && rawCode !== '') {
        if (typeof rawCode !== 'string' || !offerByCode.has(rawCode)) {
          return Errors.notFound(res, `Offre "${rawCode}"`);
        }
        byCanon.set(label, { label, offerId: offerByCode.get(rawCode) });
      } else {
        byCanon.set(label, { label, offerId: null });
      }
    }
    const normalized = [...byCanon.values()];

    await db.withTransaction(async (client) => {
      for (const row of normalized) {
        await client.query(
          `DELETE FROM wfm_activity_mappings
           WHERE label <> $1
             AND TRIM(BOTH FROM REGEXP_REPLACE(REGEXP_REPLACE(label, '\\s*\\([^)]*\\)', ' ', 'g'), '\\s+', ' ', 'g')) = $1`,
          [row.label]
        );
        await client.query(
          `INSERT INTO wfm_activity_mappings (label, offer_id) VALUES ($1, $2)
           ON CONFLICT (label) DO UPDATE SET offer_id = EXCLUDED.offer_id`,
          [row.label, row.offerId]
        );
      }
      await db.rebuildPlanningSlots(client);
    });

    const io = req.app.get('io');
    if (io) await emitQuotasUpdate(io);

    const saved = await db.queryAll(
      'SELECT label, offer_id FROM wfm_activity_mappings ORDER BY label'
    );
    const collapsed = new Map();
    for (const r of saved) {
      const label = canonicalWfmLabel(r.label) || r.label;
      collapsed.set(label, {
        label,
        offerId: r.offer_id,
        offerCode: offers.find((o) => o.id === r.offer_id)?.code ?? null,
      });
    }
    res.json({ mappings: [...collapsed.values()] });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * GET /api/supervisor/planning/slots?day=YYYY-MM-DD
 */
router.get('/planning/slots', requireSupervisor, async (req, res) => {
  try {
    const day = typeof req.query.day === 'string' ? req.query.day.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return Errors.invalidType(res, 'day', 'YYYY-MM-DD');
    }

    const rows = await db.queryAll(
      `SELECT o.id, o.code, o.label, o.default_quota, o.color, o.is_active,
              qr.allowed_percent, qr.fixed_quota,
              ps.slot_minutes, ps.headcount
       FROM offers o
       LEFT JOIN quota_rules qr ON qr.offer_id = o.id
       LEFT JOIN planning_slots ps ON ps.offer_id = o.id AND ps.day = $1::date
       WHERE o.purge_requested_at IS NULL
       ORDER BY o.code, ps.slot_minutes`,
      [day]
    );

    const byOffer = new Map();
    for (const row of rows) {
      if (!byOffer.has(row.id)) {
        byOffer.set(row.id, {
          offerId: row.id,
          offerCode: row.code,
          label: row.label,
          color: row.color,
          isActive: row.is_active === true,
          defaultQuota: row.default_quota,
          allowedPercent: row.allowed_percent == null ? null : Number(row.allowed_percent),
          fixedQuota: row.fixed_quota == null ? null : Number(row.fixed_quota),
          slots: [],
        });
      }
      if (row.slot_minutes == null) continue;
      const percent = row.allowed_percent == null ? null : Number(row.allowed_percent);
      const headcount = Number(row.headcount);
      const allowed = percent == null
        ? Number(row.default_quota)
        : allowedFromHeadcount(headcount, percent);
      byOffer.get(row.id).slots.push({
        slotMinutes: Number(row.slot_minutes),
        headcount,
        allowed,
      });
    }

    res.json({ day, offers: [...byOffer.values()] });
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
router.post('/pause/force-stop', requireSupervisor, async (req, res) => {
  try {
    const agentMatricule = typeof req.body.agent_matricule === 'string' ? req.body.agent_matricule.trim() : '';
    if (!agentMatricule) return Errors.missingField(res, 'agent_matricule');

    const now = nowIso();

    const result = await db.withTransaction(async (client) => {
      const pauseResult = await client.query(
        'SELECT p.*, o.code AS offer_code, o.id AS offer_id_val ' +
        'FROM pauses p JOIN offers o ON o.id = p.offer_id ' +
        "WHERE p.agent_matricule = $1 AND p.status = 'in_progress' LIMIT 1",
        [agentMatricule]
      );
      const pause = pauseResult.rows[0];

      if (!pause) return { err: 'NOT_FOUND' };

      const durationSeconds = Math.round((new Date(now) - new Date(pause.start_time)) / 1000);

      await client.query(
        "UPDATE pauses SET status = 'ended', end_time = $1, end_reason = 'supervisor_forced', duration_seconds = $2, updated_at = $3 WHERE id = $4",
        [now, durationSeconds, now, pause.id]
      );

      return { pause, durationSeconds, endTime: now };
    });

    if (result.err === 'NOT_FOUND') return Errors.notFound(res, 'Pause active pour cet agent');

    const io = req.app.get('io');
    if (io) {
      const agent     = await db.queryOne('SELECT nom, prenom FROM agents WHERE matricule = $1', [agentMatricule]);
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
      await emitOfferUpdate(io, offerCode, result.pause.offer_id_val);
      await emitQuotasUpdate(io);
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
router.get('/history', requireSupervisor, async (req, res) => {
  try {
    const { offerCode, from, to } = req.query;
    const page  = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;

    if (offerCode && !isValidOfferCode(offerCode)) {
      return Errors.invalidType(res, 'offerCode', 'code offre alphanumérique');
    }
    if (from && isNaN(Date.parse(from))) return Errors.invalidType(res, 'from', 'date ISO 8601');
    if (to   && isNaN(Date.parse(to)))   return Errors.invalidType(res, 'to',   'date ISO 8601');

    const where = ["p.status = 'ended'"];
    const args  = [];

    if (offerCode) { args.push(offerCode); where.push(`o.code = $${args.length}`); }
    if (from)      { args.push(from);      where.push(`p.start_time >= $${args.length}`); }
    if (to)        { args.push(to);        where.push(`p.start_time <= $${args.length}`); }

    const whereClause = 'WHERE ' + where.join(' AND ');
    const limitIdx  = args.length + 1;
    const offsetIdx = args.length + 2;

    const rows = await db.queryAll(
      `SELECT p.id, p.agent_matricule, a.nom, a.prenom, o.code AS offer_code, o.label AS offer_label,
              p.start_time, p.end_time, p.end_reason, p.duration_seconds, p.max_minutes_at_end
       FROM pauses p
       JOIN agents a ON a.matricule = p.agent_matricule
       JOIN offers o ON o.id = p.offer_id
       ${whereClause}
       ORDER BY p.start_time DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      [...args, limit, offset]
    );

    const countRow = await db.queryOne(
      `SELECT COUNT(*) AS total FROM pauses p JOIN offers o ON o.id = p.offer_id ${whereClause}`,
      args
    );
    const total = Number(countRow.total);

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
router.get('/settings', requireSupervisor, async (req, res) => {
  try {
    const rows = await db.queryAll('SELECT key, value FROM app_settings');
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
router.put('/settings', requireSupervisor, async (req, res) => {
  try {
    const body = req.body || {};

    if (body.github_owner !== undefined) {
      if (typeof body.github_owner !== 'string') {
        return Errors.invalidType(res, 'github_owner', 'chaîne');
      }
      await db.query(UPSERT_SETTING, ['github_owner', normalizeGithubOwnerRepo(body.github_owner)]);
    }

    if (body.github_repo !== undefined) {
      if (typeof body.github_repo !== 'string') {
        return Errors.invalidType(res, 'github_repo', 'chaîne');
      }
      await db.query(UPSERT_SETTING, ['github_repo', normalizeGithubOwnerRepo(body.github_repo)]);
    }

    if (Object.prototype.hasOwnProperty.call(body, 'github_token')) {
      const t = body.github_token;
      if (t !== undefined && t !== null && typeof t !== 'string') {
        return Errors.invalidType(res, 'github_token', 'chaîne ou chaîne vide');
      }
      const tokenVal = typeof t === 'string' ? t : '';
      await db.query(UPSERT_SETTING, ['github_token', tokenVal]);
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
      await db.query(UPSERT_SETTING, ['supervisor_pin', trimmed]);
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
router.put('/settings/maintenance-mode', requireSupervisor, async (req, res) => {
  try {
    const { active } = req.body;
    if (active === undefined) return Errors.missingField(res, 'active');
    if (typeof active !== 'boolean') return Errors.invalidType(res, 'active', 'boolean');

    const value = active ? '1' : '0';
    await db.query(UPSERT_SETTING, ['maintenance_mode', value]);

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
router.get('/settings/maintenance-mode', requireSupervisor, async (req, res) => {
  try {
    const row = await db.queryOne("SELECT value FROM app_settings WHERE key = 'maintenance_mode'");
    res.json({ maintenanceMode: row ? row.value === '1' : false });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PUT /api/supervisor/settings/history-retention-days
 * Body: { days }
 */
router.put('/settings/history-retention-days', requireSupervisor, async (req, res) => {
  try {
    const { days } = req.body;
    if (days === undefined)       return Errors.missingField(res, 'days');
    if (!Number.isInteger(days) || days < 1) {
      return Errors.invalidType(res, 'days', 'entier >= 1');
    }

    await db.query(UPSERT_SETTING, ['history_retention_days', String(days)]);
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
router.put('/settings/max-pause-minutes', requireSupervisor, async (req, res) => {
  try {
    const { minutes } = req.body;
    if (minutes === undefined) return Errors.missingField(res, 'minutes');
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) {
      return Errors.invalidType(res, 'minutes', 'entier entre 1 et 120');
    }

    await db.query(UPSERT_SETTING, ['max_pause_minutes', String(minutes)]);

    const io = req.app.get('io');
    if (io) io.emit('system:settings-updated', { maxPauseMinutes: minutes });

    res.json({ maxPauseMinutes: minutes });
  } catch (err) {
    Errors.internal(res, err);
  }
});

/**
 * PUT /api/supervisor/settings/pause-windows
 * Body: { windows: [{ start: "HH:MM", end: "HH:MM" }] }
 * Tableau vide = pauses autorisées 24h.
 */
router.put('/settings/pause-windows', requireSupervisor, async (req, res) => {
  try {
    const windows = req.body && req.body.windows;
    if (!Array.isArray(windows)) {
      return Errors.invalidType(res, 'windows', 'tableau { start, end }');
    }

    const normalized = [];
    for (const w of windows) {
      const start = parseHmSetting(w && w.start);
      const end = parseHmSetting(w && w.end);
      if (!start || !end) {
        return Errors.invalidType(res, 'windows', 'plages HH:MM valides');
      }
      if (!(start.minutes < end.minutes)) {
        return Errors.invalidType(res, 'windows', 'début strictement avant fin');
      }
      normalized.push({ start: start.hhmm, end: end.hhmm });
    }

    await db.query(UPSERT_SETTING, ['pause_windows', JSON.stringify(normalized)]);

    const pauseWindows = pauseWindowStatus(getParisClock().minutesOfDay, normalized);
    const io = req.app.get('io');
    if (io) {
      await emitQuotasUpdate(io);
      io.emit('system:settings-updated', { pauseWindows });
    }

    res.json({ windows: normalized });
  } catch (err) {
    Errors.internal(res, err);
  }
});

function parseImportWeekdays(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const set = new Set();
  for (const n of raw) {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || v > 7) return null;
    set.add(v);
  }
  if (set.size === 0) return null;
  return [...set].sort((a, b) => a - b);
}

/**
 * PUT /api/supervisor/settings/planning-import-days
 * Body: { weekdays: [1-7], skipFrenchHolidays: boolean }
 * UPSERT uniquement des deux clés ; n’écrase pas pause_windows ni le reste.
 */
router.put('/settings/planning-import-days', requireSupervisor, async (req, res) => {
  try {
    const body = req.body || {};
    const weekdays = parseImportWeekdays(body.weekdays);
    if (!weekdays) {
      return Errors.invalidType(res, 'weekdays', 'tableau d’entiers 1–7, au moins un jour');
    }
    if (typeof body.skipFrenchHolidays !== 'boolean') {
      return Errors.invalidType(res, 'skipFrenchHolidays', 'booléen');
    }

    await db.query(UPSERT_SETTING, ['planning_import_weekdays', JSON.stringify(weekdays)]);
    await db.query(UPSERT_SETTING, ['planning_skip_french_holidays', body.skipFrenchHolidays ? '1' : '0']);

    res.json({ weekdays, skipFrenchHolidays: body.skipFrenchHolidays });
  } catch (err) {
    Errors.internal(res, err);
  }
});

module.exports = router;
