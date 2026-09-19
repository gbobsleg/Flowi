'use strict';

const { assertSafeTestDatabase } = require('./guard');

assertSafeTestDatabase();

const { io: ioClient } = require('socket.io-client');
const db = require('../../dist/db');
const { createApp } = require('../../dist/createApp');
const { getParisClock } = require('../../dist/lib/pauseCredits');

const TRUNCATE_SQL = `
  TRUNCATE
    pauses,
    planning_slots,
    planning_activities,
    wfm_activity_mappings,
    quota_rules,
    agents,
    offers,
    app_settings
  RESTART IDENTITY CASCADE
`;

async function seedMinimal() {
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO app_settings (key, value) VALUES
      ('history_retention_days', '30'),
      ('maintenance_mode', '0'),
      ('max_pause_minutes', '15'),
      ('max_pauses_per_agent', ''),
      ('pause_windows', '[]'),
      ('supervisor_pin', '1234'),
      ('anonymize_agent_names', '0')`
  );
  const offer = await db.queryOne(
    `INSERT INTO offers (code, label, default_quota, color, is_active, created_at)
     VALUES ('TEST_A', 'Offre test', 2, NULL, true, $1)
     RETURNING id`,
    [now]
  );
  await db.query(
    `INSERT INTO quota_rules (offer_id, fixed_quota, present_count, allowed_percent, updated_at)
     VALUES ($1, NULL, NULL, 20, $2)`,
    [offer.id, now]
  );
  await db.query(
    `INSERT INTO agents (matricule, nom, prenom, is_active) VALUES
      ('MAT_T1', 'TEST', 'Alice', true),
      ('MAT_T2', 'TEST', 'Bob', true)`
  );
  return { offerId: offer.id };
}

async function resetDb() {
  await db.query(TRUNCATE_SQL);
  return seedMinimal();
}

async function startTestApp() {
  await db.init();
  const { app, server, io } = createApp();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { app, server, io, baseUrl: `http://127.0.0.1:${port}`, port };
}

async function stopTestApp(ctx) {
  if (ctx && ctx.server) {
    await new Promise((resolve, reject) => {
      ctx.server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

async function requestJson(baseUrl, method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

async function loginSupervisor(baseUrl, pin = '1234') {
  const res = await requestJson(baseUrl, 'POST', '/api/supervisor/auth', { body: { pin } });
  if (res.status !== 200 || !res.json || !res.json.token) {
    throw new Error(`auth superviseur échouée (${res.status})`);
  }
  return res.json.token;
}

function connectSupervisorSocket(baseUrl) {
  const socket = ioClient(baseUrl, { transports: ['websocket'], forceNew: true });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout connexion socket')), 4000);
    socket.on('connect', () => {
      socket.emit('join:supervisor');
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForEvent(socket, name, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout événement ${name}`)), timeoutMs);
    socket.once(name, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function hhmmFromMinutes(minutes) {
  return `${pad2(Math.floor(minutes / 60))}:${pad2(minutes % 60)}`;
}

function closedWindowsFarFromNow() {
  const clock = getParisClock();
  const start = (clock.minutesOfDay + 180) % 1440;
  const end = start + 30;
  if (end > 1440) {
    return clock.minutesOfDay < 60
      ? [{ start: '12:00', end: '13:00' }]
      : [{ start: '00:00', end: '00:30' }];
  }
  return [{ start: hhmmFromMinutes(start), end: hhmmFromMinutes(end) }];
}

async function insertEndedPause({ matricule, offerId, durationSeconds, startTime }) {
  const start = startTime || new Date(Date.now() - durationSeconds * 1000);
  const end = new Date(start.getTime() + durationSeconds * 1000);
  const now = new Date().toISOString();
  return db.queryOne(
    `INSERT INTO pauses (
       agent_matricule, offer_id, start_time, end_time, end_reason,
       duration_seconds, status, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, 'manual', $5, 'ended', $6, $6)
     RETURNING id`,
    [matricule, offerId, start.toISOString(), end.toISOString(), durationSeconds, now]
  );
}

module.exports = {
  resetDb,
  startTestApp,
  stopTestApp,
  requestJson,
  loginSupervisor,
  connectSupervisorSocket,
  waitForEvent,
  closedWindowsFarFromNow,
  insertEndedPause,
  db,
};
