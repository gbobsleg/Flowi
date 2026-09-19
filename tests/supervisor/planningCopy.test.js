'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatPlanningDay,
  planningPeriodLabel,
  planningReplaceSummary,
  planningAppliedSummary,
} = require('../../public/supervisor/js/planningCopy');

const THREE_DAYS = ['2026-10-06', '2026-10-10', '2026-12-25'];

describe('formatPlanningDay', () => {
  it('2026-10-06 → 06/10/2026', () => {
    assert.equal(formatPlanningDay('2026-10-06'), '06/10/2026');
  });

  it('vide → —', () => {
    assert.equal(formatPlanningDay(''), '—');
  });
});

describe('planningReplaceSummary', () => {
  it('liste vide → chaîne vide', () => {
    assert.equal(planningReplaceSummary([]), '');
  });

  it('1 jour', () => {
    assert.equal(planningReplaceSummary(['2026-10-06']), '1 jour sera remplacé : 06/10/2026.');
  });

  it('3 jours (copie de l’aperçu Chrome)', () => {
    assert.equal(
      planningReplaceSummary(THREE_DAYS),
      '3 jours seront remplacés, du 06/10/2026 au 25/12/2026.'
    );
  });

  it('ne mute pas le tableau passé', () => {
    const days = ['2026-12-25', '2026-10-06'];
    planningReplaceSummary(days);
    assert.deepEqual(days, ['2026-12-25', '2026-10-06']);
  });
});

describe('planningPeriodLabel', () => {
  it('3 jours → première → dernière', () => {
    assert.equal(planningPeriodLabel(THREE_DAYS), '06/10/2026 → 25/12/2026');
  });
});

describe('planningAppliedSummary', () => {
  it('0 jour', () => {
    assert.equal(planningAppliedSummary([]), 'Planning remplacé.');
  });

  it('1 jour', () => {
    assert.equal(planningAppliedSummary(['2026-10-06']), 'Planning remplacé : 1 jour (06/10/2026).');
  });

  it('3 jours', () => {
    assert.equal(
      planningAppliedSummary(THREE_DAYS),
      'Planning remplacé : 3 jours, du 06/10/2026 au 25/12/2026.'
    );
  });
});
