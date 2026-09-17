const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const config = require('../config');

let pool = null;

function createPool() {
  return new Pool({ connectionString: config.DATABASE_URL });
}

function getPool() {
  if (!pool) {
    throw new Error('DB non initialisée : appeler init() avant toute requête');
  }
  return pool;
}

async function query(sql, params = []) {
  return getPool().query(sql, params);
}

async function queryOne(sql, params = []) {
  const result = await query(sql, params);
  return result.rows[0];
}

async function queryAll(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // ignorer un échec de ROLLBACK (connexion déjà morte)
    }
    throw err;
  } finally {
    client.release();
  }
}

async function applyMigrations() {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const alreadyApplied = await queryOne(
      'SELECT filename FROM schema_migrations WHERE filename = $1',
      [file]
    );
    if (alreadyApplied) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [file]
      );
    });
  }
}

async function init() {
  if (pool) return pool;
  pool = createPool();
  await applyMigrations();
  return pool;
}

module.exports = {
  init,
  getPool,
  query,
  queryOne,
  queryAll,
  withTransaction,
};
