'use strict';

function mappingOfferLabel(offer) {
  const name = offer?.label || offer?.code || '';
  return offer?.is_active === false ? `${name} (désactivée)` : name;
}

function mappingStatusLabel(row) {
  if (row.offerCode === '__ignore__') return 'Ignoré';
  if (row.offerCode) return 'Associé';
  return 'Non classé';
}

function mappingSortRank(row) {
  if (row.offerCode && row.offerCode !== '__ignore__') return 0;
  if (row.offerCode === '__ignore__') return 2;
  return 1;
}

function mappingStatusClass(row) {
  if (row.offerCode === '__ignore__') return 'bg-slate-100 text-slate-600';
  if (row.offerCode) return 'bg-brand-500/15 text-brand-700';
  return 'bg-amber-50 text-amber-700';
}

function planningQuotaRule(row) {
  if (row.fixedQuota != null) {
    return `Quota forcé ${row.fixedQuota} — écrase le calcul de la grille`;
  }
  if (row.allowedPercent != null) {
    return `${row.allowedPercent} % des planifiés (min. 1 si effectif > 0)`;
  }
  return `Quota défaut ${row.defaultQuota} (% non renseigné)`;
}

const FlowiPlanningMapping = {
  mappingOfferLabel,
  mappingStatusLabel,
  mappingSortRank,
  mappingStatusClass,
  planningQuotaRule,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FlowiPlanningMapping;
}
if (typeof globalThis !== 'undefined') {
  globalThis.FlowiPlanningMapping = FlowiPlanningMapping;
}
