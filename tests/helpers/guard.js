'use strict';

const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'postgres']);

function parseDatabaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = new URL(raw);
    const dbName = decodeURIComponent((parsed.pathname || '').replace(/^\//, '').split('/')[0] || '');
    return {
      hostname: (parsed.hostname || '').toLowerCase(),
      dbName,
    };
  } catch {
    return null;
  }
}

function isAllowedTestDatabaseUrl(raw) {
  const parsed = parseDatabaseUrl(raw);
  if (!parsed) return false;
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return false;
  return /_test$/i.test(parsed.dbName);
}

function assertSafeTestDatabase() {
  if (process.env.NODE_ENV !== 'test') {
    console.error('[tests] Refus : NODE_ENV doit être « test ».');
    process.exit(1);
  }
  if (!isAllowedTestDatabaseUrl(process.env.DATABASE_URL || '')) {
    console.error('[tests] Refus : DATABASE_URL n’est pas une base de test autorisée (hôte localhost / 127.0.0.1 / postgres et nom *_test).');
    process.exit(1);
  }
}

module.exports = {
  parseDatabaseUrl,
  isAllowedTestDatabaseUrl,
  assertSafeTestDatabase,
};
