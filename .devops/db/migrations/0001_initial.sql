-- 0001 initial collector state schema.
-- Spec 0003 fail safe collection pipeline, child 0001 small SQLite state.
-- Seven tables. Identity and query state use typed columns. Raw facts and
-- task results stay in JSON text columns. Timestamps are UTC RFC 3339 text.

CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN (
    'collecting', 'candidate_ready', 'validated',
    'validated_not_deployed', 'promoted', 'failed'
  )),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  candidate_hash TEXT,
  error TEXT
);

CREATE TABLE tasks (
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'catalog', 'known_refresh', 'discovery',
    'benchmark_scout', 'classifier', 'editorial'
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

CREATE TABLE offers (
  provider_key TEXT NOT NULL,
  exact_model_id TEXT NOT NULL,
  canonical_model_id TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'stale', 'confirmed_removed')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  first_seen_at TEXT NOT NULL,
  last_attempted_at TEXT,
  last_verified_at TEXT,
  last_seen_run_id TEXT,
  pricing_hash TEXT,
  removal_evidence_json TEXT,
  facts_json TEXT,
  PRIMARY KEY (provider_key, exact_model_id)
);

CREATE TABLE benchmarks (
  canonical_model_id TEXT NOT NULL,
  benchmark_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  version TEXT NOT NULL,
  score REAL NOT NULL CHECK (score >= 0 AND score <= 100),
  source_url TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  facts_json TEXT,
  PRIMARY KEY (canonical_model_id, benchmark_key)
);

CREATE TABLE benchmark_searches (
  canonical_model_id TEXT PRIMARY KEY,
  last_searched_at TEXT NOT NULL,
  result TEXT,
  metadata_hash TEXT
);

CREATE TABLE source_cache (
  url TEXT NOT NULL,
  subject_key TEXT NOT NULL,
  provider_key TEXT,
  exact_model_id TEXT,
  fetched_at TEXT NOT NULL,
  http_status INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (url, subject_key)
);

CREATE INDEX idx_offers_status ON offers(status);
CREATE INDEX idx_tasks_run_kind ON tasks(run_id, kind);
