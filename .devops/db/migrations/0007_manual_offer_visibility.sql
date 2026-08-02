-- Spec 0004 operational override: keep manually hidden offers out of the public candidate.
-- Catalog refreshes and worker upserts do not write this operator controlled flag.
ALTER TABLE offers ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
CREATE INDEX idx_offers_hidden_status ON offers(hidden, status);
