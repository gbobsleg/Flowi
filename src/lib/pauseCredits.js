'use strict';

const db = require('../db');
const { parsePauseWindows, pauseWindowStatus } = require('./pauseWindows');
const {
  SQL_AGENT_DAY_PAUSES,
  SQL_DAY_PAUSES,
  parisDayBounds,
  parseMaxPauses,
  computePauseBudget,
} = require('./pauseBudget');

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

async function loadPauseWindowStatus(client) {
  const clock = getParisClock();
  const windowsRow = await qOne(
    "SELECT value FROM app_settings WHERE key = 'pause_windows'",
    [],
    client
  );
  return pauseWindowStatus(clock.minutesOfDay, parsePauseWindows(windowsRow && windowsRow.value));
}

async function loadMaxPauseMinutes(client) {
  const row = await qOne("SELECT value FROM app_settings WHERE key = 'max_pause_minutes'", [], client);
  const n = row ? parseInt(row.value, 10) : 15;
  return Number.isFinite(n) && n > 0 ? n : 15;
}

async function loadMaxPausesPerAgent(client) {
  const row = await qOne("SELECT value FROM app_settings WHERE key = 'max_pauses_per_agent'", [], client);
  return parseMaxPauses(row && row.value);
}

async function loadAgentPauseBudget(matricule, client, now = new Date()) {
  const clock = getParisClock(now);
  const { start, end } = parisDayBounds(clock.day);
  const pauses = matricule
    ? await qAll(SQL_AGENT_DAY_PAUSES, [matricule, start.toISOString(), end.toISOString()], client)
    : [];
  const windowsRow = await qOne(
    "SELECT value FROM app_settings WHERE key = 'pause_windows'",
    [],
    client
  );
  const maxPauseMinutes = await loadMaxPauseMinutes(client);
  const maxPauses = await loadMaxPausesPerAgent(client);
  return computePauseBudget({
    pauses,
    windows: parsePauseWindows(windowsRow && windowsRow.value),
    minutesOfDay: clock.minutesOfDay,
    maxPauseMinutes,
    maxPauses,
    now,
  });
}

async function loadDirectoryPauseCredits(client, now = new Date()) {
  const clock = getParisClock(now);
  const { start, end } = parisDayBounds(clock.day);
  const windowStatus = await loadPauseWindowStatus(client);
  const windowsRow = await qOne(
    "SELECT value FROM app_settings WHERE key = 'pause_windows'",
    [],
    client
  );
  const windows = parsePauseWindows(windowsRow && windowsRow.value);
  const maxPauseMinutes = await loadMaxPauseMinutes(client);
  const maxPauses = await loadMaxPausesPerAgent(client);
  const rows = await qAll(SQL_DAY_PAUSES, [start.toISOString(), end.toISOString()], client);
  const byMatricule = new Map();
  for (const pause of rows) {
    if (pause.excluded_from_budget === true) continue;
    const key = pause.agent_matricule;
    if (!byMatricule.has(key)) byMatricule.set(key, []);
    byMatricule.get(key).push(pause);
  }
  const pauseWindowOpen = windowStatus.open === true;
  const budgetByMatricule = {};
  for (const [matricule, pauses] of byMatricule) {
    budgetByMatricule[matricule] = computePauseBudget({
      pauses,
      windows,
      minutesOfDay: clock.minutesOfDay,
      maxPauseMinutes,
      maxPauses,
      now,
    });
  }
  const emptyBudget = computePauseBudget({
    pauses: [],
    windows,
    minutesOfDay: clock.minutesOfDay,
    maxPauseMinutes,
    maxPauses,
    now,
  });
  return { pauseWindowOpen, budgetByMatricule, emptyBudget };
}

async function emitDirectoryCredits(io) {
  if (!io || typeof io.to !== 'function') return;
  try {
    const credits = await loadDirectoryPauseCredits();
    io.to('supervisor').emit('directory:credits-updated', {
      pauseWindowOpen: credits.pauseWindowOpen,
      budgetByMatricule: credits.budgetByMatricule,
      emptyBudget: credits.emptyBudget,
    });
  } catch (err) {
    console.error('[directory credits]', err);
  }
}

module.exports = {
  qOne,
  qAll,
  getParisClock,
  loadPauseWindowStatus,
  loadMaxPauseMinutes,
  loadMaxPausesPerAgent,
  loadAgentPauseBudget,
  loadDirectoryPauseCredits,
  emitDirectoryCredits,
};
