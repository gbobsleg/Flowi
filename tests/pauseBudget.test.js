'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  computePauseBudget,
  currentWindowBounds,
  parseMaxPauses,
  parisDayBounds,
} = require('../src/lib/pauseBudget');

const WINDOWS = [
  { start: '10:00', end: '11:00' },
  { start: '15:00', end: '16:00' },
];

/** 18 mars 2026, heure d’hiver : UTC = Paris − 1 h. */
function pauseAt(parisHm, durationSeconds, status = 'ended') {
  const [hh, mm] = parisHm.split(':').map(Number);
  const utcH = hh - 1;
  const start = new Date(Date.UTC(2026, 2, 18, utcH, mm, 0));
  const end = new Date(start.getTime() + durationSeconds * 1000);
  return {
    start_time: start.toISOString(),
    end_time: status === 'in_progress' ? null : end.toISOString(),
    duration_seconds: status === 'in_progress' ? null : durationSeconds,
    status,
  };
}

const NOW_1030 = new Date(Date.UTC(2026, 2, 18, 9, 30, 0));
const NOW_1510 = new Date(Date.UTC(2026, 2, 18, 14, 10, 0));

describe('parseMaxPauses', () => {
  it('vide / 0 / texte = illimité', () => {
    assert.equal(parseMaxPauses(null), null);
    assert.equal(parseMaxPauses(''), null);
    assert.equal(parseMaxPauses('  '), null);
    assert.equal(parseMaxPauses(0), null);
    assert.equal(parseMaxPauses('abc'), null);
  });

  it('entier ≥ 1', () => {
    assert.equal(parseMaxPauses(1), 1);
    assert.equal(parseMaxPauses('3'), 3);
  });
});

describe('currentWindowBounds', () => {
  it('liste vide = journée entière', () => {
    assert.deepEqual(currentWindowBounds(12 * 60, []), { startMin: 0, endMin: 1440 });
  });

  it('pendant la plage du matin', () => {
    assert.deepEqual(currentWindowBounds(10 * 60 + 5, WINDOWS), { startMin: 10 * 60, endMin: 11 * 60 });
  });

  it('hors plage = null', () => {
    assert.equal(currentWindowBounds(12 * 60, WINDOWS), null);
  });
});

describe('parisDayBounds', () => {
  it('minuit suivant est après minuit du jour', () => {
    const { start, end } = parisDayBounds('2026-03-18');
    assert.equal(start < end, true);
    assert.equal(end.getTime() - start.getTime(), 24 * 60 * 60 * 1000);
  });
});

describe('computePauseBudget', () => {
  it('N vide : 5 min prises → 10 min restantes, cap du prochain départ = 10', () => {
    const budget = computePauseBudget({
      pauses: [pauseAt('10:05', 5 * 60)],
      windows: WINDOWS,
      minutesOfDay: 10 * 60 + 30,
      maxPauseMinutes: 15,
      maxPauses: null,
      now: NOW_1030,
    });
    assert.equal(budget.canStart, true);
    assert.equal(budget.maxPauses, null);
    assert.equal(budget.remainingStarts, null);
    assert.equal(budget.sittingCapSeconds, 10 * 60);
    assert.equal(budget.remainingSeconds, 10 * 60);
    assert.equal(budget.startsUsed, 1);
  });

  it('N vide : pot de 15 min consommé → refus budget', () => {
    const budget = computePauseBudget({
      pauses: [pauseAt('10:00', 15 * 60)],
      windows: WINDOWS,
      minutesOfDay: 10 * 60 + 30,
      maxPauseMinutes: 15,
      maxPauses: null,
      now: NOW_1030,
    });
    assert.equal(budget.canStart, false);
    assert.equal(budget.reason, 'budget');
    assert.equal(budget.remainingSeconds, 0);
    assert.equal(budget.remainingStarts, null);
  });

  it('une pause de 15 min bloque le 2ᵉ départ', () => {
    const budget = computePauseBudget({
      pauses: [pauseAt('10:00', 15 * 60)],
      windows: WINDOWS,
      minutesOfDay: 10 * 60 + 30,
      maxPauseMinutes: 15,
      maxPauses: 3,
      now: NOW_1030,
    });
    assert.equal(budget.canStart, false);
    assert.equal(budget.reason, 'budget');
    assert.equal(budget.remainingSeconds, 0);
    assert.equal(budget.startsUsed, 1);
    assert.equal(budget.remainingStarts, 2);
  });

  it('5 min prises → 10 min restantes, 2 départs encore possibles', () => {
    const budget = computePauseBudget({
      pauses: [pauseAt('10:05', 5 * 60)],
      windows: WINDOWS,
      minutesOfDay: 10 * 60 + 30,
      maxPauseMinutes: 15,
      maxPauses: 3,
      now: NOW_1030,
    });
    assert.equal(budget.canStart, true);
    assert.equal(budget.reason, null);
    assert.equal(budget.remainingSeconds, 10 * 60);
    assert.equal(budget.sittingCapSeconds, 10 * 60);
    assert.equal(budget.startsUsed, 1);
    assert.equal(budget.remainingStarts, 2);
  });

  it('N=1 après un départ du matin → starts', () => {
    const budget = computePauseBudget({
      pauses: [pauseAt('10:05', 4 * 60)],
      windows: WINDOWS,
      minutesOfDay: 10 * 60 + 30,
      maxPauseMinutes: 15,
      maxPauses: 1,
      now: NOW_1030,
    });
    assert.equal(budget.canStart, false);
    assert.equal(budget.reason, 'starts');
    assert.equal(budget.remainingStarts, 0);
    assert.equal(budget.remainingSeconds, 11 * 60);
  });

  it('pause du matin ignorée l’après-midi', () => {
    const budget = computePauseBudget({
      pauses: [pauseAt('10:05', 15 * 60)],
      windows: WINDOWS,
      minutesOfDay: 15 * 60 + 10,
      maxPauseMinutes: 15,
      maxPauses: 1,
      now: NOW_1510,
    });
    assert.equal(budget.canStart, true);
    assert.equal(budget.startsUsed, 0);
    assert.equal(budget.remainingSeconds, 15 * 60);
  });

  it('sans plage, tout le jour compte', () => {
    const budget = computePauseBudget({
      pauses: [pauseAt('10:05', 15 * 60)],
      windows: [],
      minutesOfDay: 15 * 60,
      maxPauseMinutes: 15,
      maxPauses: 2,
      now: NOW_1510,
    });
    assert.equal(budget.canStart, false);
    assert.equal(budget.reason, 'budget');
    assert.equal(budget.startsUsed, 1);
  });

  it('pot à 0 avec des départs encore « disponibles »', () => {
    const budget = computePauseBudget({
      pauses: [pauseAt('10:00', 15 * 60)],
      windows: WINDOWS,
      minutesOfDay: 10 * 60 + 40,
      maxPauseMinutes: 15,
      maxPauses: 3,
      now: NOW_1030,
    });
    assert.equal(budget.remainingStarts, 2);
    assert.equal(budget.remainingSeconds, 0);
    assert.equal(budget.canStart, false);
    assert.equal(budget.reason, 'budget');
  });

  it('hors plage : rien n’est imputé à une fenêtre inexistante', () => {
    const budget = computePauseBudget({
      pauses: [pauseAt('10:05', 5 * 60)],
      windows: WINDOWS,
      minutesOfDay: 12 * 60,
      maxPauseMinutes: 15,
      maxPauses: 1,
      now: NOW_1030,
    });
    assert.equal(budget.startsUsed, 0);
    assert.equal(budget.canStart, true);
  });
});
