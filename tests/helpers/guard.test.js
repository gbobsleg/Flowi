'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedTestDatabaseUrl } = require('./guard');

describe('isAllowedTestDatabaseUrl', () => {
  it('accepte localhost / 127.0.0.1 / postgres avec un nom *_test', () => {
    assert.equal(isAllowedTestDatabaseUrl('postgres://flowi:flowi@localhost:5432/flowi_test'), true);
    assert.equal(isAllowedTestDatabaseUrl('postgres://flowi:flowi@127.0.0.1:5433/flowi_test'), true);
    assert.equal(isAllowedTestDatabaseUrl('postgres://flowi:flowi@postgres:5432/flowi_test'), true);
  });

  it('refuse un hôte ou un nom de base de production', () => {
    assert.equal(isAllowedTestDatabaseUrl('postgres://flowi:flowi@postgres:5432/flowi'), false);
    assert.equal(isAllowedTestDatabaseUrl('postgres://flowi:flowi@db.example.com:5432/flowi_test'), false);
    assert.equal(isAllowedTestDatabaseUrl('postgres://flowi:flowi@10.0.0.8:5432/flowi_test'), false);
    assert.equal(isAllowedTestDatabaseUrl(''), false);
    assert.equal(isAllowedTestDatabaseUrl('not-a-url'), false);
  });
});
