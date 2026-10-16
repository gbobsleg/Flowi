'use strict';

import type { DbClient, DbResult } from './types';

const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { rebuildPlanningSlots } = require('./planning');

interface Executor {
  query(sql: string, params?: any[]): Promise<[any, any]>;
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

let pool: any = null;

function normalizeParam(v: any): any {
  if (typeof v === 'string' && ISO_DATETIME_RE.test(v)) return new Date(v);
  return v;
}

/** Placeholders pg ($1, $2…) vers `?` mysql2, en gérant la réutilisation d'un même $N. */
function convertPlaceholders(sql: string, params: any[]): { sql: string; params: any[] } {
  const ordered: any[] = [];
  const converted = sql.replace(/\$(\d+)/g, (_m, n) => {
    ordered.push(normalizeParam(params[Number(n) - 1]));
    return '?';
  });
  return { sql: converted, params: ordered };
}

function toResult<T>(raw: any): DbResult<T> {
  if (Array.isArray(raw)) return { rows: raw as T[], rowCount: raw.length };
  return { rows: [], rowCount: raw && typeof raw.affectedRows === 'number' ? raw.affectedRows : 0 };
}

function wrap(executor: Executor): DbClient {
  return {
    async query<T = any>(sql: string, params: any[] = []): Promise<DbResult<T>> {
      const c = convertPlaceholders(sql, params);
      const [raw] = await executor.query(c.sql, c.params);
      return toResult<T>(raw);
    },
  };
}

function createPool() {
  const p = mysql.createPool({
    uri: config.DATABASE_URL,
    timezone: 'Z',
    dateStrings: ['DATE'],
    decimalNumbers: true,
    supportBigNumbers: true,
    multipleStatements: true,
    connectionLimit: 10,
    maxIdle: 0,
    idleTimeout: 10000,
    charset: 'utf8mb4',
    typeCast(field: any, next: () => any) {
      if (field.type === 'TINY' && field.length === 1) {
        const v = field.string();
        return v === null ? null : v === '1';
      }
      return next();
    },
  });
  p.pool.on('connection', (conn: any) => {
    conn.query("SET time_zone = '+00:00'");
  });
  return p;
}

function getPool() {
  if (!pool) {
    throw new Error('DB non initialisée : appeler init() avant toute requête');
  }
  return {
    ...wrap(pool),
    end: () => close(),
  };
}

async function query<T = any>(sql: string, params: any[] = []): Promise<DbResult<T>> {
  if (!pool) throw new Error('DB non initialisée : appeler init() avant toute requête');
  return wrap(pool).query<T>(sql, params);
}

async function queryOne<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
  const result = await query<T>(sql, params);
  return result.rows[0];
}

async function queryAll<T = any>(sql: string, params: any[] = []): Promise<T[]> {
  const result = await query<T>(sql, params);
  return result.rows;
}

async function withTransaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
  if (!pool) throw new Error('DB non initialisée : appeler init() avant toute requête');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(wrap(conn));
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch (_) {
      // ignorer un échec de ROLLBACK (connexion déjà morte)
    }
    throw err;
  } finally {
    conn.release();
  }
}

async function applyMigrations(): Promise<void> {
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   VARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
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
    // Hors transaction : sous MariaDB, CREATE/ALTER valident implicitement la transaction en cours.
    await query(sql);
    await query('INSERT IGNORE INTO schema_migrations (filename) VALUES ($1)', [file]);
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
