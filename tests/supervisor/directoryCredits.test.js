'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  formatRemainingSpoken,
  directoryStartsLabel,
  directoryRemainingSeconds,
  stampDirectoryCredits,
  historyExcludeConfirmMessage,
  historyExcludeButtonLabel,
  stampAgentPauseBudget,
} = require('../../public/supervisor/js/directoryCredits');

describe('formatRemainingSpoken', () => {
  it('13 min 10 s sans arrondi à la minute supérieure', () => {
    assert.equal(formatRemainingSpoken(13 * 60 + 10), '13 min 10 s');
  });

  it('minutes pile, secondes seules', () => {
    assert.equal(formatRemainingSpoken(5 * 60), '5 min');
    assert.equal(formatRemainingSpoken(9), '9 s');
  });
});

describe('directoryStartsLabel', () => {
  it('Hors plage si pauseWindowOpen === false', () => {
    assert.equal(directoryStartsLabel({ pauseWindowOpen: false, pauseBudget: { remainingStarts: 2 } }), 'Hors plage');
  });

  it('Illimité si remainingStarts null / absent', () => {
    assert.equal(directoryStartsLabel({ pauseWindowOpen: true, pauseBudget: { remainingStarts: null } }), 'Illimité');
    assert.equal(directoryStartsLabel({ pauseWindowOpen: true, pauseBudget: {} }), 'Illimité');
  });

  it('affiche N restants', () => {
    assert.equal(directoryStartsLabel({ pauseWindowOpen: true, pauseBudget: { remainingStarts: 2 } }), '2');
  });
});

describe('directoryRemainingSeconds', () => {
  const budget = { remainingSeconds: 600 };

  it('agent pas en pause : snapshot inchangé', () => {
    assert.equal(
      directoryRemainingSeconds({ pauseBudget: budget, _creditsAt: 1_000 }, { now: 11_000, onPause: false }),
      600
    );
  });

  it('agent en pause, 10 s écoulées depuis _creditsAt', () => {
    assert.equal(
      directoryRemainingSeconds(
        { pauseBudget: budget, _creditsAt: 1_000 },
        { now: 11_000, onPause: true }
      ),
      590
    );
  });

  it('utilise fallbackCreditsAt si pas de _creditsAt', () => {
    assert.equal(
      directoryRemainingSeconds(
        { pauseBudget: budget },
        { now: 21_000, onPause: true, fallbackCreditsAt: 1_000 }
      ),
      580
    );
  });
});

describe('stampDirectoryCredits', () => {
  it('applique budgetByMatricule / emptyBudget et pose _creditsAt', () => {
    const empty = { remainingSeconds: 900, remainingStarts: null };
    const aliceBudget = { remainingSeconds: 120, remainingStarts: 1 };
    const { rows, directoryCreditsAt, empty: wasEmpty } = stampDirectoryCredits(
      [
        { matricule: 'MAT_T1', pauseWindowOpen: true, pauseBudget: empty },
        { matricule: 'MAT_T2', pauseWindowOpen: true, pauseBudget: empty },
      ],
      {
        pauseWindowOpen: true,
        budgetByMatricule: { MAT_T1: aliceBudget },
        emptyBudget: empty,
      },
      50_000
    );
    assert.equal(wasEmpty, false);
    assert.equal(directoryCreditsAt, 50_000);
    assert.equal(rows[0].pauseBudget, aliceBudget);
    assert.equal(rows[1].pauseBudget, empty);
    assert.equal(rows[0]._creditsAt, 50_000);
    assert.equal(rows[1]._creditsAt, 50_000);
  });

  it('lignes vides → empty, sans mute', () => {
    const { rows, empty } = stampDirectoryCredits([], { emptyBudget: {} }, 1);
    assert.equal(empty, true);
    assert.deepEqual(rows, []);
  });
});

describe('historyExcludeConfirmMessage', () => {
  it('Ignorer : pas supprimée, plus décomptée', () => {
    const msg = historyExcludeConfirmMessage(true);
    assert.match(msg, /ne sera pas supprimée/);
    assert.match(msg, /ne sera plus décomptée/);
  });

  it('Rétablir : de nouveau décomptée', () => {
    assert.match(historyExcludeConfirmMessage(false), /de nouveau décomptée/);
  });
});

describe('historyExcludeButtonLabel', () => {
  it('Ignorer / Rétablir / en cours', () => {
    assert.equal(historyExcludeButtonLabel(false, false), 'Ignorer');
    assert.equal(historyExcludeButtonLabel(true, false), 'Rétablir');
    assert.equal(historyExcludeButtonLabel(false, true), '…');
    assert.equal(historyExcludeButtonLabel(true, true), '…');
  });
});

describe('stampAgentPauseBudget', () => {
  it('ne mute pas les lignes d’entrée ; seule MAT_T1 est mise à jour', () => {
    const oldBudget = { remainingSeconds: 60 };
    const newBudget = { remainingSeconds: 900 };
    const alice = { matricule: 'MAT_T1', pauseBudget: oldBudget, _creditsAt: 1 };
    const bob = { matricule: 'MAT_T2', pauseBudget: { remainingSeconds: 300 }, _creditsAt: 2 };
    const input = [alice, bob];
    const { rows, found, directoryCreditsAt } = stampAgentPauseBudget(input, 'MAT_T1', newBudget, 50_000);
    assert.equal(found, true);
    assert.equal(directoryCreditsAt, 50_000);
    assert.equal(rows[0].pauseBudget, newBudget);
    assert.equal(rows[0]._creditsAt, 50_000);
    assert.equal(rows[1].pauseBudget, bob.pauseBudget);
    assert.equal(rows[1]._creditsAt, 2);
    assert.equal(alice.pauseBudget, oldBudget);
    assert.equal(alice._creditsAt, 1);
    assert.equal(input[0], alice);
  });

  it('matricule inconnu → found false, lignes identiques en valeur', () => {
    const rowsIn = [{ matricule: 'MAT_T2', pauseBudget: { remainingSeconds: 10 }, _creditsAt: 3 }];
    const snapshot = JSON.parse(JSON.stringify(rowsIn));
    const { rows, found } = stampAgentPauseBudget(rowsIn, 'MAT_T1', { remainingSeconds: 1 }, 9);
    assert.equal(found, false);
    assert.deepEqual(rowsIn, snapshot);
    assert.equal(rows[0].matricule, 'MAT_T2');
    assert.equal(rows[0].pauseBudget.remainingSeconds, 10);
  });
});
