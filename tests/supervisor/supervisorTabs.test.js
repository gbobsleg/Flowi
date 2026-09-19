'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSupervisorHash,
  hashForTab,
  hashForSettingsSubtab,
} = require('../../public/supervisor/js/supervisorTabs');

describe('parseSupervisorHash', () => {
  it('hash vide ou inconnu → live + rewrite', () => {
    assert.deepEqual(parseSupervisorHash(''), {
      tab: 'live',
      settingsSubtab: 'general',
      canonical: 'live',
      rewrite: true,
    });
    assert.deepEqual(parseSupervisorHash('#foo'), {
      tab: 'live',
      settingsSubtab: 'general',
      canonical: 'live',
      rewrite: true,
    });
  });

  it('#quotas (ancien nom) → live', () => {
    assert.deepEqual(parseSupervisorHash('#quotas'), {
      tab: 'live',
      settingsSubtab: 'general',
      canonical: 'live',
      rewrite: true,
    });
  });

  it('#planning (ancien nom) → grid', () => {
    assert.deepEqual(parseSupervisorHash('#planning'), {
      tab: 'grid',
      settingsSubtab: 'general',
      canonical: 'grid',
      rewrite: true,
    });
  });

  it('#settings sans sous-onglet → settings/general + rewrite', () => {
    assert.deepEqual(parseSupervisorHash('#settings'), {
      tab: 'settings',
      settingsSubtab: 'general',
      canonical: 'settings/general',
      rewrite: true,
    });
  });

  it('#settings/planning canonique → pas de rewrite', () => {
    assert.deepEqual(parseSupervisorHash('#settings/planning'), {
      tab: 'settings',
      settingsSubtab: 'planning',
      canonical: 'settings/planning',
      rewrite: false,
    });
  });

  it('#settings/inconnu → general + rewrite', () => {
    assert.deepEqual(parseSupervisorHash('#settings/foo'), {
      tab: 'settings',
      settingsSubtab: 'general',
      canonical: 'settings/general',
      rewrite: true,
    });
  });

  it('#history/extra → history + rewrite', () => {
    assert.deepEqual(parseSupervisorHash('#history/extra'), {
      tab: 'history',
      settingsSubtab: 'general',
      canonical: 'history',
      rewrite: true,
    });
  });
});

describe('hashForTab', () => {
  it('live → live', () => {
    assert.equal(hashForTab('live'), 'live');
  });

  it('settings + planning → settings/planning', () => {
    assert.equal(hashForTab('settings', 'planning'), 'settings/planning');
  });

  it('settings + sous-onglet invalide → settings/general', () => {
    assert.equal(hashForTab('settings', 'inconnu'), 'settings/general');
  });

  it('onglet inconnu → null', () => {
    assert.equal(hashForTab('inconnu'), null);
  });
});

describe('hashForSettingsSubtab', () => {
  it('planning → settings/planning', () => {
    assert.equal(hashForSettingsSubtab('planning'), 'settings/planning');
  });

  it('inconnu → settings/general', () => {
    assert.equal(hashForSettingsSubtab('inconnu'), 'settings/general');
  });
});
