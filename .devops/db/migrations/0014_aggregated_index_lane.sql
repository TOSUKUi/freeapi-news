-- 0014 Aggregated-index lane (operator direction 2026-08-22: prefer
-- pre-aggregated data sources over LLM re-browsing).
--
-- Two public, pre-aggregated sources provide the free-model discovery
-- baseline and official base URLs without any LLM session browsing:
--   GET https://freellm.net/models/                401 models / 25 providers,
--                                                   free tier flags, verified,
--                                                   tier type, context (SSG HTML)
--   GET open-free-llm-api/awesome-freellm-apis      base-url table for 30+
--          README.md                                providers (BEGIN_QUICK_REF)
--
-- aggregated-index.js fetches both and projects the rows onto the
-- crawl-facts models[] shape; lanes.js reduces it like the discovery lanes
-- (addition only, known offers never mutated). No LLM involved.
--
-- SQLite cannot ALTER a CHECK constraint; recreate tasks (0002 pattern).
-- New kind:
--   aggregated_index   deterministic free-model index fetch (no LLM)
CREATE TABLE tasks_new (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'catalog', 'known_refresh', 'discovery',
    'benchmark_scout', 'classifier', 'editorial',
    'watch', 'news_scan', 'vendor_deep_dive', 'community', 'model_fanout',
    'provider_monitor', 'nim_verify', 'product_monitor', 'program_monitor',
    'price_index',
    'aggregated_index'
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