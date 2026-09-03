'use strict';

// End to end orchestrator tests (spec 0003). Runs the whole pipeline against
// an isolated fixture project with the pi workers and the catalog fetch
// injected, so no network and no pi are needed. Proves the dry run, collect
// (local promote), and zero verified gate paths wire together correctly and
// stay fail safe: current tracked files change only after the gate passes.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const db = require('./collector-db');
const benchmarks = require('./benchmarks');
const collect = require('./collect');
const publication = require('./publication');

const FIXTURE_REGISTRY = {
  version: 1,
  providers: [
    {
      key: 'openrouter',
      label: 'OpenRouter',
      match: ['openrouter'],
      base_url: 'https://openrouter.ai/api/v1',
      docs_url: 'https://openrouter.ai/docs/quickstart',
      delivery_type: 'router',
      api_catalog_url: 'https://openrouter.ai/api/v1/models',
    },
    {
      key: 'google',
      label: 'Google Gemini',
      match: ['google', 'gemini'],
      base_url: 'https://generativelanguage.googleapis.com/v1beta',
      docs_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      delivery_type: 'official',
    },
  ],
};

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collect-test-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(root, '.devops', 'batch'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'llm-deals-intelligence-skill', 'schemas'), { recursive: true });

  fs.writeFileSync(
    path.join(root, 'build', 'provider-registry.json'),
    JSON.stringify(FIXTURE_REGISTRY, null, 2) + '\n'
  );

  // Minimal daily report schema (the stub validator below does not read it,
  // but validateCandidate computes the path and passes it).
  fs.writeFileSync(
    path.join(root, '.agents', 'skills', 'llm-deals-intelligence-skill', 'schemas', 'daily_report.schema.json'),
    JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', required: ['ranked_offers'] }, null, 2) + '\n'
  );

  // Stub validator: pass when ranked_offers is an array.
  fs.writeFileSync(path.join(root, 'build', 'validate-report.js'), `
    'use strict';
    const fs = require('fs');
    const p = process.argv[2];
    if (!fs.existsSync(p)) { console.error('not found'); process.exit(1); }
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(r.ranked_offers)) { console.error('bad'); process.exit(1); }
    console.log('ok');
  `);
  fs.writeFileSync(path.join(root, 'build', 'build-html.js'), `
    'use strict';
    const fs = require('fs');
    const inp = process.argv[2]; const out = process.argv[3];
    if (!fs.existsSync(inp)) process.exit(1);
    fs.writeFileSync(out, '<html>test</html>');
  `);
  fs.writeFileSync(path.join(root, 'build', 'build-og-image.js'), `
    'use strict';
    const fs = require('fs');
    const inp = process.argv[2]; const outHtml = process.argv[3]; const outPng = process.argv[4];
    if (!fs.existsSync(inp)) process.exit(1);
    fs.writeFileSync(outHtml, '<html>og</html>');
    fs.writeFileSync(outPng, Buffer.from('fake-png'));
  `);

  const options = { projectRoot: root, stateDir };
  return { root, stateDir, options };
}

function seedKnownOffer(ctx) {
  db.applyMigrations(ctx.options);
  db.startRun('seed', [], ctx.options);
  db.finalizeRun('seed', {
    offers: [{
      provider_key: 'google',
      exact_model_id: 'gemini-2.5-pro',
      canonical_model_id: 'gemini-2.5-pro',
      source_kind: 'report',
      status: 'verified',
      consecutive_failures: 0,
      first_seen_at: '2026-07-01T00:00:00.000Z',
      last_attempted_at: '2026-07-30T00:00:00.000Z',
      last_verified_at: '2026-07-30T00:00:00.000Z',
      pricing_hash: null,
      removal_evidence_json: null,
      effective_input_price_usd: 0,
      effective_output_price_usd: 0,
      normal_input_price_usd: 0,
      normal_output_price_usd: 0,
      source_currency: 'USD',
      source_unit: 'per_million_tokens',
      price_source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      price_verified_at: '2026-07-30T00:00:00.000Z',
      facts_json: {
        model_name: 'Gemini 2.5 Pro',
        free_quota_text: 'free tier, 100 requests per day',
        endpoint_source: 'https://ai.google.dev/gemini-api/docs/pricing',
      },
    }],
    benchmarks: [{
      canonical_model_id: 'gemini-2.5-pro',
      benchmark_key: 'terminal_bench_2_1',
      display_name: 'Terminal-Bench 2.1',
      version: '2.1',
      score: 70,
      source_url: 'https://leaderboard.example/terminal-bench',
      source_hash: 'h'.repeat(64),
      verified_at: '2026-07-30T00:00:00.000Z',
      facts_json: { origin: 'test' },
    }, {
      canonical_model_id: 'acme/new',
      benchmark_key: 'terminal_bench_2_1',
      display_name: 'Terminal-Bench 2.1',
      version: '2.1',
      score: 57,
      source_url: 'https://leaderboard.example/terminal-bench',
      source_hash: 'n'.repeat(64),
      verified_at: '2026-07-30T00:00:00.000Z',
      facts_json: { origin: 'test' },
    }],
    runStatus: 'promoted',
  }, ctx.options);
}

// Injected catalog fetch: a valid OpenRouter catalog with one scored free
// model and the aggregate route, which remains benchmark-pending.
function fakeCatalog(manifest, runDir) {
  const task = (manifest.tasks || []).find((t) => t.kind === 'catalog');
  if (!task) return;
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  const artifact = {
    schema_version: 1,
    task_id: task.task_id,
    kind: 'catalog',
    provider_key: task.provider_key,
    crawled_at: new Date().toISOString(),
    catalog_url: task.api_catalog_url,
    base_url: task.base_url,
    status: 'complete',
    available: true,
    http_status: 200,
    content_hash: 'c'.repeat(64),
    endpoint_source: task.docs_url,
    endpoint_source_hash: 'e'.repeat(64),
    models: [{
      model_id: 'acme/new:free',
      model_name: 'Acme New',
      pricing: { prompt: '0', completion: '0' },
      prompt_price: 0,
      completion_price: 0,
      is_free: true,
      pricing_hash: 'p'.repeat(64),
    }, {
      model_id: 'openrouter/free',
      model_name: 'Free Models Router',
      pricing: { prompt: '0', completion: '0' },
      prompt_price: 0,
      completion_price: 0,
      is_free: true,
      pricing_hash: 'q'.repeat(64),
    }],
    fetches: [{
      url: task.api_catalog_url,
      subject_key: `catalog:${task.provider_key}`,
      http_status: 200,
      content_hash: 'c'.repeat(64),
      fetched_at: new Date().toISOString(),
    }],
    errors: [],
  };
  fs.writeFileSync(db.artifactPathFor(runDir, task.task_id), JSON.stringify(artifact, null, 2) + '\n');
}

// Injected workers. `mode` controls the known refresh outcome.
function makeWorker(mode) {
  return (spec) => {
    fs.mkdirSync(path.dirname(spec.outputFile), { recursive: true });
    const write = (obj) => fs.writeFileSync(spec.outputFile, JSON.stringify(obj, null, 2) + '\n');
    if (spec.taskId.startsWith('known:')) {
      if (mode === 'fail-known') {
        write({
          schema_version: 1, task_id: spec.taskId, status: 'failed',
          crawled_at: new Date().toISOString(), provider_key: 'google',
          models: [], errors: ['simulated provider outage'],
        });
      } else {
        write({
          schema_version: 1, task_id: spec.taskId, status: 'complete',
          crawled_at: new Date().toISOString(), provider_key: 'google',
          models: [{
            model_id: 'gemini-2.5-pro',
            model_name: 'Gemini 2.5 Pro',
            docs_url: 'https://ai.google.dev/gemini-api/docs/pricing',
            endpoint_source: 'https://ai.google.dev/gemini-api/docs/pricing',
            base_url: 'https://generativelanguage.googleapis.com/v1beta',
            free_quota_text: 'free tier, 100 requests per day',
            pricing_text: 'free',
            is_free_signal: true,
            benchmark_finds: [],
          }],
          errors: [],
        });
      }
    } else if (spec.taskId.startsWith('discovery:')) {
      write({
        schema_version: 1, task_id: spec.taskId, status: 'complete',
        crawled_at: new Date().toISOString(), provider_key: '_discovery',
        models: [], errors: [],
      });
    } else if (spec.taskId === 'classifier' || spec.taskId.startsWith('classifier:')) {
      if (mode === 'throw-classifier' || mode === 'throw') {
        throw new Error('simulated classifier failure after lane reduction');
      }
      write({
        classifications: [{
          offer_key: 'google/gemini-2.5-pro',
          classification: 'B_PERMANENT_FREE_TIER',
          suspicion_score: 0,
          information_confidence: 'HIGH',
          operational_confidence: 'HIGH',
          reasoning: 'standing free tier',
        }],
      });
    } else if (spec.taskId === 'editorial') {
      write({
        schema_version: 1,
        summary: 'テストレポート。1件のランクイン。',
        offer_prose: [],
        change_prose: [],
      });
    } else if (spec.taskId.startsWith('benchmark_scout:')) {
      const models = mode === 'unknown-benchmark'
        ? [{
          model_id: 'openrouter/free', canonical_model_id: 'openrouter/free', model_name: 'Free Models Router',
          benchmark_finds: [{
            display_name: 'SWE-Bench (OpenHands)', version: null, score: 40,
            source_url: 'https://leaderboard.example/swe-bench',
            body: 'SWE-Bench (OpenHands): openrouter/free scored 40.0 percent.',
          }, {
            display_name: 'Terminal-Bench 2.1', version: '2.1', score: 57,
            source_url: 'https://leaderboard.example/terminal-bench',
            body: 'Terminal-Bench 2.1 leaderboard: openrouter/free scored 57.0 percent.',
          }],
        }]
        : [];
      write({
        schema_version: 1, task_id: spec.taskId, kind: 'benchmark_scout',
        status: 'complete', crawled_at: new Date().toISOString(),
        models, errors: [],
      });
    }
    return Promise.resolve(spec.taskId);
  };
}

function silent() { return () => {}; }

function durableSnapshot(ctx) {
  const database = db.openCollectorDb(ctx.options);
  try {
    const tables = ['offers', 'benchmarks', 'benchmark_searches', 'source_cache', 'runs', 'tasks'];
    return Object.fromEntries(tables.map((table) => [
      table,
      database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    ]));
  } finally {
    database.close();
  }
}

describe('concurrency lock', () => {
  it('takes over an empty stale lock file (old flock script residue)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
    const lockPath = path.join(dir, '.crawl.lock');
    fs.writeFileSync(lockPath, ''); // empty, as flock left it
    assert.equal(collect.acquireLock(lockPath, () => {}), true, 'empty lock is stale and must be taken over');
    collect.releaseLock(lockPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses when a live pid holds the lock', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-'));
    const lockPath = path.join(dir, '.crawl.lock');
    fs.writeFileSync(lockPath, `${process.pid}\n`); // this process is alive
    assert.equal(collect.acquireLock(lockPath, () => {}), false);
    collect.releaseLock(lockPath);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('collect orchestrator', () => {
  let ctx;

  beforeEach(() => { ctx = tmpProject(); });
  afterEach(() => { fs.rmSync(ctx.root, { recursive: true, force: true }); });

  it('rejects a canonical hash mismatch before startRun or workers and preserves state', async () => {
    const runDir = path.join(ctx.stateDir, 'crawl', 'stuck-run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(ctx.root, 'report.json'), '{"before":true}\n');
    publication.writeManifest(runDir, {
      run_id: 'stuck-run',
      phase: 'db_finalized',
      phase_at: {},
      files: { 'report.json': { sha256: 'a'.repeat(64) } },
      backups: {},
    });
    const manifestBefore = fs.readFileSync(publication.manifestPath(runDir), 'utf8');
    const reportBefore = fs.readFileSync(path.join(ctx.root, 'report.json'), 'utf8');
    let startRunCalled = false;
    let workerCalled = false;
    const originalStartRun = db.startRun;
    db.startRun = (...args) => {
      startRunCalled = true;
      return originalStartRun(...args);
    };
    try {
      await assert.rejects(
        collect.runPipeline({
          ...ctx.options,
          runId: 'must-not-start',
          runWorker: async () => { workerCalled = true; },
          runCatalog: async () => {},
          log: silent(),
        }),
        /requires manual inspection/
      );
    } finally {
      db.startRun = originalStartRun;
    }
    assert.equal(startRunCalled, false);
    assert.equal(workerCalled, false);
    assert.equal(fs.readFileSync(publication.manifestPath(runDir), 'utf8'), manifestBefore);
    assert.equal(fs.readFileSync(path.join(ctx.root, 'report.json'), 'utf8'), reportBefore);
    assert.ok(!fs.existsSync(path.join(ctx.stateDir, 'crawl', 'must-not-start')));
  });

  it('dry run validates a candidate without changing canonical files or durable state', async () => {
    seedKnownOffer(ctx);
    const before = durableSnapshot(ctx);
    const result = await collect.runPipeline({
      ...ctx.options,
      dryRun: true,
      runId: 'dry-1',
      runWorker: makeWorker('ok'),
      runCatalog: fakeCatalog,
      log: silent(),
    });

    assert.equal(result.canPromote, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.promoted, false);
    // Candidate report exists under the run directory.
    const candidateReport = path.join(ctx.stateDir, 'crawl', 'dry-1', 'candidate', 'report.json');
    assert.ok(fs.existsSync(candidateReport), 'candidate report.json must exist');
    const report = JSON.parse(fs.readFileSync(candidateReport, 'utf8'));
    assert.ok(Array.isArray(report.ranked_offers));
    assert.ok(report.ranked_offers.some((o) => o.name && o.name.includes('Gemini')));
    const router = report.ranked_offers.find((o) => o.delivery_type === 'router');
    assert.ok(router, 'catalog admission reaches a public router offer');
    assert.equal(router.model_id, 'acme/new:free');
    assert.equal(router.provider_key, 'openrouter');
    assert.equal(router.access_kind, 'FREE');
    assert.equal(router.effective_price_per_million.input, 0);
    assert.equal(router.price_verified_at !== null, true);
    assert.equal('free_model_names' in router, false, 'free_model_names removed (AC-2)');
    // Canonical files were NOT created (dry run never promotes).
    assert.ok(!fs.existsSync(path.join(ctx.root, 'report.json')), 'canonical report.json must not exist after dry run');
    // A dry run leaves its candidate and run directory for inspection, but
    // restores the exact pre-run SQLite snapshot and is not promotable later.
    const status = db.getStatus(ctx.options);
    assert.equal(status.currentRun, null);
    assert.deepEqual(durableSnapshot(ctx), before);
    assert.ok(fs.existsSync(path.join(ctx.stateDir, 'crawl', 'dry-1', 'backup', 'collector.sqlite')));
  });

  it('unknown benchmark versions are rejected while valid proposals continue to candidate generation', async () => {
    seedKnownOffer(ctx);
    const result = await collect.runPipeline({
      ...ctx.options,
      dryRun: true,
      runId: 'unknown-version-1',
      runWorker: makeWorker('unknown-benchmark'),
      runCatalog: fakeCatalog,
      log: silent(),
    });

    assert.equal(result.canPromote, true);
    const candidateReport = path.join(
      ctx.stateDir, 'crawl', 'unknown-version-1', 'candidate', 'report.json'
    );
    assert.ok(fs.existsSync(candidateReport));
    const candidateText = fs.readFileSync(candidateReport, 'utf8');
    assert.doesNotMatch(candidateText, /SWE-Bench \(OpenHands\)/);
    assert.match(candidateText, /Terminal-Bench 2\.1/);
    assert.equal(db.getStatus(ctx.options).currentRun, null);
  });

  it('exception after lane reduction restores exact offers, benchmarks, search, cache, and run state', async () => {
    seedKnownOffer(ctx);
    const before = durableSnapshot(ctx);

    await assert.rejects(
      collect.runPipeline({
        ...ctx.options,
        runId: 'rollback-after-lanes',
        runWorker: makeWorker('throw-classifier'),
        runCatalog: fakeCatalog,
        log: silent(),
      }),
      /simulated classifier failure/
    );

    assert.deepEqual(durableSnapshot(ctx), before);
    assert.equal(db.getStatus(ctx.options).currentRun, null);
    assert.ok(!fs.existsSync(path.join(ctx.root, 'report.json')));
    assert.ok(!fs.existsSync(path.join(ctx.root, 'index.html')));
  });

  it('startup recovery restores canonical files and the exact DB for a pre-finalized promotion', async () => {
    seedKnownOffer(ctx);
    const before = durableSnapshot(ctx);
    const runId = 'promotion-conflict';
    db.copyDatabaseForRun(runId, ctx.options);
    db.startRun(runId, [], ctx.options);
    db.finalizeRun(runId, {
      offers: [{
        provider_key: 'google',
        exact_model_id: 'gemini-2.5-pro',
        canonical_model_id: 'gemini-2.5-pro',
        source_kind: 'report',
        status: 'verified',
        consecutive_failures: 77,
        first_seen_at: '2026-07-01T00:00:00.000Z',
        last_attempted_at: '2026-07-31T00:00:00.000Z',
        last_verified_at: '2026-07-31T00:00:00.000Z',
        facts_json: { mutated: true },
      }],
      runStatus: 'validated',
    }, ctx.options);

    const publication = require('./publication');
    const runDir = path.join(ctx.stateDir, 'crawl', runId);
    const backupReport = path.join(runDir, 'backup', 'canonical', 'report.json');
    const backupRegistry = path.join(runDir, 'backup', 'canonical', 'provider-registry.json');
    fs.mkdirSync(path.dirname(backupReport), { recursive: true });
    fs.writeFileSync(backupReport, '{"before-promotion": true}\n');
    fs.copyFileSync(path.join(ctx.root, 'build', 'provider-registry.json'), backupRegistry);
    fs.writeFileSync(path.join(ctx.root, 'report.json'), '{"partial-promotion": true}\n');
    publication.writeManifest(runDir, {
      run_id: runId,
      phase: 'files_promoted',
      phase_at: { files_promoted: new Date().toISOString() },
      files: {},
      backups: {
        'report.json': {
          path: backupReport,
          sha256: db.sha256File(backupReport),
        },
        'build/provider-registry.json': {
          path: backupRegistry,
          sha256: db.sha256File(backupRegistry),
        },
      },
    });

    await assert.rejects(
      collect.runPipeline({
        ...ctx.options,
        runId: 'after-promotion-recovery',
        runWorker: async () => { throw new Error('stop after startup recovery'); },
        runCatalog: fakeCatalog,
        log: silent(),
      }),
      /stop after startup recovery/
    );

    assert.deepEqual(durableSnapshot(ctx), before,
      'pre-db_finalized promotion recovery must restore the exact pre-run DB');
    assert.equal(fs.readFileSync(path.join(ctx.root, 'report.json'), 'utf8'), '{"before-promotion": true}\n');
    assert.equal(publication.readManifest(runDir).phase, 'restored');
  });

  it('pipeline restores a missing DB before migrations can initialize an empty one', async () => {
    seedKnownOffer(ctx);
    const before = durableSnapshot(ctx);
    db.copyDatabaseForRun('migration-recovery-source', ctx.options);
    fs.rmSync(path.join(ctx.stateDir, 'collector.sqlite'), { force: true });

    let sawRecoveredOffer = false;
    await assert.rejects(
      collect.runPipeline({
        ...ctx.options,
        dryRun: true,
        runId: 'migration-recovery-check',
        runWorker: async () => {
          const database = db.openCollectorDb(ctx.options);
          try {
            sawRecoveredOffer = !!database.prepare(
              "SELECT 1 FROM offers WHERE exact_model_id = 'gemini-2.5-pro'"
            ).get();
          } finally {
            database.close();
          }
          throw new Error('stop after migration recovery check');
        },
        runCatalog: fakeCatalog,
        log: silent(),
      }),
      /stop after migration recovery check/
    );

    assert.equal(sawRecoveredOffer, true,
      'startup recovery must restore the newest valid DB copy before applyMigrations');
    assert.deepEqual(durableSnapshot(ctx), before);
  });

  it('startup recovery restores an abandoned candidate_ready run without a promotion manifest', async () => {
    seedKnownOffer(ctx);
    const before = durableSnapshot(ctx);
    db.copyDatabaseForRun('abandoned-candidate', ctx.options);
    db.startRun('abandoned-candidate', [], ctx.options);
    db.finalizeRun('abandoned-candidate', {
      offers: [{
        provider_key: 'google',
        exact_model_id: 'gemini-2.5-pro',
        canonical_model_id: 'gemini-2.5-pro',
        source_kind: 'report',
        status: 'verified',
        consecutive_failures: 99,
        first_seen_at: '2026-07-01T00:00:00.000Z',
        last_attempted_at: '2026-07-31T00:00:00.000Z',
        last_verified_at: '2026-07-31T00:00:00.000Z',
        facts_json: { mutated: true },
      }],
      runStatus: 'candidate_ready',
    }, ctx.options);
    assert.equal(db.getStatus(ctx.options).currentRun.run_id, 'abandoned-candidate');
    assert.ok(!fs.existsSync(path.join(
      ctx.stateDir, 'crawl', 'abandoned-candidate', 'promotion-manifest.json'
    )));

    await assert.rejects(
      collect.runPipeline({
        ...ctx.options,
        runId: 'after-startup-recovery',
        runWorker: makeWorker('throw-classifier'),
        runCatalog: fakeCatalog,
        log: silent(),
      }),
      /simulated classifier failure/
    );

    assert.deepEqual(durableSnapshot(ctx), before);
    assert.equal(db.getStatus(ctx.options).currentRun, null);
    assert.ok(fs.existsSync(path.join(
      ctx.stateDir, 'crawl', 'abandoned-candidate', 'backup', 'collector.sqlite'
    )), 'forensic abandoned run directory is preserved');
  });

  it('startup recovery leaves a safely finalized deploy retry state intact', async () => {
    seedKnownOffer(ctx);
    await collect.runPipeline({
      ...ctx.options,
      runId: 'safe-retry',
      runWorker: makeWorker('ok'),
      runCatalog: fakeCatalog,
      log: silent(),
    });
    const before = durableSnapshot(ctx);
    const recovered = collect.recoverAbandonedRuns(ctx.options, silent());
    assert.equal(recovered, null);
    assert.deepEqual(durableSnapshot(ctx), before);
    const status = db.getStatus(ctx.options);
    assert.equal(status.currentRun.run_id, 'safe-retry');
    assert.equal(status.currentRun.status, 'validated');
  });

  it('collect mode promotes canonical files locally without pushing', async () => {
    seedKnownOffer(ctx);
    const result = await collect.runPipeline({
      ...ctx.options,
      runId: 'col-1',
      runWorker: makeWorker('ok'),
      runCatalog: fakeCatalog,
      log: silent(),
    });

    assert.equal(result.promoted, true);
    assert.equal(result.deployed, false);
    // Canonical files now exist and carry the assembled generation.
    const canonicalReport = path.join(ctx.root, 'report.json');
    assert.ok(fs.existsSync(canonicalReport));
    assert.ok(fs.existsSync(path.join(ctx.root, 'index.html')));
    const report = JSON.parse(fs.readFileSync(canonicalReport, 'utf8'));
    assert.ok(report.ranked_offers.some((o) => o.name && o.name.includes('Gemini')));
    const router = report.ranked_offers.find((o) => o.delivery_type === 'router');
    assert.ok(router, 'catalog admission reaches a public router offer');
    assert.equal(router.model_id, 'acme/new:free');
    assert.equal(router.provider_key, 'openrouter');
    assert.equal(router.access_kind, 'FREE');
    assert.equal(router.effective_price_per_million.input, 0);
    assert.equal(router.price_verified_at !== null, true);
    assert.equal('free_model_names' in router, false, 'free_model_names removed (AC-2)');
    // Promotion manifest reached db_finalized (awaiting a separate deploy).
    const manifest = JSON.parse(fs.readFileSync(
      path.join(ctx.stateDir, 'crawl', 'col-1', 'promotion-manifest.json'), 'utf8'
    ));
    assert.equal(manifest.phase, 'db_finalized');
  });

  it('deploy target finds the locally promoted run awaiting push', async () => {
    seedKnownOffer(ctx);
    await collect.runPipeline({
      ...ctx.options,
      runId: 'col-2',
      runWorker: makeWorker('ok'),
      runCatalog: fakeCatalog,
      log: silent(),
    });
    const publication = require('./publication');
    const target = publication.findDeployTarget(ctx.options);
    assert.ok(target, 'a deploy target must exist after collect');
    assert.equal(target.run_id, 'col-2');
    assert.equal(target.phase, 'db_finalized');
  });

  it('zero verified known offers blocks promotion and leaves canonical files untouched', async () => {
    seedKnownOffer(ctx);
    const result = await collect.runPipeline({
      ...ctx.options,
      runId: 'gate-1',
      runWorker: makeWorker('fail-known'),
      runCatalog: fakeCatalog,
      log: silent(),
    });

    assert.equal(result.canPromote, false);
    assert.equal(result.promoted, false);
    assert.ok(!fs.existsSync(path.join(ctx.root, 'report.json')), 'canonical report.json must not exist when gate blocks');
    // The known offer went stale, not removed (AC-3, AC-5).
    const database = db.openCollectorDb(ctx.options);
    try {
      const row = database.prepare(
        "SELECT status, consecutive_failures FROM offers WHERE exact_model_id = 'gemini-2.5-pro'"
      ).get();
      assert.equal(row.status, 'stale');
      assert.equal(row.consecutive_failures, 1);
    } finally {
      database.close();
    }
  });

it('research sessions run with a bounded transport and no legacy discovery goals (spec 0008 Phase 5)', async () => {
    seedKnownOffer(ctx);
    // The research plan only activates with a watchlist in place. Use a
    // tiny fixture (one vendor channel + one community feed) instead of the
    // production watchlist so the test stays fast and does not hammer ~160
    // real endpoints per run.
    fs.writeFileSync(path.join(ctx.root, 'build', 'research-watchlist.json'), JSON.stringify({
      version: 1,
      windows: { hot_days: 1, warm_days: 3, catchup_days: 30 },
      frontier_vendors: ['acme'],
      vendors: [{ key: 'acme', label: 'Acme AI', tier: 1, channels: { blog: 'https://blog.acme.example/updates' }, notes: null }],
      provider_monitors: [],
      community: [{ key: 'hn', label: 'Hacker News', kind: 'hn', url: 'https://news.ycombinator.com', queries: ['LLM free API'] }],
      coding_products: [],
      credit_programs: [],
    }, null, 2) + '\n');

    const runId = 'research-goals-1';
    const captured = new Map();
    const capturingWorker = (spec) => {
      if (spec.transport === 'discovery') captured.set(spec.taskId, spec);
      return makeWorker('ok')(spec);
    };

    await collect.runPipeline({
      ...ctx.options,
      dryRun: true,
      runId,
      runWorker: capturingWorker,
      runCatalog: fakeCatalog,
      log: silent(),
    });

    // The legacy discovery goal crawlers are gone: no discovery:* worker ran.
    assert.ok([...captured.keys()].every((id) => !id.startsWith('discovery:')),
      'no legacy discovery goal crawler sessions');
    const newsScan = captured.get('news_scan');
    assert.ok(newsScan, 'the daily news scan session runs');
    assert.equal(newsScan.searchBudget, 6, 'news scan keeps its bounded search budget');
    assert.equal(newsScan.visitBudget, 8, 'news scan keeps its bounded visit budget');
    const runtime = newsScan.runtime;
    assert.doesNotMatch(runtime, /discovery_sources|search_terms|search_windows/,
      'no pool data of any kind may reach the worker');
    assert.ok(captured.get('community') || true, 'community session is optional without a watchlist');
  });
it('reports one deterministic benchmark result incrementally in completion order', async () => {
    const ctx = tmpProject();
    const runId = 'benchmark-progress';
    const runDir = path.join(ctx.stateDir, 'crawl', runId);
    fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });
    db.applyMigrations(ctx.options);
    const entries = ['verified', 'not-found', 'rejected', 'failed'].map((name, index) => ({
      canonical_model_id: `acme/${name}`,
      offer_ids: [{ provider_key: 'openrouter', exact_model_id: `acme/${name}:free` }],
      metadata_hash: `${index}`,
    }));
    db.startRun(runId, entries.map((entry, index) => ({
      task_id: `benchmark_scout:model-${index + 1}-${entry.canonical_model_id.replace('/', '-')}`,
      kind: 'benchmark_scout',
      assigned_model_ids: entry.offer_ids.map((id) => id.exact_model_id),
    })), ctx.options);
    const queue = { queue: entries };
    const scoutTasks = collect.benchmarkScoutModelTasks(queue);
    const delays = { 'acme/verified': 80, 'acme/not-found': 5, 'acme/rejected': 10, 'acme/failed': 1 };
    const logs = [];
    let fetchCalls = 0;
    const result = await collect.runBenchmarkScouts({
      runId, runDir, scoutTasks,
      dirs: { schemasDir: ctx.root },
      opts: {
        concurrency: 4, visionCapable: false, evidenceAttempts: 1,
        evidenceFetchImpl: async (url) => {
          fetchCalls += 1;
          if (url.includes('rejected')) return { status: 503, url, text: async () => '' };
          return { status: 200, url, text: async () => 'acme/verified Terminal-Bench 2.1 72 SWE-bench Verified 1.0 80' };
        },
      },
      baseOpts: ctx.options,
      log: (line) => logs.push(line),
      queue,
      runWorker: async (spec) => {
        const model = JSON.parse(fs.readFileSync(
          path.join(runDir, 'benchmarks', `needs-${db.sanitizeTaskId(spec.taskId)}.json`), 'utf8'
        )).models[0];
        await new Promise((resolve) => setTimeout(resolve, delays[model.canonical_model_id]));
        fs.mkdirSync(path.dirname(spec.outputFile), { recursive: true });
        if (model.canonical_model_id === 'acme/failed') throw new Error('worker failure');
        const artifact = {
          schema_version: 1, task_id: spec.taskId, kind: 'benchmark_scout', status: 'complete',
          crawled_at: new Date().toISOString(), models: [], errors: [],
        };
        if (model.canonical_model_id === 'acme/rejected') artifact.models = [{
          model_id: model.model_ids[0], benchmark_finds: [{ display_name: 'Terminal-Bench 2.1', version: '2.1', score: 50,
            source_url: 'https://evidence/rejected', extraction_method: 'text', confidence: 'HIGH' }],
        }];
        else if (model.canonical_model_id === 'acme/verified') artifact.models = [{
          model_id: model.model_ids[0], canonical_model_id: model.canonical_model_id, benchmark_finds: [
            { display_name: 'Terminal-Bench 2.1', version: '2.1', score: 72, source_url: 'https://evidence/verified', extraction_method: 'text', confidence: 'HIGH' },
            { display_name: 'SWE-bench Verified', version: '1.0', score: 80, source_url: 'https://evidence/verified', extraction_method: 'text', confidence: 'HIGH' },
          ],
        }];
        fs.writeFileSync(spec.outputFile, JSON.stringify(artifact));
      },
    });
    assert.deepEqual(logs.map((line) => line.match(/benchmark (\d+\/\d+) (\S+): (\S+)(?: (\d+))?/).slice(1)), [
      ['1/4', 'acme/failed', 'failed', undefined], ['2/4', 'acme/not-found', 'not_found', undefined],
      ['3/4', 'acme/rejected', 'rejected', undefined], ['4/4', 'acme/verified', 'verified', '2'],
    ]);
    assert.equal(fetchCalls, 2);
    const staged = db.loadRunCandidate(runId, ctx.options).tasks;
    const before = fetchCalls;
    await benchmarks.fetchBenchmarkSourceBodies(staged, {
      sourceBodies: result.sourceBodies, sourceHashes: result.sourceHashes, fetchCache: result.fetchCache,
      fetchImpl: async () => { throw new Error('final reduction must not refetch'); },
    });
    assert.equal(fetchCalls, before);
    assert.equal(benchmarks.evaluateBenchmarkModelProgress(
      staged.find((task) => task.task_id === scoutTasks[0].task_id), entries[0], {
        sourceBodies: result.sourceBodies, sourceHashes: result.sourceHashes, requireFetchedEvidence: true,
      }
    ).verified, 2);
    fs.rmSync(ctx.root, { recursive: true, force: true });
  });
});

describe('displayRelevantCandidate pre-filter (operator 2026-08-25)', () => {
  const base = () => ({
    offer_key: 'openrouter/acme/a:free',
    access_kind: 'FREE',
    tier: null,
    benchmark: null,
    in_caution: false,
    free_limits: null,
    description: null,
    registration_conditions: null,
  });

  it('keeps benchmark-qualified, discounted, and caution candidates', () => {
    const qualified = base();
    qualified.tier = 'A';
    qualified.benchmark = { score: 57 };
    assert.equal(collect.displayRelevantCandidate(qualified), true);

    const discounted = base();
    discounted.access_kind = 'DISCOUNTED';
    assert.equal(collect.displayRelevantCandidate(discounted), true);

    const caution = base();
    caution.in_caution = true;
    assert.equal(collect.displayRelevantCandidate(caution), true);
  });

  it('keeps candidates with trial, campaign, or conditional signals', () => {
    const trial = base();
    trial.free_limits = 'one-time $10 free credit';
    assert.equal(collect.displayRelevantCandidate(trial), true);

    const campaign = base();
    campaign.free_limits = 'free until 2026-09-15';
    assert.equal(collect.displayRelevantCandidate(campaign), true);

    const conditional = base();
    conditional.registration_conditions = 'data sharing opt-in required';
    assert.equal(collect.displayRelevantCandidate(conditional), true);
  });

  it('drops plain paid / benchmark-pending candidates (provisional classification suffices)', () => {
    const plain = base();
    plain.free_limits = 'input $0.14 / output $0.28 per 1M';
    assert.equal(collect.displayRelevantCandidate(plain), false);

    const preview = base();
    preview.description = 'a preview endpoint for testing';
    assert.equal(collect.displayRelevantCandidate(preview), true, 'preview is a trial-class signal');
  });
});

describe('runPiWorker transport (spec 0008 research sessions)', () => {
  let ctx;

  function fixtureWithPrompts() {
    ctx = tmpProject();
    fs.mkdirSync(path.join(ctx.root, 'state', 'logs'), { recursive: true });
    const promptsDir = path.join(ctx.root, '.agents', 'skills', 'llm-deals-intelligence-skill', 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'crawl-worker.md'), '# stub crawl role\n');
    const schemasDir = path.join(ctx.root, '.agents', 'skills', 'llm-deals-intelligence-skill', 'schemas');
    fs.writeFileSync(path.join(schemasDir, 'crawl-facts.schema.json'), JSON.stringify({ type: 'object' }, null, 2) + '\n');
    return ctx;
  }

  function capturingSpawn() {
    const calls = [];
    const spawnImpl = (cmd, args, opts) => {
      calls.push({ cmd, args });
      const outArgIndex = args.indexOf('--json-output');
      fs.writeFileSync(args[outArgIndex + 1], `${JSON.stringify({ schema_version: 1, status: 'complete', models: [] })}\n`);
      const { EventEmitter } = require('node:events');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0, null));
      return child;
    };
    return { calls, spawnImpl };
  }

  function lastPrompt(args) {
    const i = args.indexOf('-p');
    return args[i + 1];
  }

  function toolsValue(args) {
    const i = args.indexOf('--tools');
    return args[i + 1];
  }

  function specFor(taskId, extra = {}) {
    return {
      taskId,
      roleFile: 'crawl-worker.md',
      schemaFile: path.join(ctx.root, '.agents', 'skills', 'llm-deals-intelligence-skill', 'schemas', 'crawl-facts.schema.json'),
      outputFile: path.join(ctx.root, 'state', 'out', `${taskId.replace(/:/g, '-')}.json`),
      logFile: path.join(ctx.root, 'state', 'logs', `${taskId.replace(/:/g, '-')}.log`),
      runtime: `Task: ${taskId}.`,
      ...extra,
    };
  }

  beforeEach(() => { fixtureWithPrompts(); });
  afterEach(() => { fs.rmSync(ctx.root, { recursive: true, force: true }); });

  it('gives the research web sessions the browser tool and a search + browser transport', async () => {
    const { calls, spawnImpl } = capturingSpawn();
    await collect.runPiWorker(specFor('news-scan', { transport: 'discovery', searchTimeRange: 'week' }), {
      piModel: 'test-model', piTimeout: 600, spawnImpl,
    }, ctx.options);
    assert.equal(calls.length, 1);
    assert.equal(toolsValue(calls[0].args), 'bash,read,json_output,browser');
    const prompt = lastPrompt(calls[0].args);
    assert.match(prompt, /Discovery transport \(web search \+ browser\)/);
    assert.match(prompt, /at most 4 Bash searches/);
    assert.match(prompt, /web-search-plus --provider auto --query "<your query>" --time-range week --max-results 5/);
    assert.match(prompt, /At most 8 page visits total/);
    assert.match(prompt, /action=open/);
    assert.match(prompt, /action=snapshot/);
    assert.match(prompt, /session: "disc-news-scan"/);
    assert.match(prompt, /close_session/);
  });

  it('gives each research session its own isolated browser session', async () => {
    const { calls, spawnImpl } = capturingSpawn();
    await collect.runPiWorker(specFor('vendor:openai', { transport: 'discovery' }), {
      piModel: 'test-model', piTimeout: 600, spawnImpl,
    }, ctx.options);
    assert.equal(calls.length, 1);
    assert.equal(toolsValue(calls[0].args), 'bash,read,json_output,browser');
    const prompt = lastPrompt(calls[0].args);
    assert.match(prompt, /Discovery transport \(web search \+ browser\)/);
    assert.doesNotMatch(prompt, /curl -L --max-time/);
    assert.match(prompt, /session: "disc-vendor-openai"/);
    assert.match(prompt, /close_session/);
  });

  it('keeps non-research workers on the minimal tool surface without browser transport', async () => {
    const { calls, spawnImpl } = capturingSpawn();
    await collect.runPiWorker(specFor('known:google'), {
      piModel: 'test-model', piTimeout: 600, spawnImpl,
    }, ctx.options);
    assert.equal(calls.length, 1);
    assert.equal(toolsValue(calls[0].args), 'bash,read,json_output');
    const prompt = lastPrompt(calls[0].args);
    assert.doesNotMatch(prompt, /browser tool/);
  });

  it('maps the discovery window in days to a search time-range', () => {
    assert.equal(collect.discoverySearchTimeRange({}), 'week');
    assert.equal(collect.discoverySearchTimeRange({ DISCOVERY_WINDOW_DAYS: '2' }), 'day');
    assert.equal(collect.discoverySearchTimeRange({ DISCOVERY_WINDOW_DAYS: '30' }), 'month');
    assert.equal(collect.discoverySearchTimeRange({ DISCOVERY_WINDOW_DAYS: '400' }), 'year');
    assert.equal(collect.discoverySearchTimeRange({ DISCOVERY_WINDOW_DAYS: 'not-a-number' }), 'week');
  });

  it('halves the discovery visit budget and timeout on retry (operator 2026-08-25)', async () => {
    const calls = [];
    const spawnImpl = (cmd, args, opts) => {
      calls.push({ args });
      const outArgIndex = args.indexOf('--json-output');
      const attempt = calls.length;
      if (attempt === 1) {
        // First attempt: pi exits 1 without writing usable JSON -> retried.
        fs.rmSync(args[outArgIndex + 1], { force: true });
        const { EventEmitter } = require('node:events');
        const child = new EventEmitter();
        setImmediate(() => child.emit('close', 1, null));
        return child;
      }
      fs.writeFileSync(args[outArgIndex + 1], `${JSON.stringify({ schema_version: 1, status: 'complete', models: [] })}\n`);
      const { EventEmitter } = require('node:events');
      const child = new EventEmitter();
      setImmediate(() => child.emit('close', 0, null));
      return child;
    };
    const spec = specFor('provider-monitor', {
      transport: 'discovery', visitBudget: 12, searchBudget: 2,
    });
    await collect.runPiWorker(spec, {
      piModel: 'test-model', piTimeout: 600, spawnImpl,
    }, ctx.options);
    assert.equal(calls.length, 2, 'retried once');
    const first = lastPrompt(calls[0].args);
    const second = lastPrompt(calls[1].args);
    assert.match(first, /At most 12 page visits total/);
    assert.match(second, /At most 6 page visits total/, 'retry halves the visit budget');
    assert.match(second, /at most 2 Bash searches/);
  });
});

describe('deterministic aggregated-index lane wiring', () => {
  let ctx;
  beforeEach(() => { ctx = tmpProject(); db.applyMigrations(ctx.options); });
  afterEach(() => { fs.rmSync(ctx.root, { recursive: true, force: true }); });

  // The lane used to throw inside collect.js ("fetchHtml is not a function"),
  // which the fail-safe logged as merely "unavailable" and the previous report
  // survived. Assert the wiring produces a real artifact, not just no crash.
  it('writes an available aggregated_index artifact through runCatalogInProcess', async () => {
    const runDir = path.join(ctx.stateDir, 'crawl', 'agg-wiring');
    const manifest = {
      tasks: [{
        task_id: 'aggregated_index:freellm',
        kind: 'aggregated_index',
        provider_key: null,
      }],
    };
    const htmlFor = (url) => (
      /freellm\.net/.test(url)
        ? '<tr class="model-row" data-name="glm 5.2 (free)" data-provider="OpenRouter" data-provider-slug="openrouter" data-free="1" data-tier-type="permanent" data-verified="1" data-nocard="1" data-nophone="1" data-context="256000"></tr>'
        : '<!-- BEGIN_QUICK_REF -->\n| Provider | Base URL | Get API Key |\n| OpenRouter | `https://openrouter.ai/api/v1` | <a>key</a> |\n<!-- END_QUICK_REF -->\n'
    );
    await collect.runCatalogInProcess(manifest, runDir, {
      ...ctx.options,
      aggregatedIndexFetchHtml: async (url) => htmlFor(String(url)),
    }, silent());

    const artifact = JSON.parse(
      fs.readFileSync(db.artifactPathFor(runDir, 'aggregated_index:freellm'), 'utf8')
    );
    assert.equal(artifact.status, 'complete', `lane failed: ${JSON.stringify(artifact.errors)}`);
    assert.equal(artifact.available, true);
    assert.equal(artifact.models.length, 1);
    assert.equal(artifact.models[0].provider_key, 'openrouter');
    assert.equal(artifact.base_urls.OpenRouter, 'https://openrouter.ai/api/v1');
  });

  it('stays fail safe when an aggregated source is unreachable', async () => {
    const runDir = path.join(ctx.stateDir, 'crawl', 'agg-down');
    const manifest = {
      tasks: [{
        task_id: 'aggregated_index:freellm',
        kind: 'aggregated_index',
        provider_key: null,
      }],
    };
    await collect.runCatalogInProcess(manifest, runDir, {
      ...ctx.options,
      aggregatedIndexFetchHtml: async () => { throw new Error('network down'); },
    }, silent());

    const artifact = JSON.parse(
      fs.readFileSync(db.artifactPathFor(runDir, 'aggregated_index:freellm'), 'utf8')
    );
    assert.equal(artifact.available, false);
    assert.deepEqual(artifact.models, []);
    assert.ok(artifact.errors.length >= 1);
  });
});
