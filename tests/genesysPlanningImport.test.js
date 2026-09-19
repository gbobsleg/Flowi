'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseGenesysCsv,
  intersectingSlots,
  aggregateDetails,
  canonicalWfmLabel,
  computeUnmapped,
  slotsByDay,
} = require('../dist/services/genesysPlanningImport');

const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'genesys-planning-individuel.anonymized.csv'
);

function loadFixtureBuffer() {
  return fs.readFileSync(FIXTURE);
}

function headcount(rows, day, label, slotMinutes) {
  const row = rows.find(
    (r) => r.day === day && r.wfmLabel === label && r.slotMinutes === slotMinutes
  );
  return row ? row.headcount : 0;
}

describe('intersectingSlots — raster 15 min', () => {
  it('09:00–12:00 couvre 09:00 … 11:45, pas 12:00', () => {
    const slots = intersectingSlots(9 * 60, 12 * 60);
    assert.equal(slots[0], 9 * 60);
    assert.equal(slots[slots.length - 1], 11 * 60 + 45);
    assert.equal(slots.includes(12 * 60), false);
    assert.equal(slots.length, 12);
  });

  it('09:12–09:47 intersecte 09:00, 09:15, 09:30 et 09:45', () => {
    assert.deepEqual(
      intersectingSlots(9 * 60 + 12, 9 * 60 + 47),
      [9 * 60, 9 * 60 + 15, 9 * 60 + 30, 9 * 60 + 45]
    );
  });

  it('fin pile sur T n’occupe pas le créneau [T, T+15)', () => {
    assert.deepEqual(intersectingSlots(9 * 60, 9 * 60 + 15), [9 * 60]);
    assert.deepEqual(intersectingSlots(9 * 60 + 15, 9 * 60 + 15), []);
  });
});

describe('parseur Genesys (fixture anonymisée)', () => {
  it('ignore les résumés (heures payées) et hérite la date des détails', () => {
    const { details, daysInFile } = parseGenesysCsv(loadFixtureBuffer());
    assert.ok(details.length > 0);
    assert.equal(
      details.every((d) => d.startMin != null && d.endMin != null),
      true
    );
    assert.ok(daysInFile.includes('2026-10-06'));
    assert.ok(daysInFile.includes('2026-10-10'));
    assert.equal(
      details.some((d) => d.startMin === 9 * 60 && d.endMin === 17 * 60 && d.wfmLabel === 'CESU'),
      false,
      'les lignes résumé 09:00–17:00 ne doivent pas passer'
    );
    const inherited = details.find(
      (d) => d.employeeId === 'EMP002' && d.startMin === 9 * 60 + 12
    );
    assert.ok(inherited);
    assert.equal(inherited.day, '2026-10-06');
    assert.equal(inherited.wfmLabel, 'CESU');
  });
});

describe('agrégat par libellé × slot', () => {
  it('compte les têtes distinctes et applique l’intersection', () => {
    const { details } = parseGenesysCsv(loadFixtureBuffer());
    const weekdays = new Set([1, 2, 3, 4, 5]);
    const rows = aggregateDetails(details, weekdays, true);

    assert.equal(headcount(rows, '2026-10-06', 'CESU', 9 * 60), 2, 'EMP001 + EMP002 sur 09:00');
    assert.equal(headcount(rows, '2026-10-06', 'CESU', 9 * 60 + 45), 2, '09:12–09:47 touche 09:45');
    assert.equal(headcount(rows, '2026-10-06', 'CESU', 10 * 60), 1, 'seul EMP001 après 09:47');
    assert.equal(headcount(rows, '2026-10-06', 'CESU', 12 * 60), 0, '09:00–12:00 n’occupe pas 12:00');
    assert.equal(headcount(rows, '2026-10-06', 'REPAS', 12 * 60), 1);
    assert.equal(headcount(rows, '2026-10-06', 'ACCUR', 9 * 60), 1);

    assert.equal(headcount(rows, '2026-10-10', 'CESU', 9 * 60), 0, 'samedi exclu (lun–ven)');
    assert.equal(headcount(rows, '2026-12-25', 'CESU', 9 * 60), 0, 'férié FR exclu');
  });
});

describe('canonicalWfmLabel', () => {
  it('ignore les commentaires entre parenthèses et fusionne les variantes', () => {
    assert.equal(
      canonicalWfmLabel('FORMATION PARTIELLE (Formation courriels paje)'),
      'FORMATION PARTIELLE'
    );
    assert.equal(
      canonicalWfmLabel('FORMATION PARTIELLE (formation courriel paje)'),
      'FORMATION PARTIELLE'
    );
    assert.equal(
      canonicalWfmLabel('FORMATION PARTIELLE (formation courriels paje)'),
      'FORMATION PARTIELLE'
    );
    assert.equal(canonicalWfmLabel('DEJ CO (DEJ CO )'), 'DEJ CO');
    assert.equal(canonicalWfmLabel('CESU'), 'CESU');
  });

  it('agrège deux commentaires différents sur le même libellé de base', () => {
    const details = [
      {
        day: '2026-10-06',
        employeeId: 'EMP_A',
        wfmLabel: canonicalWfmLabel('FORMATION PARTIELLE (Formation courriels paje)'),
        startMin: 9 * 60,
        endMin: 12 * 60,
      },
      {
        day: '2026-10-06',
        employeeId: 'EMP_B',
        wfmLabel: canonicalWfmLabel('FORMATION PARTIELLE (formation courriel paje)'),
        startMin: 9 * 60,
        endMin: 12 * 60,
      },
    ];
    const rows = aggregateDetails(details, new Set([1, 2, 3, 4, 5]), false);
    assert.equal(headcount(rows, '2026-10-06', 'FORMATION PARTIELLE', 9 * 60), 2);
    assert.equal(
      rows.some((r) => r.wfmLabel.includes('(')),
      false
    );
  });
});

describe('computeUnmapped', () => {
  it('ne liste que les libellés sans aucune ligne de mapping', () => {
    const activityRows = [
      { wfmLabel: 'CESU' },
      { wfmLabel: 'ABSENCE PARTIELLE' },
      { wfmLabel: 'INCONNU' },
    ];
    const mappingRows = [
      { label: 'CESU', offer_id: 1 },
      { label: 'ABSENCE PARTIELLE', offer_id: null },
    ];
    assert.deepEqual(computeUnmapped(activityRows, mappingRows), ['INCONNU']);
  });
});

describe('slotsByDay', () => {
  it('agrège deux libellés vers une offre, exclut l’ignoré, couvre deux jours', () => {
    const activityRows = [
      { day: '2026-10-06', wfmLabel: 'CESU', slotMinutes: 540, headcount: 2 },
      { day: '2026-10-06', wfmLabel: 'CESU', slotMinutes: 555, headcount: 1 },
      { day: '2026-10-06', wfmLabel: 'ABSENCE PARTIELLE', slotMinutes: 540, headcount: 9 },
      { day: '2026-10-06', wfmLabel: 'ACCUR', slotMinutes: 540, headcount: 1 },
      { day: '2026-10-07', wfmLabel: 'CESU', slotMinutes: 540, headcount: 3 },
      { day: '2026-10-07', wfmLabel: 'ACCUR', slotMinutes: 540, headcount: 1 },
      { day: '2026-10-08', wfmLabel: 'ABSENCE PARTIELLE', slotMinutes: 540, headcount: 5 },
    ];
    const mappingRows = [
      { label: 'CESU', offer_id: 10 },
      { label: 'ACCUR', offer_id: 10 },
      { label: 'ABSENCE PARTIELLE', offer_id: null },
    ];
    const offers = [
      {
        offerId: 10,
        offerCode: 'A',
        label: 'Offre A',
        isActive: true,
        defaultQuota: 2,
        allowedPercent: 20,
        color: null,
        fixedQuota: null,
      },
      {
        offerId: 11,
        offerCode: 'B',
        label: 'Offre B',
        isActive: true,
        defaultQuota: 4,
        allowedPercent: null,
        color: null,
        fixedQuota: null,
      },
    ];
    const byDay = slotsByDay(activityRows, mappingRows, offers);
    assert.deepEqual(Object.keys(byDay), ['2026-10-06', '2026-10-07', '2026-10-08']);

    const day1A = byDay['2026-10-06'].find((o) => o.offerCode === 'A');
    assert.deepEqual(day1A.slots, [
      { slotMinutes: 540, headcount: 3, allowed: 1 },
      { slotMinutes: 555, headcount: 1, allowed: 1 },
    ]);
    const day1B = byDay['2026-10-06'].find((o) => o.offerCode === 'B');
    assert.deepEqual(day1B.slots, []);

    const day2A = byDay['2026-10-07'].find((o) => o.offerCode === 'A');
    assert.deepEqual(day2A.slots, [
      { slotMinutes: 540, headcount: 4, allowed: 1 },
    ]);

    const day3A = byDay['2026-10-08'].find((o) => o.offerCode === 'A');
    const day3B = byDay['2026-10-08'].find((o) => o.offerCode === 'B');
    assert.deepEqual(day3A.slots, []);
    assert.deepEqual(day3B.slots, []);
  });
});
