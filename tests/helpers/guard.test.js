'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedTestDatabaseUrl } = require('./guard');

describe('isAllowedTestDatabaseUrl', () => {
  it('accepte localhost / 127.0.0.1 / mariadb-test avec un nom *_test', () => {
    assert.equal(isAllowedTestDatabaseUrl('mysql://flowi:flowi@localhost:3306/flowi_test'), true);
    assert.equal(isAllowedTestDatabaseUrl('mysql://flowi:flowi@127.0.0.1:3307/flowi_test'), true);
    assert.equal(isAllowedTestDatabaseUrl('mysql://flowi:flowi@mariadb-test:3306/flowi_test'), true);
  });

  it('refuse un hôte ou un nom de base de production', () => {
    assert.equal(isAllowedTestDatabaseUrl('mysql://flowi:flowi@mariadb-test:3306/flowi'), false);
    assert.equal(isAllowedTestDatabaseUrl('mysql://flowi:flowi@db.example.com:3306/flowi_test'), false);
    assert.equal(isAllowedTestDatabaseUrl('mysql://flowi:flowi@10.0.0.8:3306/flowi_test'), false);
    assert.equal(isAllowedTestDatabaseUrl(''), false);
    assert.equal(isAllowedTestDatabaseUrl('not-a-url'), false);
  });
});
