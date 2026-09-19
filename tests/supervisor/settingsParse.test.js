'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePauseWindowsSetting,
  parseImportWeekdaysSetting,
  normalizeGithubSetting,
} = require('../../public/supervisor/js/settingsParse');

describe('parsePauseWindowsSetting', () => {
  it('JSON invalide ou vide → []', () => {
    assert.deepEqual(parsePauseWindowsSetting(''), []);
    assert.deepEqual(parsePauseWindowsSetting('pas-json'), []);
    assert.deepEqual(parsePauseWindowsSetting('{}'), []);
  });

  it('copie les plages valides sans muter l’entrée', () => {
    const raw = [{ start: '10:00', end: '11:00', extra: true }];
    const out = parsePauseWindowsSetting(raw);
    assert.deepEqual(out, [{ start: '10:00', end: '11:00' }]);
    assert.equal(raw[0].extra, true);
  });
});

describe('parseImportWeekdaysSetting', () => {
  it('JSON invalide ou vide → lun–ven', () => {
    assert.deepEqual(parseImportWeekdaysSetting(''), [1, 2, 3, 4, 5]);
    assert.deepEqual(parseImportWeekdaysSetting('x'), [1, 2, 3, 4, 5]);
  });

  it('déduplique, filtre 1–7, trie, ne mute pas', () => {
    const raw = [6, 1, 1, 9];
    assert.deepEqual(parseImportWeekdaysSetting(raw), [1, 6]);
    assert.deepEqual(raw, [6, 1, 1, 9]);
    assert.deepEqual(parseImportWeekdaysSetting('[6,1,1,9]'), [1, 6]);
  });
});

describe('normalizeGithubSetting', () => {
  it('compacte les espaces ; non-string → vide', () => {
    assert.equal(normalizeGithubSetting('  gbobsleg  /  Flowi '), 'gbobsleg / Flowi');
    assert.equal(normalizeGithubSetting(null), '');
  });
});
