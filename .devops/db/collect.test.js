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
const collect = require('./collect');

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
    } else if (spec.taskId === 'discovery') {
      write({
        schema_version: 1, task_id: 'discovery', status: 'complete',
        crawled_at: new Date().toISOString(), provider_key: '_discovery',
        models: [], errors: [],
      });
    } else if (spec.taskId === 'classifier') {
      if (mode === 'throw-classifier' || mode === 'throw') {
        throw new Error('simulated classifier failure after lane reduction');
      }
      write({
        classifications: [{
          name: 'Gemini 2.5 Pro',
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
    assert.deepEqual(router.free_model_names, ['acme/new:free', 'openrouter/free']);
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
    assert.deepEqual(router.free_model_names, ['acme/new:free', 'openrouter/free']);
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
});
