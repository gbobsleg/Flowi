-- Tampon d'effectifs par libellé WFM (sans PII), projection par offre Flowi, mapping.

CREATE TABLE planning_activities (
  day           DATE     NOT NULL,
  wfm_label     TEXT     NOT NULL,
  slot_minutes  SMALLINT NOT NULL CHECK (slot_minutes >= 0 AND slot_minutes < 1440),
  headcount     INTEGER  NOT NULL CHECK (headcount >= 0),
  PRIMARY KEY (day, wfm_label, slot_minutes)
);

CREATE TABLE wfm_activity_mappings (
  label    TEXT PRIMARY KEY,
  offer_id INTEGER REFERENCES offers (id) ON DELETE SET NULL
);

CREATE TABLE planning_slots (
  day           DATE     NOT NULL,
  offer_id      INTEGER  NOT NULL REFERENCES offers (id) ON DELETE CASCADE,
  slot_minutes  SMALLINT NOT NULL CHECK (slot_minutes >= 0 AND slot_minutes < 1440),
  headcount     INTEGER  NOT NULL CHECK (headcount >= 0),
  PRIMARY KEY (day, offer_id, slot_minutes)
);

CREATE INDEX idx_planning_slots_day ON planning_slots (day);
CREATE INDEX idx_planning_activities_day ON planning_activities (day);
