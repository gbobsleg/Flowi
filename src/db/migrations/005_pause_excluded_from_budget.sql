ALTER TABLE pauses
  ADD COLUMN excluded_from_budget BOOLEAN NOT NULL DEFAULT false;
