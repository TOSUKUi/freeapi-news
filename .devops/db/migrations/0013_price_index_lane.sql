-- 0013 Deterministic price-index lane (operator decision 2026-08-20: the
-- deterministic collection lanes are pure code, no LLM).
--
-- llmpricing.dev publishes a normalized pricing index (models.dev +
-- Artificial Analysis + OpenRouter, CC-BY-4.0, static CDN, no API key):
--   GET /api/models.json   all models: official reference + cheapest channel
--   GET /m/<model-id>/     static page with the per-provider quote array
--                          embedded (provider / modelId / input / output /
--                          official / tiers, per 1M tokens)
--
-- price-index.js fetches both, parses the quote array, and lanes.js
-- deterministically derives discount offers: a registered provider quoting
-- at least 10% below the official reference price for a frontier (or
-- already tracked) model becomes a verified DISCOUNTED offer with the
-- official quote as the normal price. A quote that is no longer below the
-- reference ends the discount (campaign liveness). No LLM involved.
--
-- llmpricing_quotes: latest quote per (model, provider) so the next run can
-- detect price changes and discount endings deterministically.

CREATE TABLE IF NOT EXISTS llmpricing_quotes (
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  quote_model_id TEXT,
  input_price_usd REAL,
  output_price_usd REAL,
  cache_read_usd REAL,
  official INTEGER NOT NULL DEFAULT 0,
  reference_input_usd REAL,
  reference_output_usd REAL,
  source_url TEXT,
  observed_at TEXT NOT NULL,
  run_id TEXT,
  PRIMARY KEY (model_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_llmpricing_quotes_model
  ON llmpricing_quotes(model_id);

-- SQLite cannot ALTER a CHECK constraint; recreate tasks (0002 pattern).
-- New kind:
--   price_index        deterministic llmpricing.dev index + quote fetch (no LLM)
CREATE TABLE tasks_new (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'catalog', 'known_refresh', 'discovery',
    'benchmark_scout', 'classifier', 'editorial',
    'watch', 'news_scan', 'vendor_deep_dive', 'community', 'model_fanout',
    'provider_monitor', 'nim_verify', 'product_monitor', 'program_monitor',
    'price_index'
  )),
  provider_key TEXT,
  assigned_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'complete', 'partial', 'failed'
  )),
  result_json TEXT,
  error_json TEXT,
  completed_at TEXT,
  PRIMARY KEY (run_id, task_id)
);

INSERT INTO tasks_new SELECT * FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_new RENAME TO tasks;
