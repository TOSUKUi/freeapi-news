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

const BULK_FIXTURE_20 = `
<h1>Terminal-Bench 2.0</h1><table><tbody>
<tr><td></td><td>1</td><td>Agent A</td><td>Acme Model</td><td>2026-08-01</td><td>Acme</td><td>Acme</td><td>61.5 % ± 1.0</td></tr>
</tbody></table>`;

const BULK_FIXTURE_21 = `
<h1>Terminal-Bench 2.1</h1><table><tbody>
<tr><td>1</td><td>Agent B</td><td>GPT-5.5</td><td>high</td><td>83.1% ± 1.1%</td><td>Aug 2, 2026</td><td>OpenAI</td><td>OpenAI</td><td>#1</td><td>0%</td><td>$10</td></tr>
</tbody></table>`;

test('bulk leaderboard parser fetches each official version once and matches queued models', async (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  const queue = {
    queued: 3,
    queue: [
      {
        canonical_model_id: 'openai/gpt-5.5',
        model_name: 'GPT-5.5',
        facts: { model_name: 'GPT-5.5' },
        offer_ids: [{ provider_key: 'openrouter', exact_model_id: 'openai/gpt-5.5:free' }],
        metadata_hash: 'a'.repeat(64),
      },
      {
        canonical_model_id: 'acme/acme-model',
        model_name: 'Acme Model',
        facts: { model_name: 'Acme Model' },
        offer_ids: [{ provider_key: 'openrouter', exact_model_id: 'acme/acme-model:free' }],
        metadata_hash: 'b'.repeat(64),
      },
      {
        canonical_model_id: 'unlisted/model',
        model_name: 'Unlisted Model',
        facts: { model_name: 'Unlisted Model' },
        offer_ids: [{ provider_key: 'openrouter', exact_model_id: 'unlisted/model:free' }],
        metadata_hash: 'c'.repeat(64),
      },
    ],
  };
  const result = await benchmarks.collectBulkBenchmarkFacts(queue, {
    ...ctx.options,
    now: '2026-08-09T00:00:00.000Z',
    fetchImpl: async (url) => ({
      status: 200,
      url,
      headers: { get: () => null },
      body: url.endsWith('/2.1') ? BULK_FIXTURE_21 : BULK_FIXTURE_20,
    }),
  });
  assert.equal(result.fetches.length, 2);
  assert.equal(result.fetches.filter((entry) => entry.ok).length, 2);
  assert.equal(result.rows.length, 2);
  assert.equal(result.accepted.length, 2);
  // A model absent from both official leaderboards is NOT a terminal
  // not_found: official vendor model cards publish scores the leaderboard
  // never lists, so the model routes to the targeted scout (unresolved)
  // instead of being recorded as not_found.
  assert.deepEqual(result.notFoundModels, []);
  assert.deepEqual(result.unresolved.map((entry) => entry.canonical_model_id), ['unlisted/model']);
  assert.deepEqual(result.changes.map((change) => change.canonical_model_id).sort(), [
    'acme/acme-model', 'openai/gpt-5.5',
  ]);
  assert.deepEqual(result.changes.map((change) => change.score).sort((a, b) => a - b), [61.5, 83.1]);
  assert.deepEqual(result.searchChanges.map((change) => change.result).sort(), ['found', 'found']);
  assert.equal(result.changes.every((change) => change.facts_json.origin === 'benchmark_bulk'), true);
});

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

test('the queue holds only current free models with no accepted benchmark fact (AC-7)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
    offerSeed({ exact_model_id: 'acme/b:free', canonical_model_id: 'acme/b' }),
    offerSeed({ exact_model_id: 'acme/c:free', canonical_model_id: 'acme/c', status: 'confirmed_removed' }),
    offerSeed({ exact_model_id: 'acme/d:free', canonical_model_id: 'acme/d' }),
    offerSeed({ exact_model_id: 'acme/supplemental:free', canonical_model_id: 'acme/supplemental' }),
  ]);
  // acme/a has the gate benchmark, acme/supplemental has usable non Terminal
  // information, and acme/c is removed.
  seedBenchmarks(ctx, [
    benchRow({ canonical_model_id: 'acme/a' }),
    benchRow({
      canonical_model_id: 'acme/supplemental',
      benchmark_key: 'mmlu_pro',
      display_name: 'MMLU Pro',
      version: '1',
      score: 82,
    }),
  ]);

  const queue = benchmarks.buildBenchmarkQueue(ctx.options);
  const queued = queue.queue.map((entry) => entry.canonical_model_id).sort();
  assert.deepEqual(queued, ['acme/b', 'acme/d']);
  assert.ok(!queued.includes('acme/a'), 'model with an accepted Terminal Bench gate row is not queued');
  assert.ok(!queued.includes('acme/supplemental'), 'a supplemental benchmark stops further search');
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
    'the existing Terminal Bench gate fact is reused instead of queued');
});

test('a completed found search is not repeated without a metadata change (AC-7)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);
  db.startRun('seed-search', [], ctx.options);
  db.finalizeRun('seed-search', {
    benchmarkSearches: [{
      canonical_model_id: 'acme/a',
      last_searched_at: '2026-07-30T00:00:00.000Z',
      result: 'found',
      metadata_hash: null,
    }],
    runStatus: 'promoted',
  }, ctx.options);

  assert.deepEqual(benchmarks.buildBenchmarkQueue(ctx.options).queue, [],
    'a found-but-unaccepted search must not burn tokens again every day');
  assert.deepEqual(
    benchmarks.buildBenchmarkQueue({ ...ctx.options, forceModelIds: ['acme/a'] })
      .queue.map((entry) => entry.canonical_model_id),
    ['acme/a'],
    'an operator can explicitly re-search a completed model'
  );

  db.startRun('seed-search-metadata-change', [], ctx.options);
  db.finalizeRun('seed-search-metadata-change', {
    benchmarkSearches: [{
      canonical_model_id: 'acme/a',
      last_searched_at: '2026-07-31T00:00:00.000Z',
      result: 'found',
      metadata_hash: 'stale-metadata',
    }],
    runStatus: 'promoted',
  }, ctx.options);
  assert.deepEqual(
    benchmarks.buildBenchmarkQueue(ctx.options).queue.map((entry) => entry.canonical_model_id),
    ['acme/a'],
    'a changed model metadata reopens a prior found search'
  );
});

test('hidden offers are not added to the benchmark research queue', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'acme/visible:free', canonical_model_id: 'acme/visible' }),
    offerSeed({ exact_model_id: 'acme/hidden:free', canonical_model_id: 'acme/hidden' }),
  ]);
  db.setOfferHidden('openrouter', 'acme/hidden:free', true, ctx.options);
  const queue = benchmarks.buildBenchmarkQueue(ctx.options);
  assert.deepEqual(queue.queue.map((entry) => entry.canonical_model_id), ['acme/visible']);
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

test('failed scout workers remain retryable instead of becoming not_found (AC-7)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);
  startScoutRun(ctx, 'run-failed-scout');

  const { reduce } = scoutCycle(ctx, 'run-failed-scout', {
    'benchmark_scout:chunk-0': scoutArtifact('benchmark_scout:chunk-0', [], {
      status: 'failed',
      errors: ['worker did not produce conforming output'],
    }),
  });
  assert.deepEqual(reduce.searchChanges, []);
  assert.deepEqual(benchmarks.buildBenchmarkQueue(ctx.options).queue.map((entry) => entry.canonical_model_id), ['acme/a']);
});

test('old models leave the routine queue while unknown release dates remain eligible (AC-7)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({
      exact_model_id: 'acme/old:free', canonical_model_id: 'acme/old',
      facts_json: { model_name: 'Old', release_date: '2025-12-31' },
    }),
    offerSeed({
      exact_model_id: 'acme/recent:free', canonical_model_id: 'acme/recent',
      facts_json: { model_name: 'Recent', release_date: '2026-03-01' },
    }),
    offerSeed({
      exact_model_id: 'acme/unknown:free', canonical_model_id: 'acme/unknown',
      facts_json: { model_name: 'Unknown', release_date: null },
    }),
  ]);

  const queue = benchmarks.buildBenchmarkQueue({
    ...ctx.options,
    now: '2026-08-02T00:00:00.000Z',
  });
  assert.deepEqual(queue.queue.map((entry) => entry.canonical_model_id).sort(), ['acme/recent', 'acme/unknown']);

  const forcedModel = benchmarks.buildBenchmarkQueue({
    ...ctx.options,
    now: '2026-08-02T00:00:00.000Z',
    forceModelIds: ['acme/old'],
  });
  assert.ok(forcedModel.queue.some((entry) => entry.canonical_model_id === 'acme/old'));

  const forcedBenchmark = benchmarks.buildBenchmarkQueue({
    ...ctx.options,
    now: '2026-08-02T00:00:00.000Z',
    forceBenchmarkKeys: ['terminal_bench_2_1'],
  });
  assert.deepEqual(forcedBenchmark.queue.map((entry) => entry.canonical_model_id).sort(),
    ['acme/old', 'acme/recent', 'acme/unknown']);
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

test('recent not_found models are not requeued, old not_found reopens after TTL (AC-7)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'acme/old:free', canonical_model_id: 'acme/old', first_seen_at: '2026-01-01T00:00:00.000Z' }),
    offerSeed({ exact_model_id: 'acme/recent:free', canonical_model_id: 'acme/recent', first_seen_at: '2026-07-01T00:00:00.000Z' }),
    offerSeed({ exact_model_id: 'acme/expired:free', canonical_model_id: 'acme/expired', first_seen_at: '2026-07-01T00:00:00.000Z' }),
  ]);
  const now = '2026-08-22T00:00:00.000Z';
  const daysAgo = (d) => new Date(Date.parse(now) - d * 86400000).toISOString();
  // acme/old: not_found 100 days ago (outside TTL) -> requeued
  // acme/recent: not_found 1 day ago (inside TTL) -> not requeued
  // acme/expired: not_found 15 days ago (outside TTL) -> requeued
  db.startRun('search-seed', [], ctx.options);
  db.finalizeRun('search-seed', {
    benchmarkSearches: [
      { canonical_model_id: 'acme/old', last_searched_at: daysAgo(100), result: 'not_found', metadata_hash: 'a'.repeat(64) },
      { canonical_model_id: 'acme/recent', last_searched_at: daysAgo(1), result: 'not_found', metadata_hash: 'b'.repeat(64) },
      { canonical_model_id: 'acme/expired', last_searched_at: daysAgo(15), result: 'not_found', metadata_hash: 'c'.repeat(64) },
    ],
    runStatus: 'promoted',
  }, ctx.options);

  const queue = benchmarks.buildBenchmarkQueue({ ...ctx.options, now });
  const queued = queue.queue.map((entry) => entry.canonical_model_id).sort();
  assert.deepEqual(queued, ['acme/expired', 'acme/old'],
    'not_found inside the TTL window stays excluded; older not_found reopens');
  assert.ok(!queue.queue.some((entry) => entry.canonical_model_id === 'acme/recent'),
    'a not_found search inside the TTL window is terminal until the window passes');
});

// ── Proposal validation (AC-8, AC-9) ─────────────────────────────

test('unknown and malformed Terminal Bench versions stay pending (AC-8, AC-9)', () => {
  for (const version of ['unknown', 'n/a', 'none', 'undefined']) {
    const shape = benchmarks.validateProposalShape({
      ...textFind(), display_name: 'Terminal-Bench 2.1', version,
    });
    assert.equal(shape.ok, false, `Terminal Bench version ${JSON.stringify(version)}`);
    assert.match(shape.reason, /version|unknown/i);
  }

  for (const version of [2.1, 0, false, {}, []]) {
    const shape = benchmarks.validateProposalShape({ ...textFind(), version });
    assert.equal(shape.ok, false, `malformed version ${JSON.stringify(version)}`);
    assert.match(shape.reason, /version.*string/i);
  }
});

test('benchmark versions are optional for supplemental metrics but not Terminal Bench (AC-8, AC-9)', () => {
  const shape = benchmarks.validateProposalShape({
    ...textFind(),
    display_name: 'MMLU Pro',
    version: null,
    score: 82,
    body: 'MMLU Pro: acme/a scored 82 percent.',
  });
  assert.equal(shape.ok, true);
  assert.equal(shape.version, '');

  assert.equal(
    benchmarks.bodyConfirmsBenchmark('MMLU Pro: acme/a scored 82', {
      key: 'mmlu_pro', displayName: 'MMLU Pro', version: '',
    }),
    true,
    'a supplemental metric without a published version still supplies useful evidence'
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
    display_name: 'Terminal-Bench 2.1',
    version: 'unknown',
    score: 40,
    source_url: 'https://leaderboard.example/terminal-bench',
    body: 'Terminal-Bench 2.1: acme/a scored 40.0 percent.',
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

test('DeepSeek score is accepted only from the fetched full Hugging Face body (AC-9)', async () => {
  const sourceUrl = 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash-0731';
  const find = textFind({
    model_id: 'deepseek-ai/DeepSeek-V4-Flash-0731:free',
    score: 82.7,
    source_url: sourceUrl,
    body: undefined,
    body_excerpt: 'Terminal Bench 2.1 82.7 ...',
  });
  const supplementalFind = textFind({
    model_id: 'deepseek-ai/DeepSeek-V4-Flash-0731:free',
    display_name: 'SWE-bench Verified',
    version: '1.0',
    score: 74.3,
    source_url: sourceUrl,
    body: undefined,
    body_excerpt: 'SWE-bench Verified 1.0 74.3 ...',
  });
  const model = {
    canonical_model_id: 'deepseek-ai/DeepSeek-V4-Flash-0731',
    model_ids: ['deepseek-ai/DeepSeek-V4-Flash-0731:free'],
  };
  const artifact = scoutArtifact('benchmark_scout:chunk-0', [{
    model_id: 'deepseek-ai/DeepSeek-V4-Flash-0731:free',
    canonical_model_id: model.canonical_model_id,
    benchmark_finds: [find, supplementalFind],
  }]);
  const fullBody = 'DeepSeek-V4-Flash-0731\nTerminal-Bench 2.1\nscore: 82.7\nSWE-bench Verified 1.0: 74.3';
  const fetched = await benchmarks.fetchBenchmarkSourceBodies([{
    kind: 'benchmark_scout', result_json: artifact,
  }], {
    fetchImpl: async (url) => ({ status: 200, url, body: fullBody }),
  });
  const accepted = benchmarks.evaluateProposal(find, model, {
    requireFetchedEvidence: true,
    sourceBodies: fetched.sourceBodies,
    sourceHashes: fetched.sourceHashes,
  });
  assert.equal(accepted.accepted, true,
    'the official full body supplies the model name missing from the artifact excerpt');
  assert.equal(accepted.change.source_hash, fetched.sourceHashes.get(sourceUrl),
    'the persisted source hash comes from the fetched body, not the worker claim');
  const supplemental = benchmarks.evaluateProposal(supplementalFind, model, {
    requireFetchedEvidence: true,
    sourceBodies: fetched.sourceBodies,
  });
  assert.equal(supplemental.accepted, true,
    'the same fetched model card also accepts a supplemental benchmark row');
  assert.notEqual(supplemental.change, undefined);
  const supplementalWithoutFetchedBody = benchmarks.evaluateProposal(supplementalFind, model, {
    requireFetchedEvidence: true,
    sourceBodies: new Map(),
  });
  assert.equal(supplementalWithoutFetchedBody.accepted, false,
    'supplemental rows also require the fetched full body');

  const withoutFetchedBody = benchmarks.evaluateProposal(find, model, {
    requireFetchedEvidence: true,
    sourceBodies: new Map(),
  });
  assert.equal(withoutFetchedBody.accepted, false,
    'the excerpt alone must not be accepted when production evidence is required');
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

test('an accepted supplemental benchmark stops further search and remains immutable (AC-7, AC-8)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' })]);
  seedBenchmarks(ctx, [benchRow({
    canonical_model_id: 'acme/a',
    benchmark_key: 'swe_bench_verified',
    display_name: 'SWE-bench Verified',
    version: '',
    score: 55,
  })]);

  const queue = benchmarks.buildBenchmarkQueue(ctx.options);
  assert.deepEqual(queue.queue, [], 'a model with another accepted benchmark is not searched again');

  db.startRun('run-overwrite', [], ctx.options);
  db.finalizeRun('run-overwrite', {
    benchmarks: [benchRow({
      canonical_model_id: 'acme/a',
      benchmark_key: 'swe_bench_verified',
      display_name: 'SWE-bench Verified',
      version: '',
      score: 95,
    })],
    runStatus: 'promoted',
  }, ctx.options);

  const rows = benchmarkRowsFor(ctx, 'acme/a');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 55, 'existing score is preserved');
});

// ── Tier derivation (AC-10) ──────────────────────────────────────

test('tier derives from either Terminal Bench gate version thresholds (AC-10)', () => {
  const s = benchmarks.deriveTier([benchRow({ score: 65 })]);
  assert.equal(s.tier, 'S');
  assert.equal(s.score, 65);

  const a = benchmarks.deriveTier([benchRow({ score: 50 })]);
  assert.equal(a.tier, 'A');

  const aHigh = benchmarks.deriveTier([benchRow({ score: 64.999 })]);
  assert.equal(aHigh.tier, 'A');

  const b = benchmarks.deriveTier([benchRow({ score: 49.9 })]);
  assert.equal(b.tier, null, 'below 50 is benchmark_pending and never ranks (AC-5)');
  assert.equal(b.benchmark_pending, true);
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

// ── Spec 0004 dual Terminal Bench versions (AC-5, AC-6) ─────────

test('terminal_bench_2_0 also admits; 2.1 is representative when both exist (AC-5)', () => {
  const only20 = benchmarks.deriveTier([benchRow({
    benchmark_key: 'terminal_bench_2_0', display_name: 'Terminal-Bench 2.0', version: '2.0', score: 52,
  })]);
  assert.equal(only20.tier, 'A');
  assert.equal(only20.benchmark_key, 'terminal_bench_2_0');
  assert.equal(only20.version, '2.0');

  const both = benchmarks.deriveTier([
    benchRow({ benchmark_key: 'terminal_bench_2_0', display_name: 'Terminal-Bench 2.0', version: '2.0', score: 80 }),
    benchRow({ benchmark_key: 'terminal_bench_2_1', display_name: 'Terminal-Bench 2.1', version: '2.1', score: 55 }),
  ]);
  assert.equal(both.benchmark_key, 'terminal_bench_2_1', '2.1 is the representative row');
  assert.equal(both.score, 55);
  assert.equal(both.version, '2.1');
});

test('a 49.999 score on 2.0 fails admission (AC-5 threshold)', () => {
  const result = benchmarks.deriveTier([benchRow({
    benchmark_key: 'terminal_bench_2_0', display_name: 'Terminal-Bench 2.0', version: '2.0', score: 49.999,
  })]);
  assert.equal(result.tier, null, 'below 50 is benchmark_pending, never a rankable tier (AC-5)');
  assert.equal(result.benchmark_pending, true);
});

test('the display name variant maps to terminal_bench_2_0 (AC-5 identity)', () => {
  assert.equal(db.benchmarkKey('Terminal-Bench 2.0'), 'terminal_bench_2_0');
  assert.equal(db.benchmarkKey('Terminal Bench 2.0'), 'terminal_bench_2_0');
  assert.equal(db.benchmarkVersion('Terminal-Bench 2.0'), '2.0');
});

test('a model with an accepted 2.0 row already satisfies the current gate', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'acme/has20:free', canonical_model_id: 'acme/has20' }),
  ]);
  seedBenchmarks(ctx, [benchRow({
    canonical_model_id: 'acme/has20',
    benchmark_key: 'terminal_bench_2_0',
    display_name: 'Terminal-Bench 2.0',
    version: '2.0',
    score: 55,
  })]);
  // Any accepted 2.0 or 2.1 row satisfies admission (AC-5), so the model is not queued.
  const queue = benchmarks.buildBenchmarkQueue(ctx.options);
  assert.deepEqual(queue.queue.map((entry) => entry.canonical_model_id), []);
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

test('one-model progress tasks still record found and not_found search changes', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
    offerSeed({ exact_model_id: 'acme/b:free', canonical_model_id: 'acme/b' }),
  ]);
  const queue = benchmarks.buildBenchmarkQueue(ctx.options);
  const taskFor = (entry, index) => ({
    task_id: `benchmark_scout:model-${index + 1}-${entry.canonical_model_id.replace('/', '-')}`,
    kind: 'benchmark_scout',
    assigned_model_ids: entry.offer_ids.map((id) => id.exact_model_id),
  });
  const tasks = queue.queue.map(taskFor);
  db.startRun('run-model-progress-search', tasks, ctx.options);
  const runDir = path.join(ctx.stateDir, 'crawl', 'run-model-progress-search');
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(db.artifactPathFor(runDir, tasks[0].task_id), JSON.stringify(
    scoutArtifact(tasks[0].task_id, [{
      model_id: 'acme/a:free', canonical_model_id: 'acme/a', benchmark_finds: [textFind()],
    }])
  ));
  fs.writeFileSync(db.artifactPathFor(runDir, tasks[1].task_id), JSON.stringify(
    scoutArtifact(tasks[1].task_id, [])
  ));
  require('./lanes').ingestTaskArtifacts('run-model-progress-search', runDir, ctx.options);
  const reduced = benchmarks.reduceBenchmarkTasks('run-model-progress-search', runDir, {
    ...ctx.options,
    requireFetchedEvidence: true,
    sourceBodies: new Map([[
      'https://leaderboard.example/terminal-bench',
      'Terminal-Bench 2.1 leaderboard: acme/a scored 72.0 percent.',
    ]]),
  });
  assert.deepEqual(
    reduced.searchChanges.map((row) => [row.canonical_model_id, row.result]).sort(),
    [['acme/a', 'found'], ['acme/b', 'not_found']]
  );
});
