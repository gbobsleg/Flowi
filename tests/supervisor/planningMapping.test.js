'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  mappingOfferLabel,
  mappingStatusLabel,
  mappingSortRank,
  mappingStatusClass,
  planningQuotaRule,
} = require('../../public/supervisor/js/planningMapping');

describe('mappingStatusLabel', () => {
  it('Ignoré / Associé / Non classé', () => {
    assert.equal(mappingStatusLabel({ offerCode: '__ignore__' }), 'Ignoré');
    assert.equal(mappingStatusLabel({ offerCode: 'TEST_A' }), 'Associé');
    assert.equal(mappingStatusLabel({}), 'Non classé');
  });
});

describe('mappingOfferLabel', () => {
  it('ajoute (désactivée) si is_active === false', () => {
    assert.equal(mappingOfferLabel({ label: 'Offre A', is_active: false }), 'Offre A (désactivée)');
    assert.equal(mappingOfferLabel({ label: 'Offre A', is_active: true }), 'Offre A');
  });
});

describe('mappingSortRank', () => {
  it('associé 0, non classé 1, ignoré 2', () => {
    assert.equal(mappingSortRank({ offerCode: 'TEST_A' }), 0);
    assert.equal(mappingSortRank({}), 1);
    assert.equal(mappingSortRank({ offerCode: '__ignore__' }), 2);
  });
});

describe('mappingStatusClass', () => {
  it('classes Tailwind par statut', () => {
    assert.equal(mappingStatusClass({ offerCode: '__ignore__' }), 'bg-slate-100 text-slate-600');
    assert.equal(mappingStatusClass({ offerCode: 'TEST_A' }), 'bg-brand-500/15 text-brand-700');
    assert.equal(mappingStatusClass({}), 'bg-amber-50 text-amber-700');
  });
});

describe('planningQuotaRule', () => {
  it('forcé / % / défaut', () => {
    assert.equal(
      planningQuotaRule({ fixedQuota: 3 }),
      'Quota forcé 3 — écrase le calcul de la grille'
    );
    assert.equal(
      planningQuotaRule({ allowedPercent: 20 }),
      '20 % des planifiés (min. 1 si effectif > 0)'
    );
    assert.equal(
      planningQuotaRule({ defaultQuota: 2 }),
      'Quota défaut 2 (% non renseigné)'
    );
  });
});
