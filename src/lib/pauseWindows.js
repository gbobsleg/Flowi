'use strict';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function minutesToHm(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

function hmToMinutes(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function parsePauseWindows(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeWindows(windows) {
  if (!Array.isArray(windows)) return [];
  const out = [];
  for (const w of windows) {
    const start = hmToMinutes(w && w.start);
    const end = hmToMinutes(w && w.end);
    if (start == null || end == null) continue;
    if (!(start < end)) continue;
    out.push({ start: minutesToHm(start), end: minutesToHm(end), startMin: start, endMin: end });
  }
  out.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  return out;
}

function isInsidePauseWindows(minutesOfDay, windows) {
  const sorted = normalizeWindows(windows);
  if (!sorted.length) return true;
  return sorted.some((w) => minutesOfDay >= w.startMin && minutesOfDay < w.endMin);
}

/**
 * @param {number} minutesOfDay minutes depuis minuit (horloge Paris)
 * @param {Array|{start:string,end:string}} windows
 * @returns {{ windows: Array<{start:string,end:string}>, open: boolean, nextOpen: { hhmm: string, tomorrow: boolean } | null }}
 */
function pauseWindowStatus(minutesOfDay, windows) {
  const sorted = normalizeWindows(windows);
  const publicWindows = sorted.map((w) => ({ start: w.start, end: w.end }));

  if (!sorted.length) {
    return { windows: publicWindows, open: true, nextOpen: null };
  }

  const t = Number(minutesOfDay);
  const open = Number.isFinite(t) && sorted.some((w) => t >= w.startMin && t < w.endMin);
  if (open) {
    return { windows: publicWindows, open: true, nextOpen: null };
  }

  const later = Number.isFinite(t) ? sorted.find((w) => w.startMin > t) : sorted[0];
  if (later) {
    return { windows: publicWindows, open: false, nextOpen: { hhmm: later.start, tomorrow: false } };
  }
  return { windows: publicWindows, open: false, nextOpen: { hhmm: sorted[0].start, tomorrow: true } };
}

module.exports = {
  hmToMinutes,
  minutesToHm,
  parsePauseWindows,
  normalizeWindows,
  isInsidePauseWindows,
  pauseWindowStatus,
};
