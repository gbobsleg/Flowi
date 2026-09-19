'use strict';

function formatRemainingSpoken(totalSec) {
  const s = Math.max(0, Math.floor(Number(totalSec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r} s`;
  if (r === 0) return `${m} min`;
  return `${m} min ${r} s`;
}

function directoryStartsLabel(agent) {
  if (!agent || agent.pauseWindowOpen === false) return 'Hors plage';
  const n = agent.pauseBudget && agent.pauseBudget.remainingStarts;
  if (n === null || n === undefined) return 'Illimité';
  return String(n);
}

function directoryRemainingSeconds(agent, opts) {
  const now = opts && opts.now != null ? Number(opts.now) : Date.now();
  const onPause = !!(opts && opts.onPause);
  const fallback = opts && opts.fallbackCreditsAt;
  let sec = Number(agent && agent.pauseBudget && agent.pauseBudget.remainingSeconds);
  if (!Number.isFinite(sec)) sec = 0;
  if (!onPause) return sec;
  const origin = (agent && agent._creditsAt) || fallback || now;
  const extra = Math.max(0, Math.floor((now - origin) / 1000));
  return Math.max(0, sec - extra);
}

function stampDirectoryCredits(rows, evt, now) {
  const list = Array.isArray(rows) ? rows : [];
  const stamped = Number(now);
  const at = Number.isFinite(stamped) ? stamped : Date.now();
  if (!list.length) {
    return { rows: [], directoryCreditsAt: at, empty: true };
  }
  const src = evt && typeof evt === 'object' ? evt : {};
  const by = src.budgetByMatricule && typeof src.budgetByMatricule === 'object'
    ? src.budgetByMatricule
    : {};
  const emptyBudget = src.emptyBudget;
  const next = list.map((agent) => {
    const matricule = agent && agent.matricule;
    const budget = (matricule && by[matricule]) || emptyBudget || (agent && agent.pauseBudget) || null;
    const out = {
      matricule,
      pauseBudget: budget,
      _creditsAt: at,
    };
    if (src.pauseWindowOpen !== undefined) out.pauseWindowOpen = src.pauseWindowOpen;
    else if (agent) out.pauseWindowOpen = agent.pauseWindowOpen;
    return out;
  });
  return { rows: next, directoryCreditsAt: at, empty: false };
}

function historyExcludeConfirmMessage(excluded) {
  if (excluded) {
    return 'Cette pause ne sera pas supprimée : elle restera dans l’historique.\n\nEn revanche, elle ne sera plus décomptée : l’agent récupère le temps de pause et le droit de repartir en pause associés à cette ligne.';
  }
  return 'Cette pause sera de nouveau décomptée. Le temps de pause restant et le droit de repartir de l’agent seront recalculés comme si elle avait bien eu lieu.';
}

function historyExcludeButtonLabel(excluded, excluding) {
  if (excluding) return '…';
  return excluded ? 'Rétablir' : 'Ignorer';
}

function stampAgentPauseBudget(rows, matricule, pauseBudget, now) {
  const list = Array.isArray(rows) ? rows : [];
  const stamped = Number(now);
  const at = Number.isFinite(stamped) ? stamped : Date.now();
  let found = false;
  const next = list.map((agent) => {
    const copy = {
      matricule: agent && agent.matricule,
      pauseWindowOpen: agent && agent.pauseWindowOpen,
      pauseBudget: agent && agent.pauseBudget,
      _creditsAt: agent && agent._creditsAt,
    };
    if (matricule && copy.matricule === matricule) {
      found = true;
      copy.pauseBudget = pauseBudget;
      copy._creditsAt = at;
    }
    return copy;
  });
  return { rows: next, found, directoryCreditsAt: at };
}

const FlowiDirectoryCredits = {
  formatRemainingSpoken,
  directoryStartsLabel,
  directoryRemainingSeconds,
  stampDirectoryCredits,
  historyExcludeConfirmMessage,
  historyExcludeButtonLabel,
  stampAgentPauseBudget,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FlowiDirectoryCredits;
}
if (typeof window !== 'undefined') {
  window.FlowiDirectoryCredits = FlowiDirectoryCredits;
}
