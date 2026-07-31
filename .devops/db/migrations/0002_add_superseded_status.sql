-- Add 'superseded' to the runs.status CHECK constraint.
-- SQLite cannot ALTER a CHECK constraint; recreate the table (standard pattern).
-- A later promoted generation marks older un-deployed runs superseded so
-- deploy retry always targets the newest non-superseded generation (AC-14).

CREATE TABLE runs_new (
  run_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'collecting' CHECK (status IN (
    'collecting', 'candidate_ready', 'validated',
    'validated_not_deployed', 'promoted', 'superseded', 'failed'
  )),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  candidate_hash TEXT,
  error TEXT
);

INSERT INTO runs_new SELECT * FROM runs;
DROP TABLE runs;
ALTER TABLE runs_new RENAME TO runs;
