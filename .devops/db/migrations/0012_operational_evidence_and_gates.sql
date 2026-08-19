-- 0012 spec 0008 Phase 2: operational evidence and gates.
--
-- Adds Gate 3 evidence columns to offers (router provider count / uptime,
-- NIM free endpoint status, API activity, offer condition facts, data
-- policy, classifier suspicion), the persistent change engine (changes)
-- and within-run contradiction resolution (contradictions) tables, a
-- deterministic source_tier column on source_cache, and extends the
-- tasks.kind CHECK for the Phase 2/3 research worker kinds.

ALTER TABLE offers ADD COLUMN provider_count INTEGER;
ALTER TABLE offers ADD COLUMN uptime_percent REAL;
ALTER TABLE offers ADD COLUMN activity_evidence TEXT;
ALTER TABLE offers ADD COLUMN free_endpoint_status TEXT
  CHECK (free_endpoint_status IN ('available', 'deprecated', 'unknown'));
ALTER TABLE offers ADD COLUMN api_calls_30d INTEGER;
ALTER TABLE offers ADD COLUMN card_required INTEGER;
ALTER TABLE offers ADD COLUMN minimum_deposit_usd REAL;
ALTER TABLE offers ADD COLUMN subscription_required INTEGER;
ALTER TABLE offers ADD COLUMN referral_required INTEGER;
ALTER TABLE offers ADD COLUMN data_policy_json TEXT;
ALTER TABLE offers ADD COLUMN data_policy_hash TEXT;
ALTER TABLE offers ADD COLUMN data_policy_verified_at TEXT;
ALTER TABLE offers ADD COLUMN suspicion_score INTEGER
  CHECK (suspicion_score IS NULL OR (suspicion_score >= 0 AND suspicion_score <= 5));

CREATE TABLE changes (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  change_key TEXT NOT NULL,            -- offer: <provider/exact_id> or model:<canonical>
  change_type TEXT NOT NULL,
  field TEXT,
  before_json TEXT,
  after_json TEXT,
  detected_at TEXT NOT NULL
);
CREATE INDEX idx_changes_run ON changes(run_id);
CREATE INDEX idx_changes_key ON changes(change_key, detected_at);

CREATE TABLE contradictions (
  contradiction_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  change_key TEXT NOT NULL,            -- offer: <provider/exact_id>
  fact TEXT NOT NULL,                   -- 'free_status' | 'price' | 'context' | ...
  values_json TEXT NOT NULL,            -- [{source_url, source_tier, value, fetched_at}]
  resolved_value TEXT,
  resolution_rule TEXT,                 -- 'lowest_source_tier' | ...
  open INTEGER NOT NULL DEFAULT 1,
  detected_at TEXT NOT NULL,
  resolved_at TEXT
);

ALTER TABLE source_cache ADD COLUMN source_tier INTEGER;

-- SQLite cannot ALTER a CHECK constraint; recreate tasks (0002 pattern).
-- New kinds (spec 0008 Phase 2 + Phase 3 reservation):
--   provider_monitor   per provider batch research worker (always, 4 sessions)
--   nim_verify         NIM free endpoint browser verification worker
--   product_monitor    coding product pricing/changelog change worker
--   program_monitor    startup credit program change worker

CREATE TABLE tasks_new (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'catalog', 'known_refresh', 'discovery',
    'benchmark_scout', 'classifier', 'editorial',
    'watch', 'news_scan', 'vendor_deep_dive', 'community', 'model_fanout',
    'provider_monitor', 'nim_verify', 'product_monitor', 'program_monitor'
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
