'use strict';

// Tests for migration 0010 (spec 0008 Phase 0): models / leads / watch_facts
// tables plus the offers -> models backfill. Fresh temp projects only; the
// live state directory is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('./collector-db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'models-mig-test-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, dbPath: path.join(stateDir, 'collector.sqlite') };
}

// Apply a subset of migrations (by version) from a temp copy of the
// migrations directory, so the backfill (migration 0010) can be exercised
// with offers rows that already exist.
function applySubset(ctx, upToVersion) {
  const dir = path.join(ctx.root, `migrations-${upToVersion}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    const version = Number(name.match(/^(\d+)/)[1]);
    if (version <= upToVersion) fs.copyFileSync(path.join(MIGRATIONS_DIR, name), path.join(dir, name));
  }
  return db.applyMigrations({ dbPath: ctx.dbPath, migrationsDir: dir });
}

function insertOffer(dbo, row) {
  dbo.prepare(
    `INSERT INTO offers (provider_key, exact_model_id, canonical_model_id, source_kind,
       status, first_seen_at, last_verified_at, facts_json, price_source_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.provider_key,
    row.exact_model_id,
    row.canonical_model_id,
    'catalog',
    row.status || 'verified',
    row.first_seen_at || '2026-08-01T00:00:00.000Z',
    row.last_verified_at || null,
    row.facts_json || null,
    row.price_source_url || null
  );
}

test('0010 creates models, leads and watch_facts and backfills models from offers', () => {
  const ctx = tmpProject();
  const r9 = applySubset(ctx, 9);
  assert.equal(r9.schemaVersion, 9);

  const dbo = db.openDatabaseFile(ctx.dbPath);
  try {
    // Two providers serving the same canonical model with different exact
    // ids, plus a display name in facts and a removed offer elsewhere.
    insertOffer(dbo, {
      provider_key: 'google',
      exact_model_id: 'gemini-2.5-pro',
      canonical_model_id: 'gemini-2.5-pro',
      facts_json: JSON.stringify({ model_name: 'Gemini 2.5 Pro' }),
      price_source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      last_verified_at: '2026-08-02T00:00:00.000Z',
    });
    insertOffer(dbo, {
      provider_key: 'openrouter',
      exact_model_id: 'google/gemini-2.5-pro:free',
      canonical_model_id: 'gemini-2.5-pro',
      facts_json: JSON.stringify({ model_name: 'Google: Gemini 2.5 Pro' }),
      last_verified_at: '2026-08-03T00:00:00.000Z',
    });
    insertOffer(dbo, {
      provider_key: 'moonshot',
      exact_model_id: 'kimi-k3',
      canonical_model_id: 'moonshotai/kimi-k3',
      status: 'confirmed_removed',
    });
  } finally {
    dbo.close();
  }

  // Now apply the real migrations directory: only 0010 is new.
  const r10 = db.applyMigrations({ dbPath: ctx.dbPath, migrationsDir: MIGRATIONS_DIR });
  assert.deepEqual(r10.applied, [10]);
  assert.equal(r10.schemaVersion, 10);

  const t = db.openDatabaseFile(ctx.dbPath);
  try {
    const gemini = t.prepare('SELECT * FROM models WHERE canonical_model_id = ?').get('gemini-2.5-pro');
    assert.ok(gemini, 'backfilled gemini row');
    // display_name comes from the freshest facts model_name (openrouter, 08-03)
    assert.equal(gemini.display_name, 'Google: Gemini 2.5 Pro');
    assert.equal(gemini.vendor_key, null);
    const aliases = JSON.parse(gemini.aliases_json);
    assert.ok(aliases.includes('google/gemini-2.5-pro:free'), 'exact id variant is an alias');
    assert.ok(aliases.includes('Google: Gemini 2.5 Pro'), 'facts model_name variant is an alias');
    assert.ok(!aliases.includes('gemini-2.5-pro'), 'the canonical id itself is not an alias');
    assert.equal(JSON.parse(gemini.known_providers_json).length, 0);
    assert.equal(gemini.frontier, 0);
    assert.equal(gemini.first_seen_at, '2026-08-01T00:00:00.000Z');
    assert.equal(gemini.last_seen_at, '2026-08-03T00:00:00.000Z');
    assert.equal(gemini.source_url, 'https://ai.google.dev/gemini-api/docs/pricing');

    const kimi = t.prepare('SELECT * FROM models WHERE canonical_model_id = ?').get('moonshotai/kimi-k3');
    assert.ok(kimi, 'confirmed_removed offers still create model rows');
    assert.equal(kimi.display_name, 'moonshotai/kimi-k3', 'falls back to the canonical id without facts');
    assert.deepEqual(JSON.parse(kimi.aliases_json), ['kimi-k3'], 'exact id differing from canonical becomes an alias');

    assert.equal(t.prepare('SELECT COUNT(*) AS c FROM models').get().c, 2);
  } finally {
    t.close();
  }

  // Re-applying is a no-op and does not duplicate backfill rows.
  const again = db.applyMigrations({ dbPath: ctx.dbPath, migrationsDir: MIGRATIONS_DIR });
  assert.deepEqual(again.applied, []);
  const t2 = db.openDatabaseFile(ctx.dbPath);
  try {
    assert.equal(t2.prepare('SELECT COUNT(*) AS c FROM models').get().c, 2);
  } finally {
    t2.close();
  }
});

test('leads enforces the status lifecycle and watch_facts enforces domains', () => {
  const ctx = tmpProject();
  db.applyMigrations({ dbPath: ctx.dbPath, migrationsDir: MIGRATIONS_DIR });
  const t = db.openDatabaseFile(ctx.dbPath);
  try {
    t.prepare(
      `INSERT INTO leads (lead_id, run_id, detected_at, source_url, source_tier, claim_text, status)
       VALUES ('l1', 'run1', '2026-08-19T00:00:00.000Z', 'https://reddit.com/r/LocalLLaMA/1', 9, 'claim', 'open')`
    ).run();
    const lead = t.prepare('SELECT * FROM leads WHERE lead_id = ?').get('l1');
    assert.equal(lead.status, 'open');

    assert.throws(() => t.prepare(
      `INSERT INTO leads (lead_id, run_id, detected_at, source_url, source_tier, claim_text, status)
       VALUES ('l2', 'run1', '2026-08-19T00:00:00.000Z', 'https://x', 9, 'c', 'bogus')`
    ).run(), /CHECK/);

    t.prepare(
      `INSERT INTO watch_facts (domain, entity_key, run_id, fetched_at, content_hash)
       VALUES ('vendor_channel', 'vendor:openai:pricing', 'run1', '2026-08-19T00:00:00.000Z', 'abc')`
    ).run();
    assert.throws(() => t.prepare(
      `INSERT INTO watch_facts (domain, entity_key, run_id, fetched_at)
       VALUES ('nope', 'k', 'run1', '2026-08-19T00:00:00.000Z')`
    ).run(), /CHECK/);

    const row = t.prepare('SELECT * FROM watch_facts WHERE entity_key = ?').get('vendor:openai:pricing');
    assert.equal(row.domain, 'vendor_channel');
  } finally {
    t.close();
  }
});

test('db status reports the watch summary on a v10 database', () => {
  const ctx = tmpProject();
  db.applyMigrations({ dbPath: ctx.dbPath, migrationsDir: MIGRATIONS_DIR });
  const t = db.openDatabaseFile(ctx.dbPath);
  try {
    t.prepare(
      `INSERT INTO leads (lead_id, run_id, detected_at, source_url, source_tier, claim_text, status)
       VALUES ('l1', 'run1', '2026-08-19T00:00:00.000Z', 'https://reddit.com', 9, 'claim', 'open')`
    ).run();
    t.prepare(
      `INSERT INTO leads (lead_id, run_id, detected_at, source_url, source_tier, claim_text, status, resolved_at)
       VALUES ('l2', 'run1', '2026-08-19T00:00:00.000Z', 'https://reddit.com', 9, 'claim2', 'verified', '2026-08-19T01:00:00.000Z')`
    ).run();
  } finally {
    t.close();
  }
  const status = db.getStatus({ dbPath: ctx.dbPath, stateDir: ctx.stateDir });
  assert.equal(status.schemaVersion, 10);
  assert.equal(status.watch.leads_open, 1);
  assert.deepEqual(
    status.watch.leads.map((r) => ({ status: r.status, c: r.c })).sort((a, b) => a.status.localeCompare(b.status)),
    [
      { status: 'open', c: 1 },
      { status: 'verified', c: 1 },
    ]
  );
  assert.equal(status.watch.contradictions_open, null, 'contradictions table arrives in 0011');
});
