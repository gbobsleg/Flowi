-- File d'attente de suppression définitive des offres (historique encore présent).
ALTER TABLE offers
  ADD COLUMN purge_requested_at TIMESTAMPTZ NULL;

CREATE INDEX idx_offers_purge_requested
  ON offers (purge_requested_at)
  WHERE purge_requested_at IS NOT NULL;
