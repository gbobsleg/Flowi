'use strict';

const SUPERVISOR_TAB_IDS = new Set(['live', 'history', 'grid', 'directory', 'settings', 'about']);
const SETTINGS_SUBTAB_IDS = new Set(['general', 'offers', 'planning', 'access']);
const LEGACY_TAB_REDIRECTS = { quotas: 'live', planning: 'grid' };

function parseSupervisorHash(hash) {
  const raw = String(hash || '').replace(/^#/, '').trim();
  const parts = raw.split('/').filter(Boolean);
  const seg0 = parts[0] || '';
  const seg1 = parts[1] || '';

  if (!seg0) {
    return { tab: 'live', settingsSubtab: 'general', canonical: 'live', rewrite: true };
  }
  if (LEGACY_TAB_REDIRECTS[seg0]) {
    const tab = LEGACY_TAB_REDIRECTS[seg0];
    return { tab, settingsSubtab: 'general', canonical: tab, rewrite: true };
  }
  if (!SUPERVISOR_TAB_IDS.has(seg0)) {
    return { tab: 'live', settingsSubtab: 'general', canonical: 'live', rewrite: true };
  }
  if (seg0 === 'settings') {
    const sub = SETTINGS_SUBTAB_IDS.has(seg1) ? seg1 : 'general';
    const canonical = `settings/${sub}`;
    return {
      tab: 'settings',
      settingsSubtab: sub,
      canonical,
      rewrite: raw !== canonical,
    };
  }
  return {
    tab: seg0,
    settingsSubtab: 'general',
    canonical: seg0,
    rewrite: parts.length > 1,
  };
}

function hashForTab(tabId, settingsSubtab) {
  if (!SUPERVISOR_TAB_IDS.has(tabId)) return null;
  if (tabId === 'settings') {
    const sub = SETTINGS_SUBTAB_IDS.has(settingsSubtab) ? settingsSubtab : 'general';
    return `settings/${sub}`;
  }
  return tabId;
}

function hashForSettingsSubtab(sub) {
  const next = SETTINGS_SUBTAB_IDS.has(sub) ? sub : 'general';
  return `settings/${next}`;
}

const FlowiSupervisorTabs = {
  SUPERVISOR_TAB_IDS,
  SETTINGS_SUBTAB_IDS,
  LEGACY_TAB_REDIRECTS,
  parseSupervisorHash,
  hashForTab,
  hashForSettingsSubtab,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = FlowiSupervisorTabs;
}
if (typeof globalThis !== 'undefined') {
  globalThis.FlowiSupervisorTabs = FlowiSupervisorTabs;
}
