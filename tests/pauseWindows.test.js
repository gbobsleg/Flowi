'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { pauseWindowStatus, isInsidePauseWindows } = require('../src/lib/pauseWindows');

const WINDOWS = [
  { start: '09:00', end: '12:00' },
  { start: '14:00', end: '16:00' },
];

describe('pauseWindowStatus', () => {
  it('liste vide = ouvert 24 h, pas de prochaine ouverture', () => {
    const status = pauseWindowStatus(10 * 60, []);
    assert.deepEqual(status, { windows: [], open: true, nextOpen: null });
    assert.equal(isInsidePauseWindows(10 * 60, []), true);
  });

  it('avant la première plage → prochaine ouverture aujourd’hui', () => {
    const status = pauseWindowStatus(8 * 60, WINDOWS);
    assert.equal(status.open, false);
    assert.deepEqual(status.nextOpen, { hhmm: '09:00', tomorrow: false });
    assert.deepEqual(status.windows, WINDOWS);
  });

  it('pendant une plage → ouvert, nextOpen null', () => {
    const status = pauseWindowStatus(10 * 60, WINDOWS);
    assert.equal(status.open, true);
    assert.equal(status.nextOpen, null);
    assert.equal(isInsidePauseWindows(9 * 60, WINDOWS), true);
    assert.equal(isInsidePauseWindows(12 * 60, WINDOWS), false);
  });

  it('entre deux plages → prochaine ouverture du jour', () => {
    const status = pauseWindowStatus(13 * 60, WINDOWS);
    assert.equal(status.open, false);
    assert.deepEqual(status.nextOpen, { hhmm: '14:00', tomorrow: false });
  });

  it('après la dernière plage → demain à la première', () => {
    const status = pauseWindowStatus(17 * 60, WINDOWS);
    assert.equal(status.open, false);
    assert.deepEqual(status.nextOpen, { hhmm: '09:00', tomorrow: true });
    assert.equal(isInsidePauseWindows(16 * 60, WINDOWS), false);
  });

  it('saisie désordonnée : même nextOpen qu’en ordre croissant', () => {
    const disordered = [
      { start: '14:00', end: '16:00' },
      { start: '09:00', end: '12:00' },
    ];
    const ordered = pauseWindowStatus(8 * 60, WINDOWS);
    const shuffled = pauseWindowStatus(8 * 60, disordered);
    assert.deepEqual(shuffled.windows, WINDOWS);
    assert.deepEqual(shuffled.nextOpen, ordered.nextOpen);
    assert.equal(shuffled.open, ordered.open);

    const afterLast = pauseWindowStatus(17 * 60, disordered);
    assert.deepEqual(afterLast.nextOpen, { hhmm: '09:00', tomorrow: true });
  });
});
