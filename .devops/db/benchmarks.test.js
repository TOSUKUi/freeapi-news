'use strict';

// Benchmark verification tests for spec 0003 child 0003 (AC-7 through AC-11
// and the benchmark cases of AC-18): existing facts copied without
// replacement, the deterministic daily search queue, proposal shape and
// source evidence gates, text and official image acceptance, tier derivation,
// and the immutability of verified rows. Every test runs in a fresh temp
// directory and never touches live project state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('./collector-db');
const benchmarks = require('./benchmarks');

const FIXTURE_REGISTRY = {
  version: 1,
  providers: [
    {
      key: 'openrouter',
      label: 'OpenRouter',
      match: ['openrouter'],
      base_url: 'https://openrouter.ai/api/v1',
      docs_url: 'https://openrouter.ai/docs/quickstart',
      api_catalog_url: 'https://openrouter.ai/api/v1/models',
    },
  ],
};

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-bench-test-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'build', 'provider-registry.json'),
    JSON.stringify(FIXTURE_REGISTRY)
  );
  return { root, stateDir, options: { projectRoot: root, stateDir } };
}

function setup(ctx) {
  db.applyMigrations(ctx.options);
}

function seedOffers(ctx, offers, runId = 'seed-offers') {
  db.startRun(runId, [], ctx.options);
  db.finalizeRun(runId, { offers, runStatus: 'promoted' }, ctx.options);
}

function seedBenchmarks(ctx, rows, runId = 'seed-benchmarks') {
  db.startRun(runId, [], ctx.options);
  db.finalizeRun(runId, { benchmarks: rows, runStatus: 'promoted' }, ctx.options);
}

function offerSeed(overrides = {}) {
  return {
    provider_key: 'openrouter',
    exact_model_id: 'acme/a:free',
    canonical_model_id: 'acme/a',
    source_kind: 'catalog',
    status: 'verified',
    consecutive_failures: 0,
    first_seen_at: '2026-07-01T00:00:00.000Z',
    last_attempted_at: '2026-07-30T00:00:00.000Z',
    last_verified_at: '2026-07-30T00:00:00.000Z',
    pricing_hash: null,
    removal_evidence_json: null,
    facts_json: { model_name: 'Acme A', free_quota_text: 'free tier' },
    ...overrides,
  };
}

function benchRow(overrides = {}) {
  return {
    canonical_model_id: 'acme/a',
    benchmark_key: 'terminal_bench_2_1',
    display_name: 'Terminal-Bench 2.1',
    version: '2.1',
    score: 70,
    source_url: 'https://leaderboard.example/terminal-bench',
    source_hash: 'h'.repeat(64),
    verified_at: '2026-07-30T00:00:00.000Z',
    facts_json: { origin: 'test' },
    ...overrides,
  };
}

function benchmarkRowsFor(ctx, canonicalModelId) {
  const database = db.openCollectorDb(ctx.options);
  try {
    return database.prepare(
      'SELECT * FROM benchmarks WHERE canonical_model_id = ? ORDER BY benchmark_key'
    ).all(canonicalModelId).map((row) => db.parseRow('benchmarks', row));
  } finally {
    database.close();
  }
}

// Starts a run whose manifest mirrors the benchmark queue chunks, so scout
// artifacts carry real assigned model ids.
function startScoutRun(ctx, runId) {
  const queue = benchmarks.buildBenchmarkQueue(ctx.options);
  const tasks = queue.chunks.map((chunk) => ({
    task_id: chunk.task_id,
    kind: 'benchmark_scout',
    assigned_model_ids: chunk.models.flatMap((m) => m.model_ids),
  }));
  db.startRun(runId, tasks, ctx.options);
  return queue;
}

function scoutArtifact(taskId, models, overrides = {}) {
  return {
    schema_version: 1,
    task_id: taskId,
    kind: 'benchmark_scout',
    status: 'complete',
    crawled_at: '2026-07-31T00:00:00.000Z',
    models,
    errors: [],
    ...overrides,
  };
}

function textFind(overrides = {}) {
  return {
    display_name: 'Terminal-Bench 2.1',
    version: '2.1',
    score: 72,
    source_url: 'https://leaderboard.example/terminal-bench',
    source_hash: 's'.repeat(64),
    extraction_method: 'text',
    confidence: 'HIGH',
    body: 'Terminal-Bench 2.1 leaderboard: acme/a scored 72.0 percent.',
    ...overrides,
  };
}

// Correct order: write artifacts, then ingest, then reduce.
function scoutCycle(ctx, runId, artifactByTask, reduceOptions = {}) {
  const runDir = path.join(ctx.stateDir, 'crawl', runId);
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  for (const [taskId, artifact] of Object.entries(artifactByTask)) {
    fs.writeFileSync(db.artifactPathFor(runDir, taskId), JSON.stringify(artifact, null, 2));
  }
  const lanes = require('./lanes');
  const ingest = lanes.ingestTaskArtifacts(runId, runDir, ctx.options);
  const reduce = benchmarks.reduceBenchmarkTasks(runId, runDir, {
    ...ctx.options,
    now: '2026-07-31T00:00:00.000Z',
    ...reduceOptions,
  });
  if (reduce.benchmarkChanges.length > 0 || reduce.searchChanges.length > 0) {
    db.finalizeRun(runId, {
      benchmarks: reduce.benchmarkChanges,
      benchmarkSearches: reduce.searchChanges,
    }, ctx.options);
  }
  return { runDir, ingest, reduce };
}

// ── Benchmark identity (AC-7) ────────────────────────────────────

test('display variants collapse to the terminal_bench_2_1 key (AC-7)', () => {
  const variants = [
    'Terminal Bench 2.1', 'Terminal-Bench 2.1', 'TerminalBench 2.1',
    'terminal-bench 2.1', 'Terminal  Bench  2.1',
  ];
  for (const name of variants) {
    assert.equal(db.benchmarkKey(name), 'terminal_bench_2_1', `variant: ${name}`);
  }
});

test('canonical model id removes only the :free transport suffix (AC-7)', () => {
  assert.equal(db.canonicalModelId('acme/a:free'), 'acme/a');
  assert.equal(db.canonicalModelId('acme/a'), 'acme/a');
  assert.equal(db.canonicalModelId('gemini-2.5-pro'), 'gemini-2.5-pro');
});

// ── Search queue (AC-7) ──────────────────────────────────────────

test('the queue holds only current free models missing terminal_bench_2_1 (AC-7)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
    offerSeed({ exact_model_id: 'acme/b:free', canonical_model_id: 'acme/b' }),
    offerSeed({ exact_model_id: 'acme/c:free', canonical_model_id: 'acme/c', status: 'confirmed_removed' }),
    offerSeed({ exact_model_id: 'acme/d:free', canonical_model_id: 'acme/d' }),
  ]);
  // acme/a already has the gate benchmark; acme/c is removed.
  seedBenchmarks(ctx, [benchRow({ canonical_model_id: 'acme/a' })]);

  const queue = benchmarks.buildBenchmarkQueue(ctx.options);
  const queued = queue.queue.map((entry) => entry.canonical_model_id).sort();
  assert.deepEqual(queued, ['acme/b', 'acme/d']);
  assert.ok(!queued.includes('acme/a'), 'model with terminal_bench_2_1 is not queued');
  assert.ok(!queued.includes('acme/c'), 'confirmed_removed model is not queued');
});

test('a newly admitted catalog model is queued while an existing gate score is reused', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'acme/new:free', canonical_model_id: 'acme/new', first_seen_at: '2026-07-31T00:00:00.000Z' }),
    offerSeed({ exact_model_id: 'acme/scored:free', canonical_model_id: 'acme/scored' }),
  ]);
  seedBenchmarks(ctx, [benchRow({ canonical_model_id: 'acme/scored', score: 57 })]);

  const queue = benchmarks.buildBenchmarkQueue(ctx.options);
  assert.deepEqual(queue.queue.map((entry) => entry.canonical_model_id), ['acme/new']);
  assert.equal(queue.queue[0].newly_discovered, true);
  assert.equal(queue.queue.some((entry) => entry.canonical_model_id === 'acme/scored'), false,
    'the existing terminal_bench_2_1 fact is reused instead of queued');
});

test('legacy empty or unknown benchmark versions do not satisfy queue reuse or tier eligibility', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'acme/empty:free', canonical_model_id: 'acme/empty' }),
    offerSeed({ exact_model_id: 'acme/unknown:free', canonical_model_id: 'acme/unknown' }),
  ]);

  const database = db.openCollectorDb(ctx.options);
  try {
    database.exec('BEGIN IMMEDIATE');
    const insert = database.prepare(
      'INSERT INTO benchmarks (' +
      'canonical_model_id, benchmark_key, display_name, version, score, ' +
      'source_url, source_hash, verified_at, facts_json) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    insert.run(
      'acme/empty', 'terminal_bench_2_1', 'Terminal-Bench 2.1', '', 90,
      'https://leaderboard.example/terminal-bench', 'legacy-empty',
      '2026-07-30T00:00:00.000Z', null
    );
    insert.run(
      'acme/unknown', 'terminal_bench_2_1', 'Terminal-Bench 2.1', 'unknown', 90,
      'https://leaderboard.example/terminal-bench', 'legacy-unknown',
      '2026-07-30T00:00:00.000Z', null
    );
    database.exec('COMMIT');
  } finally {
    database.close();
  }

  const queue = benchmarks.buildBenchmarkQueue(ctx.options);
  assert.deepEqual(
    queue.queue.map((entry) => entry.canonical_model_id).sort(),
    ['acme/empty', 'acme/unknown'],
    'legacy invalid versions must not suppress daily queueing'
  );

  for (const canonical of ['acme/empty', 'acme/unknown']) {
    const tier = benchmarks.deriveTier(benchmarkRowsFor(ctx, canonical));
    assert.equal(tier.tier, null, `${canonical} must not receive a tier from an invalid version`);
    assert.equal(tier.benchmark_pending, true);
  }
});

test('the queue splits into chunks of at most four models (AC-7)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  const offers = [];
  for (let i = 0; i < 9; i += 1) {
    offers.push(offerSeed({ exact_model_id: `acme/m${i}:free`, canonical_model_id: `acme/m${i}` }));
  }
  seedOffers(ctx, offers);
  const queue = benchmarks.buildBenchmarkQueue(ctx.options);
  assert.equal(queue.queued, 9);
  assert.equal(queue.chunks.length, 3);
  assert.deepEqual(queue.chunks.map((c) => c.models.length), [4, 4, 1]);
  for (const chunk of queue.chunks) {
    assert.ok(chunk.models.length <= benchmarks.QUEUE_CHUNK_SIZE);
  }
});

test('newly discovered models sort before previously searched ones (AC-7)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'acme/old:free', canonical_model_id: 'acme/old', first_seen_at: '2026-01-01T00:00:00.000Z' }),
    offerSeed({ exact_model_id: 'acme/new:free', canonical_model_id: 'acme/new', first_seen_at: '2026-07-01T00:00:00.000Z' }),
  ]);
  // Mark acme/old as searched before with no result.
  db.startRun('search-seed', [], ctx.options);
  db.finalizeRun('search-seed', {
    benchmarkSearches: [{
      canonical_model_id: 'acme/old',
      last_searched_at: '2026-06-01T00:00:00.000Z',
      result: 'not_found',
      metadata_hash: 'x'.repeat(64),
    }],
    runStatus: 'promoted',
  }, ctx.options);

  const queue = benchmarks.buildBenchmarkQueue(ctx.options);
  assert.equal(queue.queue[0].canonical_model_id, 'acme/new', 'never searched sorts first');
  assert.equal(queue.queue[0].newly_discovered, true);
  assert.equal(queue.queue[1].canonical_model_id, 'acme/old');
});

// ── Proposal validation (AC-8, AC-9) ─────────────────────────────

test('unknown and malformed benchmark versions stay pending (AC-8, AC-9)', () => {
  for (const displayName of ['SWE-Bench (OpenHands)', 'OSWorld']) {
    for (const version of [undefined, null, '', '   ']) {
      const shape = benchmarks.validateProposalShape({
        ...textFind(), display_name: displayName, version,
      });
      assert.equal(shape.ok, false, `${displayName} version ${JSON.stringify(version)}`);
      assert.match(shape.reason, /version|unknown/i);
    }
  }

  for (const version of [2.1, 0, false, {}, []]) {
    const shape = benchmarks.validateProposalShape({ ...textFind(), version });
    assert.equal(shape.ok, false, `malformed version ${JSON.stringify(version)}`);
    assert.match(shape.reason, /version.*string/i);
  }
});

test('a known display-name version is deterministically normalized (AC-8)', () => {
  const shape = benchmarks.validateProposalShape({ ...textFind(), version: null });
  assert.equal(shape.ok, true);
  assert.equal(shape.version, '2.1');

  assert.equal(
    benchmarks.bodyConfirmsBenchmark('SWE-Bench (OpenHands): acme/a scored 40', {
      key: 'swe_bench_openhands', displayName: 'SWE-Bench (OpenHands)', version: '',
    }),
    false,
    'evidence validation fails closed for an unknown version'
  );
});

test('an explicit text version conflicting with the display name is rejected (AC-8)', () => {
  const result = benchmarks.evaluateProposal({
    ...textFind(),
    model_id: 'acme/a:free',
    version: '1.0',
    body: 'Terminal-Bench 2.1 leaderboard: acme/a scored 72.0 percent.',
  }, {
    canonical_model_id: 'acme/a',
    model_ids: ['acme/a:free'],
  });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /conflicts.*2\.1/);
});

test('an official image version must match the accepted proposal version (AC-9)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-image-version-mismatch');

  const imageFind = {
    display_name: 'Terminal-Bench 2.1',
    version: '2.1',
    score: 68,
    source_url: 'https://x.com/vendor/status/123',
    source_hash: 'i'.repeat(64),
    extraction_method: 'official_image',
    confidence: 'HIGH',
    image_facts: { model: 'acme/a', benchmark: 'Terminal-Bench', version: '1.0', score: 68 },
  };
  const { reduce } = scoutCycle(ctx, 'run-image-version-mismatch', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'acme/a:free', canonical_model_id: 'acme/a', model_name: 'Acme A', benchmark_finds: [imageFind] },
    ]),
  }, { visionCapable: true });

  assert.equal(reduce.coverage.accepted, 0);
  assert.ok(reduce.rejected.some((entry) => /version.*match proposal version/.test(entry.reason)));
  assert.equal(benchmarkRowsFor(ctx, 'acme/a').length, 0);
});

test('a malformed proposal does not abort a valid proposal in the same task (AC-8)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-mixed-version');

  const unknown = {
    display_name: 'SWE-Bench (OpenHands)',
    version: null,
    score: 40,
    source_url: 'https://leaderboard.example/swe-bench',
    body: 'SWE-Bench (OpenHands): acme/a scored 40.0 percent.',
  };
  const { reduce } = scoutCycle(ctx, 'run-mixed-version', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [{
      model_id: 'acme/a:free', canonical_model_id: 'acme/a', model_name: 'Acme A',
      benchmark_finds: [unknown, textFind()],
    }]),
  });

  assert.equal(reduce.coverage.accepted, 1);
  assert.ok(reduce.rejected.some((entry) => /version|unknown/i.test(entry.reason)));
  assert.equal(reduce.benchmarkChanges.length, 1);
  assert.ok(reduce.benchmarkChanges.every((change) => change.version.trim().length > 0));
  assert.equal(benchmarkRowsFor(ctx, 'acme/a').length, 1);
  const database = db.openCollectorDb(ctx.options);
  try {
    assert.ok(database.prepare(
      'SELECT * FROM benchmark_searches WHERE canonical_model_id = ?'
    ).get('acme/a'));
  } finally {
    database.close();
  }
});

test('a text proposal confirmed by the fetched body is accepted (AC-8, AC-9)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-accept');

  const { reduce } = scoutCycle(ctx, 'run-accept', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'acme/a:free', canonical_model_id: 'acme/a', model_name: 'Acme A', benchmark_finds: [textFind()] },
    ]),
  });

  assert.equal(reduce.coverage.accepted, 1);
  assert.equal(reduce.benchmarkChanges.length, 1);
  const rows = benchmarkRowsFor(ctx, 'acme/a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].benchmark_key, 'terminal_bench_2_1');
  assert.equal(rows[0].score, 72);
  assert.equal(rows[0].source_url, 'https://leaderboard.example/terminal-bench');
  assert.equal(rows[0].source_hash, 's'.repeat(64));
  assert.equal(rows[0].facts_json.extraction_method, 'text');
});

test('a proposal for an unqueued model is rejected (AC-8, AC-11)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-unqueued');

  const { reduce } = scoutCycle(ctx, 'run-unqueued', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'hallucinated/model:free', canonical_model_id: 'hallucinated/model', benchmark_finds: [textFind()] },
    ]),
  });

  assert.equal(reduce.coverage.accepted, 0);
  assert.equal(reduce.benchmarkChanges.length, 0);
  assert.ok(reduce.rejected.some((r) => /not in the search queue/.test(r.reason)));
  assert.equal(benchmarkRowsFor(ctx, 'hallucinated/model').length, 0);
});

test('a proposal whose body does not confirm the model is rejected (AC-9)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-unrelated');

  const { reduce } = scoutCycle(ctx, 'run-unrelated', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'acme/a:free', canonical_model_id: 'acme/a', benchmark_finds: [
        textFind({ body: 'Terminal-Bench 2.1 leaderboard: some other model scored 72.0 percent.' }),
      ] },
    ]),
  });

  assert.equal(reduce.coverage.accepted, 0);
  assert.ok(reduce.rejected.some((r) => /does not confirm the model/.test(r.reason)));
});

test('a proposal whose body does not confirm the version is rejected (AC-9)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-version');

  const { reduce } = scoutCycle(ctx, 'run-version', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'acme/a:free', canonical_model_id: 'acme/a', benchmark_finds: [
        textFind({ version: '2.1', body: 'Terminal-Bench 1.0 leaderboard: acme/a scored 72.0 percent.' }),
      ] },
    ]),
  });

  assert.equal(reduce.coverage.accepted, 0);
  assert.ok(reduce.rejected.some((r) => /benchmark name and version/.test(r.reason)));
});

test('a proposal with a score outside 0 through 100 is rejected (AC-8)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-range');

  const { reduce } = scoutCycle(ctx, 'run-range', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'acme/a:free', canonical_model_id: 'acme/a', benchmark_finds: [
        textFind({ score: 172, body: 'Terminal-Bench 2.1 leaderboard: acme/a scored 172.0 percent.' }),
      ] },
    ]),
  });

  assert.equal(reduce.coverage.accepted, 0);
  assert.ok(reduce.rejected.some((r) => /from 0 through 100/.test(r.reason)));
});

test('a text proposal without any fetched body is rejected (AC-9)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-nobody');

  const { reduce } = scoutCycle(ctx, 'run-nobody', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'acme/a:free', canonical_model_id: 'acme/a', benchmark_finds: [
        textFind({ body: null, body_excerpt: null }),
      ] },
    ]),
  });

  assert.equal(reduce.coverage.accepted, 0);
  assert.ok(reduce.rejected.some((r) => /no fetched body/.test(r.reason)));
});

// ── Official image acceptance (AC-9) ─────────────────────────────

test('an official image with HIGH confidence and all four values is accepted (AC-9)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-image');

  const imageFind = {
    display_name: 'Terminal-Bench 2.1',
    version: '2.1',
    score: 68,
    source_url: 'https://x.com/vendor/status/123',
    source_hash: 'i'.repeat(64),
    extraction_method: 'official_image',
    confidence: 'HIGH',
    image_hash: 'c'.repeat(64),
    row_description: 'acme/a row, Terminal-Bench 2.1 column',
    image_facts: { model: 'acme/a', benchmark: 'Terminal-Bench', version: '2.1', score: 68 },
  };
  const { reduce } = scoutCycle(ctx, 'run-image', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'acme/a:free', canonical_model_id: 'acme/a', benchmark_finds: [imageFind] },
    ]),
  }, { visionCapable: true });

  assert.equal(reduce.coverage.accepted, 1);
  const rows = benchmarkRowsFor(ctx, 'acme/a');
  assert.equal(rows[0].facts_json.extraction_method, 'official_image');
  assert.equal(rows[0].facts_json.confidence, 'HIGH');
  assert.equal(rows[0].facts_json.image_hash, 'c'.repeat(64));
});

test('an official image is rejected without a vision capable worker (AC-9)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-image-novision');

  const imageFind = {
    display_name: 'Terminal-Bench 2.1', version: '2.1', score: 68,
    source_url: 'https://x.com/vendor/status/123', source_hash: 'i'.repeat(64),
    extraction_method: 'official_image', confidence: 'HIGH',
    image_facts: { model: 'acme/a', benchmark: 'Terminal-Bench', version: '2.1', score: 68 },
  };
  const { reduce } = scoutCycle(ctx, 'run-image-novision', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'acme/a:free', canonical_model_id: 'acme/a', benchmark_finds: [imageFind] },
    ]),
  }, { visionCapable: false });

  assert.equal(reduce.coverage.accepted, 0);
  assert.ok(reduce.rejected.some((r) => /not vision capable/.test(r.reason)));
});

test('a MEDIUM confidence image stays pending (AC-9)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-image-medium');

  const imageFind = {
    display_name: 'Terminal-Bench 2.1', version: '2.1', score: 68,
    source_url: 'https://x.com/vendor/status/123', source_hash: 'i'.repeat(64),
    extraction_method: 'official_image', confidence: 'MEDIUM',
    image_facts: { model: 'acme/a', benchmark: 'Terminal-Bench', version: '2.1', score: 68 },
  };
  const { reduce } = scoutCycle(ctx, 'run-image-medium', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'acme/a:free', canonical_model_id: 'acme/a', benchmark_finds: [imageFind] },
    ]),
  }, { visionCapable: true });

  assert.equal(reduce.coverage.accepted, 0);
  assert.ok(reduce.rejected.some((r) => /confidence MEDIUM is not HIGH/.test(r.reason)));
});

// ── Immutability of verified rows (AC-8) ─────────────────────────

test('a higher proposed score never replaces an existing verified score (AC-8)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  // The model has an existing SWE-bench row but no terminal_bench_2_1, so it
  // is still queued. A higher SWE-bench proposal must not replace the row.
  seedBenchmarks(ctx, [benchRow({
    canonical_model_id: 'acme/a',
    benchmark_key: 'swe_bench_verified',
    display_name: 'SWE-bench Verified',
    version: '1.0',
    score: 55,
  })]);
  startScoutRun(ctx, 'run-overwrite');

  const { reduce } = scoutCycle(ctx, 'run-overwrite', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'acme/a:free', canonical_model_id: 'acme/a', benchmark_finds: [
        textFind({
          display_name: 'SWE-bench Verified',
          version: '1.0',
          score: 95,
          body: 'SWE-bench Verified 1.0 leaderboard: acme/a solved 95.0 percent of tasks.',
        }),
      ] },
    ]),
  });

  assert.equal(reduce.coverage.accepted, 0);
  assert.ok(reduce.rejected.some((r) => /immutable/.test(r.reason)));
  const rows = benchmarkRowsFor(ctx, 'acme/a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 55, 'existing score is preserved');
});

// ── Tier derivation (AC-10) ──────────────────────────────────────

test('tier derives from terminal_bench_2_1 thresholds (AC-10)', () => {
  const s = benchmarks.deriveTier([benchRow({ score: 65 })]);
  assert.equal(s.tier, 'S');
  assert.equal(s.score, 65);

  const a = benchmarks.deriveTier([benchRow({ score: 50 })]);
  assert.equal(a.tier, 'A');

  const aHigh = benchmarks.deriveTier([benchRow({ score: 64.999 })]);
  assert.equal(aHigh.tier, 'A');

  const b = benchmarks.deriveTier([benchRow({ score: 49.9 })]);
  assert.equal(b.tier, 'B');
  assert.equal(b.terminal_bench, 49.9);
});

test('another verified benchmark supports tier B at most (AC-10)', () => {
  const result = benchmarks.deriveTier([
    benchRow({ benchmark_key: 'swe_bench_verified', display_name: 'SWE-bench Verified', version: '1.0', score: 90 }),
  ]);
  assert.equal(result.tier, 'B');
  assert.equal(result.terminal_bench, null);
  assert.equal(result.benchmark_pending, false);
});

test('no verified benchmark is benchmark_pending and not ranked (AC-10)', () => {
  const result = benchmarks.deriveTier([]);
  assert.equal(result.tier, null);
  assert.equal(result.benchmark_pending, true);
});

// ── Search state bookkeeping (AC-7) ──────────────────────────────

test('searched models record a benchmark_searches row with metadata hash (AC-7)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  startScoutRun(ctx, 'run-search');

  scoutCycle(ctx, 'run-search', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [
      { model_id: 'acme/a:free', canonical_model_id: 'acme/a', benchmark_finds: [textFind()] },
    ]),
  });

  const database = db.openCollectorDb(ctx.options);
  try {
    const row = database.prepare(
      'SELECT * FROM benchmark_searches WHERE canonical_model_id = ?'
    ).get('acme/a');
    assert.ok(row, 'benchmark_searches row exists');
    assert.equal(row.result, 'found');
    assert.ok(row.metadata_hash);
  } finally {
    database.close();
  }
});
