-- Spec 0004: preserve normal/effective/cache raw source amounts separately.
-- Typed USD/M columns are derived only after deterministic evidence audit.
ALTER TABLE offers ADD COLUMN normal_source_amount_input REAL CHECK (normal_source_amount_input IS NULL OR normal_source_amount_input >= 0);
ALTER TABLE offers ADD COLUMN normal_source_amount_output REAL CHECK (normal_source_amount_output IS NULL OR normal_source_amount_output >= 0);
ALTER TABLE offers ADD COLUMN normal_source_amount_cache_read REAL CHECK (normal_source_amount_cache_read IS NULL OR normal_source_amount_cache_read >= 0);
ALTER TABLE offers ADD COLUMN normal_source_amount_cache_write REAL CHECK (normal_source_amount_cache_write IS NULL OR normal_source_amount_cache_write >= 0);
ALTER TABLE offers ADD COLUMN effective_source_amount_input REAL CHECK (effective_source_amount_input IS NULL OR effective_source_amount_input >= 0);
ALTER TABLE offers ADD COLUMN effective_source_amount_output REAL CHECK (effective_source_amount_output IS NULL OR effective_source_amount_output >= 0);
ALTER TABLE offers ADD COLUMN effective_source_amount_cache_read REAL CHECK (effective_source_amount_cache_read IS NULL OR effective_source_amount_cache_read >= 0);
ALTER TABLE offers ADD COLUMN effective_source_amount_cache_write REAL CHECK (effective_source_amount_cache_write IS NULL OR effective_source_amount_cache_write >= 0);
