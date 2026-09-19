'use strict';

import type { PublicBudget } from './pauseBudget';

type QueryResult = { rows?: Array<{ value?: string }> };
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<QueryResult> };

type PauseRow = {
  id?: unknown;
  start_time?: unknown;
  agent_matricule?: string;
};

type SnapshotEntry = {
  pauses?: PauseRow[];
  [key: string]: unknown;
};

type PauseEventPayload = {
  pauseId?: unknown;
  offerCode?: unknown;
  agent_matricule?: string;
  pauseBudget?: PublicBudget;
  startTime?: unknown;
  allowedSeconds?: unknown;
  [key: string]: unknown;
};

type SocketRoom = { emit: (event: string, payload: unknown) => void };
type SocketServer = {
  emit: (event: string, payload: unknown) => void;
  to?: (room: string) => SocketRoom;
  except?: (room: string) => SocketServer;
};

function parseEnabled(raw: unknown): boolean {
  if (raw == null) return false;
  return String(raw).trim() === '1';
}

async function loadAnonymizeAgentNames(client?: Queryable | null): Promise<boolean> {
  const sql = "SELECT value FROM app_settings WHERE key = 'anonymize_agent_names'";
  let row: { value?: string } | undefined;
  if (client && typeof client.query === 'function') {
    const result = await client.query(sql);
    row = result.rows && result.rows[0];
  } else {
    const db = require('../db');
    row = await db.queryOne(sql);
  }
  return parseEnabled(row && row.value);
}

function redactPause(pause: PauseRow | null | undefined, selfMatricule?: string | null): Record<string, unknown> {
  const src = pause && typeof pause === 'object' ? pause : {};
  const out: Record<string, unknown> = {
    id: src.id,
    start_time: src.start_time,
  };
  if (selfMatricule && src.agent_matricule === selfMatricule) {
    out.agent_matricule = src.agent_matricule;
  }
  return out;
}

function redactSnapshot(snapshot: unknown, selfMatricule?: string | null): SnapshotEntry[] {
  if (!Array.isArray(snapshot)) return [];
  return (snapshot as SnapshotEntry[]).map((entry) => {
    const pauses = entry && entry.pauses;
    return {
      ...entry,
      pauses: Array.isArray(pauses) ? pauses.map((p) => redactPause(p, selfMatricule)) : [],
    };
  });
}

function publicPauseEvent(payload: PauseEventPayload | null | undefined): Record<string, unknown> {
  const src = payload && typeof payload === 'object' ? payload : {};
  const out: Record<string, unknown> = {
    pauseId: src.pauseId,
    offerCode: src.offerCode,
  };
  if (src.startTime != null) out.startTime = src.startTime;
  return out;
}

function agentPauseEvent(payload: PauseEventPayload | null | undefined): Record<string, unknown> {
  const src = payload && typeof payload === 'object' ? payload : {};
  const out: Record<string, unknown> = {
    pauseId: src.pauseId,
    offerCode: src.offerCode,
    agent_matricule: src.agent_matricule,
    pauseBudget: src.pauseBudget as PublicBudget | undefined,
  };
  if (src.startTime != null) out.startTime = src.startTime;
  if (src.allowedSeconds != null) out.allowedSeconds = src.allowedSeconds;
  return out;
}

function agentRoom(matricule: string): string {
  return `agent:${matricule}`;
}

function broadcastPauseEvent(
  io: SocketServer | null | undefined,
  eventName: string,
  fullPayload: PauseEventPayload,
  anonymize: boolean
): void {
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
