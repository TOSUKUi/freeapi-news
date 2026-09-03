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
// and the pi workers and the catalog fetch are injectable (`runWorker`,
// `runCatalog`, `aggregatedIndexFetchHtml`), so the whole pipeline runs
// against an isolated fixture project with no network and no pi.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const db = require('./collector-db');
const lanes = require('./lanes');
const benchmarks = require('./benchmarks');
const assemble = require('./assemble');
const publication = require('./publication');
const catalog = require('./catalog');
const priceIndex = require('./price-index');
const aggregatedIndex = require('./aggregated-index');
const evidence = require('./evidence');
const watch = require('./watch');
const modelsLane = require('./models');
const observe = require('./observe');
const { loadWatchlist } = require('../../build/research-watchlist');

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

// Reads a JSON file when present and parseable; returns null otherwise.
function readJsonIfPresent(filePath) {
  try {
    const body = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(body);
  } catch {
    return null;
  }
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

// Spec 0007: the discovery crawlers hunt news inside a fixed recency window
// (DISCOVERY_WINDOW_DAYS, default 7). Maps the window to a web-search-plus
// --time-range value; the worker still filters results against the exact
// window before reporting a fact.
function discoveryWindowDays(env = process.env) {
  const raw = env.DISCOVERY_WINDOW_DAYS;
  if (raw === undefined || raw === '') return 7;
  const value = Number.parseInt(raw, 10);
  return Number.isInteger(value) && value >= 1 ? value : 7;
}

function windowFromDays(days) {
  if (days <= 2) return 'day';
  if (days <= 7) return 'week';
  if (days <= 31) return 'month';
  return 'year';
}

function discoverySearchTimeRange(env = process.env) {
  return windowFromDays(discoveryWindowDays(env));
}

// The research web sessions (news scan, vendor deep dive, community, model
// fan out, provider monitor, product/program monitor, nim verify) investigate
// with web search (web-search-plus CLI) and a real browser (pi `browser` tool
// on the camofox server). The transport text is appended to the role prompt
// at runtime; the prompt file owns the output contract and the worker budget.
function isDiscoveryTransport(spec) {
  return spec.transport === 'discovery';
}

function discoveryTransportText(spec, visitBudgetOverride) {
  if (!isDiscoveryTransport(spec)) return '';
  const session = `disc-${db.sanitizeTaskId(spec.taskId)}`;
  const sessionRule = `Every browser call must pass session: "${session}" so parallel workers stay isolated.`;
  const searchBudget = spec.searchBudget ?? 4;
  const visitBudget = visitBudgetOverride ?? spec.visitBudget ?? 8;
  return '\n\n## Discovery transport (web search + browser)\nThis is a research task with a bounded transport. Work in this order:\n'
    + `1. Search: run at most ${searchBudget} Bash searches phrased for your goal: \`web-search-plus --provider auto --query "<your query>" --time-range ${spec.searchTimeRange || 'week'} --max-results 5 --compact\`. `
    + 'If the CLI fails or returns nothing usable, fall back to browser search-engine queries (browser action=search, engine=bing, query=<your query>; Google often serves a captcha to this host, so do not use google) and keep at most 5 results per search.\n'
    + '2. Pick the most promising results. Prefer official provider pages (vendor site, docs, pricing, announcements). Ignore social media, aggregator listicles, and paywalled results unless they link to an official page. A result counts only if its date falls inside the assigned recency window.\n'
    + `3. Verify with the browser: browser action=open with the URL, then browser action=snapshot to read the page. If a news page links to the official announcement, follow that link ONCE (official domain only) and snapshot that page instead. At most ${visitBudget} page visits total.\n`
    + '4. Extract raw facts verbatim from pages you actually saw: exact model id, pricing, free quota, endpoint. Never write a value you did not see on the page.\n'
    + `5. ${sessionRule}\n`
    + 'When done (or when the budget is used up): emit json_output once (an empty output with status complete is a valid result), then browser action=close_session.\n';
}

// Runs one pi worker. The role contract (prompts/*.md) is prepended to the
// runtime parameters; --json-schema/--json-output (via @nqbao/pi-json-schema)
// force schema conforming output written straight to outputFile. A worker that
// exits without a usable JSON output is retried once, because local models can
// spend their turn researching and miss the final json_output call.
function runPiWorker(spec, options, baseOpts) {
  const dirs = skillDirs(baseOpts);
  const role = fs.readFileSync(path.join(dirs.promptsDir, spec.roleFile), 'utf8');
  const schema = fs.readFileSync(spec.schemaFile, 'utf8');
  const satelliteSearch = process.env.WSP_SATELLITE_URL
    ? '\n\n## Search transport\nWhen search is needed, use Bash to run the local `web-search-plus` command. '
      + 'It is configured for satellite mode and is the supported search route for this worker. '
      + 'Do not call a hosted web_search tool. Example: `web-search-plus --provider auto --query "..." '
      + '--time-range week --max-results 5 --compact`.\n'
    : '';

  fs.mkdirSync(path.dirname(spec.outputFile), { recursive: true });

  // Spec 0006: discovery workers get the browser tool. Known, catalog,
  // benchmark, and editorial workers keep the minimal bash/read/json_output
  // surface so their sessions stay small and cheap.
  const isDiscovery = isDiscoveryTransport(spec);
  const retryCount = Math.max(0, Number(spec.retryCount ?? options.workerRetries ?? 1));
  const spawnWorker = options.spawnImpl || spawn;
  // On retry, halve the discovery budget: a session that already burned its
  // full budget without a conforming output is unlikely to finish on a second
  // full pass — it should re-verify only the highest-value facts (operator
  // 2026-08-25: the retry tax was ~9 sessions × up to 30 min per run).
  const baseTimeout = (spec.timeoutSeconds ?? options.piTimeout);
  const attemptTimeout = (attempt) => {
    if (attempt <= 1 || !isDiscovery) return baseTimeout;
    return Math.max(120, Math.round(baseTimeout / 2));
  };
  const attemptVisitBudget = (attempt) => {
    if (attempt <= 1 || !isDiscovery) return undefined;
    return Math.max(1, Math.ceil((spec.visitBudget ?? 8) / 2));
  };
  // Rebuild the prompt + args per attempt: the discovery transport text
  // carries the (halved) visit budget, so a retry gets a smaller prompt too.
  const buildArgs = (attempt) => [
    '--skill', dirs.skillDir,
    '--model', options.piModel,
    '--approve',
    '--no-session',
    '--json-schema', schema,
    '--json-output', spec.outputFile,
    '--json-fallback', 'force',
    '--no-context-files',
    '--thinking', 'low',
    '--tools', isDiscovery ? 'bash,read,json_output,browser' : 'bash,read,json_output',
    ...(process.env.WSP_SATELLITE_URL ? ['--exclude-tools', 'web_search'] : []),
    '-p', `${role}\n\n---\n\n## This run\n\n${spec.runtime}\n${satelliteSearch}${discoveryTransportText(spec, attemptVisitBudget(attempt))}`,
  ];

  function outputIsUsable() {
    if (!fs.existsSync(spec.outputFile)) return false;
    try {
      const value = JSON.parse(fs.readFileSync(spec.outputFile, 'utf8'));
      return !!value && typeof value === 'object' && !Array.isArray(value);
    } catch {
      return false;
    }
  }

  return new Promise((resolve) => {
    let attempt = 0;
    const runAttempt = () => {
      attempt += 1;
      try { fs.rmSync(spec.outputFile, { force: true }); } catch { /* best effort */ }
      const logStream = fs.openSync(spec.logFile, attempt === 1 ? 'w' : 'a');
      let settled = false;
      const finish = (exitCode = null, signal = null, error = null) => {
        if (settled) return;
        settled = true;
        try { fs.closeSync(logStream); } catch { /* ok */ }
        // A timeout/termination may leave a partial fallback JSON file behind;
        // never accept that as a successful worker result.
        const usable = !error && exitCode === 0 && !signal && outputIsUsable();
        const diagnostic = error
          ? `error=${error.message}`
          : `exit=${exitCode === null ? 'null' : exitCode} signal=${signal || 'none'}`;
        try {
          fs.appendFileSync(spec.logFile,
            `[worker] attempt ${attempt}/${retryCount + 1} ${diagnostic} output=${usable ? 'ok' : 'missing-or-invalid'}\\n`);
        } catch { /* diagnostics must not mask the pipeline result */ }
        const retryable = !error && !signal && exitCode !== null && exitCode !== 143;
        if (usable || attempt > retryCount || !retryable) {
          if (!usable && spec.failureArtifact) {
            fs.writeFileSync(
              spec.outputFile,
              `${JSON.stringify(spec.failureArtifact, null, 2)}\\n`
            );
            options.log(`     └─ ${spec.taskId}: no conforming output after ${attempt} attempt(s), wrote failure artifact`);
          }
          resolve(spec.taskId);
          return;
        }
        runAttempt();
      };
      let child;
      try {
        child = spawnWorker('pi', buildArgs(attempt), {
          stdio: ['ignore', logStream, logStream],
          // Discovery gets its own budget because it is intentionally more
          // exploratory than the known-offer, benchmark, and editorial workers.
          timeout: attemptTimeout(attempt) * 1000,
        });
      } catch (error) {
        finish(null, null, error);
        return;
      }
      child.on('error', (error) => finish(null, null, error));
      child.on('close', (code, signal) => finish(code, signal));
    };
    runAttempt();
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

// Spec 0008: failure artifacts for the vendor-facts shaped workers. The
// reducer treats a failed worker as zero facts; the failure artifact keeps
// the shape valid so ingest never records an identity error on top of the
// real worker failure.
function vendorFactsFailureArtifact(taskId, vendorKey) {
  return {
    schema_version: 1,
    task_id: taskId,
    status: 'failed',
    crawled_at: nowIso(),
    vendor_key: vendorKey || '_multi',
    announcements: [],
    pricing_claims: [],
    distribution: [],
    leads: [],
    errors: ['worker did not produce conforming output'],
  };
}

function leadsFailureArtifact(taskId) {
  return {
    schema_version: 1,
    task_id: taskId,
    status: 'failed',
    crawled_at: nowIso(),
    leads: [],
    errors: ['worker did not produce conforming output'],
  };
}

// Spec 0008 Phase 3: failure artifacts for the product / program monitors.
function productFactsFailureArtifact(taskId) {
  return {
    schema_version: 1,
    task_id: taskId,
    status: 'failed',
    crawled_at: nowIso(),
    provider_key: null,
    products: [],
    errors: ['worker did not produce conforming output'],
  };
}

function programFactsFailureArtifact(taskId) {
  return {
    schema_version: 1,
    task_id: taskId,
    status: 'failed',
    crawled_at: nowIso(),
    provider_key: null,
    programs: [],
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
  const priceIndexTasks = (manifest.tasks || []).filter((t) => t.kind === 'price_index');
  const aggregatedIndexTasks = (manifest.tasks || []).filter((t) => t.kind === 'aggregated_index');
  if (catalogTasks.length === 0 && priceIndexTasks.length === 0 && aggregatedIndexTasks.length === 0) return;
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

  // 0013 price-index lane: static llmpricing.dev fetches, pure code (no LLM).
  for (const task of priceIndexTasks) {
    let artifact;
    try {
      artifact = await priceIndex.fetchPriceIndex({});
    } catch (err) {
      artifact = {
        schema_version: 1,
        task_id: task.task_id,
        kind: 'price_index',
        provider_key: null,
        status: 'failed',
        available: false,
        models: [],
        fetches: [],
        errors: [err.message],
      };
    }
    artifact.task_id = task.task_id;
    const outPath = db.artifactPathFor(runDir, task.task_id);
    fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    if (artifact.available) {
      log(`  ✅ price_index: ${artifact.models.length} model page(s) from ${artifact.index_model_count} indexed`);
    } else {
      log(`  ❌ price_index unavailable (${artifact.errors[0] || 'unknown'}); prior offers preserved`);
    }
  }

  // Aggregated-index lane: freellm.net models + base-URL README, pure code
  // (no LLM). Failures preserve prior offers like any other lane.
  for (const task of aggregatedIndexTasks) {
    let artifact;
    try {
      artifact = await aggregatedIndex.fetchAggregatedIndex({
        fetchHtml: baseOpts.aggregatedIndexFetchHtml,
      });
    } catch (err) {
      artifact = {
        schema_version: 1,
        task_id: task.task_id,
        kind: 'aggregated_index',
        provider_key: null,
        status: 'failed',
        available: false,
        models: [],
        base_urls: {},
        fetches: [],
        errors: [err.message],
      };
    }
    artifact.task_id = task.task_id;
    const outPath = db.artifactPathFor(runDir, task.task_id);
    fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    if (artifact.available) {
      const freeHits = artifact.models.filter((m) => m.is_free_signal).length;
      log(`  ✅ aggregated_index: ${artifact.models.length} model(s) from freellm.net, ${freeHits} free-signal, ${Object.keys(artifact.base_urls).length} base URLs`);
    } else {
      log(`  ❌ aggregated_index unavailable (${(artifact.errors || ['unknown'])[0]}); prior offers preserved`);
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

// Display-relevant pre-filter (operator 2026-08-25): the classifier and
// editor only need candidates that can actually reach the report — those
// with a ranking benchmark, a frontier discount, caution status, or an
// explicit trial / campaign / conditional signal in their facts. The
// remaining ~180 candidates are excluded by deterministic gates no matter
// what the classifier says, so classifying them is pure LLM spend (was 4
// chunk sessions + a huge editor read per run). Dropped candidates keep
// their provisional classification.
function displayRelevantCandidate(x) {
  const bench = x.benchmark || {};
  const hasBench = x.tier !== undefined && x.tier !== null
    && typeof bench.score === 'number' && bench.score >= 50;
  if (hasBench || x.access_kind === 'DISCOUNTED' || x.in_caution) return true;
  const text = [x.free_limits, x.description, x.registration_conditions]
    .filter((s) => typeof s === 'string')
    .join(' ').toLowerCase();
  return /trial|one[- ]?time|launch credit|free credit|data sharing|data used for training|opt[- ]?in|preview|prototype|campaign|limited[- ]?(time|period)|\u671f\u9593\u9650\u5b9a|free until/.test(text);
}

async function runPipeline(options = {}) {
  const opts = {
    dryRun: false,
    push: false,
    skipCitation: false,
    visionCapable: false,
    concurrency: Number(process.env.GLOBAL_CONCURRENCY || 3),
    piModel: process.env.PI_MODEL || 'litellm/deepseek-v4-flash',
    piTimeout: Number(process.env.PI_TIMEOUT || 1800),
    // Spec 0006: discovery workers now drive a real browser, so the per-chunk
    // budget is 5 minutes instead of the old 3 minute curl budget.
    discoveryTimeout: Number(process.env.DISCOVERY_TIMEOUT || 600),
    workerRetries: Number(process.env.PI_RETRIES || 1),
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
      const restored = db.restoreExactRunDatabase(preRunBackup, baseOpts);
      // Mark the promotion manifest terminal. Without this, a later startup
      // recovery sees the 'prepared' phase and restores this run's (older)
      // pre run backup on top of newer schema state.
      const manifestPath = path.join(runDir, 'promotion-manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          manifest.phase = 'restored';
          manifest.phase_at = manifest.phase_at || {};
          manifest.phase_at.restored = new Date().toISOString();
          manifest.restore_reason = 'exact pre-run database restored';
          fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        } catch { /* manifest bookkeeping never fails the restore */ }
      }
      return restored;
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
    // A recovered exact pre run backup can predate the newest migrations
    // (the backup is a byte copy taken before this run upgraded anything).
    // Re-apply idempotently so the restored file reaches the current schema.
    const reMigrated = db.applyMigrations(baseOpts);
    if (reMigrated.applied && reMigrated.applied.length) {
      log(`[1/9] migrations re-applied after recovery: ${reMigrated.applied.join(', ')}`);
    }
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

    // Wall-clock phase instrumentation. Every expensive stage stamps a line
    // with the elapsed seconds since the run started so a slow run can be
    // attributed to a phase without grepping file mtimes.
    const phaseStart = Date.now();
    const markPhase = (name, extra = '') => {
      const elapsed = ((Date.now() - phaseStart) / 1000).toFixed(1);
      log(`⏱ [t+${elapsed}s] ${name}${extra ? ` ${extra}` : ''}`);
    };
    markPhase('run started');

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
      markPhase('catalog fetch done');
    } else {
      log('[3/9] catalog fetch: no catalog providers, skipped');
    }

    // Spec 0008: deterministic research watch. Fetches every watchlist
    // channel in process (no LLM), records per-run watch_facts snapshots,
    // and derives hash based change signals. Fetch failures are signals, not
    // run failures: the watch lane is addition only.
    let watchlist = null;
    let watchSignals = [];
    try {
      watchlist = loadWatchlist(paths.watchlistPath);
    } catch (err) {
      log(`  watchlist unreadable (${err.message}); research lanes skipped`);
    }
    const watchTasks = manifest.tasks.filter((t) => t.kind === 'watch');
    if (watchTasks.length > 0 && watchlist) {
      log(`[3/9] watch fetch (${watchTasks.length} channel(s))...`);
      const watchResult = await watch.runWatchPhase({
        runId, runDir, baseOpts, watchlist,
        fetchImpl: opts.watchFetchImpl || undefined, log,
      });
      watchSignals = watchResult.signals;
      log(`  watch: ${watchResult.summary.ok}/${watchResult.summary.channels} ok, `
        + `${watchResult.summary.changed} changed, ${watchResult.summary.first_seen} first seen, `
        + `${watchResult.summary.fetch_failed} fetch failed`);
      markPhase('watch fetch done');
    } else {
      log('[3/9] watch fetch: no watch channels, skipped');
    }

    // Spec 0008: deterministic new model detection from this run's catalog
    // artifacts and the HF new-models feed, against the models table. Dated
    // in-window newcomers become model fan out tasks (0..3 per day); undated
    // catalog newcomers are registered as baseline rows without fan out.
    const fanoutTasks = [];
    const catalogArtifacts = modelsLane.readCatalogArtifacts(runDir);
    if (watchlist) {
      const detection = modelsLane.detectNewModels({
        runDir, baseOpts, now: nowIso(), watchlist,
        windowDays: discoveryWindowDays(),
      });
      const stamp = nowIso();
      for (const baseline of detection.baselines) {
        db.upsertModel(baseline.model_id, {
          display_name: baseline.display_name,
          release_date: baseline.release_date || undefined,
          source_url: baseline.source_url || undefined,
          last_run_id: runId,
          last_seen_at: stamp,
        }, baseOpts);
      }
      fanoutTasks.push(...modelsLane.planFanoutTasks(
        detection.candidates, catalogArtifacts, watchlist));
      log(`[3/9] models: ${detection.baselines.length} baseline row(s), `
        + `${detection.candidates.length} new model candidate(s) -> ${fanoutTasks.length} fan out task(s)`
        + (detection.deferred_candidates.length > 0
          ? `, ${detection.deferred_candidates.length} deferred` : ''));
    }

    // Spec 0008 Phase 2: deterministic router market observer (D5). For
    // every openrouter offer that is free or a known offer, read the public
    // endpoints API and store provider count / uptime as Gate 3 evidence.
    // Bounded: 120 calls/day, 250ms interval, 24h cache in watch_facts.
    if (watchlist) {
      const orCatalog = catalogArtifacts.find((a) => a && a.provider_key === 'openrouter') || null;
      const orOffers = db.listOffersByProvider('openrouter', baseOpts);
      const orResult = await watch.observeOrEndpoints({
        runId, runDir, baseOpts,
        fetchImpl: opts.watchFetchImpl || undefined,
        now: nowIso(),
        catalogArtifact: orCatalog,
        offers: orOffers,
        log,
      });
      const orSummary = orResult.summary;
      log(`[3/9] or_endpoints: ${orSummary.models} model(s), ${orSummary.fetched} fetched, ${orSummary.cached} cached, ${orSummary.failed} failed`);
    }

    // Spec 0008 Phase 2: deterministic community prefilter. Fetches the
    // community feeds (reddit / HN / GitHub) and keeps only items that name
    // a known model, alias, or registry provider. The candidates are the
    // community worker's input; the LLM extracts leads only.
    let prefilterCandidates = [];
    if (watchlist) {
      const rawRegistry = JSON.parse(fs.readFileSync(paths.registryPath, 'utf8'));
      const registryProviders = Array.isArray(rawRegistry) ? rawRegistry : rawRegistry.providers || [];
      prefilterCandidates = await watch.prefilterCommunity({
        runId, runDir, baseOpts,
        fetchImpl: opts.watchFetchImpl || undefined,
        now: nowIso(),
        watchlist,
        models: db.listModels(baseOpts),
        providerNames: registryProviders.map((p) => p.key),
        log,
      });
      log(`[3/9] community prefilter: ${prefilterCandidates.length} candidate(s)`);
    }

    // Spec 0008: the research worker plan. news_scan always runs once; the
    // community worker always runs once (an empty prefilter is a valid
    // zero-lead day); vendor deep dives are signal driven plus the tier 1
    // 7 day rotation; model fan out runs only for detected new models. A
    // quiet day therefore costs exactly two research sessions.
    const researchTasks = [];
    if (watchlist) {
      researchTasks.push(watch.planNewsScanTask(watchlist));
      researchTasks.push(watch.planCommunityTask(watchSignals, prefilterCandidates));
      for (const vt of watch.planVendorTasks(watchSignals, watchlist, new Date())) {
        researchTasks.push({
          task_id: `vendor:${vt.key}`,
          kind: 'vendor_deep_dive',
          provider_key: null,
          assigned_model_ids: [],
          vendor_key: vt.key,
          vendor_reason: vt.reason,
          vendor_changed_urls: vt.changed_urls,
        });
      }
      // Spec 0008 Phase 2: NIM per-model verification (small browser
      // session, one visit per candidate model) and the provider monitors
      // (4-6 LLM-side providers per session, always run; catalog discount
      // signals ride along as hints).
      const nvidiaCatalog = catalogArtifacts.find((a) => a && a.provider_key === 'nvidia') || null;
      const nimTask = watch.planNimVerifyTask(baseOpts, nvidiaCatalog);
      if (nimTask) researchTasks.push(nimTask);
      const discountSignals = observe.catalogDiscountSignals(
        catalogArtifacts, db.knownNormalPricesByCanonical(baseOpts));
      // Provider coverage from the deterministic aggregated-index lane
      // (freellm.net), read from this run's artifacts. Providers the index
      // verified as free this run get spot-check (not full-sweep) visits.
      const aggIndexTasks = manifest.tasks.filter((t) => t.kind === 'aggregated_index');
      const indexedProviders = new Set();
      for (const t of aggIndexTasks) {
        const artPath = db.artifactPathFor(runDir, t.task_id);
        if (!fs.existsSync(artPath)) continue;
        try {
          const art = JSON.parse(fs.readFileSync(artPath, 'utf8'));
          if (!art.available || !Array.isArray(art.models)) continue;
          for (const m of art.models) {
            if (m && m.is_free_signal && m.verified_free && typeof m.provider_key === 'string') {
              indexedProviders.add(m.provider_key);
            }
          }
        } catch { /* artifact unreadable: treat as no coverage */ }
      }
      researchTasks.push(...watch.planProviderMonitorTasks(watchlist, watchSignals, discountSignals, {
        indexed_providers: indexedProviders,
      }));
      // Spec 0008 Phase 3: product / program monitors run only when the
      // deterministic watch found a hash change (one bundled session each).
      researchTasks.push(...watch.planProductProgramTasks(watchSignals, watchlist));
      researchTasks.push(...fanoutTasks);
    }

    // Research tasks are planned at runtime (after the watch phase), so they
    // are not part of the static manifest. Register them in the run before
    // the workers start; ingestTaskArtifacts only validates task rows that
    // exist, and reduceLanes only reduces rows with recorded results.
    if (researchTasks.length > 0) {
      const added = db.addRunTasks(runId, researchTasks, baseOpts);
      log(`  research plan: ${researchTasks.length} worker task(s) registered (${added.added} new)`);
    }

    // Known refresh + discovery LLM workers, plus the spec 0008 research
    // workers (news_scan / vendor / community / model_fanout).
    const laneTasks = manifest.tasks.filter(
      (t) => t.kind === 'known_refresh' || t.kind === 'discovery'
    );
    const allWorkerTasks = [...laneTasks, ...researchTasks];
    log(`[4/9] lane workers (${allWorkerTasks.length} task(s): ${laneTasks.length} legacy, ${researchTasks.length} research)...`);
    await runPool(allWorkerTasks, opts.concurrency, (task) => {
      let roleFile;
      let schemaName = 'crawl-facts.schema.json';
      let runtime;
      let failureArtifact;
      let transport = undefined;
      let searchBudget = undefined;
      let visitBudget = undefined;
      let searchTimeRange = undefined;
      let timeoutSeconds = opts.piTimeout;
      if (task.kind === 'news_scan') {
        roleFile = 'news-scan.md';
        schemaName = 'vendor-facts.schema.json';
        transport = 'discovery';
        searchBudget = 6;
        visitBudget = 8;
        searchTimeRange = 'day';
        timeoutSeconds = opts.discoveryTimeout;
        failureArtifact = vendorFactsFailureArtifact(task.task_id, '_multi');
        const vendorLines = (watchlist && watchlist.vendors || [])
          .map((v) => `${v.key} (${v.label})`).join(', ');
        const signals = watchSignals
          .filter((s) => s.status === 'changed' || s.status === 'first_seen')
          .map((s) => ({
            entity: s.entity_key,
            url: s.url,
            status: s.status,
            new_items: (s.new_items || []).slice(0, 10),
            summary: (s.summary || '').slice(0, 200),
          }));
        runtime = `Task: ${task.task_id}. Vendor list to cover: ${vendorLines}. `
          + `Recency windows: hot = last 24h, warm = last 72h; facts older than 72h are not news.\n`
          + "Triage signals (deterministic hash diffs from today's watch fetch; each is a hint, verify on the page before using it):\n"
          + JSON.stringify(signals, null, 1);
      } else if (task.kind === 'vendor_deep_dive') {
        roleFile = 'vendor-deep-dive.md';
        schemaName = 'vendor-facts.schema.json';
        transport = 'discovery';
        searchBudget = 2;
        visitBudget = 4;
        timeoutSeconds = opts.discoveryTimeout;
        failureArtifact = vendorFactsFailureArtifact(task.task_id, task.vendor_key);
        const vendor = (watchlist && watchlist.vendors || []).find((v) => v.key === task.vendor_key) || {};
        const channelLines = Object.entries(vendor.channels || {})
          .filter(([, v]) => typeof v === 'string' && v.trim())
          .map(([k, v]) => `- ${k}: ${v}`).join('\n');
        runtime = `Task: ${task.task_id}. Vendor: ${vendor.label || task.vendor_key} (key ${task.vendor_key}). Reason: ${task.vendor_reason}.\n`
          + (task.vendor_reason === 'signal' || task.vendor_reason === 'signal+rotation'
            ? 'Changed URLs to investigate (at most 4 page visits total):\n'
              + (task.vendor_changed_urls || []).map((u) => `- ${u}`).join('\n')
            : 'Rotation run: no channel changed today. Re-read the model catalog or changelog (at most 4 page visits total).\n'
              + channelLines);
      } else if (task.kind === 'community') {
        roleFile = 'community-leads.md';
        schemaName = 'leads.schema.json';
        transport = 'discovery';
        searchBudget = 2;
        visitBudget = 4;
        searchTimeRange = 'day';
        timeoutSeconds = opts.discoveryTimeout;
        failureArtifact = leadsFailureArtifact(task.task_id);
        const prefilter = (task.prefilter || []).map((p) => ({
          entity: p.entity_key,
          url: p.url,
          status: p.status,
          new_items: (p.new_items || []).slice(0, 20),
        }));
        const candidates = (task.candidates || []).map((c) => ({
          source: c.entity,
          url: c.url,
          title: c.title,
          snippet: c.snippet,
        }));
        runtime = `Task: ${task.task_id}. Prefilter (community feed items that changed since the last run; empty means no changed items):\n`
          + JSON.stringify(prefilter, null, 1) + '\n'
          + 'Deterministic prefilter candidates (feed items from the last day that name a known model, alias, or provider; verify on the page before using any claim):\n'
          + JSON.stringify(candidates, null, 1);
      } else if (task.kind === 'model_fanout') {
        roleFile = 'model-fanout.md';
        schemaName = 'vendor-facts.schema.json';
        transport = 'discovery';
        searchBudget = 4;
        visitBudget = 6;
        searchTimeRange = 'week';
        timeoutSeconds = opts.discoveryTimeout;
        failureArtifact = vendorFactsFailureArtifact(task.task_id, null);
        const m = task.model || {};
        runtime = `Task: ${task.task_id}. New model: ${m.model_id}`
          + (m.display_name && m.display_name !== m.model_id ? ` (${m.display_name})` : '')
          + `. Detected via: ${m.reason}`
          + (m.release_date ? `, release date ${m.release_date}` : '') + '.\n'
          + 'Catalog verdicts (machine-verified this run; do NOT re-check these providers, carry the verdicts into distribution):\n'
          + JSON.stringify(task.catalog_verdicts || [], null, 1) + '\n'
          + `Routes to check on official pages: ${JSON.stringify(task.routes_to_check || [])}. `
          + 'Emit an explicit distribution verdict (served / not_served / unconfirmed) for every route. '
          + 'Free, ultra-low, or discount routes also get a models[] offer-facts entry with verbatim pricing, base_url, and endpoint_source.';
      } else if (task.kind === 'provider_monitor') {
        roleFile = 'provider-monitor.md';
        schemaName = 'crawl-facts.schema.json';
        transport = 'discovery';
        searchBudget = 1;
        visitBudget = task.visit_budget || 12;
        timeoutSeconds = opts.discoveryTimeout;
        failureArtifact = factsFailureArtifact(
          task.task_id, task.provider_keys ? task.provider_keys.join(',') : null);
        const watchLines = (task.watch_urls || [])
          .map((w) => `- ${w.provider_key} ${w.channel}: ${w.url}`).join('\n');
        const spotNote = task.spot_check
          ? '\nThe deterministic aggregated free-model index already verified these providers as free this run; only visit a watch URL when you need to confirm a change. This is a spot check, not a sweep (at most 3 visits).'
          : '';
        runtime = `Task: ${task.task_id}. Providers in this session: ${(task.provider_keys || []).join(', ')}.\n`
          + 'Watch URLs (deterministic watch):\n' + watchLines + '\n'
          + (task.changed_urls && task.changed_urls.length
            ? `Changed watch URLs, investigate these first (at most ${visitBudget} visits total):\n${task.changed_urls.map((u) => `- ${u}`).join('\n')}\n`
            : `No watch changes today: verify the current facts on the watch URLs (at most ${visitBudget} visits total).\n`)
          + 'Catalog discount signals (deterministic price drops vs known normal prices; a hint, verify on the page):\n'
          + JSON.stringify(task.discount_signals || [], null, 1) + spotNote + '\n'
          + 'Report only changed or newly evidenced facts with verbatim pricing text and the fetched source URL. '
          + 'For discount claims report normal and effective amounts separately.';
      } else if (task.kind === 'product_monitor' || task.kind === 'program_monitor') {
        const isProduct = task.kind === 'product_monitor';
        roleFile = isProduct ? 'product-monitor.md' : 'program-monitor.md';
        schemaName = isProduct ? 'product-facts.schema.json' : 'program-facts.schema.json';
        transport = 'discovery';
        searchBudget = 0;
        visitBudget = 8;
        timeoutSeconds = opts.discoveryTimeout;
        failureArtifact = isProduct
          ? productFactsFailureArtifact(task.task_id)
          : programFactsFailureArtifact(task.task_id);
        const entryLines = (task.entries || [])
          .map((e) => `- ${e.key} (${e.label}): ${e.url} [${e.channel}]`)
          .join('\n');
        const diffLines = (task.entries || [])
          .flatMap((e) => (e.new_items || []).map((n) => `  ${e.key}: ${n}`))
          .join('\n');
        runtime = `Task: ${task.task_id}. Changed ${isProduct ? 'product' : 'program'} channels this run:\n`
          + entryLines + '\n'
          + (diffLines ? `Deterministic diff (hints of what changed):\n${diffLines}\n` : '')
          + 'Watchlist entries (extra URLs you may visit):\n'
          + JSON.stringify((task.entries || []).map((e) => ({ key: e.key, ...e.watchlist_urls })), null, 1) + '\n'
          + `Emit one ${isProduct ? 'products[]' : 'programs[]'} entry per changed key, with the watchlist key verbatim and the fetched source_url.`;
      } else if (task.kind === 'nim_verify') {
        roleFile = 'nim-verify.md';
        schemaName = 'crawl-facts.schema.json';
        transport = 'discovery';
        searchBudget = 0;
        visitBudget = Math.max(1, (task.assigned_model_ids || []).length);
        timeoutSeconds = opts.discoveryTimeout;
        failureArtifact = factsFailureArtifact(task.task_id, 'nvidia');
        const modelLines = (task.assigned_model_ids || [])
          .map((id, i) => `- ${id} -> ${task.check_urls ? task.check_urls[i] : null}`).join('\n');
        runtime = `Task: ${task.task_id}. Open each NVIDIA model page below and record the free endpoint status and API call count:\n`
          + modelLines + '\n'
          + 'For every model emit one models[] entry with model_id, free_endpoint_status (available / deprecated), '
          + 'api_calls_30d (integer when visible, else null), and evidence_url. '
          + 'Do not report prices; the catalog lane handles pricing.';
      } else {
        roleFile = 'crawl-worker.md';
        failureArtifact = factsFailureArtifact(task.task_id, task.provider_key);
        runtime = `Task: ${task.task_id} (kind: known_refresh). Provider: ${task.provider_key}. `
          + `Assigned model_ids: ${(task.assigned_model_ids || []).join(', ') || '(none)'}. `
          + `Manifest: ${path.join(runDir, 'manifest.json')}. Registry: build/provider-registry.json. `
          + `Cached URLs to try first: ${JSON.stringify((task.cached_urls || []).map((c) => c.url))}. `
          + 'Re-fetch the official docs for each assigned model and report current facts. '
          + 'Do not search benchmark sources or emit benchmark_finds; the dedicated benchmark_scout stage handles benchmark lookup.';
      }
      return runWorker({
        taskId: task.task_id,
        roleFile,
        schemaFile: path.join(dirs.schemasDir, schemaName),
        outputFile: db.artifactPathFor(runDir, task.task_id),
        logFile: path.join(runDir, 'logs', `${db.sanitizeTaskId(task.task_id)}.log`),
        runtime,
        transport,
        searchBudget,
        visitBudget,
        searchTimeRange,
        timeoutSeconds,
        failureArtifact,
      }, opts, baseOpts);
    });


    // Ingest lane artifacts, then deterministic reduction.
    const ingest = lanes.ingestTaskArtifacts(runId, runDir, baseOpts);
    log(`[5/9] ingest: ${summarizeIngest(ingest)}`);
    markPhase('lane workers done');
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

    // Spec 0008: the deterministic model lane applies the ingested vendor
    // facts (announcements, distribution verdicts, leads) to the models and
    // leads tables. Every write is backed by a bounded fetch that shows the
    // model name on the cited page. This never affects the promotion gate:
    // model/lead state is additive and the fail-safe offers are already
    // reduced above.
    if (watchlist) {
      const modelSummary = await modelsLane.applyModelFacts({
        runId, runDir, baseOpts,
        fetchImpl: opts.watchFetchImpl || undefined,
        now: nowIso(),
        watchlist,
        log,
      });
      log(`[5/9] models: ${modelSummary.announcements_verified} announcement(s) verified, `
        + `${modelSummary.distribution_served_verified}/${modelSummary.distribution_notes} served route(s) verified, `
        + `${modelSummary.leads_created} new lead(s), ${modelSummary.leads_expired} expired`);
    }

    // Spec 0008 Phase 2: deterministic observation application. The LLM
    // artifacts (nim_verify, provider_monitor, discovery candidates) and
    // the catalog artifacts are applied as data: operational evidence
    // columns, NIM removals, within-run contradictions, frontier
    // re-derivation, and DISCOUNTED admission plus liveness. Everything
    // runs against the candidate DB before the candidate view is built, so
    // the classifier and the report see the final observed state.
    if (watchlist) {
      const obsSummary = observe.runObservationPhase(runId, runDir, baseOpts, {
        watchlist,
        now: nowIso(),
        catalogArtifacts,
        log,
      });
      log(`[5/9] observe: or=${obsSummary.or_endpoints.applied} `
        + `nim=${obsSummary.nim.applied} updated / ${obsSummary.nim.removed} removed `
        + `contradictions=${obsSummary.contradictions.findings} `
        + `frontier=${obsSummary.frontier.updated} `
        + `discounted=${obsSummary.discounted.admitted} admitted / ${obsSummary.discounted.ended} ended`);
    }
    if (!reduce.canPromote) {
      log(`  gate blocked promotion; previous report stays live (run ${runId} failed)`);
      if (opts.dryRun) restoreExactPreRun();
      return {
        runId, runDir, promoted: false, deployed: false,
        canPromote: false, gateReason: reduce.gateReason, coverage: reduce.coverage,
      };
    }

    // Fetch the two complete official leaderboards once, then use targeted
    // scouts only for aliases that the deterministic matcher cannot resolve.
    // This removes the old one LLM search session per queued model.
    const queue = benchmarks.buildBenchmarkQueue(baseOpts);
    benchmarks.writeBenchmarkQueue(runDir, queue, baseOpts);
    let benchmarkEvidence = {
      sourceBodies: new Map(), sourceHashes: new Map(), fetchCache: new Map(), fetches: [],
    };
    if (queue.queued > 0) {
      const bulk = opts.bulkBenchmark
        ? await opts.bulkBenchmark(queue, runDir, baseOpts)
        : opts.runWorker
          // Unit and fixture pipelines inject their workers and must remain
          // network free. Production uses the deterministic bulk collector.
          ? {
            changes: [], searchChanges: [], coveredModels: [], notFoundModels: [],
            unresolved: queue.queue, accepted: [], rows: [],
            sourceBodies: new Map(), sourceHashes: new Map(), fetches: [], errors: [],
          }
          : await benchmarks.collectBulkBenchmarkFacts(queue, {
            ...baseOpts,
            runDir,
            now: nowIso(),
            fetchImpl: opts.evidenceFetchImpl || undefined,
          });
      benchmarkEvidence.sourceBodies = bulk.sourceBodies;
      benchmarkEvidence.sourceHashes = bulk.sourceHashes;
      benchmarkEvidence.fetches.push(...bulk.fetches);
      if (bulk.changes.length > 0 || bulk.searchChanges.length > 0) {
        db.finalizeRun(runId, {
          benchmarks: bulk.changes,
          benchmarkSearches: bulk.searchChanges,
        }, baseOpts);
      }
      log(`[6/9] bulk leaderboards: ${bulk.accepted.length}/${queue.queued} model(s) matched, `
        + `${bulk.rows.length} row(s) parsed, ${bulk.errors.length} source error(s)`);

      const covered = new Set(bulk.coveredModels);
      const remainingQueue = queue.queue.filter((entry) => !covered.has(entry.canonical_model_id));
      if (remainingQueue.length > 0) {
        // Cap the per run scout budget: each scout is one LLM session, and a
        // large unresolved backlog (models absent from the tbench leaderboards
        // but not yet scout checked) must not blow the wall-clock budget. The
        // queue is already deterministically ordered (newly discovered first,
        // then metadata changed, then oldest search); taking the head keeps
        // the most important models first. Models beyond the cap stay in the
        // queue and are scouted on later runs; a `not_found` reopens after
        // NOT_FOUND_RESEARCH_TTL_DAYS, so nothing is starved forever.
        const MAX_SCOUTS = Number(process.env.BENCHMARK_SCOUTS_PER_RUN || 3);
        const scoutEntries = remainingQueue.slice(0, MAX_SCOUTS);
        if (scoutEntries.length < remainingQueue.length) {
          log(`[6/9] benchmark scouts: ${remainingQueue.length} unresolved, `
            + `capped to ${scoutEntries.length}/run (BENCHMARK_SCOUTS_PER_RUN); `
            + `${remainingQueue.length - scoutEntries.length} deferred to later runs`);
        }
        const scoutQueue = { ...queue, queue: scoutEntries, queued: scoutEntries.length };
        const scoutTasks = benchmarkScoutModelTasks(scoutQueue);
        db.addRunTasks(runId, scoutTasks.map((task) => ({
          task_id: task.task_id,
          kind: task.kind,
          assigned_model_ids: task.model.offer_ids.map((id) => id.exact_model_id),
        })), baseOpts);
        log(`[6/9] targeted benchmark scouts (${scoutTasks.length} unresolved model(s), `
          + `concurrency ${opts.concurrency})...`);
        const scoutEvidence = await runBenchmarkScouts({
          runId, runDir, scoutTasks, dirs, opts, baseOpts, log, queue: scoutQueue, runWorker,
        });
        for (const [url, body] of scoutEvidence.sourceBodies) benchmarkEvidence.sourceBodies.set(url, body);
        for (const [url, hash] of scoutEvidence.sourceHashes) benchmarkEvidence.sourceHashes.set(url, hash);
        benchmarkEvidence.fetchCache = scoutEvidence.fetchCache;
        benchmarkEvidence.fetches.push(...scoutEvidence.fetches);
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
        log('[6/9] targeted benchmark scouts: no unresolved model aliases, skipped');
      }
    } else {
      log('[6/9] bulk leaderboards: no models without accepted benchmark facts, skipped');
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

    // Display-relevant pre-filter (operator 2026-08-25): see
    // displayRelevantCandidate above. Dropped candidates keep their
    // provisional classification.
    const relevant = view.candidates.filter(displayRelevantCandidate);
    fs.writeFileSync(
      path.join(runDir, 'reduced', 'editorial-view.json'),
      `${JSON.stringify({ ...view, candidates: relevant }, null, 2)}\n`
    );
    log(`[7/9] display-relevant candidates: ${relevant.length}/${view.candidates.length} (classifier + editor input)`);

    // Classifier + editor (both read the candidate view; run together). The
    // classifier is chunked: one worker per candidate slice so the candidates
    // classify in parallel instead of one long sequential session.
    // The chunk outputs are merged into the single classifications.json the
    // assembler reads. Chunking is deterministic (stable slice of the same
    // candidate array) and each chunk worker still emits the full schema.
    log('[8/9] classifier (chunked) + editor...');
    const CLASSIFIER_CHUNK_SIZE = 60;
    const classifierChunks = [];
    for (let i = 0; i < relevant.length; i += CLASSIFIER_CHUNK_SIZE) {
      classifierChunks.push(relevant.slice(i, i + CLASSIFIER_CHUNK_SIZE));
    }
    const reducedDir = path.join(runDir, 'reduced');
    const classifierTasks = classifierChunks.map((chunk, index) => {
      const chunkFile = path.join(reducedDir, `classifier-chunk-${index}.json`);
      fs.writeFileSync(chunkFile, `${JSON.stringify({ candidates: chunk }, null, 2)}\n`);
      return {
        taskId: `classifier:chunk-${index}`,
        roleFile: 'classifier-agent.md',
        schemaFile: path.join(dirs.schemasDir, 'classifications.schema.json'),
        outputFile: path.join(reducedDir, `classifications-chunk-${index}.json`),
        logFile: path.join(runDir, 'logs', `classifier-chunk-${index}.log`),
        runtime: `Candidate view chunk: ${chunkFile} (${chunk.length} candidates; part ${index + 1} of ${classifierChunks.length}). `
          + 'Decide the FINAL classification and confidence for every candidate in THIS chunk and emit them via json_output '
          + 'conforming to schemas/classifications.schema.json. Do not classify candidates outside this chunk.',
        failureArtifact: null,
      };
    });
    await runPool([
      ...classifierTasks,
      {
        taskId: 'editorial',
        roleFile: 'editor-agent.md',
        schemaFile: path.join(dirs.schemasDir, 'editorial.schema.json'),
        outputFile: path.join(runDir, 'candidate', 'editorial.json'),
        logFile: path.join(runDir, 'logs', 'editorial.log'),
        runtime: `Candidate view: ${path.join(runDir, 'reduced', 'editorial-view.json')} (the final observed offer state, filtered to display-relevant candidates only; read it, do not modify it). `
          + `Changes preview: ${path.join(runDir, 'reduced', 'changes-preview.json')} (structured before / after values for this run's change records; write change_prose from these values only). `
          + `Coverage: ${path.join(runDir, 'reduced', 'lane-coverage.json')}. `
          + `Discovery: ${path.join(runDir, 'reduced', 'discovery-candidates.json')}. `
          + 'Write the Japanese prose to editorial.json via json_output conforming to schemas/editorial.schema.json.',
        failureArtifact: null,
      },
    ], opts.concurrency, (spec) => runWorker(spec, opts, baseOpts));

    // Merge the classifier chunk outputs into the single classifications.json
    // the assembler consumes. Deterministic: concatenate in chunk order, keep
    // the first classification per offer_key, drop chunk files afterwards.
    const merged = [];
    const seenKeys = new Set();
    for (let i = 0; i < classifierChunks.length; i += 1) {
      const chunkFile = path.join(reducedDir, `classifications-chunk-${i}.json`);
      const parsed = readJsonIfPresent(chunkFile);
      if (parsed && Array.isArray(parsed.classifications)) {
        for (const entry of parsed.classifications) {
          if (entry && typeof entry.offer_key === 'string' && !seenKeys.has(entry.offer_key)) {
            seenKeys.add(entry.offer_key);
            merged.push(entry);
          }
        }
      }
      fs.rmSync(chunkFile, { force: true });
    }
    fs.writeFileSync(
      path.join(reducedDir, 'classifications.json'),
      `${JSON.stringify({ classifications: merged }, null, 2)}\n`
    );
    markPhase('classifier + editor done');

    // Deterministic assembly of the staged report.
    const assembled = assemble.assembleReport(runId, runDir, baseOpts);
    log(`[8/9] assemble: ranked=${assembled.counts.ranked} conditional=${assembled.counts.conditional} `
      + `caution=${assembled.counts.caution} excluded=${assembled.counts.excluded}`);
    markPhase('assemble done');

    // Candidate validation + HTML/OG build + promotion manifest.
    const validated = publication.validateCandidate(runId, runDir, {
      ...baseOpts,
      skipCitationCheck: opts.skipCitation,
    });
    log(`[9/9] validated candidate ${validated.candidateHash.slice(0, 12)} `
      + `(og: ${validated.ogProvenance})`);
    markPhase('validated');

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
  runPiWorker,
  discoveryWindowDays,
  discoverySearchTimeRange,
  runBenchmarkScouts,
  benchmarkScoutModelTasks,
  defaultRunId,
  acquireLock,
  releaseLock,
  runCatalogInProcess,
  recoverAbandonedRuns,
  hasSafelyFinalizedPromotion,
  displayRelevantCandidate,
  // Wall-clock total for the CLI summary (set when runPipeline starts).
  pipelineStartAt: () => module.exports.__pipelineStartAt || 0,
};

module.exports.__pipelineStartAt = 0;
const __origRunPipeline = module.exports.runPipeline;
module.exports.runPipeline = async function runPipelineWrapped(options = {}) {
  module.exports.__pipelineStartAt = Date.now();
  return __origRunPipeline(options);
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
