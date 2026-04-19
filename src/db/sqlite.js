const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');
const config   = require('../config');

const DB_PATH = path.resolve(config.DB_PATH);

// Créer le dossier parent si besoin
const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// WAL + clés étrangères
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
const fkState = db.pragma('foreign_keys', { simple: true });
if (fkState !== 1) {
  throw new Error('SQLite foreign_keys pragma is disabled');
}

// Appliquer toutes les migrations dans l'ordre
const migrationsDir = path.join(__dirname, 'migrations');
const migrationFiles = fs.readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

db.exec(
  'CREATE TABLE IF NOT EXISTS schema_migrations (' +
  'filename TEXT PRIMARY KEY, ' +
  "applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))" +
  ')'
);

for (const file of migrationFiles) {
  const alreadyApplied = db.prepare(
    'SELECT filename FROM schema_migrations WHERE filename = ?'
  ).get(file);
  if (alreadyApplied) continue;

  const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
  try {
    db.exec(sql);
  } catch (err) {
    const message = String(err && err.message ? err.message : err).toLowerCase();
    const duplicateColumn =
      message.includes('duplicate column name') ||
      message.includes('already exists');
    if (!duplicateColumn) throw err;
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations (filename) VALUES (?)').run(file);
}

module.exports = db;
