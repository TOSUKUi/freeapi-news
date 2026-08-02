'use strict';

// End to end fail safe collection orchestrator (spec 0003, children 0001
// through 0004). Drives the whole pipeline in process, calling the tested
// modules directly and shelling out only for the pi LLM workers.
//
// Order (index.md "Task kinds and order"):
//   DB recovery preflight, migrate, startup recovery, pre run DB copy,
//   catalog (deterministic) + known refresh + discovery (LLM), ingest,
//   deterministic lane reduction, benchmark queue + scout (LLM), ingest,
//   benchmark reduction, candidate view, classifier (LLM) + editor (LLM),
//   deterministic assembly, candidate validation and build, then promotion
//   and (optionally) deploy.
//
// Modes:
//   dry run  — collect and validate the candidate, never promote or deploy.
//   collect  — collect, validate, promote locally, never push (default).
//   full     — collect, validate, promote, then commit and push.
//
// Fail safe: current tracked files only change inside promoteGeneration after
// every check passes. A gate failure leaves the run failed and the previous
// published generation live.
//
// Testability: every module call receives `baseOpts` (projectRoot/stateDir),
// and the pi workers and the catalog fetch are injectable, so the whole
// pipeline runs against an isolated fixture project with no network and no pi.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const db = require('./collector-db');
const lanes = require('./lanes');
const benchmarks = require('./benchmarks');
const assemble = require('./assemble');
const publication = require('./publication');
const catalog = require('./catalog');
const evidence = require('./evidence');

function skillDirs(baseOpts) {
  const { projectRoot } = db.resolvePaths(baseOpts);
  const skillDir = path.join(
    projectRoot, '.agents', 'skills', 'llm-deals-intelligence-skill'
  );
  return {
    projectRoot,
    skillDir,
    schemasDir: path.join(skillDir, 'schemas'),
    promptsDir: path.join(skillDir, 'prompts'),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function defaultRunId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Concurrency lock (prevents two collectors racing over one SQLite file)
// ---------------------------------------------------------------------------

function acquireLock(lockPath, log) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, `${process.pid}\n`);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // A lock exists. Take it over when it is stale: empty, not a pid, or the
    // owning pid is gone. (The old flock based script left an empty lock file
    // behind, which is stale by definition.)
    let pid = NaN;
    try { pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10); } catch { /* unreadable */ }
    if (!Number.isFinite(pid) || !processAlive(pid)) {
      log(`  stale lock${Number.isFinite(pid) ? ` from pid ${pid}` : ''}; taking over`);
      fs.rmSync(lockPath, { force: true });
      try {
        const fd = fs.openSync(lockPath, 'wx');
        fs.writeSync(fd, `${process.pid}\n`);
        fs.closeSync(fd);
        return true;
      } catch {
        return false; // someone else grabbed it first
      }
    }
    return false;
  }
}

function releaseLock(lockPath) {
  try { fs.rmSync(lockPath, { force: true }); } catch { /* ok */ }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// pi worker runner
// ---------------------------------------------------------------------------

// Runs one pi worker. The role contract (prompts/*.md) is prepended to the
// runtime parameters; --json-schema/--json-output (via @nqbao/pi-json-schema)
// force schema conforming output written straight to outputFile. When the
// worker produces nothing and a failureArtifact is supplied, write it so the
// deterministic reducer counts the task as failed (not missing).
function runPiWorker(spec, options, baseOpts) {
  const dirs = skillDirs(baseOpts);
  const role = fs.readFileSync(path.join(dirs.promptsDir, spec.roleFile), 'utf8');
  const schema = fs.readFileSync(spec.schemaFile, 'utf8');
  const fullPrompt = `${role}\n\n---\n\n## This run\n\n${spec.runtime}\n`;

  fs.mkdirSync(path.dirname(spec.outputFile), { recursive: true });
  const logStream = fs.openSync(spec.logFile, 'w');

  const args = [
    '--skill', dirs.skillDir,
    '--model', options.piModel,
    '--approve',
    '--no-session',
    '--json-schema', schema,
    '--json-output', spec.outputFile,
    '--json-fallback', 'force',
    '-p', fullPrompt,
  ];

  return new Promise((resolve) => {
    const child = spawn('pi', args, {
      stdio: ['ignore', logStream, logStream],
      timeout: options.piTimeout * 1000,
    });
    const finish = () => {
      try { fs.closeSync(logStream); } catch { /* ok */ }
      if (!fs.existsSync(spec.outputFile) && spec.failureArtifact) {
        fs.writeFileSync(
          spec.outputFile,
          `${JSON.stringify(spec.failureArtifact, null, 2)}\n`
        );
        options.log(`     └─ ${spec.taskId}: no conforming output, wrote failure artifact`);
      }
      resolve(spec.taskId);
    };
    child.on('error', finish);
    child.on('close', finish);
  });
}

// Runs async worker fns with at most `limit` in flight.
async function runPool(items, limit, workerFn) {
  const results = new Array(items.length);
  let next = 0;
  async function lane() {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await workerFn(items[i], i);
    }
  }
  const laneCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: laneCount }, lane));
  return results;
}

function summarizeIngest(summary) {
  const counts = { complete: 0, partial: 0, failed: 0 };
  for (const entry of summary.recorded || []) {
    if (counts[entry.status] !== undefined) counts[entry.status] += 1;
  }
  return `${counts.complete} complete, ${counts.partial} partial, ${counts.failed} failed`;
}

function factsFailureArtifact(taskId, providerKey) {
  return {
    schema_version: 1,
    task_id: taskId,
    status: 'failed',
    crawled_at: nowIso(),
    provider_key: providerKey || '',
    models: [],
    errors: ['worker did not produce conforming output'],
  };
}

function benchmarkScoutModelTasks(queue) {
  return queue.queue.map((model, index) => ({
    task_id: `benchmark_scout:model-${index + 1}-${db.sanitizeTaskId(model.canonical_model_id)}`,
    kind: 'benchmark_scout',
    model,
  }));
}

function writeBenchmarkScoutNeeds(runDir, task) {
  const file = path.join(runDir, 'benchmarks', `needs-${db.sanitizeTaskId(task.task_id)}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    task_id: task.task_id,
    kind: 'benchmark_scout',
    models: [{
      canonical_model_id: task.model.canonical_model_id,
      model_ids: task.model.offer_ids.map((id) => id.exact_model_id),
      offer_ids: task.model.offer_ids,
      metadata_hash: task.model.metadata_hash,
    }],
  }, null, 2)}\n`);
  return file;
}

function scoutFailureArtifact(taskId) {
  return {
    schema_version: 1,
    task_id: taskId,
    kind: 'benchmark_scout',
    status: 'failed',
    crawled_at: nowIso(),
    models: [],
    errors: ['worker did not produce conforming output'],
  };
}

// Runs one worker per queued model while retaining the configured pool
// concurrency. Ingest, bounded evidence fetch, and proposal validation happen
// before the model's progress line is printed. The evidence maps are returned
// for final reduction, avoiding a second network fetch.
async function runBenchmarkScouts({ runId, runDir, scoutTasks, dirs, opts, baseOpts, log, queue, runWorker }) {
  const total = scoutTasks.length;
  const sourceBodies = new Map();
  const sourceHashes = new Map();
  const fetchCache = new Map();
  const fetches = [];
  let completed = 0;
  const progress = [];

  await runPool(scoutTasks, opts.concurrency, async (task) => {
    const needsFile = writeBenchmarkScoutNeeds(runDir, task);
    try {
      await runWorker({
        taskId: task.task_id,
        roleFile: 'benchmark-scout.md',
        schemaFile: path.join(dirs.schemasDir, 'benchmark-scout.schema.json'),
        outputFile: db.artifactPathFor(runDir, task.task_id),
        logFile: path.join(runDir, 'logs', `${db.sanitizeTaskId(task.task_id)}.log`),
        runtime: `Needs-list: ${needsFile}. For this one model, search only (1) official Terminal-Bench/Harbor results, `
          + '(2) the official Hugging Face model card, then (3) official vendor technical documentation/model card; stop after those three sources. '
          + 'Do not use social, community, GitHub, aggregator, or other fallback sources and do not keep exploring. '
          + 'Extract every benchmark row present in each allowed page (Terminal-Bench 2.0/2.1 is the ranking gate; others are supplemental), copy model_id verbatim from the list, and emit accepted evidence via json_output.'
          + (Array.isArray(opts.forceBenchmarkKeys) && opts.forceBenchmarkKeys.length > 0
            ? ` Focus especially on benchmark(s): ${opts.forceBenchmarkKeys.join(', ')}.`
            : ''),
        failureArtifact: scoutFailureArtifact(task.task_id),
      }, opts, baseOpts);
    } catch {
      fs.mkdirSync(path.dirname(db.artifactPathFor(runDir, task.task_id)), { recursive: true });
      fs.writeFileSync(db.artifactPathFor(runDir, task.task_id), `${JSON.stringify(scoutFailureArtifact(task.task_id), null, 2)}\n`);
    }

    lanes.ingestTaskArtifacts(runId, runDir, { ...baseOpts, onlyTaskIds: [task.task_id] });
    const staged = db.loadRunCandidate(runId, baseOpts).tasks.find((entry) => entry.task_id === task.task_id);
    const evidence = await benchmarks.fetchBenchmarkSourceBodies(staged ? [staged] : [], {
      fetchImpl: opts.evidenceFetchImpl || undefined,
      attempts: opts.evidenceAttempts,
      sourceBodies,
      sourceHashes,
      fetchCache,
    });
    fetches.push(...evidence.fetches);
    const result = benchmarks.evaluateBenchmarkModelProgress(staged, task.model, {
      visionCapable: opts.visionCapable,
      sourceBodies,
      sourceHashes,
      requireFetchedEvidence: true,
    });
    completed += 1;
    const line = `[6/9] benchmark ${completed}/${total} ${task.model.canonical_model_id}: `
      + (result.outcome === 'verified' ? `verified ${result.verified}` : result.outcome);
    log(line);
    progress.push({ ...result, canonical_model_id: task.model.canonical_model_id, line });
    return evidence;
  });

  // The pool completion order is intentionally not used for reduction order;
  // task order remains deterministic and the final reducer stays unchanged.
  return { queue, progress, sourceBodies, sourceHashes, fetchCache, fetches };
}

// ---------------------------------------------------------------------------
// Deterministic catalog fetch (in process, no LLM)
// ---------------------------------------------------------------------------

// Fetches every catalog task in the run manifest straight from the provider
// API and writes the artifacts where ingest expects them. Mirrors catalog.js
// main() but runs in process so it honors baseOpts (test isolation).
async function runCatalogInProcess(manifest, runDir, baseOpts, log) {
  const paths = db.resolvePaths(baseOpts);
  const raw = JSON.parse(fs.readFileSync(paths.registryPath, 'utf8'));
  const providers = Array.isArray(raw) ? raw : raw.providers;
  const regByKey = Object.fromEntries((providers || []).map((p) => [p.key, p]));

  const catalogTasks = (manifest.tasks || []).filter((t) => t.kind === 'catalog');
  if (catalogTasks.length === 0) return;
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  for (const task of catalogTasks) {
    let artifact;
    try {
      artifact = await catalog.fetchCatalogForProvider(task, regByKey[task.provider_key] || {});
    } catch (err) {
      artifact = {
        schema_version: 1,
        task_id: task.task_id,
        kind: 'catalog',
        provider_key: task.provider_key,
        crawled_at: nowIso(),
        catalog_url: task.api_catalog_url,
        base_url: task.base_url || null,
        status: 'failed',
        available: false,
        http_status: null,
        content_hash: null,
        endpoint_source: null,
        endpoint_source_hash: null,
        models: [],
        fetches: [],
        errors: [err.message],
      };
    }
    const outPath = db.artifactPathFor(runDir, task.task_id);
    fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    if (artifact.available) {
      const free = artifact.models.filter((m) => m.is_free).length;
      log(`  ✅ ${task.provider_key}: ${artifact.models.length} model(s), ${free} free`);
    } else {
      log(`  ❌ ${task.provider_key}: catalog unavailable (${artifact.errors[0] || 'unknown'}); prior offers preserved`);
    }
  }
}

// ---------------------------------------------------------------------------
// Startup and pipeline recovery
// ---------------------------------------------------------------------------

const SAFELY_FINALIZED_PHASES = new Set(['db_finalized', 'committed', 'pushed']);
const ABANDONED_PREPUBLICATION_STATUSES = new Set(['collecting', 'candidate_ready', 'validated']);

function hasSafelyFinalizedPromotion(runDir, runId = null, options = {}) {
  const manifest = publication.readManifest(runDir);
  if (manifest && SAFELY_FINALIZED_PHASES.has(manifest.phase)) return true;
  // A deploy push failure is explicitly resumable even if a caller reaches
  // this guard after the manifest write but before it can be reread.
  if (runId) {
    try {
      const { run } = db.loadRunCandidate(runId, options);
      return !!run && ['validated_not_deployed', 'promoted'].includes(run.status);
    } catch {
      // An absent/failed run is not evidence of safe finalization.
    }
  }
  return false;
}

// A process can terminate after a lane transaction but before a promotion
// manifest exists. Recover the oldest nonterminal pre-publication run from
// its own persisted backup before building a new manifest. This deliberately
// does not inspect or choose the newest backup: the run id and sidecar hash
// identify one exact pre-run snapshot.
function recoverAbandonedRuns(baseOpts, log = () => {}) {
  const paths = db.resolvePaths(baseOpts);
  if (!fs.existsSync(paths.dbPath) || !db.checkIntegrity(paths.dbPath)) return null;

  const database = db.openCollectorDb(baseOpts);
  let candidates;
  try {
    candidates = database.prepare(
      'SELECT run_id, status, started_at FROM runs ' +
      "WHERE status IN ('collecting', 'candidate_ready', 'validated') " +
      'ORDER BY started_at ASC, run_id ASC'
    ).all();
  } finally {
    database.close();
  }

  const abandoned = candidates.filter((run) => {
    if (!ABANDONED_PREPUBLICATION_STATUSES.has(run.status)) return false;
    const runDir = path.join(paths.stateDir, 'crawl', run.run_id);
    return !hasSafelyFinalizedPromotion(runDir);
  });
  if (abandoned.length === 0) return null;

  // Collection is lock-serialized, so normally there is one candidate. If a
  // prior hard termination left more than one, the oldest backup predates all
  // later mutations and is the only safe rollback target.
  const run = abandoned[0];
  const runDir = path.join(paths.stateDir, 'crawl', run.run_id);
  const backup = db.exactRunDatabaseBackup(run.run_id, baseOpts);
  if (!backup) {
    throw new Error(
      `abandoned run ${run.run_id} has no exact pre-run database backup and cannot be recovered safely`
    );
  }
  const restored = db.restoreExactRunDatabase(backup, baseOpts);
  log(`  restored abandoned run ${run.run_id} from its exact pre-run DB backup`);
  return [{
    runId: run.run_id,
    action: 'restored_exact_database',
    fromStatus: run.status,
    runDir,
    ...restored,
  }];
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

async function runPipeline(options = {}) {
  const opts = {
    dryRun: false,
    push: false,
    skipCitation: false,
    visionCapable: false,
    concurrency: Number(process.env.GLOBAL_CONCURRENCY || 2),
    piModel: process.env.PI_MODEL || 'litellm/free',
    piTimeout: Number(process.env.PI_TIMEOUT || 1800),
    forceModelIds: [],
    forceBenchmarkKeys: [],
    runId: null,
    projectRoot: undefined,
    stateDir: undefined,
    runWorker: null,    // injectable: async (spec, opts, baseOpts) => void
    runCatalog: null,   // injectable: async (manifest, runDir, baseOpts, log) => void
    evidenceFetchImpl: null, // injectable bounded HTTP fetch for evidence audit
    log: (...a) => console.log(...a),
    ...options,
  };
  const log = opts.log;
  const baseOpts = {
    projectRoot: opts.projectRoot,
    stateDir: opts.stateDir,
    forceModelIds: opts.forceModelIds,
    forceBenchmarkKeys: opts.forceBenchmarkKeys,
  };

  db.assertRuntime();
  const dirs = skillDirs(baseOpts);
  const paths = db.resolvePaths(baseOpts);
  const lockPath = path.join(dirs.projectRoot, '.devops', 'batch', '.crawl.lock');
  if (!acquireLock(lockPath, log)) {
    throw new Error('another collection is already running (lock held)');
  }

  let runWorker = null;
  let runCatalog = null;
  let runId = null;
  let runDir = null;
  let preRunBackup = null;
  let mutationStarted = false;
  let restoreAttempted = false;
  let restoreFailure = null;

  const restoreExactPreRun = () => {
    restoreAttempted = true;
    if (!preRunBackup) {
      const error = new Error(`run ${runId} has no exact pre-run database backup`);
      restoreFailure = error;
      throw error;
    }
    try {
      return db.restoreExactRunDatabase(preRunBackup, baseOpts);
    } catch (err) {
      restoreFailure = err;
      throw err;
    }
  };

  try {
    // Canonical hash mismatches are an operator decision point. Perform this
    // read-only preflight before opening/recovering SQLite, creating a run
    // directory, or starting any worker.
    publication.assertNoManualInspectionRequired(baseOpts);

    // AC-1: openCollectorDb must restore the newest valid copy before
    // migrations can create/initialize a missing database. Migrations then
    // upgrade that recovered file in place.
    const recoveredDb = db.openCollectorDb(baseOpts);
    recoveredDb.close();
    db.applyMigrations(baseOpts);
    runWorker = opts.runWorker || ((spec) => runPiWorker(spec, opts, baseOpts));
    runCatalog = opts.runCatalog
      || ((manifest, runDir) => runCatalogInProcess(manifest, runDir, baseOpts, log));

    // Startup recovery runs before this collection obtains a run ID or creates
    // its directory, so a manual-inspection stop cannot start a new run.
    const recovered = publication.recoverInterruptedPromotion(baseOpts);
    if (recovered) {
      log(`[recover] ${recovered.length} interrupted promotion(s): `
        + recovered.map((r) => `${r.runId} (${r.action})`).join(', '));
    }
    const abandoned = recoverAbandonedRuns(baseOpts, log);
    if (abandoned) {
      log(`[recover] ${abandoned.length} abandoned pre-publication run(s): `
        + abandoned.map((r) => `${r.runId} (${r.action})`).join(', '));
    }

    runId = opts.runId || defaultRunId();
    runDir = path.join(paths.stateDir, 'crawl', runId);
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    fs.mkdirSync(path.join(runDir, 'logs'), { recursive: true });

    log('============================================');
    log('  Fail safe collection (spec 0003)');
    log(`  Run: ${runId}`);
    log(`  Mode: ${opts.dryRun ? 'dry run' : opts.push ? 'full (push)' : 'collect (no push)'}`);
    log(`  Model: ${opts.piModel}  Concurrency: ${opts.concurrency}`);
    log('============================================');

    // AC-1: copy the closed database into the ignored run directory before
    // any mutation. This copy is the normal recovery input.
    preRunBackup = db.copyDatabaseForRun(runId, baseOpts);
    log(preRunBackup
      ? `[1/9] pre run DB copy → ${path.relative(dirs.projectRoot, preRunBackup.backupPath)}`
      : '[1/9] pre run DB copy: no database yet (first run)');

    // Lane manifest from current SQLite state + registry.
    const manifest = lanes.buildLaneManifest({ ...baseOpts, runId });
    fs.writeFileSync(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    db.startRun(runId, lanes.toStartRunTasks(manifest), baseOpts);
    mutationStarted = true;
    const kindCounts = manifest.tasks.reduce((acc, t) => {
      acc[t.kind] = (acc[t.kind] || 0) + 1;
      return acc;
    }, {});
    log(`[2/9] manifest: ${manifest.tasks.length} task(s) `
      + `(${Object.entries(kindCounts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}), `
      + `${manifest.lanes.known.assigned_offers} known offer(s) assigned`);

    // Deterministic catalog fetch (no LLM). A failure writes a failed
    // artifact; the reducer then preserves prior offers (AC-6).
    const catalogTasks = manifest.tasks.filter((t) => t.kind === 'catalog');
    if (catalogTasks.length > 0) {
      log(`[3/9] catalog fetch (${catalogTasks.length} provider(s))...`);
      await runCatalog(manifest, runDir, baseOpts, log);
    } else {
      log('[3/9] catalog fetch: no catalog providers, skipped');
    }

    // Known refresh + discovery LLM workers.
    const laneTasks = manifest.tasks.filter(
      (t) => t.kind === 'known_refresh' || t.kind === 'discovery'
    );
    log(`[4/9] lane workers (${laneTasks.length} task(s))...`);
    await runPool(laneTasks, opts.concurrency, (task) => {
      const roleFile = task.kind === 'discovery' ? 'discovery-agent.md' : 'crawl-worker.md';
      const runtime = task.kind === 'discovery'
        ? `Task: discovery. Manifest: ${path.join(runDir, 'manifest.json')}.\n`
          + `Discovery sources (${task.discovery_sources.length}): ${JSON.stringify(task.discovery_sources)}\n`
          + `Search terms (${task.search_terms.length}): ${JSON.stringify(task.search_terms)}\n`
          + `Search windows (${task.search_windows.length}): ${JSON.stringify(task.search_windows)}\n`
          + 'Search exactly these sources, terms, and recency windows from the manifest task snapshot — '
          + 'do not add or drop any. Look for newly announced models and pricing changes within these windows. '
          + 'For any unregistered API provider you find, report a provider_candidate with the fetched official base_url, docs_url, and model id form (AC-11).'
        : `Task: ${task.task_id} (kind: known_refresh). Provider: ${task.provider_key}. `
          + `Assigned model_ids: ${(task.assigned_model_ids || []).join(', ') || '(none)'}. `
          + `Manifest: ${path.join(runDir, 'manifest.json')}. Registry: build/provider-registry.json. `
          + `Cached URLs to try first: ${JSON.stringify((task.cached_urls || []).map((c) => c.url))}. `
          + 'Re-fetch the official docs for each assigned model and report current facts.';
      return runWorker({
        taskId: task.task_id,
        roleFile,
        schemaFile: path.join(dirs.schemasDir, 'crawl-facts.schema.json'),
        outputFile: db.artifactPathFor(runDir, task.task_id),
        logFile: path.join(runDir, 'logs', `${db.sanitizeTaskId(task.task_id)}.log`),
        runtime,
        failureArtifact: factsFailureArtifact(task.task_id, task.provider_key),
      }, opts, baseOpts);
    });

    // Ingest lane artifacts, then deterministic reduction.
    const ingest = lanes.ingestTaskArtifacts(runId, runDir, baseOpts);
    log(`[5/9] ingest: ${summarizeIngest(ingest)}`);
    // Worker candidate claims are untrusted. Fetch all candidate URLs with
    // bounded deterministic HTTP before reduction; only the audited result is
    // then written back in short SQLite transactions.
    const auditInput = db.loadRunCandidate(runId, baseOpts).tasks;
    const audit = await evidence.auditRunEvidence(auditInput, {
      fetchImpl: opts.evidenceFetchImpl || undefined,
      registryPath: db.resolvePaths(baseOpts).registryPath,
      now: nowIso(),
    });
    for (const task of audit.tasks) {
      if (task.result_json) db.updateTaskResult(runId, task.task_id, task.result_json, baseOpts);
    }
    const reduce = lanes.reduceLanes(runId, runDir, baseOpts);
    log(`[5/9] reduce: can_promote=${reduce.canPromote}`
      + (reduce.gateReason ? ` (${reduce.gateReason})` : '')
      + ` known verified=${reduce.coverage.known.verified}/${reduce.coverage.known.assigned}`
      + ` stale=${reduce.coverage.known.stale} removed=${reduce.coverage.known.removed}`);
    if (!reduce.canPromote) {
      log(`  gate blocked promotion; previous report stays live (run ${runId} failed)`);
      if (opts.dryRun) restoreExactPreRun();
      return {
        runId, runDir, promoted: false, deployed: false,
        canPromote: false, gateReason: reduce.gateReason, coverage: reduce.coverage,
      };
    }

    // Benchmark queue + scout workers (only models with no accepted benchmark fact).
    const queue = benchmarks.buildBenchmarkQueue(baseOpts);
    benchmarks.writeBenchmarkQueue(runDir, queue, baseOpts);
    let benchmarkEvidence = {
      sourceBodies: new Map(), sourceHashes: new Map(), fetchCache: new Map(), fetches: [],
    };
    if (queue.queued > 0) {
      const scoutTasks = benchmarkScoutModelTasks(queue);
      db.addRunTasks(runId, scoutTasks.map((task) => ({
        task_id: task.task_id,
        kind: task.kind,
        assigned_model_ids: task.model.offer_ids.map((id) => id.exact_model_id),
      })), baseOpts);
      log(`[6/9] benchmark scouts (${scoutTasks.length} model(s), concurrency ${opts.concurrency})...`);
      benchmarkEvidence = await runBenchmarkScouts({
        runId, runDir, scoutTasks, dirs, opts, baseOpts, log, queue, runWorker,
      });
      const benchmarkTasks = db.loadRunCandidate(runId, baseOpts).tasks
        .filter((task) => task.kind === 'benchmark_scout');
      const finalFetches = await benchmarks.fetchBenchmarkSourceBodies(benchmarkTasks, {
        fetchImpl: opts.evidenceFetchImpl || undefined,
        sourceBodies: benchmarkEvidence.sourceBodies,
        sourceHashes: benchmarkEvidence.sourceHashes,
        fetchCache: benchmarkEvidence.fetchCache,
      });
      benchmarkEvidence.fetches.push(...finalFetches.fetches);
    } else {
      log('[6/9] benchmark scouts: no models without accepted benchmark facts, skipped');
    }
    const benchmarkTasks = db.loadRunCandidate(runId, baseOpts).tasks
      .filter((task) => task.kind === 'benchmark_scout');
    if (benchmarkEvidence.fetches.length > 0) {
      const ok = benchmarkEvidence.fetches.filter((entry) => entry.ok).length;
      log(`  benchmark evidence: ${ok}/${benchmarkEvidence.fetches.length} source(s) fetched`);
    }
    const benchReduce = benchmarks.reduceBenchmarkTasks(runId, runDir, {
      ...baseOpts,
      visionCapable: opts.visionCapable,
      sourceBodies: benchmarkEvidence.sourceBodies,
      sourceHashes: benchmarkEvidence.sourceHashes,
      requireFetchedEvidence: true,
    });
    if (benchReduce.benchmarkChanges.length > 0 || benchReduce.searchChanges.length > 0) {
      db.finalizeRun(runId, {
        benchmarks: benchReduce.benchmarkChanges,
        benchmarkSearches: benchReduce.searchChanges,
      }, baseOpts);
    }
    log(`[6/9] benchmarks: ${benchReduce.accepted.length} accepted, `
      + `${benchReduce.rejected.length} rejected, ${benchReduce.benchmarkChanges.length} new fact(s)`);

    // Candidate view: the deterministic input both LLM judges read.
    const view = assemble.buildCandidateView(baseOpts);
    fs.mkdirSync(path.join(runDir, 'reduced'), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'reduced', 'candidate-view.json'),
      `${JSON.stringify(view, null, 2)}\n`
    );
    log(`[7/9] candidate view: ${view.candidates.length} candidate(s)`);

    // Classifier + editor (both read the candidate view; run together).
    log('[8/9] classifier + editor...');
    await runPool([
      {
        taskId: 'classifier',
        roleFile: 'classifier-agent.md',
        schemaFile: path.join(dirs.schemasDir, 'classifications.schema.json'),
        outputFile: path.join(runDir, 'reduced', 'classifications.json'),
        logFile: path.join(runDir, 'logs', 'classifier.log'),
        runtime: `Candidate view: ${path.join(runDir, 'reduced', 'candidate-view.json')}. `
          + 'Decide the FINAL classification and confidence per candidate and emit them via json_output '
          + 'conforming to schemas/classifications.schema.json.',
        failureArtifact: null,
      },
      {
        taskId: 'editorial',
        roleFile: 'editor-agent.md',
        schemaFile: path.join(dirs.schemasDir, 'editorial.schema.json'),
        outputFile: path.join(runDir, 'candidate', 'editorial.json'),
        logFile: path.join(runDir, 'logs', 'editorial.log'),
        runtime: `Candidate view: ${path.join(runDir, 'reduced', 'candidate-view.json')}. `
          + `Coverage: ${path.join(runDir, 'reduced', 'lane-coverage.json')}. `
          + `Discovery: ${path.join(runDir, 'reduced', 'discovery-candidates.json')}. `
          + 'Write the Japanese prose to editorial.json via json_output conforming to schemas/editorial.schema.json.',
        failureArtifact: null,
      },
    ], opts.concurrency, (spec) => runWorker(spec, opts, baseOpts));

    // Deterministic assembly of the staged report.
    const assembled = assemble.assembleReport(runId, runDir, baseOpts);
    log(`[8/9] assemble: ranked=${assembled.counts.ranked} conditional=${assembled.counts.conditional} `
      + `caution=${assembled.counts.caution} excluded=${assembled.counts.excluded}`);

    // Candidate validation + HTML/OG build + promotion manifest.
    const validated = publication.validateCandidate(runId, runDir, {
      ...baseOpts,
      skipCitationCheck: opts.skipCitation,
    });
    log(`[9/9] validated candidate ${validated.candidateHash.slice(0, 12)} `
      + `(og: ${validated.ogProvenance})`);

    if (opts.dryRun) {
      // A dry run validates and leaves all candidate artifacts for inspection,
      // but its successful state writes are not durable. Restore the exact
      // snapshot taken before startRun; the run directory remains available,
      // and its validated candidate is intentionally not promotable later.
      restoreExactPreRun();
      log('  dry run: candidate validated, DB restored to the exact pre-run state. Inspect:');
      log(`    ${path.join(runDir, 'candidate', 'report.json')}`);
      return {
        runId, runDir, dryRun: true, promoted: false, deployed: false,
        canPromote: true, candidateHash: validated.candidateHash,
        counts: assembled.counts, coverage: reduce.coverage,
      };
    }

    publication.promoteGeneration(runId, runDir, baseOpts);
    log('  promoted canonical files (report.json, index.html, og-image.png, registry)');

    let deployed = false;
    if (opts.push) {
      const deployResult = publication.deployGeneration(runId, runDir, baseOpts);
      deployed = deployResult.deployed;
      log(deployed
        ? `  deployed: committed and pushed (run ${runId} promoted)`
        : `  push failed: run ${runId} kept as validated_not_deployed for deploy retry`);
    } else {
      log('  collect mode: promoted locally, not pushed. Run `npm run deploy` to publish.');
    }

    return {
      runId, runDir, promoted: true, deployed, canPromote: true,
      candidateHash: validated.candidateHash, counts: assembled.counts,
      coverage: reduce.coverage,
    };
  } catch (err) {
    // A thrown failure before the publication manifest reaches db_finalized
    // may follow one or more committed SQLite reductions. Roll back the
    // whole current state to this run's exact pre-run snapshot, never to a
    // different run's newest copy. Once DB finalization is safely recorded,
    // leave the generation intact for deploy retry.
    const safeFinalized = runDir ? hasSafelyFinalizedPromotion(runDir, runId, baseOpts) : false;
    if (mutationStarted && !safeFinalized && !restoreAttempted) {
      try {
        restoreExactPreRun();
      } catch {
        // The combined error below reports both the pipeline and restore
        // failures; no later publication or recovery is attempted here.
      }
    }
    if (mutationStarted && !safeFinalized && restoreFailure) {
      throw new Error(
        `collection failed: ${err.message}; exact pre-run DB restore failed: ${restoreFailure.message}`
      );
    }
    throw err;
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = {
  runPipeline,
  // exported for tests
  runPool,
  runBenchmarkScouts,
  benchmarkScoutModelTasks,
  defaultRunId,
  acquireLock,
  releaseLock,
  runCatalogInProcess,
  recoverAbandonedRuns,
  hasSafelyFinalizedPromotion,
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  const options = {
    dryRun: argv.includes('--dry-run'),
    push: argv.includes('--push'),
    skipCitation: argv.includes('--skip-citation') || process.env.SKIP_CITATION_CHECK === '1',
    visionCapable: argv.includes('--vision'),
  };
  runPipeline(options).then((result) => {
    console.log(JSON.stringify({
      run_id: result.runId,
      promoted: result.promoted,
      deployed: result.deployed,
      can_promote: result.canPromote,
      gate_reason: result.gateReason || null,
      candidate_hash: result.candidateHash || null,
      counts: result.counts || null,
    }, null, 2));
    if (!result.canPromote) process.exitCode = 2;
    else if (options.push && !result.deployed) process.exitCode = 3;
  }).catch((err) => {
    console.error(`collect failed: ${err.message}`);
    process.exitCode = 1;
  });
}
