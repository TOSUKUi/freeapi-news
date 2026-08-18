-- 0008 contributor and training data discovery terms.
-- Keep model variants that are advertised as a Contributor or as data used for
-- training discoverable even when the provider does not call them free tiers.
-- The deterministic catalog lane remains the authority for identity and price.

INSERT OR IGNORE INTO search_terms
  (category, locale, term, active, priority, added_from, created_at, last_used_at)
VALUES
  ('new_model', 'en', 'Contributor model', 1, 0, 'migration:0008_contributor_model_discovery', '2026-08-08T00:00:00.000Z', NULL),
  ('new_model', 'en', 'data used for training model', 1, 1, 'migration:0008_contributor_model_discovery', '2026-08-08T00:00:00.000Z', NULL),
  ('new_model', 'en', 'opt-in model API', 1, 2, 'migration:0008_contributor_model_discovery', '2026-08-08T00:00:00.000Z', NULL),
  ('offer', 'any', 'Contributor API pricing', 1, 3, 'migration:0008_contributor_model_discovery', '2026-08-08T00:00:00.000Z', NULL),
  ('offer', 'any', 'data contribution model pricing', 1, 4, 'migration:0008_contributor_model_discovery', '2026-08-08T00:00:00.000Z', NULL),
  ('offer', 'any', 'training data opt-in model', 1, 5, 'migration:0008_contributor_model_discovery', '2026-08-08T00:00:00.000Z', NULL);

INSERT OR IGNORE INTO discovery_sources
  (source_key, category, label, source_url, parent_label, active, priority, added_from, created_at, last_attempted_at, last_success_at, consecutive_failures)
VALUES
  ('router:nanogpt-muse-spark-1-2-contributor', 'router', 'NanoGPT Muse Spark 1.2 Contributor', 'https://nano-gpt.com/models/text/meta/muse-spark-1.2-contributor', 'NanoGPT', 1, 0, 'migration:0008_contributor_model_discovery', '2026-08-08T00:00:00.000Z', NULL, NULL, 0);
