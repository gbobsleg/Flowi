-- File d'attente de suppression définitive des offres (historique encore présent).
ALTER TABLE offers
  ADD COLUMN purge_requested_at DATETIME(3) NULL;

CREATE INDEX idx_offers_purge_requested ON offers (purge_requested_at);
