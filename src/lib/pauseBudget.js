'use strict';

const { normalizeWindows } = require('./pauseWindows');

const PARIS = 'Europe/Paris';

const SQL_AGENT_DAY_PAUSES =
  'SELECT id, start_time, end_time, duration_seconds, status, excluded_from_budget ' +
  'FROM pauses ' +
  'WHERE agent_matricule = $1 AND start_time >= $2 AND start_time < $3 ' +
  'AND excluded_from_budget = false';

const SQL_DAY_PAUSES =
  'SELECT agent_matricule, id, start_time, end_time, duration_seconds, status, excluded_from_budget ' +
  'FROM pauses ' +
  'WHERE start_time >= $1 AND start_time < $2';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function parisClockFromDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PARIS,
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
  };
}

function tzOffsetMs(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: PARIS,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const g = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
  return asUtc - date.getTime();
}

function addYmdDays(dayYmd, days) {
  const [y, mo, d] = String(dayYmd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

function parisCivilInstant(dayYmd, hm = '00:00:00') {
  const [y, mo, d] = String(dayYmd).split('-').map(Number);
  const segs = String(hm).split(':').map(Number);
  const hh = segs[0] || 0;
  const mm = segs[1] || 0;
  const ss = segs[2] || 0;
  const utcGuess = Date.UTC(y, mo - 1, d, hh, mm, ss);
  return new Date(utcGuess - tzOffsetMs(new Date(utcGuess)));
}

function parisDayBounds(dayYmd) {
  const start = parisCivilInstant(dayYmd, '00:00:00');
  const end = parisCivilInstant(addYmdDays(dayYmd, 1), '00:00:00');
  return { start, end };
}

function parseMaxPauses(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

function currentWindowBounds(minutesOfDay, windows) {
  const sorted = normalizeWindows(windows);
  if (!sorted.length) return { startMin: 0, endMin: 1440 };
  const t = Number(minutesOfDay);
  const hit = sorted.find((w) => t >= w.startMin && t < w.endMin);
  return hit ? { startMin: hit.startMin, endMin: hit.endMin } : null;
}

function isExcludedFromBudget(pause) {
  return !!(pause && pause.excluded_from_budget === true);
}

function pauseDurationSeconds(pause, now) {
  const start = new Date(pause.start_time).getTime();
  if (!Number.isFinite(start)) return 0;
  const inProgress = pause.status === 'in_progress' || pause.end_time == null;
  if (inProgress) {
    return Math.max(0, Math.round((now.getTime() - start) / 1000));
  }
  if (pause.duration_seconds != null && Number.isFinite(Number(pause.duration_seconds))) {
    return Math.max(0, Math.round(Number(pause.duration_seconds)));
  }
  const end = new Date(pause.end_time).getTime();
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - start) / 1000));
}

function publicBudget(parts) {
  return {
    maxPauses: parts.maxPauses,
    startsUsed: parts.startsUsed,
    remainingStarts: parts.remainingStarts,
    remainingSeconds: parts.remainingSeconds,
    sittingCapSeconds: parts.sittingCapSeconds,
    canStart: parts.canStart,
    reason: parts.reason,
  };
}

/**
 * @param {{
 *   pauses: Array<{start_time:string|Date, end_time?:string|Date|null, duration_seconds?:number|null, status?:string}>,
 *   windows: Array|{start:string,end:string},
 *   minutesOfDay: number,
 *   maxPauseMinutes: number,
 *   maxPauses: number|null,
 *   now?: Date,
 * }} opts
 */
function computePauseBudget(opts) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const potSeconds = Math.max(1, Number(opts.maxPauseMinutes) || 15) * 60;
  const maxPauses = parseMaxPauses(opts.maxPauses);
  const bounds = currentWindowBounds(opts.minutesOfDay, opts.windows);

  const inWindow = [];
  if (bounds) {
    for (const pause of opts.pauses || []) {
      if (isExcludedFromBudget(pause)) continue;
      const mins = parisClockFromDate(new Date(pause.start_time)).minutesOfDay;
      if (mins >= bounds.startMin && mins < bounds.endMin) inWindow.push(pause);
    }
  }

  let usedSeconds = 0;
  for (const pause of inWindow) usedSeconds += pauseDurationSeconds(pause, now);
  const startsUsed = inWindow.length;

  const remainingStarts = maxPauses == null ? null : Math.max(0, maxPauses - startsUsed);
  const remainingSeconds = Math.max(0, potSeconds - usedSeconds);
  const sittingCapSeconds = remainingSeconds;
  let reason = null;
  if (maxPauses != null && startsUsed >= maxPauses) reason = 'starts';
  else if (remainingSeconds <= 0) reason = 'budget';
  const canStart = reason == null;

  return publicBudget({
    maxPauses,
    startsUsed,
    remainingStarts,
    remainingSeconds,
    sittingCapSeconds,
    canStart,
    reason,
  });
}

function pauseLimitMessage(reason) {
  if (reason === 'budget') return 'Temps de pause épuisé sur cette plage.';
  return 'Pause déjà prise sur cette plage.';
}

module.exports = {
  SQL_AGENT_DAY_PAUSES,
  SQL_DAY_PAUSES,
  parisClockFromDate,
  parisDayBounds,
  parseMaxPauses,
  currentWindowBounds,
  isExcludedFromBudget,
  computePauseBudget,
  pauseLimitMessage,
};
