'use strict';

function formatDuration(totalSec) {
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR');
}

function endReasonLabel(reason, row, maxPauseMinutes) {
  const map = {
    manual: 'Manuel',
    auto_15m: `Auto (${row?.max_minutes_at_end ?? maxPauseMinutes} min)`,
    supervisor_forced: 'Forcé superviseur',
  };
  return map[reason] || reason || '—';
}

const FlowiSupervisorFormat = {
  formatDuration,
  formatTime,
  formatDate,
  endReasonLabel,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FlowiSupervisorFormat;
}
if (typeof globalThis !== 'undefined') {
  globalThis.FlowiSupervisorFormat = FlowiSupervisorFormat;
}
