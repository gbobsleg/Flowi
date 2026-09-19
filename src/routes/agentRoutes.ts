'use strict';

import type { Request, Response } from 'express';
import type { PublicBudget } from '../lib/pauseBudget';

const express = require('express');
const router = express.Router();
const db = require('../db');
const { Errors, isValidOfferCode } = require('../middlewares/validate');
const { pauseLimitMessage } = require('../lib/pauseBudget');
const {
  qOne,
  loadPauseWindowStatus,
  loadMaxPauseMinutes,
  loadAgentPauseBudget,
  emitDirectoryCredits,
} = require('../lib/pauseCredits');
const {
  loadAnonymizeAgentNames,
  redactSnapshot,
  broadcastPauseEvent,
} = require('../lib/pauseIdentity');
const {
  effectiveQuota,
  countActivePauses,
  visibleOffersForAgent,
  buildQuotasSnapshot,
  emitOfferUpdate,
  emitQuotasUpdate,
} = require('../lib/offerQuota');

type StartBody = { agent_matricule?: unknown; offerCode?: unknown };
type StopBody = { agent_matricule?: unknown };

function normalize(name: string): string {
  return name.trim().toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
}

function nowIso(): string {
  return new Date().toISOString();
}

async function offerByCode(code: string) {
  return db.queryOne('SELECT * FROM offers WHERE code = $1', [code]);
}

function sanitizeText(v: unknown, max = 100): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

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

router.get('/bootstrap', async (req: Request, res: Response) => {
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

    const maxPauseMinutes = await loadMaxPauseMinutes();
    const anonymizeAgentNames = await loadAnonymizeAgentNames();
    const snapshot = await buildSnapshot();
    const pauseBudget: PublicBudget | null = agentMatricule
      ? await loadAgentPauseBudget(agentMatricule)
      : null;

    res.json({
      agent: agent || null,
      activePause: activePause || null,
      snapshot: anonymizeAgentNames ? redactSnapshot(snapshot, agentMatricule || null) : snapshot,
      quotas: await buildQuotasSnapshot(),
      pauseWindows: await loadPauseWindowStatus(),
      pauseBudget,
      maintenanceMode,
      maxPauseMinutes,
      anonymizeAgentNames,
    });
  } catch (err) {
    Errors.internal(res, err);
  }
});

router.post('/identify', async (req: Request, res: Response) => {
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

router.get('/suggestions', async (req: Request, res: Response) => {
  try {
    const query = req.query.query;
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

router.post('/pause/start', async (req: Request, res: Response) => {
  try {
    const body = req.body as StartBody;
    const agentMatricule = sanitizeText(body.agent_matricule, 32);
    const offerCode = sanitizeText(body.offerCode, 32);

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

    const result = await db.withTransaction(async (client: { query: Function }) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
        ['pause-start', agentMatricule]
      );

      const windowStatusTx = await loadPauseWindowStatus(client);
      if (!windowStatusTx.open) {
        return { err: 'OUTSIDE_WINDOW' as const, nextOpen: windowStatusTx.nextOpen };
      }

      await client.query('SELECT id FROM offers WHERE id = $1 FOR UPDATE', [offer.id]);

      const existingPause = await qOne(
        "SELECT id FROM pauses WHERE agent_matricule = $1 AND status = 'in_progress' LIMIT 1",
        [agentMatricule],
        client
      );
      if (existingPause) return { err: 'CONFLICT' as const, message: 'Une pause est déjà en cours pour cet agent' };

      const budget: PublicBudget = await loadAgentPauseBudget(agentMatricule, client);
      if (!budget.canStart) {
        return { err: 'PAUSE_LIMIT' as const, budget };
      }

      const quota = await effectiveQuota(offer.id, client);
      const active = await countActivePauses(offer.id, client);
      if (active >= quota) return { err: 'QUOTA_REACHED' as const, quota, active };

      const inserted = await qOne(
        "INSERT INTO pauses (agent_matricule, offer_id, start_time, status, created_at, updated_at, allowed_seconds) " +
        "VALUES ($1, $2, $3, 'in_progress', $4, $5, $6) RETURNING id, allowed_seconds",
        [agentMatricule, offer.id, now, now, now, budget.sittingCapSeconds],
        client
      );

      const pauseBudget: PublicBudget = await loadAgentPauseBudget(agentMatricule, client);
      return {
        pauseId: inserted.id,
        startTime: now,
        allowedSeconds: inserted.allowed_seconds,
        pauseBudget,
      };
    });

    if (result.err === 'OUTSIDE_WINDOW') return Errors.outsidePauseWindow(res, result.nextOpen);
    if (result.err === 'CONFLICT') return Errors.conflict(res, result.message);
    if (result.err === 'PAUSE_LIMIT') {
      return Errors.pauseLimitReached(res, pauseLimitMessage(result.budget.reason), result.budget);
    }
    if (result.err === 'QUOTA_REACHED') return Errors.quotaReached(res, result.quota, result.active);

    const pauseBudget: PublicBudget = result.pauseBudget;
    const io = req.app.get('io') as any;
    if (io) {
      const startedPayload = {
        pauseId: result.pauseId,
        agent_matricule: agentMatricule,
        agentName: `${agent.prenom} ${agent.nom}`,
        offerCode,
        startTime: result.startTime,
        allowedSeconds: result.allowedSeconds,
        pauseBudget,
      };
      broadcastPauseEvent(io, 'pause:started', startedPayload, await loadAnonymizeAgentNames());

      await emitOfferUpdate(io, offerCode, offer.id);
      await emitQuotasUpdate(io);
      await emitDirectoryCredits(io);
    }

    res.status(201).json({
      pauseId: result.pauseId,
      startTime: result.startTime,
      allowedSeconds: result.allowedSeconds,
      pauseBudget,
    });
  } catch (err) {
    Errors.internal(res, err);
  }
});

router.post('/pause/stop', async (req: Request, res: Response) => {
  try {
    const body = req.body as StopBody;
    const agentMatricule = sanitizeText(body.agent_matricule, 32);

    if (!agentMatricule) return Errors.missingField(res, 'agent_matricule');

    const now = nowIso();

    const result = await db.withTransaction(async (client: { query: Function }) => {
      const pause = await qOne(
        'SELECT p.*, o.code AS offer_code, o.id AS offer_id_val ' +
        'FROM pauses p JOIN offers o ON o.id = p.offer_id ' +
        "WHERE p.agent_matricule = $1 AND p.status = 'in_progress' LIMIT 1",
        [agentMatricule],
        client
      );

      if (!pause) return { err: 'NOT_FOUND' as const };

      const durationSeconds = Math.round((Date.parse(now) - Date.parse(pause.start_time)) / 1000);

      await client.query(
        "UPDATE pauses SET status = 'ended', end_time = $1, end_reason = 'manual', duration_seconds = $2, updated_at = $3 WHERE id = $4",
        [now, durationSeconds, now, pause.id]
      );

      const pauseBudget: PublicBudget = await loadAgentPauseBudget(agentMatricule, client);
      return { pause, durationSeconds, endTime: now, pauseBudget };
    });

    if (result.err === 'NOT_FOUND') return Errors.notFound(res, 'Pause active pour cet agent');

    const pauseBudget: PublicBudget = result.pauseBudget;
    const io = req.app.get('io') as any;
    if (io) {
      const agent = await db.queryOne('SELECT nom, prenom FROM agents WHERE matricule = $1', [agentMatricule]);
      const offerCode = result.pause.offer_code;

      const stoppedPayload = {
        pauseId: result.pause.id,
        agent_matricule: agentMatricule,
        agentName: agent ? `${agent.prenom} ${agent.nom}` : agentMatricule,
        offerCode,
        endTime: result.endTime,
        durationSeconds: result.durationSeconds,
        endReason: 'manual',
        pauseBudget,
      };
      broadcastPauseEvent(io, 'pause:stopped', stoppedPayload, await loadAnonymizeAgentNames());

      await emitOfferUpdate(io, offerCode, result.pause.offer_id_val);
      await emitQuotasUpdate(io);
      await emitDirectoryCredits(io);
    }

    res.json({
      endTime: result.endTime,
      durationSeconds: result.durationSeconds,
      pauseBudget,
    });
  } catch (err) {
    Errors.internal(res, err);
  }
});

module.exports = {
  router,
  buildSnapshot,
};
