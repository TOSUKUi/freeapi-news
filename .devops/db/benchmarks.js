'use strict';

// Verified benchmark reuse and targeted research. Spec 0003 fail safe
// collection pipeline, child 0003 (AC-7 through AC-10, AC-11, and the
// benchmark cases of AC-18).
//
// Accepted benchmark facts live only in the SQLite benchmarks table. LLM
// benchmark results stay proposals inside the run task result_json until a
// deterministic check accepts them. A proposal is never a fact.
//
// Rules:
//   * AC-7  Existing benchmark facts resolve by canonical model ID and
//           internal benchmark key and copy into the run candidate without
//           replacement. Source display variants collapse to one internal
//           key (Terminal Bench 2.1 / Terminal-Bench 2.1 -> terminal_bench_2_1).
//           Only current free models missing terminal_bench_2_1 are searched
//           each day, in deterministic priority order, in chunks of at most
//           four models.
//   * AC-8  A proposal enters current benchmarks only after matching an exact
//           queued model ID, canonical benchmark key and version, a score from
//           0 through 100, and accepted source evidence. A higher proposed
//           score never replaces an existing score (finalizeRun is insert only).
//   * AC-9  Text sources are accepted only when validation confirms the model,
//           benchmark version, and score in the fetched body. Official image
//           sources are accepted only from a vision capable worker that returns
//           all four values with HIGH confidence. Ambiguous, low resolution,
//           unknown version, and MEDIUM or LOW confidence remain pending. The
//           source URL and source hash live in benchmark columns; image hash,
//           extraction time, method, and confidence live in benchmarks.facts_json.
//   * AC-10 terminal_bench_2_1 at 65 or higher is tier S, 50 through 64.999 is
//           tier A. Without that key another verified official benchmark
//           supports tier B at most. No verified benchmark is benchmark_pending
//           and is never ranked.
//   * AC-11 A benchmark scout artifact must match its manifest task id and the
//           exact queued model ids; unqueued models are rejected.

const fs = require('node:fs');
const path = require('node:path');

const db = require('./collector-db');

// The ranking admission benchmark. A model missing this key is queued for
// daily research (AC-7) and, with no verified benchmark at all, stays
// benchmark_pending (AC-10).
const RANKING_BENCHMARK_KEY = 'terminal_bench_2_1';

// Tier thresholds for the ranking benchmark (AC-10).
const TIER_S_SCORE = 65;
const TIER_A_SCORE = 50;

// Search queue chunks hold at most four models (AC-7).
const QUEUE_CHUNK_SIZE = 4;

const EXTRACTION_METHODS = ['text', 'official_image'];
const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'];
const UNKNOWN_VERSION_VALUES = new Set([
  'unknown', 'n/a', 'na', 'none', 'null', 'undefined', 'undetermined',
]);

function nowIso() {
  return new Date().toISOString();
}

// Fold away punctuation and case so a source page's "Terminal-Bench 2.1",
// "terminal bench 2.1", and a model id like "vendor/model:free" compare
// loosely against prose. Used only for evidence confirmation, never for
// identity (identity is exact).
function fold(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Legacy rows may have been imported before version validation existed. Keep
// those immutable rows in SQLite, but never let an empty or sentinel version
// satisfy a queue gate or tier derivation.
function isUsableBenchmarkVersion(version) {
  if (typeof version !== 'string') return false;
  const normalized = version.trim().toLowerCase();
  return normalized.length > 0 && !UNKNOWN_VERSION_VALUES.has(normalized);
}

// ---------------------------------------------------------------------------
// Existing benchmark reuse (AC-7: copy without replacement)
// ---------------------------------------------------------------------------

// Loads every accepted benchmark row, grouped by canonical model ID. These
// rows are immutable facts: the queue and the report copy them forward
// without replacement.
function loadCurrentBenchmarks(options = {}) {
  const database = db.openCollectorDb(options);
  try {
    const rows = database.prepare(
      'SELECT * FROM benchmarks ORDER BY canonical_model_id, benchmark_key'
    ).all().map((row) => db.parseRow('benchmarks', row));
    const byModel = new Map();
    for (const row of rows) {
      if (!byModel.has(row.canonical_model_id)) byModel.set(row.canonical_model_id, []);
      byModel.get(row.canonical_model_id).push(row);
    }
    return { rows, byModel };
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Deterministic daily search queue (AC-7)
// ---------------------------------------------------------------------------

// Computes a stable metadata hash for a model so a metadata change bumps it
// up the search queue (AC-7 value sourcing: benchmark_searches.metadata_hash).
function modelMetadataHash(facts) {
  const f = facts && typeof facts === 'object' && !Array.isArray(facts) ? facts : {};
  const canonical = JSON.stringify([
    f.canonical_model_id || f.model_id || null,
    f.total_parameters_b ?? null,
    f.active_parameters_b ?? null,
    f.architecture ?? null,
    f.context_tokens ?? null,
    f.release_date ?? null,
  ]);
  return require('node:crypto').createHash('sha256').update(canonical).digest('hex');
}

// Builds the deterministic daily search queue: every current free canonical
// model missing terminal_bench_2_1. "Current free" means an offer that is
// verified or stale (confirmed_removed offers are never searched). One entry
// per canonical model ID (an offer identity is finer than a model, but the
// benchmark is keyed on the model).
//
// Priority order (AC-7): newly discovered models, metadata changed models,
// oldest successful or failed search, then canonical model ID. The queue is
// split into chunks of at most four models.
function buildBenchmarkQueue(options = {}) {
  const now = options.now || nowIso();
  const database = db.openCollectorDb(options);
  let offers;
  let benchmarkRows;
  let searches;
  try {
    offers = database.prepare(
      "SELECT * FROM offers WHERE status IN ('verified', 'stale') " +
      'ORDER BY provider_key, exact_model_id'
    ).all().map((row) => db.parseRow('offers', row));
    benchmarkRows = database.prepare(
      'SELECT canonical_model_id, benchmark_key, version FROM benchmarks'
    ).all();
    searches = database.prepare(
      'SELECT canonical_model_id, last_searched_at, result, metadata_hash FROM benchmark_searches'
    ).all();
  } finally {
    database.close();
  }

  const hasRankingKey = new Set(
    benchmarkRows
      .filter((row) => row.benchmark_key === RANKING_BENCHMARK_KEY &&
        isUsableBenchmarkVersion(row.version))
      .map((row) => row.canonical_model_id)
  );
  const searchByModel = new Map(searches.map((row) => [row.canonical_model_id, row]));

  // Collapse offers to canonical models, keeping the richest facts and the
  // earliest first_seen_at (newly discovered models sort first).
  const models = new Map();
  for (const offer of offers) {
    const canonical = offer.canonical_model_id;
    if (hasRankingKey.has(canonical)) continue; // already has the gate benchmark
    const existing = models.get(canonical);
    const facts = offer.facts_json && typeof offer.facts_json === 'object' && !Array.isArray(offer.facts_json)
      ? offer.facts_json
      : {};
    if (!existing) {
      models.set(canonical, {
        canonical_model_id: canonical,
        first_seen_at: offer.first_seen_at,
        facts,
        offer_ids: [{ provider_key: offer.provider_key, exact_model_id: offer.exact_model_id }],
      });
    } else {
      existing.offer_ids.push({
        provider_key: offer.provider_key,
        exact_model_id: offer.exact_model_id,
      });
      if (offer.first_seen_at && (!existing.first_seen_at || offer.first_seen_at < existing.first_seen_at)) {
        existing.first_seen_at = offer.first_seen_at;
      }
      existing.facts = { ...existing.facts, ...facts };
    }
  }

  const queue = [];
  for (const model of models.values()) {
    const search = searchByModel.get(model.canonical_model_id) || null;
    const metadataHash = modelMetadataHash({ ...model.facts, canonical_model_id: model.canonical_model_id });
    const neverSearched = !search;
    const metadataChanged = !!search && !!search.metadata_hash && search.metadata_hash !== metadataHash;
    queue.push({
      canonical_model_id: model.canonical_model_id,
      offer_ids: model.offer_ids,
      first_seen_at: model.first_seen_at,
      last_searched_at: search ? search.last_searched_at : null,
      last_result: search ? search.result : null,
      metadata_hash: metadataHash,
      newly_discovered: neverSearched,
      metadata_changed: metadataChanged,
    });
  }

  // Deterministic priority: newly discovered first, then metadata changed,
  // then oldest search (never searched sorts before any timestamp), then
  // canonical model ID.
  queue.sort((a, b) => {
    if (a.newly_discovered !== b.newly_discovered) return a.newly_discovered ? -1 : 1;
    if (a.metadata_changed !== b.metadata_changed) return a.metadata_changed ? -1 : 1;
    const aTime = a.last_searched_at || '';
    const bTime = b.last_searched_at || '';
    if (aTime !== bTime) return aTime < bTime ? -1 : 1;
    return a.canonical_model_id.localeCompare(b.canonical_model_id);
  });

  const chunks = [];
  for (let i = 0; i < queue.length; i += QUEUE_CHUNK_SIZE) {
    const slice = queue.slice(i, i + QUEUE_CHUNK_SIZE);
    chunks.push({
      chunk_index: chunks.length,
      task_id: `benchmark_scout:chunk-${chunks.length}`,
      models: slice.map((entry) => ({
        canonical_model_id: entry.canonical_model_id,
        model_ids: entry.offer_ids.map((id) => id.exact_model_id),
        offer_ids: entry.offer_ids,
        metadata_hash: entry.metadata_hash,
      })),
    });
  }

  return { generated_at: now, queued: queue.length, queue, chunks };
}

// Writes one needs-list file per chunk into <run_dir>/benchmarks/ and returns
// the chunk manifest. Workers read these lists; the same lists are the
// allowlist the reducer validates proposals against (AC-8, AC-11).
function writeBenchmarkQueue(runDir, queueResult, options = {}) {
  const dir = path.join(runDir, 'benchmarks');
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const chunk of queueResult.chunks) {
    const file = path.join(dir, `needs-${db.sanitizeTaskId(chunk.task_id)}.json`);
    fs.writeFileSync(file, `${JSON.stringify({
      task_id: chunk.task_id,
      kind: 'benchmark_scout',
      chunk_index: chunk.chunk_index,
      generated_at: queueResult.generated_at,
      models: chunk.models,
    }, null, 2)}\n`);
    written.push({ task_id: chunk.task_id, file, models: chunk.models.length });
  }
  return { dir, written };
}

// ---------------------------------------------------------------------------
// Proposal validation (AC-8 shape, AC-9 evidence)
// ---------------------------------------------------------------------------

// Mechanical shape check (AC-8): canonical key and version resolve, the score
// is a finite number from 0 through 100, and the source URL is http(s).
// Returns { ok, key, version, reason }.
function validateProposalShape(find) {
  if (!find || typeof find !== 'object') {
    return { ok: false, reason: 'find is not an object' };
  }
  const displayName = find.display_name || find.name;
  if (typeof displayName !== 'string' || !displayName.trim()) {
    return { ok: false, reason: 'find is missing a benchmark display_name' };
  }
  const key = db.benchmarkKey(displayName);
  const displayVersion = db.benchmarkVersion(displayName).trim();
  let version;
  if (find.version !== undefined && find.version !== null) {
    if (typeof find.version !== 'string') {
      return { ok: false, reason: 'benchmark version must be a non-empty string or a nullable unknown value' };
    }
    const explicitVersion = find.version.trim();
    if (explicitVersion) {
      if (!isUsableBenchmarkVersion(explicitVersion)) {
        return { ok: false, reason: 'benchmark version is unknown; unknown version remains pending' };
      }
      if (displayVersion && explicitVersion !== displayVersion) {
        return {
          ok: false,
          reason: `benchmark version ${JSON.stringify(explicitVersion)} conflicts with ` +
            `display_name version ${JSON.stringify(displayVersion)}`,
        };
      }
      version = explicitVersion;
    }
  }
  if (!version) version = displayVersion;
  if (!key || key === 'unknown_benchmark') {
    return { ok: false, reason: `benchmark display_name ${JSON.stringify(displayName)} does not resolve to a key` };
  }
  const score = Number(find.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return { ok: false, reason: `score must be a finite number from 0 through 100, got ${JSON.stringify(find.score)}` };
  }
  if (typeof find.source_url !== 'string' || !/^https?:\/\//.test(find.source_url)) {
    return { ok: false, reason: 'a source_url (http(s)) is required; a URL alone is not evidence but it is required' };
  }
  const method = find.extraction_method || 'text';
  if (!EXTRACTION_METHODS.includes(method)) {
    return { ok: false, reason: `extraction_method must be one of ${EXTRACTION_METHODS.join(', ')}` };
  }
  if (!version) {
    return { ok: false, reason: 'benchmark version is required; unknown version remains pending' };
  }
  const confidence = find.confidence || 'HIGH';
  if (!CONFIDENCE_LEVELS.includes(confidence)) {
    return { ok: false, reason: `confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}` };
  }
  return { ok: true, key, version, score, displayName, method, confidence };
}

// Text evidence check (AC-9): the fetched body must confirm the model, the
// benchmark version, and the score. A URL alone is never evidence. The body
// is the full fetched text or a worker supplied excerpt; both are part of the
// fetched body. Loose folding stands in for the layout of leaderboards and
// model cards while still requiring every three facts to be present.
function bodyConfirmsModel(body, model) {
  const folded = fold(body);
  const candidates = [model.canonical_model_id, model.exact_model_id, model.model_name]
    .filter((value) => typeof value === 'string' && value.trim().length > 0)
    .map(fold);
  if (candidates.length === 0) return false;
  return candidates.some((candidate) => folded.includes(candidate));
}

function bodyConfirmsBenchmark(body, shape) {
  const folded = fold(body);
  // Evidence validation is fail closed too: an unknown version is a pending
  // observation, never a fact accepted merely because its family is present.
  if (!shape || typeof shape.version !== 'string' || !shape.version.trim()) return false;
  // The benchmark family must appear (terminal bench), and the version must
  // appear too.
  const keyFold = fold(shape.key.replace(/_/g, ' ')); // terminalbench21
  const familyFold = keyFold.replace(/[0-9.]+$/g, ''); // terminalbench
  if (familyFold && !folded.includes(familyFold)) {
    // Fall back to the display name family (e.g. "Terminal Bench").
    const displayFamily = fold(shape.displayName).replace(/[0-9.]+$/g, '');
    if (!displayFamily || !folded.includes(displayFamily)) return false;
  }
  const versionFold = fold(shape.version);
  if (!versionFold || !folded.includes(versionFold)) return false;
  return true;
}

function bodyConfirmsScore(body, score) {
  const folded = fold(body);
  const variants = new Set();
  variants.add(fold(String(score)));
  if (Number.isInteger(score)) variants.add(fold(String(score)));
  // Allow a single decimal rendering (57 vs 57.0) and a trailing percent.
  variants.add(fold(score.toFixed(1)));
  for (const variant of variants) {
    if (variant && folded.includes(variant)) return true;
  }
  return false;
}

function validateTextEvidence(find, shape, model, body) {
  if (typeof body !== 'string' || body.trim().length === 0) {
    return { ok: false, reason: 'text source has no fetched body to confirm against' };
  }
  if (!bodyConfirmsModel(body, model)) {
    return { ok: false, reason: 'fetched body does not confirm the model' };
  }
  if (!bodyConfirmsBenchmark(body, shape)) {
    return { ok: false, reason: 'fetched body does not confirm the benchmark name and version' };
  }
  if (!bodyConfirmsScore(body, shape.score)) {
    return { ok: false, reason: 'fetched body does not confirm the score' };
  }
  return { ok: true };
}

// Official image evidence check (AC-9): accepted only from a vision capable
// worker that returns all four values (model, benchmark, version, score) with
// HIGH confidence. MEDIUM or LOW confidence, unknown versions, and non vision
// environments remain pending.
function validateImageEvidence(find, shape, model, options = {}) {
  if (!options.visionCapable) {
    return { ok: false, reason: 'official image source rejected: environment is not vision capable' };
  }
  if (shape.confidence !== 'HIGH') {
    return { ok: false, reason: `official image source rejected: confidence ${shape.confidence} is not HIGH` };
  }
  if (!shape.version) {
    return { ok: false, reason: 'official image source rejected: benchmark version is unknown' };
  }
  const imageFacts = find.image_facts && typeof find.image_facts === 'object' ? find.image_facts : {};
  const hasAllFour = typeof imageFacts.model === 'string' && imageFacts.model.trim() &&
    typeof imageFacts.benchmark === 'string' && imageFacts.benchmark.trim() &&
    typeof imageFacts.version === 'string' && imageFacts.version.trim() &&
    imageFacts.score !== undefined && imageFacts.score !== null && Number.isFinite(Number(imageFacts.score));
  if (!hasAllFour) {
    return { ok: false, reason: 'official image source rejected: worker did not return all four values (model, benchmark, version, score)' };
  }
  if (!bodyConfirmsModel(JSON.stringify(imageFacts), model)) {
    return { ok: false, reason: 'official image extraction does not confirm the model' };
  }
  if (imageFacts.version.trim() !== shape.version) {
    return {
      ok: false,
      reason: `official image extraction version ${JSON.stringify(imageFacts.version.trim())} ` +
        `does not match proposal version ${JSON.stringify(shape.version)}`,
    };
  }
  return { ok: true, imageFacts };
}

// Evaluates one proposal find against the queue allowlist and source policy.
// Returns { accepted, reason, change? } where change is the benchmarks row to
// insert at finalization (insert only; an existing row is never replaced).
//
// model: the queued model entry { canonical_model_id, model_ids, offer_ids }.
// body: the fetched text for text sources (full body or excerpt). Optional
// fetchImpl resolves the body from source_url when not supplied.
function evaluateProposal(find, model, options = {}) {
  const queuedIds = new Set(model.model_ids || []);
  queuedIds.add(model.canonical_model_id);
  const findModelId = find.model_id || find.canonical_model_id;
  if (!queuedIds.has(findModelId)) {
    return { accepted: false, reason: `model_id ${JSON.stringify(findModelId)} is not in the exact search queue` };
  }

  const shape = validateProposalShape(find);
  if (!shape.ok) {
    return { accepted: false, reason: shape.reason };
  }

  const sourceHash = typeof find.source_hash === 'string' && find.source_hash ? find.source_hash : null;

  if (shape.method === 'official_image') {
    const check = validateImageEvidence(find, shape, model, options);
    if (!check.ok) return { accepted: false, reason: check.reason };
    return {
      accepted: true,
      reason: 'official image accepted (HIGH confidence, all four values)',
      change: buildBenchmarkChange(model, shape, find, sourceHash, {
        extraction_method: 'official_image',
        confidence: shape.confidence,
        image_hash: find.image_hash || null,
        image_facts: check.imageFacts,
        extracted_at: options.now || nowIso(),
        row_description: find.row_description || null,
      }),
    };
  }

  // Text source: confirm against the fetched body.
  let body = typeof find.body === 'string' && find.body ? find.body
    : (typeof find.body_excerpt === 'string' && find.body_excerpt ? find.body_excerpt : null);
  if (body === null && typeof options.fetchImpl === 'function') {
    try {
      const res = options.fetchImpl(find.source_url);
      if (res && typeof res.body === 'string') body = res.body;
    } catch {
      body = null;
    }
  }
  const check = validateTextEvidence(find, shape, model, body);
  if (!check.ok) return { accepted: false, reason: check.reason };
  return {
    accepted: true,
    reason: 'text source accepted (model, version, and score confirmed in fetched body)',
    change: buildBenchmarkChange(model, shape, find, sourceHash, {
      extraction_method: 'text',
      confidence: shape.confidence,
      extracted_at: options.now || nowIso(),
    }),
  };
}

function buildBenchmarkChange(model, shape, find, sourceHash, factsExtra) {
  const facts = {
    origin: 'benchmark_scout',
    ...(factsExtra || {}),
  };
  return {
    canonical_model_id: model.canonical_model_id,
    benchmark_key: shape.key,
    display_name: shape.displayName,
    version: shape.version,
    score: shape.score,
    source_url: find.source_url,
    source_hash: sourceHash || 'unverified',
    verified_at: factsExtra.extracted_at || nowIso(),
    facts_json: facts,
  };
}

// ---------------------------------------------------------------------------
// Benchmark task reduction (proposals -> accepted facts)
// ---------------------------------------------------------------------------

// Validates a benchmark scout artifact against its manifest task and the
// queued allowlist (AC-11). Returns { ok, errors, status }.
function validateBenchmarkArtifact(task, artifact, queuedIdsForTask) {
  const errors = [];
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, errors: ['artifact is not a JSON object'], status: 'failed' };
  }
  if (artifact.task_id !== undefined && String(artifact.task_id) !== String(task.task_id)) {
    errors.push(`artifact task_id ${JSON.stringify(artifact.task_id)} does not match manifest task ${JSON.stringify(task.task_id)}`);
  }
  if (!['complete', 'partial', 'failed'].includes(artifact.status)) {
    errors.push('artifact status must be one of complete, partial, failed');
  }
  if (artifact.models !== undefined && !Array.isArray(artifact.models)) {
    errors.push('artifact models must be an array');
  }
  if (errors.length > 0) return { ok: false, errors, status: 'failed' };

  // Every model in the artifact must be an assigned (queued) model. Models
  // outside the assignment are rejected, never added (AC-8, AC-11).
  if (Array.isArray(artifact.models) && queuedIdsForTask) {
    for (const model of artifact.models) {
      const id = model && (model.model_id || model.canonical_model_id);
      if (id && !queuedIdsForTask.has(id)) {
        errors.push(`artifact model ${JSON.stringify(id)} is not in the assigned search queue`);
      }
    }
  }
  return { ok: true, errors, status: artifact.status };
}

// Reduces one run's benchmark scout task results against the search queue.
// Accepted proposals become benchmark changes (applied later in the single
// finalizeRun transaction); rejected and pending proposals stay only in the
// task record. Also produces benchmark_searches updates (every queued model
// that had a task is marked searched this run).
//
// Returns { accepted, rejected, benchmarkChanges, searchChanges, coverage }.
function reduceBenchmarkTasks(runId, runDir, options = {}) {
  const now = options.now || nowIso();
  const { tasks } = db.loadRunCandidate(runId, options);
  const { byModel } = loadCurrentBenchmarks(options);
  const scoutTasks = tasks.filter((t) => t.kind === 'benchmark_scout');

  // Rebuild the queue allowlist from the run's needs-list files when present,
  // else from current state. The needs-lists are what the workers received,
  // so they are the authoritative allowlist for this run.
  const queueResult = buildBenchmarkQueue({ ...options, now });
  const queuedByTask = new Map();
  const queuedModelByCanonical = new Map(queueResult.queue.map((entry) => [entry.canonical_model_id, entry]));
  for (const chunk of queueResult.chunks) {
    const ids = new Set();
    for (const model of chunk.models) {
      ids.add(model.canonical_model_id);
      for (const exactId of model.model_ids) ids.add(exactId);
    }
    queuedByTask.set(chunk.task_id, ids);
  }

  const accepted = [];
  const rejected = [];
  const benchmarkChanges = [];
  const seenInsert = new Set(); // one insert per canonical+key this run
  const searchedModels = new Set();
  const coverage = { tasks: 0, complete: 0, partial: 0, failed: 0, accepted: 0, rejected: 0 };

  for (const task of scoutTasks) {
    coverage.tasks += 1;
    if (task.status === 'complete') coverage.complete += 1;
    else if (task.status === 'partial') coverage.partial += 1;
    else coverage.failed += 1;

    const queuedIdsForTask = queuedByTask.get(task.task_id) || null;
    const result = task.result_json;
    if (task.status === 'failed' || !result || !Array.isArray(result.models)) continue;

    for (const model of result.models) {
      if (!model || typeof model !== 'object') continue;
      const canonical = model.canonical_model_id || db.canonicalModelId(model.model_id || '');
      const queuedEntry = queuedModelByCanonical.get(canonical);
      if (!queuedEntry) {
        rejected.push({ task_id: task.task_id, model_id: model.model_id, reason: 'model not in the search queue' });
        coverage.rejected += 1;
        continue;
      }
      searchedModels.add(canonical);
      const evalModel = {
        canonical_model_id: canonical,
        model_ids: queuedEntry.offer_ids.map((id) => id.exact_model_id),
        offer_ids: queuedEntry.offer_ids,
        model_name: model.model_name || canonical,
      };
      for (const find of model.benchmark_finds || []) {
        const evaluation = evaluateProposal({ ...find, model_id: find.model_id || model.model_id }, evalModel, options);
        if (!evaluation.accepted) {
          rejected.push({
            task_id: task.task_id,
            model_id: model.model_id,
            canonical_model_id: canonical,
            benchmark: find.display_name || find.name,
            reason: evaluation.reason,
          });
          coverage.rejected += 1;
          continue;
        }
        const change = evaluation.change;
        const insertKey = `${change.canonical_model_id}\u0000${change.benchmark_key}`;
        // Never replace an existing verified row, and never insert the same
        // key twice in one run (the first accepted fact wins) (AC-8).
        const existingRows = byModel.get(change.canonical_model_id) || [];
        if (existingRows.some((row) => row.benchmark_key === change.benchmark_key)) {
          rejected.push({
            task_id: task.task_id,
            model_id: model.model_id,
            canonical_model_id: canonical,
            benchmark: change.display_name,
            reason: `existing verified ${change.benchmark_key} is immutable; proposal not applied`,
          });
          coverage.rejected += 1;
          continue;
        }
        if (seenInsert.has(insertKey)) {
          rejected.push({
            task_id: task.task_id,
            model_id: model.model_id,
            canonical_model_id: canonical,
            benchmark: change.display_name,
            reason: 'a proposal for this benchmark key was already accepted this run',
          });
          coverage.rejected += 1;
          continue;
        }
        seenInsert.add(insertKey);
        benchmarkChanges.push(change);
        accepted.push({
          task_id: task.task_id,
          canonical_model_id: canonical,
          benchmark_key: change.benchmark_key,
          score: change.score,
          source_url: change.source_url,
        });
        coverage.accepted += 1;
      }
    }
  }

  // Every queued model that a task covered is marked searched this run, with
  // its current metadata hash, so the next queue orders by oldest search.
  const searchChanges = [];
  for (const chunk of queueResult.chunks) {
    const taskPresent = scoutTasks.some((t) => t.task_id === chunk.task_id);
    if (!taskPresent) continue;
    for (const model of chunk.models) {
      searchChanges.push({
        canonical_model_id: model.canonical_model_id,
        last_searched_at: now,
        result: searchedModels.has(model.canonical_model_id) ? 'found' : 'not_found',
        metadata_hash: model.metadata_hash,
      });
    }
  }

  // Run local outputs for inspection and the assembly stage.
  if (runDir) {
    const dir = path.join(runDir, 'reduced');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'benchmark-proposals.json'), `${JSON.stringify({
      run_id: runId,
      reduced_at: now,
      coverage,
      accepted,
      rejected,
    }, null, 2)}\n`);
  }

  return { accepted, rejected, benchmarkChanges, searchChanges, coverage };
}

// ---------------------------------------------------------------------------
// Tier derivation (AC-10)
// ---------------------------------------------------------------------------

// Derives the tier and representative benchmark for one model from its
// accepted benchmark rows. terminal_bench_2_1 at 65+ is S, 50 through 64.999
// is A. Without that key, another verified official benchmark supports tier B
// at most. No verified benchmark is benchmark_pending (tier null, not ranked).
// The representative score comes from the same benchmark that sets the tier so
// raw scores from different benchmarks are never compared (AGENTS.md).
function deriveTier(benchmarkRows) {
  const rows = (Array.isArray(benchmarkRows) ? benchmarkRows : [])
    .filter((row) => row && isUsableBenchmarkVersion(row.version));
  const terminal = rows.find((row) => row.benchmark_key === RANKING_BENCHMARK_KEY);
  if (terminal) {
    let tier = 'B';
    if (terminal.score >= TIER_S_SCORE) tier = 'S';
    else if (terminal.score >= TIER_A_SCORE) tier = 'A';
    return {
      tier,
      score: terminal.score,
      benchmark_key: terminal.benchmark_key,
      benchmark_name: terminal.display_name,
      terminal_bench: terminal.score,
      benchmark_pending: false,
    };
  }
  if (rows.length > 0) {
    // Another verified official benchmark supports tier B at most. Pick the
    // representative deterministically: highest score, then benchmark_key.
    const best = rows.slice().sort((a, b) =>
      (b.score - a.score) || a.benchmark_key.localeCompare(b.benchmark_key))[0];
    return {
      tier: 'B',
      score: best.score,
      benchmark_key: best.benchmark_key,
      benchmark_name: best.display_name,
      terminal_bench: null,
      benchmark_pending: false,
    };
  }
  return {
    tier: null,
    score: null,
    benchmark_key: null,
    benchmark_name: null,
    terminal_bench: null,
    benchmark_pending: true,
  };
}

module.exports = {
  RANKING_BENCHMARK_KEY,
  TIER_S_SCORE,
  TIER_A_SCORE,
  QUEUE_CHUNK_SIZE,
  EXTRACTION_METHODS,
  CONFIDENCE_LEVELS,
  fold,
  isUsableBenchmarkVersion,
  modelMetadataHash,
  loadCurrentBenchmarks,
  buildBenchmarkQueue,
  writeBenchmarkQueue,
  validateProposalShape,
  validateTextEvidence,
  validateImageEvidence,
  bodyConfirmsModel,
  bodyConfirmsBenchmark,
  bodyConfirmsScore,
  evaluateProposal,
  validateBenchmarkArtifact,
  reduceBenchmarkTasks,
  deriveTier,
};
