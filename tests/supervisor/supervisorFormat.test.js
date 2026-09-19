'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatDuration,
  formatTime,
  formatDate,
  endReasonLabel,
} = require('../../public/supervisor/js/supervisorFormat');

describe('formatDuration', () => {
  it('90 s → 01:30', () => {
    assert.equal(formatDuration(90), '01:30');
  });
});

describe('formatTime / formatDate', () => {
  it('vide → —', () => {
    assert.equal(formatTime(''), '—');
    assert.equal(formatDate(''), '—');
  });

  it('ISO → forme locale, pas une heure figée', () => {
    const iso = '2026-10-06T09:12:00.000Z';
    assert.match(formatTime(iso), /^\d{2}:\d{2}:\d{2}$/);
    assert.match(formatDate(iso), /\d/);
  });
});

describe('endReasonLabel', () => {
  it('manual / forcé / auto avec max_minutes_at_end', () => {
    assert.equal(endReasonLabel('manual', {}, 15), 'Manuel');
    assert.equal(endReasonLabel('supervisor_forced', {}, 15), 'Forcé superviseur');
    assert.equal(endReasonLabel('auto_15m', { max_minutes_at_end: 12 }, 15), 'Auto (12 min)');
  });

  it('auto sans max_minutes_at_end → 3ᵉ argument', () => {
    assert.equal(endReasonLabel('auto_15m', {}, 15), 'Auto (15 min)');
  });
});
