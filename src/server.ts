'use strict';

import type { PoolClient } from 'pg';
import type { PublicBudget } from './lib/pauseBudget';

require('dotenv').config();
const config = require('./config');
import db = require('./db');
const { createApp } = require('./createApp');
const { emitOfferUpdate, emitQuotasUpdate } = require('./lib/offerQuota');
const { getParisClock, loadAgentPauseBudget, emitDirectoryCredits } = require('./lib/pauseCredits');
const {
  loadAnonymizeAgentNames,
  broadcastPauseEvent,
} = require('./lib/pauseIdentity');

const { app, server, io } = createApp();

const SCHEDULER_INTERVAL_MS = 8000;

type SettingRow = { value: string };
type ExpiredPause = {
  id: unknown;
  agent_matricule: string;
  start_time: string | Date;
  offer_code: string;
  offer_id_val: unknown;
  agent_nom: string;
  agent_prenom: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

async function getMaxMs(): Promise<number> {
  const row = await db.queryOne<SettingRow>("SELECT value FROM app_settings WHERE key = 'max_pause_minutes'");
  const minutes = row ? parseInt(row.value, 10) : config.MAX_PAUSE_MINUTES;
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : config.MAX_PAUSE_MINUTES) * 60 * 1000;
}

let autoCloseRunning = false;
let lastQuotaSlotKey: string | null = null;

async function closeExpiredPauses(): Promise<void> {
  const maxMs = await getMaxMs();
  const cutoff = new Date(Date.now() - maxMs).toISOString();

  const expired = await db.queryAll<ExpiredPause>(
    'SELECT p.*, o.code AS offer_code, o.id AS offer_id_val, a.nom AS agent_nom, a.prenom AS agent_prenom ' +
    'FROM pauses p ' +
    'JOIN offers o ON o.id = p.offer_id ' +
    'JOIN agents a ON a.matricule = p.agent_matricule ' +
    "WHERE p.status = 'in_progress' AND (" +
    '  (p.allowed_seconds IS NOT NULL AND p.start_time + (p.allowed_seconds * INTERVAL \'1 second\') <= NOW()) ' +
    '  OR (p.allowed_seconds IS NULL AND p.start_time <= $1)' +
    ')',
    [cutoff]
  );

  if (expired.length === 0) return;

  const now = nowIso();
  const currentMaxMinutes = Math.round(maxMs / 60000);

  await db.withTransaction(async (client: PoolClient) => {
    for (const p of expired) {
      await client.query(
        "UPDATE pauses SET status = 'ended', end_time = $1, end_reason = 'auto_15m', " +
        'duration_seconds = EXTRACT(EPOCH FROM ($1::timestamptz - start_time))::integer, ' +
        'max_minutes_at_end = $2, updated_at = $1 WHERE id = $3 AND status = \'in_progress\'',
        [now, currentMaxMinutes, p.id]
      );
    }
  });

  for (const p of expired) {
    const duration = Math.round((Date.parse(now) - Date.parse(String(p.start_time))) / 1000);
    const pauseBudget: PublicBudget = await loadAgentPauseBudget(p.agent_matricule);

    const stoppedPayload = {
      pauseId: p.id,
      agent_matricule: p.agent_matricule,
      nom: p.agent_nom,
      prenom: p.agent_prenom,
      agentName: `${p.agent_prenom} ${p.agent_nom}`,
      offerCode: p.offer_code,
      endTime: now,
      durationSeconds: duration,
      endReason: 'auto_15m',
      pauseBudget,
    };

    broadcastPauseEvent(io, 'pause:stopped', stoppedPayload, await loadAnonymizeAgentNames());

    await emitOfferUpdate(io, p.offer_code, p.offer_id_val);
    await emitQuotasUpdate(io);
  }
  await emitDirectoryCredits(io);
}

async function purgeHistory(): Promise<void> {
  const row = await db.queryOne<SettingRow>("SELECT value FROM app_settings WHERE key = 'history_retention_days'");
  const days = row ? parseInt(row.value, 10) : config.HISTORY_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const result = await db.query(
    "DELETE FROM pauses WHERE status = 'ended' AND end_time < $1",
    [cutoff]
  );

  if ((result.rowCount ?? 0) > 0) console.log(`[purge] ${result.rowCount} pause(s) supprimée(s) (rétention: ${days} j)`);

  const staleOffers = await db.queryAll<{ id: unknown }>(
    `SELECT id FROM offers o
     WHERE o.purge_requested_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pauses p WHERE p.offer_id = o.id)`
  );
  if (staleOffers.length === 0) return;

  let deleted = 0;
  await db.withTransaction(async (client: PoolClient) => {
    for (const offer of staleOffers) {
      const stillUsed = await client.query(
        'SELECT 1 FROM pauses WHERE offer_id = $1 LIMIT 1',
        [offer.id]
      );
      if ((stillUsed.rowCount ?? 0) > 0) continue;
      await client.query('DELETE FROM quota_rules WHERE offer_id = $1', [offer.id]);
      await client.query('UPDATE wfm_activity_mappings SET offer_id = NULL WHERE offer_id = $1', [offer.id]);
      await client.query('DELETE FROM planning_slots WHERE offer_id = $1', [offer.id]);
      await client.query('DELETE FROM offers WHERE id = $1', [offer.id]);
      deleted += 1;
    }
  });
  if (deleted > 0) console.log(`[purge] ${deleted} offre(s) supprimée(s)`);
}

async function start(): Promise<void> {
  await db.init();

  setInterval(() => {
    if (autoCloseRunning) return;
    autoCloseRunning = true;
    closeExpiredPauses()
      .catch((err) => console.error('[scheduler] auto-close', err))
      .then(async () => {
        const clock = getParisClock();
        if (clock.minute % 15 !== 0) return;
        const key = `${clock.day}:${clock.slotMinutes}`;
        if (key === lastQuotaSlotKey) return;
        lastQuotaSlotKey = key;
        await emitQuotasUpdate(io);
      })
      .catch((err) => console.error('[scheduler] quotas-slot', err))
      .finally(() => { autoCloseRunning = false; });
  }, SCHEDULER_INTERVAL_MS);

  setTimeout(() => {
    purgeHistory().catch((err) => console.error('[scheduler] purge', err));
    setInterval(() => {
      purgeHistory().catch((err) => console.error('[scheduler] purge', err));
    }, 24 * 60 * 60 * 1000);
  }, 10 * 60 * 1000);

  server.listen(config.PORT, () => {
    console.log(`[server] App pauses démarrée sur http://localhost:${config.PORT}`);
  });
}

if (require.main === module) {
  start().catch((err) => {
    console.error('[server] Échec de démarrage', err);
    process.exit(1);
  });
}

module.exports = { createApp, start, app, server, io };
