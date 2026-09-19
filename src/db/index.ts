'use strict';

import type { PoolClient, QueryResult, QueryResultRow } from 'pg';

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { rebuildPlanningSlots } = require('./planning');

let pool: InstanceType<typeof Pool> | null = null;

function createPool() {
  return new Pool({ connectionString: config.DATABASE_URL });
}

function getPool() {
  if (!pool) {
    throw new Error('DB non initialisée : appeler init() avant toute requête');
  }
  return pool;
}

async function query<T extends QueryResultRow = any>(sql: string, params: any[] = []): Promise<QueryResult<T>> {
  return getPool().query(sql, params);
}

async function queryOne<T extends QueryResultRow = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  const result = await query<T>(sql, params);
  return result.rows[0];
}

async function queryAll<T extends QueryResultRow = any>(sql: string, params: any[] = []): Promise<T[]> {
  const result = await query<T>(sql, params);
  return result.rows;
}

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
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

async function applyMigrations(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const migrationsDir = path.join(__dirname, 'migrations');
  const migrationFiles = fs.readdirSync(migrationsDir)
    .filter((f: string) => f.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const alreadyApplied = await queryOne<{ filename: string }>(
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

async function close(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

export = {
  init,
  close,
  getPool,
  query,
  queryOne,
  queryAll,
  withTransaction,
  rebuildPlanningSlots,
};
