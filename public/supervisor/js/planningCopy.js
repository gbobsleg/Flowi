'use strict';

function formatPlanningDay(isoDay) {
  const m = String(isoDay || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return isoDay || '—';
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function sortedDays(days) {
  return Array.isArray(days) ? [...days].sort() : [];
}

function planningPeriodLabel(days) {
  const list = sortedDays(days);
  if (!list.length) return '—';
  if (list.length === 1) return formatPlanningDay(list[0]);
  return `${formatPlanningDay(list[0])} → ${formatPlanningDay(list[list.length - 1])}`;
}

function planningReplaceSummary(days) {
  const list = sortedDays(days);
  if (!list.length) return '';
  if (list.length === 1) {
    return `1 jour sera remplacé : ${formatPlanningDay(list[0])}.`;
  }
  return `${list.length} jours seront remplacés, du ${formatPlanningDay(list[0])} au ${formatPlanningDay(list[list.length - 1])}.`;
}

function planningAppliedSummary(days) {
  const list = sortedDays(days);
  if (!list.length) return 'Planning remplacé.';
  if (list.length === 1) {
    return `Planning remplacé : 1 jour (${formatPlanningDay(list[0])}).`;
  }
  return `Planning remplacé : ${list.length} jours, du ${formatPlanningDay(list[0])} au ${formatPlanningDay(list[list.length - 1])}.`;
}

const FlowiPlanningCopy = {
  formatPlanningDay,
  planningPeriodLabel,
  planningReplaceSummary,
  planningAppliedSummary,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FlowiPlanningCopy;
}
if (typeof globalThis !== 'undefined') {
  globalThis.FlowiPlanningCopy = FlowiPlanningCopy;
}
