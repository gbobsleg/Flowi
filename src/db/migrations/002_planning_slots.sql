-- Tampon d'effectifs par libellé WFM (sans PII), projection par offre Flowi, mapping.

CREATE TABLE planning_activities (
  day           DATE         NOT NULL,
  wfm_label     VARCHAR(255) COLLATE utf8mb4_bin NOT NULL,
  slot_minutes  SMALLINT     NOT NULL CHECK (slot_minutes >= 0 AND slot_minutes < 1440),
  headcount     INT          NOT NULL CHECK (headcount >= 0),
  PRIMARY KEY (day, wfm_label, slot_minutes)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE wfm_activity_mappings (
  label    VARCHAR(255) COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  offer_id INT,
  CONSTRAINT fk_wfm_mappings_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE planning_slots (
  day           DATE     NOT NULL,
  offer_id      INT      NOT NULL,
  slot_minutes  SMALLINT NOT NULL CHECK (slot_minutes >= 0 AND slot_minutes < 1440),
  headcount     INT      NOT NULL CHECK (headcount >= 0),
  PRIMARY KEY (day, offer_id, slot_minutes),
  CONSTRAINT fk_planning_slots_offer FOREIGN KEY (offer_id) REFERENCES offers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_planning_slots_day ON planning_slots (day);
CREATE INDEX idx_planning_activities_day ON planning_activities (day);
