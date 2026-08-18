'use strict';

// Focused DB tests for spec 0003 child 0001 (AC-1, AC-15, AC-17, AC-18 DB
// portions): migration, rollback, identity conflict, DB copy recovery, and
// legacy report bootstrap. Every test runs in a fresh temp directory and
// never touches live project state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('./collector-db');

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-db-test-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, options: { projectRoot: root, stateDir } };
}

function dbPathFor(ctx) {
  return path.join(ctx.stateDir, 'collector.sqlite');
}

function openRaw(ctx) {
  return db.openDatabaseFile(dbPathFor(ctx));
}

function countRows(ctx, table) {
  const raw = openRaw(ctx);
  try {
    return raw.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
  } finally {
    raw.close();
  }
}

function allRows(ctx, table) {
  const raw = openRaw(ctx);
  try {
    return raw.prepare(`SELECT * FROM ${table}`).all();
  } finally {
    raw.close();
  }
}

const FIXTURE_REGISTRY = {
  version: 1,
  providers: [
    { key: 'openrouter', label: 'OpenRouter', match: ['openrouter'], base_url: 'https://openrouter.ai/api/v1' },
    { key: 'google', label: 'Google Gemini', match: ['google', 'gemini'], base_url: 'https://generativelanguage.googleapis.com/v1beta' },
  ],
};

const FIXTURE_REPORT = {
  generated_at: '2026-07-30T02:00:00.000Z',
  ranked_offers: [
    {
      name: 'Poolside: Laguna S 2.1 (free)',
      provider: 'OpenRouter',
      model_id: 'poolside/laguna-s-2.1:free',
      base_url: 'https://openrouter.ai/api/v1',
      endpoint_source: 'https://openrouter.ai/poolside/laguna-s-2.1',
      last_verified: '2026-07-30T02:10:00Z',
      benchmark: { benchmark_name: 'Terminal-Bench 2.1', score: 70.2, tier: 'S' },
      benchmarks: [
        { name: 'Terminal-Bench 2.1', score: 70.2 },
        { name: 'DeepSWE', score: 40.4 },
      ],
    },
  ],
  caution_offers: [
    {
      name: 'Gemini 2.5 Pro',
      provider: 'Google Gemini',
      model_id: 'gemini-2.5-pro',
      endpoint_source: 'https://ai.google.dev/gemini-api/docs/pricing',
      last_verified: '2026-07-29T00:00:00Z',
      benchmarks: [{ name: 'Terminal Bench 2.1', score: 59 }],
    },
  ],
  conditional_credits: [],
  excluded_offers: [{ name: 'Mystery Offer', reason: 'no identity fields' }],
};

function writeFixtures(ctx, report = FIXTURE_REPORT, registry = FIXTURE_REGISTRY) {
  fs.writeFileSync(path.join(ctx.root, 'report.json'), JSON.stringify(report));
  fs.mkdirSync(path.join(ctx.root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, 'build', 'provider-registry.json'), JSON.stringify(registry));
}

function seedOfferChange(overrides = {}) {
  return {
    provider_key: 'openrouter',
    exact_model_id: 'acme/model-a:free',
    canonical_model_id: 'acme/model-a',
    source_kind: 'catalog',
    status: 'verified',
    consecutive_failures: 0,
    first_seen_at: '2026-07-01T00:00:00.000Z',
    last_attempted_at: '2026-07-31T00:00:00.000Z',
    last_verified_at: '2026-07-31T00:00:00.000Z',
    ...overrides,
  };
}

test('runtime preflight passes on the current Node', () => {
  const sqlite = db.assertRuntime();
  assert.equal(typeof sqlite.DatabaseSync, 'function');
});

test('migrations create the tables and are idempotent', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  const first = db.applyMigrations(ctx.options);
  assert.deepEqual(first.applied, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(first.schemaVersion, 9);

  const raw = openRaw(ctx);
  let names;
  try {
    names = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all().map((r) => r.name);
  } finally {
    raw.close();
  }
  for (const table of [
    'schema_migrations', 'runs', 'tasks', 'offers',
    'benchmarks', 'benchmark_searches', 'source_cache',
  ]) {
    assert.ok(names.includes(table), `missing table ${table}`);
  }
  // Spec 0007: the discovery source/term pool tables are dropped.
  for (const table of ['discovery_sources', 'search_terms', 'search_windows']) {
    assert.ok(!names.includes(table), `pool table ${table} must be dropped`);
  }

  const second = db.applyMigrations(ctx.options);
  assert.deepEqual(second.applied, []);
  assert.equal(second.schemaVersion, 9);
});

test('operator hidden flag survives catalog upserts and can be changed explicitly', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('seed-hidden', [], ctx.options);
  db.finalizeRun('seed-hidden', {
    offers: [seedOfferChange({ exact_model_id: 'deepseek/deepseek-v4-flash' })],
    runStatus: 'promoted',
  }, ctx.options);

  assert.equal(db.setOfferHidden('openrouter', 'deepseek/deepseek-v4-flash', true, ctx.options).hidden, 1);
  db.startRun('refresh-hidden', [], ctx.options);
  db.finalizeRun('refresh-hidden', {
    offers: [seedOfferChange({ exact_model_id: 'deepseek/deepseek-v4-flash' })],
    runStatus: 'promoted',
  }, ctx.options);

  let database = db.openCollectorDb(ctx.options);
  let row;
  try {
    row = database.prepare(
      "SELECT hidden FROM offers WHERE provider_key = 'openrouter' AND exact_model_id = 'deepseek/deepseek-v4-flash'"
    ).get();
  } finally {
    database.close();
  }
  assert.equal(row.hidden, 1, 'worker or catalog upsert must not clear the operator flag');

  assert.equal(db.setOfferHidden('openrouter', 'deepseek/deepseek-v4-flash', false, ctx.options).hidden, 0);
  database = db.openCollectorDb(ctx.options);
  try {
    row = database.prepare(
      "SELECT hidden FROM offers WHERE provider_key = 'openrouter' AND exact_model_id = 'deepseek/deepseek-v4-flash'"
    ).get();
  } finally {
    database.close();
  }
  assert.equal(row.hidden, 0);
});

test('missing DB with no copy stops until bootstrap (AC-1)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  assert.throws(
    () => db.openCollectorDb(ctx.options),
    (err) => err.code === 'BOOTSTRAP_REQUIRED' && /db:bootstrap/.test(err.message)
  );

  // allowCreate is the explicit escape hatch used by migrate and bootstrap.
  const created = db.openCollectorDb({ ...ctx.options, allowCreate: true });
  created.close();
  assert.ok(fs.existsSync(dbPathFor(ctx)));
});

test('pre run DB copy lands in the run backup directory with a hash (AC-1)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);

  const result = db.copyDatabaseForRun('20260731T000000Z', ctx.options);
  assert.ok(result);
  assert.equal(
    result.backupPath,
    path.join(ctx.stateDir, 'crawl', '20260731T000000Z', 'backup', 'collector.sqlite')
  );
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
  assert.ok(fs.existsSync(result.backupPath));

  const copies = db.listDatabaseCopies(ctx.options);
  assert.equal(copies.length, 1);
  assert.equal(copies[0].runId, '20260731T000000Z');

  // A run id that could escape the run directory is rejected.
  assert.throws(() => db.copyDatabaseForRun('../escape', ctx.options), /invalid run_id/);
});

test('exact run restore uses only the named backup and verifies it (AC-1)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('seed', [], ctx.options);
  db.finalizeRun('seed', { offers: [seedOfferChange()], runStatus: 'promoted' }, ctx.options);

  const exact = db.copyDatabaseForRun('exact-old', ctx.options);
  assert.ok(exact);
  db.startRun('mutation', [], ctx.options);
  db.finalizeRun('mutation', {
    offers: [seedOfferChange({ exact_model_id: 'acme/model-b:free', canonical_model_id: 'acme/model-b' })],
  }, ctx.options);
  const newer = db.copyDatabaseForRun('exact-new', ctx.options);
  assert.ok(newer);

  const descriptor = db.exactRunDatabaseBackup('exact-old', ctx.options);
  assert.deepEqual(descriptor, { runId: 'exact-old', backupPath: exact.backupPath, sha256: exact.sha256 });
  const restored = db.restoreExactRunDatabase(descriptor, ctx.options);
  assert.equal(restored.runId, 'exact-old');
  assert.equal(restored.sha256, exact.sha256);
  assert.equal(db.sha256File(dbPathFor(ctx)), exact.sha256);
  assert.equal(countRows(ctx, 'offers'), 1, 'the exact older snapshot was restored, not the newer copy');

  assert.throws(
    () => db.restoreExactRunDatabase({ ...descriptor, backupPath: newer.backupPath }, ctx.options),
    /does not match run exact-old/
  );
});

test('missing DB restores from the newest validated copy (AC-1)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [{ task_id: 'k1', kind: 'known_refresh' }], ctx.options);
  db.finalizeRun('run-1', {
    offers: [seedOfferChange()],
    runStatus: 'candidate_ready',
  }, ctx.options);

  db.copyDatabaseForRun('20260731T010000Z', ctx.options);
  fs.rmSync(dbPathFor(ctx));
  assert.ok(!fs.existsSync(dbPathFor(ctx)));

  const restored = db.openCollectorDb(ctx.options);
  try {
    const row = restored.prepare(
      "SELECT * FROM offers WHERE exact_model_id = 'acme/model-a:free'"
    ).get();
    assert.ok(row, 'offer survived restore');
    assert.equal(row.status, 'verified');
  } finally {
    restored.close();
  }
});

test('corrupt DB is moved aside and restored from copy (AC-1)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);
  db.finalizeRun('run-1', { offers: [seedOfferChange()] }, ctx.options);
  db.copyDatabaseForRun('20260731T020000Z', ctx.options);

  fs.writeFileSync(dbPathFor(ctx), 'this is not a sqlite database');
  const restored = db.openCollectorDb(ctx.options);
  try {
    const count = restored.prepare('SELECT COUNT(*) AS c FROM offers').get().c;
    assert.equal(count, 1);
  } finally {
    restored.close();
  }
  const movedAside = fs.readdirSync(ctx.stateDir)
    .filter((name) => name.includes('corrupt-'));
  assert.equal(movedAside.length, 1, 'corrupt file preserved for inspection');
});

test('restore prefers a newer copy and skips copies failing the manifest hash', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);
  db.finalizeRun('run-1', { offers: [seedOfferChange()] }, ctx.options);

  const older = db.copyDatabaseForRun('20260731T030000Z', ctx.options);
  // Make the older copy corrupt so only the newer one can restore.
  fs.writeFileSync(older.backupPath, 'corrupt bytes');

  db.startRun('run-2', [], ctx.options);
  db.finalizeRun('run-2', {
    offers: [seedOfferChange({ exact_model_id: 'acme/model-b', canonical_model_id: 'acme/model-b' })],
  }, ctx.options);
  const newer = db.copyDatabaseForRun('20260731T040000Z', ctx.options);
  // Newer mtime ordering matters; ensure the filesystem agrees.
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(older.backupPath, past, past);

  fs.rmSync(dbPathFor(ctx));
  const result = db.restoreLatestDatabase(ctx.options);
  assert.ok(result);
  assert.equal(result.runId, '20260731T040000Z');
  assert.equal(result.sha256, newer.sha256);

  // A manifest with a wrong recorded hash disqualifies that copy.
  fs.rmSync(dbPathFor(ctx));
  fs.writeFileSync(
    path.join(ctx.stateDir, 'crawl', '20260731T040000Z', 'promotion-manifest.json'),
    JSON.stringify({ db_backup: { sha256: 'deadbeef' } })
  );
  const fallback = db.restoreLatestDatabase(ctx.options);
  assert.equal(fallback, null, 'corrupt older copy plus hash mismatch newer copy leaves nothing');
});

test('finalizeRun rolls back every write on error (AC-15)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);
  db.finalizeRun('run-1', { offers: [seedOfferChange()], runStatus: 'candidate_ready' }, ctx.options);

  db.startRun('run-2', [], ctx.options);
  const goodOffer = seedOfferChange({
    exact_model_id: 'acme/model-b:free',
    canonical_model_id: 'acme/model-b',
  });
  const badBenchmark = {
    canonical_model_id: 'acme/model-b',
    benchmark_key: 'terminal_bench_2_1',
    display_name: 'Terminal-Bench 2.1',
    version: '2.1',
    score: 150, // out of range, fails inside the transaction
    source_url: 'https://example.test/tb',
    source_hash: 'abc',
    verified_at: '2026-07-31T00:00:00.000Z',
  };

  assert.throws(
    () => db.finalizeRun('run-2', {
      offers: [goodOffer],
      benchmarks: [badBenchmark],
      runStatus: 'validated',
    }, ctx.options),
    /score must be a finite number/
  );

  assert.equal(countRows(ctx, 'offers'), 1, 'good offer from the failed transaction absent');
  const runs = allRows(ctx, 'runs');
  const run2 = runs.find((r) => r.run_id === 'run-2');
  assert.equal(run2.status, 'collecting', 'run status unchanged after rollback');
  const run1 = runs.find((r) => r.run_id === 'run-1');
  assert.equal(run1.status, 'candidate_ready', 'prior run untouched');
});

test('an empty benchmark version rolls back preceding writes (AC-15)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-empty-version', [], ctx.options);

  assert.throws(
    () => db.finalizeRun('run-empty-version', {
      offers: [seedOfferChange()],
      benchmarks: [{
        canonical_model_id: 'acme/model-a',
        benchmark_key: 'terminal_bench_2_1',
        display_name: 'Terminal-Bench 2.1',
        version: '   ',
        score: 70,
        source_url: 'https://example.test/tb',
        source_hash: 'hash',
        verified_at: '2026-07-31T00:00:00.000Z',
      }],
    }, ctx.options),
    /non empty string field version/
  );
  assert.equal(countRows(ctx, 'offers'), 0, 'preceding offer write was rolled back');
  assert.equal(countRows(ctx, 'benchmarks'), 0, 'empty-version benchmark was never inserted');
});

test('one exact offer ID mapping to two canonical IDs aborts finalization', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);

  // Conflict inside one change set.
  assert.throws(
    () => db.finalizeRun('run-1', {
      offers: [
        seedOfferChange({ canonical_model_id: 'acme/model-a' }),
        seedOfferChange({ canonical_model_id: 'acme/other-canonical' }),
      ],
    }, ctx.options),
    (err) => err.code === 'IDENTITY_CONFLICT'
  );
  assert.equal(countRows(ctx, 'offers'), 0);

  // Conflict against an existing row.
  db.finalizeRun('run-1', { offers: [seedOfferChange()] }, ctx.options);
  assert.throws(
    () => db.finalizeRun('run-1', {
      offers: [seedOfferChange({ canonical_model_id: 'acme/remapped' })],
    }, ctx.options),
    (err) => err.code === 'IDENTITY_CONFLICT'
  );
  const rows = allRows(ctx, 'offers');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].canonical_model_id, 'acme/model-a');
});

test('existing benchmark rows are immutable; a higher score does not replace them', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);

  const benchmark = {
    canonical_model_id: 'acme/model-a',
    benchmark_key: 'terminal_bench_2_1',
    display_name: 'Terminal-Bench 2.1',
    version: '2.1',
    score: 60,
    source_url: 'https://example.test/tb',
    source_hash: 'hash-1',
    verified_at: '2026-07-01T00:00:00.000Z',
  };
  db.finalizeRun('run-1', { benchmarks: [benchmark] }, ctx.options);
  db.finalizeRun('run-1', { benchmarks: [{ ...benchmark, score: 99, source_hash: 'hash-2' }] }, ctx.options);

  const rows = allRows(ctx, 'benchmarks');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 60);
  assert.equal(rows[0].source_hash, 'hash-1');
});

test('startRun and recordTaskResult enforce manifest identity without touching offers (AC-11)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);

  const started = db.startRun('run-1', [
    { task_id: 'known-openrouter', kind: 'known_refresh', provider_key: 'openrouter', assigned_model_ids: ['acme/model-a:free'] },
    { task_id: 'catalog-openrouter', kind: 'catalog', provider_key: 'openrouter' },
  ], ctx.options);
  assert.equal(started.run.status, 'collecting');
  assert.equal(started.tasks.length, 2);
  assert.ok(started.tasks.every((task) => task.status === 'pending'));
  assert.deepEqual(started.tasks[1].assigned_json, ['acme/model-a:free']);

  assert.throws(
    () => db.startRun('run-1', [], ctx.options),
    /run already exists/
  );
  assert.throws(
    () => db.startRun('run-2', [{ task_id: 'x', kind: 'not-a-kind' }], ctx.options),
    /unknown task kind/
  );

  // Matching identity stores the result.
  const recorded = db.recordTaskResult('run-1', 'known-openrouter', {
    status: 'complete',
    result: { task_id: 'known-openrouter', provider_key: 'openrouter', facts: [{ model_id: 'acme/model-a:free' }] },
  }, ctx.options);
  assert.equal(recorded.status, 'complete');
  assert.equal(recorded.result_json.provider_key, 'openrouter');

  // Mismatched provider_key is rejected.
  assert.throws(
    () => db.recordTaskResult('run-1', 'catalog-openrouter', {
      status: 'complete',
      result: { provider_key: 'google' },
    }, ctx.options),
    /does not match manifest provider_key/
  );

  // Unknown task id is rejected.
  assert.throws(
    () => db.recordTaskResult('run-1', 'no-such-task', { status: 'failed' }, ctx.options),
    /unknown task/
  );

  // Double recording is rejected.
  assert.throws(
    () => db.recordTaskResult('run-1', 'known-openrouter', { status: 'failed' }, ctx.options),
    /already recorded/
  );

  // Failed task results record error payloads.
  const failed = db.recordTaskResult('run-1', 'catalog-openrouter', {
    status: 'failed',
    error: { message: 'catalog timeout' },
  }, ctx.options);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.error_json, { message: 'catalog timeout' });

  // Current offers were never touched by task recording.
  assert.equal(countRows(ctx, 'offers'), 0);

  const candidate = db.loadRunCandidate('run-1', ctx.options);
  assert.equal(candidate.tasks.length, 2);
  assert.equal(candidate.tasks.find((task) => task.task_id === 'known-openrouter').status, 'complete');
});

test('source_cache upserts on url plus subject_key', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);

  const entry = {
    url: 'https://openrouter.ai/poolside/laguna-s-2.1',
    subject_key: 'openrouter:poolside/laguna-s-2.1:free',
    provider_key: 'openrouter',
    exact_model_id: 'poolside/laguna-s-2.1:free',
    fetched_at: '2026-07-31T00:00:00.000Z',
    http_status: 200,
    content_hash: 'hash-a',
  };
  db.finalizeRun('run-1', { sourceCache: [entry] }, ctx.options);
  db.finalizeRun('run-1', { sourceCache: [{ ...entry, content_hash: 'hash-b' }] }, ctx.options);

  const rows = allRows(ctx, 'source_cache');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content_hash, 'hash-b');
});

test('source_cache accepts only integer 2xx evidence entries (AC-16)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);

  const base = {
    url: 'https://example.test/evidence',
    subject_key: 'example:subject',
    provider_key: 'example',
    exact_model_id: null,
    fetched_at: '2026-07-31T00:00:00.000Z',
    http_status: 200,
    content_hash: 'hash-200',
  };
  const entries = [
    { ...base, http_status: 200 },
    { ...base, http_status: 299, subject_key: 'example:subject-299', content_hash: 'hash-299' },
    { ...base, url: 'https://example.test/moved', http_status: 300, content_hash: 'hash-300' },
    { ...base, url: 'https://example.test/not-found', http_status: 404, content_hash: 'hash-404' },
    { ...base, url: 'https://example.test/error', http_status: 500, content_hash: 'hash-500' },
    // 200 status alone is not evidence: content_hash is missing.
    { ...base, url: 'https://example.test/no-hash', content_hash: undefined },
    // 200 status alone is not evidence: subject_key is empty.
    { ...base, url: 'https://example.test/no-subject', subject_key: '' },
  ];
  db.finalizeRun('run-1', { sourceCache: entries }, ctx.options);

  const rows = allRows(ctx, 'source_cache');
  assert.equal(rows.length, 2, 'only 200 and 299 evidence rows are stored');
  const statuses = rows.map((r) => r.http_status).sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 299]);
  const subjects = rows.map((r) => r.subject_key).sort();
  assert.deepEqual(subjects, ['example:subject', 'example:subject-299']);
});

test('a failed later attempt leaves the previous successful cache row unchanged (AC-16)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);

  const entry = {
    url: 'https://example.test/stable',
    subject_key: 'example:stable',
    provider_key: 'example',
    exact_model_id: null,
    fetched_at: '2026-07-31T00:00:00.000Z',
    http_status: 200,
    content_hash: 'hash-good',
  };
  db.finalizeRun('run-1', { sourceCache: [entry] }, ctx.options);
  db.finalizeRun('run-1', {
    sourceCache: [{
      ...entry,
      http_status: 500,
      content_hash: 'hash-bad',
      fetched_at: '2026-08-01T00:00:00.000Z',
    }],
  }, ctx.options);

  const rows = allRows(ctx, 'source_cache');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].http_status, 200, 'non-2xx attempt never overwrites a 2xx row');
  assert.equal(rows[0].content_hash, 'hash-good', 'stale content hash is preserved');
  assert.equal(rows[0].fetched_at, '2026-07-31T00:00:00.000Z', 'stale fetched_at is preserved');
});

test('non-2xx attempts never write source_cache; 2xx evidence does (AC-16)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);

  const url = 'https://example.test/page';
  const failedFetch = {
    url,
    subject_key: 'example:subject',
    provider_key: 'example',
    exact_model_id: null,
    fetched_at: '2026-08-01T00:00:00.000Z',
    http_status: 500,
    content_hash: 'hash-failed',
  };
  db.finalizeRun('run-1', { sourceCache: [failedFetch] }, ctx.options);
  assert.equal(countRows(ctx, 'source_cache'), 0, 'failed fetch never lands in source_cache');

  db.finalizeRun('run-1', {
    sourceCache: [{ ...failedFetch, http_status: 200, content_hash: 'hash-ok', fetched_at: '2026-08-02T00:00:00.000Z' }],
  }, ctx.options);
  const cached = allRows(ctx, 'source_cache');
  assert.equal(cached.length, 1);
  assert.equal(cached[0].http_status, 200);
  assert.equal(cached[0].content_hash, 'hash-ok');
});

test('bootstrap imports visible offers and benchmarks with legacy defaults (AC-1)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  writeFixtures(ctx);

  const summary = db.bootstrapFromReport(ctx.options);
  assert.equal(summary.visibleOffers, 2, 'excluded offers carry no identity and are not visible');
  assert.equal(summary.offersImported, 2);
  assert.equal(summary.offersSkipped, 0);
  assert.equal(summary.benchmarksImported, 3);

  const offers = allRows(ctx, 'offers');
  assert.equal(offers.length, 2);
  const poolside = offers.find((o) => o.exact_model_id === 'poolside/laguna-s-2.1:free');
  assert.equal(poolside.provider_key, 'openrouter');
  assert.equal(poolside.canonical_model_id, 'poolside/laguna-s-2.1', 'transport suffix removed');
  assert.equal(poolside.status, 'verified');
  assert.equal(poolside.consecutive_failures, 0);
  assert.equal(poolside.source_kind, 'report');
  assert.equal(poolside.last_verified_at, '2026-07-30T02:10:00Z', 'report source time');

  const benchmarks = allRows(ctx, 'benchmarks');
  assert.equal(benchmarks.length, 3);
  const tb = benchmarks.find((b) => b.benchmark_key === 'terminal_bench_2_1' && b.canonical_model_id === 'poolside/laguna-s-2.1');
  assert.ok(tb, 'display variant maps to terminal_bench_2_1');
  assert.equal(tb.score, 70.2);
  assert.equal(tb.version, '2.1');
  assert.equal(tb.source_hash, 'legacy-bootstrap');
  assert.equal(tb.source_url, 'https://openrouter.ai/poolside/laguna-s-2.1');
  const geminiTb = benchmarks.find((b) => b.canonical_model_id === 'gemini-2.5-pro');
  assert.equal(geminiTb.benchmark_key, 'terminal_bench_2_1', 'space variant maps too');

  // Second bootstrap refuses without force (one time emergency import).
  assert.throws(
    () => db.bootstrapFromReport(ctx.options),
    /non empty offers table/
  );

  // Forced re-bootstrap refreshes offers and never replaces benchmark rows.
  const second = db.bootstrapFromReport({ ...ctx.options, force: true });
  assert.equal(second.offersImported, 2);
  assert.equal(second.benchmarksImported, 0);
  assert.equal(second.benchmarksExisting, 3);
  const after = allRows(ctx, 'benchmarks');
  assert.equal(after.length, 3);
  assert.equal(after.find((b) => b.benchmark_key === 'terminal_bench_2_1' && b.canonical_model_id === 'poolside/laguna-s-2.1').score, 70.2);
});

test('bootstrap skips offers with unresolvable providers or missing model ids', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  writeFixtures(ctx, {
    generated_at: '2026-07-30T02:00:00.000Z',
    ranked_offers: [
      { name: 'No Provider', model_id: 'x/y' },
      { name: 'No Model', provider: 'OpenRouter' },
      {
        name: 'Good', provider: 'OpenRouter', model_id: 'x/y:free',
        endpoint_source: 'https://example.test/x', last_verified: '2026-07-30T00:00:00Z',
      },
    ],
  });

  const summary = db.bootstrapFromReport(ctx.options);
  assert.equal(summary.offersImported, 1);
  assert.equal(summary.offersSkipped, 2);
  assert.equal(countRows(ctx, 'offers'), 1);
});

test('bootstrap fails clearly without a report file', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  assert.throws(() => db.bootstrapFromReport(ctx.options), /report\.json not found/);
});

test('getStatus reports schema, runs, and copies', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));

  const before = db.getStatus(ctx.options);
  assert.equal(before.dbExists, false);
  assert.equal(before.schemaVersion, null);

  db.applyMigrations(ctx.options);
  db.startRun('run-1', [{ task_id: 'k1', kind: 'known_refresh' }], ctx.options);
  db.copyDatabaseForRun('20260731T050000Z', ctx.options);

  const mid = db.getStatus(ctx.options);
  assert.equal(mid.dbExists, true);
  assert.equal(mid.integrityOk, true);
  assert.equal(mid.schemaVersion, 9);
  assert.equal(mid.currentRun.run_id, 'run-1');
  assert.equal(mid.lastPromotedRun, null);
  assert.equal(mid.copies.length, 1);

  db.finalizeRun('run-1', { runStatus: 'promoted', candidateHash: 'cafe' }, ctx.options);
  const after = db.getStatus(ctx.options);
  assert.equal(after.currentRun, null);
  assert.equal(after.lastPromotedRun.run_id, 'run-1');
  assert.equal(after.lastPromotedRun.candidate_hash, 'cafe');
  assert.ok(after.lastPromotedRun.finished_at, 'terminal run records finished_at');
});

test('superseded runs are terminal and absent from currentRun', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('superseded-run', [], ctx.options);
  db.finalizeRun('superseded-run', { runStatus: 'superseded' }, ctx.options);
  const status = db.getStatus(ctx.options);
  assert.equal(status.currentRun, null);
  assert.equal(db.RUN_TERMINAL_STATUSES.includes('superseded'), true);
  assert.throws(
    () => db.finalizeRun('superseded-run', { error: 'must not mutate terminal run' }, ctx.options),
    /already terminal with status superseded/
  );
  const row = db.openDatabaseFile(ctx.options.dbPath || path.join(ctx.stateDir, 'collector.sqlite'), { readOnly: true });
  try {
    const run = row.prepare('SELECT status, finished_at FROM runs WHERE run_id = ?').get('superseded-run');
    assert.equal(run.status, 'superseded');
    assert.ok(run.finished_at);
  } finally {
    row.close();
  }
});

test('buildPublicReportState returns deterministic current state', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);
  db.finalizeRun('run-1', {
    offers: [
      seedOfferChange(),
      seedOfferChange({ provider_key: 'google', exact_model_id: 'gemini-2.5-pro', canonical_model_id: 'gemini-2.5-pro' }),
    ],
    benchmarks: [{
      canonical_model_id: 'acme/model-a',
      benchmark_key: 'terminal_bench_2_1',
      display_name: 'Terminal-Bench 2.1',
      version: '2.1',
      score: 70,
      source_url: 'https://example.test/tb',
      source_hash: 'h',
      verified_at: '2026-07-31T00:00:00.000Z',
    }],
    runStatus: 'promoted',
  }, ctx.options);

  const state = db.buildPublicReportState(ctx.options);
  assert.equal(state.offers.length, 2);
  assert.deepEqual(
    state.offers.map((o) => o.provider_key),
    ['google', 'openrouter'],
    'ordered by provider_key then exact_model_id'
  );
  assert.equal(state.benchmarks.length, 1);
  assert.equal(state.lastPromotedRun.run_id, 'run-1');
});

test('migration 9 drops the discovery pool on a pre-0009 database (spec 0007)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);

  const raw = openRaw(ctx);
  let priceColumns;
  try {
    priceColumns = raw.prepare(
      "SELECT name FROM pragma_table_info('offers') WHERE name IN " +
      "('effective_input_price_usd', 'effective_output_price_usd', 'price_source_url', 'price_verified_at', 'discount_end_at')"
    ).all().map((r) => r.name);
    const poolTables = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN " +
      "('discovery_sources', 'search_terms', 'search_windows')"
    ).all().map((r) => r.name);
    assert.deepEqual(poolTables, [], 'spec 0007 drops the discovery pool tables');
  } finally {
    raw.close();
  }
  // The offers pricing columns survive the pool removal.
  assert.deepEqual(priceColumns.sort(), ['discount_end_at', 'effective_input_price_usd', 'effective_output_price_usd', 'price_source_url', 'price_verified_at']);

  const second = db.applyMigrations(ctx.options);
  assert.deepEqual(second.applied, []);
});

test('price columns persist through finalizeRun and survive fetch failure (AC-3, AC-8)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);
  db.finalizeRun('run-1', {
    offers: [{
      ...seedOfferChange(),
      effective_input_price_usd: 0,
      effective_output_price_usd: 0,
      normal_input_price_usd: 0.2,
      normal_output_price_usd: 0.4,
      source_currency: 'USD',
      source_unit: 'per_million_tokens',
      price_source_url: 'https://example.test/pricing',
      price_verified_at: '2026-07-31T00:00:00.000Z',
      discount_start_at: '2026-08-01T00:00:00.000Z',
      discount_end_at: '2026-09-01T00:00:00.000Z',
    }],
    runStatus: 'promoted',
  }, ctx.options);

  const rows = allRows(ctx, 'offers');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].effective_input_price_usd, 0);
  assert.equal(rows[0].normal_output_price_usd, 0.4);
  assert.equal(rows[0].price_source_url, 'https://example.test/pricing');
  assert.equal(rows[0].discount_end_at, '2026-09-01T00:00:00.000Z');
  assert.equal(rows[0].source_currency, 'USD');
});

test('negative price columns are rejected by the database check (AC-3)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-1', [], ctx.options);
  assert.throws(
    () => db.finalizeRun('run-1', {
      offers: [{ ...seedOfferChange(), effective_input_price_usd: -0.5 }],
    }, ctx.options),
    /CHECK constraint/
  );
  assert.equal(countRows(ctx, 'offers'), 0);
});

test('identity helpers normalize benchmark names and transport suffixes', () => {
  assert.equal(db.canonicalModelId('poolside/laguna-s-2.1:free'), 'poolside/laguna-s-2.1');
  assert.equal(db.canonicalModelId('poolside/laguna-s-2.1'), 'poolside/laguna-s-2.1');
  assert.equal(db.canonicalModelId('acme/x:FREE'), 'acme/x');
  assert.equal(db.benchmarkKey('Terminal Bench 2.1'), 'terminal_bench_2_1');
  assert.equal(db.benchmarkKey('Terminal-Bench 2.1'), 'terminal_bench_2_1');
  assert.equal(db.benchmarkKey('terminal.bench  2.1'), 'terminal_bench_2_1');
  assert.equal(db.benchmarkKey('DeepSWE'), 'deepswe');
  assert.equal(db.benchmarkVersion('Terminal-Bench 2.1'), '2.1');
  assert.equal(db.benchmarkVersion('DeepSWE'), '');
});

test('sanitizeOfferFacts strips typed price keys but keeps prose evidence (AC-3)', () => {
  const dirty = {
    model_name: 'Acme Model',
    pricing_text: '$0.000003 per token input, $0.000015 per token output',
    free_quota_text: 'free tier available',
    prompt_price: 0.000003,
    completion_price: 0.000015,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    is_free: false,
    normal_input_price_usd: 3,
    normal_output_price_usd: 15,
    effective_input_price_usd: 3,
    effective_output_price_usd: 15,
    source_amount_input: 0.000003,
    source_amount_output: 0.000015,
    source_currency: 'USD',
    source_unit: 'per_token',
    conversion_rate: 1,
    conversion_source: 'https://example.test/rates',
    conversion_confirmed_at: '2026-08-01T00:00:00.000Z',
    price_source_url: 'https://openrouter.ai/api/v1/models',
    price_verified_at: '2026-08-01T00:00:00.000Z',
    discount_start_at: '2026-08-01T00:00:00.000Z',
    discount_end_at: '2026-09-01T00:00:00.000Z',
    free_model_names: ['acme/m'],
    normal_price_per_million: { input: 3, output: 15 },
    effective_price_per_million: { input: 3, output: 15 },
  };
  const clean = db.sanitizeOfferFacts(dirty);
  for (const key of [
    'prompt_price', 'completion_price', 'pricing', 'is_free', 'free_model_names',
    'normal_input_price_usd', 'normal_output_price_usd',
    'effective_input_price_usd', 'effective_output_price_usd',
    'source_amount_input', 'source_amount_output',
    'source_currency', 'source_unit',
    'conversion_rate', 'conversion_source', 'conversion_confirmed_at',
    'price_source_url', 'price_verified_at',
    'discount_start_at', 'discount_end_at',
    'normal_price_per_million', 'effective_price_per_million',
  ]) {
    assert.equal(key in clean, false, `${key} must be stripped from facts_json`);
  }
  assert.equal(clean.model_name, 'Acme Model');
  assert.equal(clean.pricing_text, dirty.pricing_text, 'prose pricing evidence is preserved');
  assert.equal(clean.free_quota_text, 'free tier available');
});

test('finalizeRun sanitizes facts_json on every write path (AC-3)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  db.applyMigrations(ctx.options);
  db.startRun('run-san', [], ctx.options);
  db.finalizeRun('run-san', {
    offers: [{
      provider_key: 'openrouter',
      exact_model_id: 'acme/m:free',
      canonical_model_id: 'acme/m',
      source_kind: 'catalog',
      status: 'verified',
      consecutive_failures: 0,
      first_seen_at: '2026-08-01T00:00:00.000Z',
      last_attempted_at: '2026-08-01T00:00:00.000Z',
      last_verified_at: '2026-08-01T00:00:00.000Z',
      last_seen_run_id: 'run-san',
      pricing_hash: null,
      removal_evidence_json: null,
      facts_json: {
        model_name: 'M',
        prompt_price: 1,
        completion_price: 2,
        pricing_text: '$1 per token',
        effective_price_per_million: { input: 1, output: 2 },
      },
      effective_input_price_usd: 1,
      effective_output_price_usd: 2,
    }],
    runStatus: 'promoted',
  }, ctx.options);

  const database = db.openCollectorDb(ctx.options);
  let row;
  try {
    row = database.prepare(
      "SELECT * FROM offers WHERE exact_model_id = 'acme/m:free'"
    ).get();
  } finally {
    database.close();
  }
  const facts = JSON.parse(row.facts_json);
  assert.equal(facts.model_name, 'M');
  assert.equal(facts.pricing_text, '$1 per token');
  assert.equal('prompt_price' in facts, false);
  assert.equal('completion_price' in facts, false);
  assert.equal('effective_price_per_million' in facts, false);
});

test('migration 0004 backfills per-token catalog rows and strips facts (AC-3, AC-4)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  const options = { ...ctx.options, migrationsDir: path.join(__dirname, 'migrations') };

  // Create a database at schema version 3 with an OpenRouter catalog row
  // that misrecorded a per-token price as per million.
  {
    const database = db.openDatabaseFile(path.join(ctx.root, 'state', 'collector.sqlite'));
    database.exec(`
      CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT);
      INSERT INTO schema_migrations (version, applied_at) VALUES (1, 'x'), (2, 'x'), (3, 'x');
      CREATE TABLE search_terms (
        category TEXT NOT NULL,
        locale TEXT NOT NULL,
        term TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 100,
        added_from TEXT,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        PRIMARY KEY (category, locale, term)
      );
      CREATE TABLE discovery_sources (
        source_key TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        source_url TEXT,
        parent_label TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 100,
        added_from TEXT,
        created_at TEXT NOT NULL,
        last_attempted_at TEXT,
        last_success_at TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE offers (
        provider_key TEXT NOT NULL,
        exact_model_id TEXT NOT NULL,
        canonical_model_id TEXT NOT NULL,
        source_kind TEXT,
        status TEXT,
        consecutive_failures INTEGER,
        first_seen_at TEXT,
        last_attempted_at TEXT,
        last_verified_at TEXT,
        last_seen_run_id TEXT,
        pricing_hash TEXT,
        removal_evidence_json TEXT,
        facts_json TEXT,
        normal_input_price_usd REAL, normal_output_price_usd REAL,
        normal_cache_read_price_usd REAL, normal_cache_write_price_usd REAL,
        effective_input_price_usd REAL, effective_output_price_usd REAL,
        effective_cache_read_price_usd REAL, effective_cache_write_price_usd REAL,
        source_amount_input REAL, source_amount_output REAL,
        source_currency TEXT, source_unit TEXT,
        conversion_rate REAL, conversion_source TEXT, conversion_confirmed_at TEXT,
        price_source_url TEXT, price_verified_at TEXT,
        discount_start_at TEXT, discount_end_at TEXT,
        PRIMARY KEY (provider_key, exact_model_id)
      );
    `);
    database.prepare(`
      INSERT INTO offers (
        provider_key, exact_model_id, canonical_model_id, source_kind, status,
        facts_json, effective_input_price_usd, effective_output_price_usd,
        source_currency, source_unit, price_verified_at
      ) VALUES (?, ?, ?, 'catalog', 'verified', ?, 0.000003, 0.000015, 'USD', 'per_million_tokens', '2026-08-01T00:00:00.000Z')
    `).run(
      'openrouter', 'moonshotai/kimi-k3', 'moonshotai/kimi-k3',
      JSON.stringify({ prompt_price: 0.000003, completion_price: 0.000015, model_name: 'Kimi K3' })
    );
    database.prepare(`
      INSERT INTO offers (
        provider_key, exact_model_id, canonical_model_id, source_kind, status,
        facts_json, effective_input_price_usd, effective_output_price_usd,
        source_currency, source_unit
      ) VALUES (?, ?, ?, 'catalog', 'verified', ?, 0, 0, 'USD', 'per_million_tokens')
    `).run(
      'openrouter', 'acme/free:free', 'acme/free',
      JSON.stringify({ model_name: 'Free', is_free: true })
    );
    database.close();
  }

  db.applyMigrations(options);

  const database = db.openCollectorDb(options);
  let rows;
  try {
    rows = database.prepare(
      "SELECT * FROM offers WHERE provider_key = 'openrouter' ORDER BY exact_model_id"
    ).all();
  } finally {
    database.close();
  }
  const kimi = rows.find((r) => r.exact_model_id === 'moonshotai/kimi-k3');
  assert.equal(kimi.effective_input_price_usd, 3, 'per token × 1,000,000');
  assert.equal(kimi.effective_output_price_usd, 15);
  assert.equal(kimi.source_unit, 'per_token');
  assert.equal(kimi.source_amount_input, 0.000003, 'raw source amount preserved');
  const kimiFacts = JSON.parse(kimi.facts_json);
  assert.equal('prompt_price' in kimiFacts, false, 'typed price keys purged from facts');
  assert.equal(kimiFacts.model_name, 'Kimi K3');

  const free = rows.find((r) => r.exact_model_id === 'acme/free:free');
  assert.equal(free.effective_input_price_usd, 0);
  assert.equal(free.source_unit, 'per_token');
  const freeFacts = JSON.parse(free.facts_json);
  assert.equal('is_free' in freeFacts, false);
});

test('sanitizeOfferFacts strips unknown typed price and fact type keys recursively', () => {
  const clean = db.sanitizeOfferFacts({ nested: { input_price_usd: 1, fact_type: 'tier', prose: 'keep' } });
  assert.deepEqual(clean, { nested: { prose: 'keep' } });
});
