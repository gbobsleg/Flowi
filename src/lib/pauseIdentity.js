'use strict';

function parseEnabled(raw) {
  if (raw == null) return false;
  return String(raw).trim() === '1';
}

/**
 * @param {import('pg').PoolClient|{query: Function}|null} [client]
 * @returns {Promise<boolean>}
 */
async function loadAnonymizeAgentNames(client) {
  const sql = "SELECT value FROM app_settings WHERE key = 'anonymize_agent_names'";
  let row;
  if (client && typeof client.query === 'function') {
    const result = await client.query(sql);
    row = result.rows && result.rows[0];
  } else {
    const db = require('../db');
    row = await db.queryOne(sql);
  }
  return parseEnabled(row && row.value);
}

function redactPause(pause, selfMatricule) {
  const src = pause && typeof pause === 'object' ? pause : {};
  const out = {
    id: src.id,
    start_time: src.start_time,
  };
  if (selfMatricule && src.agent_matricule === selfMatricule) {
    out.agent_matricule = src.agent_matricule;
  }
  return out;
}

function redactSnapshot(snapshot, selfMatricule) {
  if (!Array.isArray(snapshot)) return [];
  return snapshot.map((entry) => ({
    ...entry,
    pauses: Array.isArray(entry && entry.pauses)
      ? entry.pauses.map((p) => redactPause(p, selfMatricule))
      : [],
  }));
}

function publicPauseEvent(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const out = {
    pauseId: src.pauseId,
    offerCode: src.offerCode,
  };
  if (src.startTime != null) out.startTime = src.startTime;
  return out;
}

function agentPauseEvent(payload) {
  const src = payload && typeof payload === 'object' ? payload : {};
  const out = {
    pauseId: src.pauseId,
    offerCode: src.offerCode,
    agent_matricule: src.agent_matricule,
    pauseBudget: src.pauseBudget,
  };
  if (src.startTime != null) out.startTime = src.startTime;
  if (src.allowedSeconds != null) out.allowedSeconds = src.allowedSeconds;
  return out;
}

function agentRoom(matricule) {
  return `agent:${matricule}`;
}

/**
 * @param {import('socket.io').Server} io
 * @param {string} eventName
 * @param {object} fullPayload
 * @param {boolean} anonymize
 */
function broadcastPauseEvent(io, eventName, fullPayload, anonymize) {
  if (!io || typeof io.emit !== 'function') return;
  if (!anonymize) {
    io.emit(eventName, fullPayload);
    return;
  }

  const matricule = fullPayload && fullPayload.agent_matricule;
  if (typeof io.to === 'function') {
    io.to('supervisor').emit(eventName, fullPayload);
    if (matricule) io.to(agentRoom(matricule)).emit(eventName, agentPauseEvent(fullPayload));
  }

  const publicPayload = publicPauseEvent(fullPayload);
  if (typeof io.except !== 'function') {
    io.emit(eventName, publicPayload);
    return;
  }

  let excluded = io.except('supervisor');
  if (matricule && typeof excluded.except === 'function') {
    excluded = excluded.except(agentRoom(matricule));
  }
  excluded.emit(eventName, publicPayload);
}

module.exports = {
  loadAnonymizeAgentNames,
  redactSnapshot,
  publicPauseEvent,
  agentPauseEvent,
  broadcastPauseEvent,
  parseEnabled,
  agentRoom,
};
