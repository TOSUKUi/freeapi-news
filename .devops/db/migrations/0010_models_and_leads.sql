-- 0010: spec 0008 (Phase 0) — models and leads become first-class entities.
-- offers stays the offer-of-record keyed by (provider_key, exact_model_id);
-- models is the model-of-record keyed by canonical_model_id, carrying aliases
-- and the known-provider distribution map that model fan-out fills in.
-- leads persist community and news claims across runs (open -> verified /
-- dismissed / expired). watch_facts stores deterministic triage snapshots
-- (channel hashes, product, program, provider watch) for change detection.

CREATE TABLE models (
  canonical_model_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  vendor_key TEXT,                     -- watchlist vendors[].key (filled by reduce)
  aliases_json TEXT NOT NULL DEFAULT '[]',
  known_providers_json TEXT NOT NULL DEFAULT '[]',  -- distribution map (served / not_served / unconfirmed)
  frontier INTEGER NOT NULL DEFAULT 0,             -- re-derived by reduce (Terminal-Bench 80%+ or frontier_vendors)
  release_status TEXT,                 -- announced|preview|beta|ga|open_weight_planned|deprecated
  release_date TEXT,
  total_parameters_b REAL,
  active_parameters_b REAL,
  open_weight INTEGER,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT,
  source_url TEXT,
  last_run_id TEXT
);

CREATE TABLE leads (
  lead_id TEXT PRIMARY KEY,            -- sha1(source_url + claim_text)
  run_id TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_tier INTEGER NOT NULL,
  claim_text TEXT NOT NULL,            -- verbatim
  model_name TEXT,
  provider_key TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'verified', 'dismissed', 'expired')),
  resolved_at TEXT,
  linked_offer_key TEXT,               -- provider_key/exact_model_id or model:<canonical>
  note TEXT
);
CREATE INDEX idx_leads_open ON leads(status, detected_at);

CREATE TABLE watch_facts (
  domain TEXT NOT NULL CHECK (domain IN ('product', 'program', 'vendor_channel', 'community', 'provider_watch')),
  entity_key TEXT NOT NULL,            -- product:claude_code / vendor:openai:pricing / ...
  url TEXT,
  run_id TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  http_status INTEGER,
  content_hash TEXT,
  facts_json TEXT,
  PRIMARY KEY (domain, entity_key, run_id)
);
CREATE INDEX idx_watch_latest ON watch_facts(domain, entity_key, run_id DESC);

-- Backfill models from offers: one row per canonical_model_id.
-- display_name comes from the freshest facts_json model_name; vendor_key stays
-- NULL until reduce maps it through the watchlist. aliases are initialized
-- from the distinct exact_model_id and facts model_name variants (the
-- canonical id itself is not an alias).
INSERT OR IGNORE INTO models (
  canonical_model_id, display_name, vendor_key, aliases_json,
  known_providers_json, frontier, first_seen_at, last_seen_at, source_url
)
SELECT
  o.canonical_model_id,
  COALESCE(
    (SELECT json_extract(o2.facts_json, '$.model_name')
       FROM offers o2
      WHERE o2.canonical_model_id = o.canonical_model_id
        AND json_extract(o2.facts_json, '$.model_name') IS NOT NULL
      ORDER BY o2.last_verified_at DESC, o2.provider_key
      LIMIT 1),
    o.canonical_model_id
  ),
  NULL,
  (
    SELECT COALESCE('[' || GROUP_CONCAT(
      '"' || replace(replace(a.alt, char(92), char(92) || char(92)), char(34), char(92) || char(34)) || '"',
      ', ') || ']', '[]')
    FROM (
      SELECT DISTINCT alt FROM (
        SELECT exact_model_id AS alt
          FROM offers
         WHERE canonical_model_id = o.canonical_model_id
           AND exact_model_id IS NOT NULL
           AND exact_model_id != ''
           AND exact_model_id != o.canonical_model_id
        UNION
        SELECT json_extract(facts_json, '$.model_name') AS alt
          FROM offers
         WHERE canonical_model_id = o.canonical_model_id
           AND json_extract(facts_json, '$.model_name') IS NOT NULL
           AND json_extract(facts_json, '$.model_name') != o.canonical_model_id
      )
      ORDER BY alt
    ) AS a
  ),
  '[]',
  0,
  MIN(o.first_seen_at),
  MAX(o.last_verified_at),
  (SELECT o3.price_source_url
     FROM offers o3
    WHERE o3.canonical_model_id = o.canonical_model_id
      AND o3.price_source_url IS NOT NULL
    ORDER BY o3.last_verified_at DESC
    LIMIT 1)
FROM offers o
GROUP BY o.canonical_model_id;
