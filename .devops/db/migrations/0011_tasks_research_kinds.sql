-- 0011 extend tasks.kind for spec 0008 Phase 1.
-- SQLite cannot ALTER a CHECK constraint; recreate the table (0002 pattern).
-- New kinds:
--   watch              deterministic research watch channel fetch (no LLM)
--   news_scan          daily news scan research worker (always once per run)
--   vendor_deep_dive   per vendor research worker (signal + tier 1 rotation)
--   model_fanout       per new model distribution research worker (0..3/day)

CREATE TABLE tasks_new (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'catalog', 'known_refresh', 'discovery',
    'benchmark_scout', 'classifier', 'editorial',
    'watch', 'news_scan', 'vendor_deep_dive', 'community', 'model_fanout'
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
