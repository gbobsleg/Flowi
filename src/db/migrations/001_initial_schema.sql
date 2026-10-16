-- Schéma unifié MariaDB (InnoDB, utf8mb4). Aucune donnée applicative.
-- Horodatages en DATETIME(3), toujours en UTC (time_zone fixé par la connexion).
-- Identifiants en utf8mb4_bin : comparaison sensible à la casse, comme sous PostgreSQL.

CREATE TABLE offers (
  id            INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code          VARCHAR(255) COLLATE utf8mb4_bin NOT NULL UNIQUE,
  label         TEXT         NOT NULL,
  default_quota INT          NOT NULL DEFAULT 2,
  color         TEXT,
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE agents (
  matricule VARCHAR(255) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  nom       VARCHAR(255) NOT NULL,
  prenom    VARCHAR(255) NOT NULL,
  is_active BOOLEAN      NOT NULL DEFAULT true
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_agents_nom_prenom_active ON agents (nom, prenom, is_active);

CREATE TABLE pauses (
  id                 INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  agent_matricule    VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  offer_id           INT          NOT NULL,
  start_time         DATETIME(3)  NOT NULL,
  end_time           DATETIME(3),
  end_reason         VARCHAR(32)  CHECK (end_reason IN ('manual', 'auto_15m', 'supervisor_forced')),
  duration_seconds   INT,
  max_minutes_at_end INT,
  status             VARCHAR(32)  NOT NULL DEFAULT 'in_progress'
                                  CHECK (status IN ('in_progress', 'ended')),
  created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_pauses_agent FOREIGN KEY (agent_matricule) REFERENCES agents (matricule) ON DELETE RESTRICT,
  CONSTRAINT fk_pauses_offer FOREIGN KEY (offer_id) REFERENCES offers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_pauses_status_offer ON pauses (status, offer_id);
CREATE INDEX idx_pauses_agent_status ON pauses (agent_matricule, status);
CREATE INDEX idx_pauses_start_time ON pauses (start_time);

CREATE TABLE quota_rules (
  id              INT         NOT NULL AUTO_INCREMENT PRIMARY KEY,
  offer_id        INT         NOT NULL UNIQUE,
  fixed_quota     INT,
  present_count   INT,
  allowed_percent DOUBLE,
  updated_by      TEXT,
  updated_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_quota_rules_offer FOREIGN KEY (offer_id) REFERENCES offers (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE app_settings (
  `key`   VARCHAR(255) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  value   TEXT         NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
