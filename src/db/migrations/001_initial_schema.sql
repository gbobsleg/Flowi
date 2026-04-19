-- Schéma unifié (squash des migrations 001–013). Aucune donnée applicative.
-- PRAGMA journal_mode / foreign_keys : appliqués dans src/db/sqlite.js

CREATE TABLE offers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  label         TEXT    NOT NULL,
  default_quota INTEGER NOT NULL DEFAULT 2,
  color         TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE agents (
  matricule TEXT PRIMARY KEY,
  nom       TEXT NOT NULL,
  prenom    TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1))
);

CREATE INDEX idx_agents_nom_prenom_active ON agents (nom, prenom, is_active);

CREATE TABLE pauses (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_matricule    TEXT NOT NULL REFERENCES agents (matricule) ON DELETE RESTRICT,
  offer_id           INTEGER NOT NULL REFERENCES offers (id),
  start_time         TEXT    NOT NULL,
  end_time           TEXT,
  end_reason         TEXT CHECK (end_reason IN ('manual', 'auto_15m', 'supervisor_forced')),
  duration_seconds   INTEGER,
  max_minutes_at_end INTEGER,
  status             TEXT NOT NULL DEFAULT 'in_progress'
                            CHECK (status IN ('in_progress', 'ended')),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_pauses_status_offer ON pauses (status, offer_id);
CREATE INDEX idx_pauses_agent_status ON pauses (agent_matricule, status);
CREATE INDEX idx_pauses_start_time ON pauses (start_time);

CREATE TABLE quota_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_id        INTEGER NOT NULL UNIQUE REFERENCES offers (id),
  fixed_quota     INTEGER,
  present_count   INTEGER,
  allowed_percent REAL,
  updated_by      TEXT,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
