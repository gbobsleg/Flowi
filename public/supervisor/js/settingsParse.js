'use strict';

function parsePauseWindowsSetting(raw) {
  if (Array.isArray(raw)) {
    return raw.filter((w) => w && w.start && w.end).map((w) => ({ start: w.start, end: w.end }));
  }
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((w) => w && w.start && w.end).map((w) => ({ start: w.start, end: w.end }));
  } catch {
    return [];
  }
}

function parseImportWeekdaysSetting(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { parsed = [1, 2, 3, 4, 5]; }
  }
  if (!Array.isArray(parsed) || !parsed.length) return [1, 2, 3, 4, 5];
  const nums = [...new Set(parsed.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 7))]
    .sort((a, b) => a - b);
  return nums.length ? nums : [1, 2, 3, 4, 5];
}

function normalizeGithubSetting(s) {
  if (typeof s !== 'string') return '';
  return s.trim().replace(/\s+/g, ' ');
}

const FlowiSettingsParse = {
  parsePauseWindowsSetting,
  parseImportWeekdaysSetting,
  normalizeGithubSetting,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FlowiSettingsParse;
}
if (typeof globalThis !== 'undefined') {
  globalThis.FlowiSettingsParse = FlowiSettingsParse;
}
