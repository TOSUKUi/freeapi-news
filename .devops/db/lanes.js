'use strict';

// Collection lanes. Spec 0003 fail safe collection pipeline, child 0002
// (AC-2 through AC-6, AC-11).
//
// Known offer verification and general new-offer discovery are separate lanes
// with separate coverage. Deterministic catalogs also admit newly observed free
// exact IDs into SQLite offers. A failed known check makes an offer stale, not
// ended. Catalogs stay deterministic code paths (catalog.js owns the fetch;
// this module owns admission and liveness consequences).
//
// Lane rules:
//   * AC-2  Each run records separate coverage for the known lane and the
//           discovery lane. Discovery failure never removes or changes a
//           known offer.
//   * AC-3  A failed, partial, empty, mismatched, or missing known offer
//           refresh carries the prior offer forward as stale. Runs one
//           through three stay ranked under prior facts; run four moves the
//           offer to caution. A later success resets the count and returns
//           the offer to verified.
//   * AC-4  With at least one known offer assigned, zero verified known
//           offers blocks promotion. A first bootstrap run with no assigned
//           known offers may promote only after deterministic catalog
//           success.
//   * AC-5  confirmed_removed only from a successful exhaustive catalog
//           omitting the exact id, or an official statement that the offer
//           ended or became paid. Fetch failures never prove removal. A
//           reappearing exact id returns to verified.
//   * AC-11 Task artifacts must match manifest task id, provider, assigned
//           model ids, and shape. Partial or empty results never count as
//           completed coverage for omitted assigned offers.
//
// Two phases, matching the cross child contract "current state is never
// mutated during collection":
//   1. ingestTaskArtifacts  validate each artifact and stage it in tasks rows
//   2. reduceLanes          deterministic reduction, then one finalizeRun
//                           transaction applies offer and cache changes

const fs = require('node:fs');
const path = require('node:path');

const db = require('./collector-db');

// Run four moves a stale offer to the caution section (AC-3). Runs one
// through three stay ranked with a stale disclosure.
const CAUTION_FAILURES = 4;

const LANE_TASK_RESULT_STATUSES = ['complete', 'partial', 'failed'];

function loadRegistryProviders(registryPath) {
  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const providers = Array.isArray(raw) ? raw : raw.providers;
  if (!Array.isArray(providers)) {
    throw new Error(`provider registry has no providers array: ${registryPath}`);
  }
  return providers;
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Manifest (build task 1: split into known and discovery lane assignments)
// ---------------------------------------------------------------------------

// Builds one manifest with two logical lane groups from current SQLite state:
//   catalog:<key>   one per registry provider with api_catalog_url. Assigned
//                   model ids are that provider's current known offers.
//   known:<key>     one per provider with known offers and no catalog.
//                   Carries cached_urls from source_cache so workers try
//                   known good pages first.
//   discovery       exactly one general LLM discovery task, addition only.
// confirmed_removed offers are never assigned; a catalog can still surface
// them again, which the reducer turns back into verified (AC-5).
function buildLaneManifest(options = {}) {
  const paths = db.resolvePaths(options);
  const providers = loadRegistryProviders(paths.registryPath);
  const regByKey = Object.fromEntries(providers.map((p) => [p.key, p]));

  const database = db.openCollectorDb(options);
  let offers;
  let cacheRows;
  try {
    offers = database.prepare(
      'SELECT * FROM offers ORDER BY provider_key, exact_model_id'
    ).all().map((row) => db.parseRow('offers', row));
    cacheRows = database.prepare(
      'SELECT url, subject_key, provider_key, exact_model_id, fetched_at, http_status ' +
      'FROM source_cache ORDER BY fetched_at DESC'
    ).all();
  } finally {
    database.close();
  }

  const known = offers.filter((o) => o.status === 'verified' || o.status === 'stale');
  const knownByProvider = new Map();
  for (const offer of known) {
    if (!knownByProvider.has(offer.provider_key)) knownByProvider.set(offer.provider_key, []);
    knownByProvider.get(offer.provider_key).push(offer);
  }

  const cacheByProvider = new Map();
  for (const row of cacheRows) {
    if (!row.provider_key) continue;
    if (!cacheByProvider.has(row.provider_key)) cacheByProvider.set(row.provider_key, []);
    const list = cacheByProvider.get(row.provider_key);
    if (!list.some((entry) => entry.url === row.url)) {
      list.push({ url: row.url, subject_key: row.subject_key, fetched_at: row.fetched_at });
    }
  }

  const tasks = [];
  const catalogKeys = new Set();
  for (const provider of providers) {
    if (!provider.api_catalog_url) continue;
    catalogKeys.add(provider.key);
    const assigned = (knownByProvider.get(provider.key) || [])
      .map((o) => o.exact_model_id).sort();
    tasks.push({
      task_id: `catalog:${provider.key}`,
      kind: 'catalog',
      provider_key: provider.key,
      provider_label: provider.label || provider.key,
      base_url: provider.base_url || null,
      docs_url: provider.docs_url || null,
      api_catalog_url: provider.api_catalog_url,
      assigned_model_ids: assigned,
      cached_urls: [],
      output: `artifacts/${db.sanitizeTaskId(`catalog:${provider.key}`)}.json`,
    });
  }

  for (const [providerKey, list] of knownByProvider) {
    if (catalogKeys.has(providerKey)) continue;
    const reg = regByKey[providerKey] || {};
    tasks.push({
      task_id: `known:${providerKey}`,
      kind: 'known_refresh',
      provider_key: providerKey,
      provider_label: reg.label || providerKey,
      base_url: reg.base_url || null,
      docs_url: reg.docs_url || null,
      api_catalog_url: null,
      assigned_model_ids: list.map((o) => o.exact_model_id).sort(),
      cached_urls: cacheByProvider.get(providerKey) || [],
      output: `artifacts/${db.sanitizeTaskId(`known:${providerKey}`)}.json`,
    });
  }

  tasks.push({
    task_id: 'discovery',
    kind: 'discovery',
    provider_key: null,
    provider_label: null,
    base_url: null,
    docs_url: null,
    api_catalog_url: null,
    assigned_model_ids: [],
    cached_urls: [],
    output: 'artifacts/discovery.json',
  });

  tasks.sort((a, b) => a.task_id.localeCompare(b.task_id));

  return {
    run_id: options.runId || null,
    created_at: nowIso(),
    lanes: {
      known: {
        assigned_offers: known.length,
        providers: [...new Set(known.map((o) => o.provider_key))].sort(),
      },
      discovery: { assigned: 1 },
      catalog: { providers: [...catalogKeys].sort() },
    },
    tasks,
  };
}

// Slim rows for db.startRun (the tasks table holds identity, not worker
// parameters; the full manifest lives in the run directory for workers).
function toStartRunTasks(manifest) {
  return manifest.tasks.map((task) => ({
    task_id: task.task_id,
    kind: task.kind,
    provider_key: task.provider_key ?? undefined,
    assigned_model_ids: task.assigned_model_ids,
  }));
}

// ---------------------------------------------------------------------------
// Strict artifact validation (build task 2, AC-11)
// ---------------------------------------------------------------------------

// Validates one artifact against its manifest task. Returns
// { ok, errors, status } where status is the effective status: a known
// refresh artifact claiming complete while omitting assigned offers is
// demoted to partial, because omitted assigned offers can never count as
// verified (AC-11). Identity mismatches (task id, provider) fail the
// artifact outright.
function validateTaskArtifact(task, artifact) {
  const errors = [];
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, errors: ['artifact is not a JSON object'], status: 'failed' };
  }
  if (artifact.task_id !== undefined && String(artifact.task_id) !== String(task.task_id)) {
    errors.push(`artifact task_id ${JSON.stringify(artifact.task_id)} does not match manifest task ${JSON.stringify(task.task_id)}`);
  }
  if (task.provider_key && artifact.provider_key !== undefined &&
      artifact.provider_key !== task.provider_key) {
    errors.push(`artifact provider_key ${JSON.stringify(artifact.provider_key)} does not match manifest provider ${JSON.stringify(task.provider_key)}`);
  }
  if (!LANE_TASK_RESULT_STATUSES.includes(artifact.status)) {
    errors.push(`artifact status must be one of ${LANE_TASK_RESULT_STATUSES.join(', ')}`);
  }
  if (artifact.models !== undefined && !Array.isArray(artifact.models)) {
    errors.push('artifact models must be an array');
  }
  if (Array.isArray(artifact.models)) {
    artifact.models.forEach((model, index) => {
      if (!model || typeof model !== 'object' || typeof model.model_id !== 'string' ||
          model.model_id.length === 0) {
        errors.push(`artifact models[${index}] is missing a string model_id`);
      }
    });
  }
  if (artifact.errors !== undefined && !Array.isArray(artifact.errors)) {
    errors.push('artifact errors must be an array');
  }
  if (errors.length > 0) {
    return { ok: false, errors, status: 'failed' };
  }

  let status = artifact.status;
  if (task.kind === 'known_refresh' && status === 'complete' &&
      Array.isArray(task.assigned_json) && task.assigned_json.length > 0) {
    const present = new Set((artifact.models || []).map((m) => m.model_id));
    const missing = task.assigned_json.filter((id) => !present.has(id));
    if (missing.length > 0) {
      status = 'partial';
      errors.push(`complete artifact omits assigned offers (demoted to partial): ${missing.join(', ')}`);
    }
  }
  if (task.kind === 'catalog' && status === 'complete' && !Array.isArray(artifact.models)) {
    return { ok: false, errors: ['catalog artifact must carry a models array'], status: 'failed' };
  }
  return { ok: true, errors, status };
}

// Reads every pending task's artifact from the run directory, validates it,
// and stages the outcome in the tasks table via recordTaskResult. Never
// touches current offers. Missing, unparsable, and identity mismatched
// artifacts become failed task rows, so coverage sees them explicitly.
function ingestTaskArtifacts(runId, runDir, options = {}) {
  const { tasks } = db.loadRunCandidate(runId, options);
  const summary = { recorded: [], skipped: [] };
  for (const task of tasks) {
    if (task.status !== 'pending') {
      summary.skipped.push({ task_id: task.task_id, status: task.status });
      continue;
    }
    const artifactPath = db.artifactPathFor(runDir, task.task_id);
    if (!fs.existsSync(artifactPath)) {
      db.recordTaskResult(runId, task.task_id, {
        status: 'failed',
        error: { message: 'artifact file missing', path: artifactPath },
      }, options);
      summary.recorded.push({ task_id: task.task_id, status: 'failed', reason: 'artifact file missing' });
      continue;
    }
    let artifact;
    try {
      artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    } catch (err) {
      db.recordTaskResult(runId, task.task_id, {
        status: 'failed',
        error: { message: `artifact is not valid JSON: ${err.message}` },
      }, options);
      summary.recorded.push({ task_id: task.task_id, status: 'failed', reason: 'invalid JSON' });
      continue;
    }

    const check = validateTaskArtifact(task, artifact);
    if (!check.ok) {
      // Identity failure: store the error, not the artifact. recordTaskResult
      // would reject a mismatched task_id or provider_key inside the result.
      db.recordTaskResult(runId, task.task_id, {
        status: 'failed',
        error: { message: 'artifact failed identity or shape validation', problems: check.errors },
      }, options);
      summary.recorded.push({ task_id: task.task_id, status: 'failed', reason: check.errors.join('; ') });
      continue;
    }

    if (check.status !== artifact.status) {
      // Demoted (complete with missing assigned offers becomes partial).
      db.recordTaskResult(runId, task.task_id, {
        status: check.status,
        result: artifact,
        error: { message: 'demoted from complete', problems: check.errors },
      }, options);
      summary.recorded.push({ task_id: task.task_id, status: check.status, reason: check.errors.join('; ') });
    } else {
      db.recordTaskResult(runId, task.task_id, {
        status: artifact.status,
        result: artifact,
        error: artifact.status === 'failed'
          ? { message: (artifact.errors || []).join('; ') || 'worker reported failure' }
          : undefined,
      }, options);
      summary.recorded.push({ task_id: task.task_id, status: artifact.status });
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Deterministic lane reduction (build tasks 3, 4, 5)
// ---------------------------------------------------------------------------

function offerChangeKey(providerKey, exactModelId) {
  return `${providerKey}\u0000${exactModelId}`;
}

// Catalog identity is exact. This list is the authoritative, deterministic
// router inventory persisted with every live catalog offer.
function sortedUniqueModelIds(models) {
  return [...new Set((models || [])
    .map((model) => model && model.model_id)
    .filter((modelId) => typeof modelId === 'string' && modelId.length > 0))]
    .sort();
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

// Keep catalog offer facts limited to values in the deterministic artifact.
// In particular, do not create quota or rate-limit claims from a zero price.
function catalogModelFacts(result, entry, freeModelNames, catalogUrl) {
  const facts = {
    ...(entry || {}),
    free_model_names: freeModelNames,
  };
  const observedCatalogUrl = result && isHttpUrl(result.catalog_url)
    ? result.catalog_url
    : (isHttpUrl(catalogUrl) ? catalogUrl : null);
  if (observedCatalogUrl) facts.catalog_url = observedCatalogUrl;
  if (result && isHttpUrl(result.endpoint_source)) {
    facts.endpoint_source = result.endpoint_source;
  }
  return facts;
}

// Reduces one run's staged task results against current offers, then applies
// everything in one finalizeRun transaction. Returns the coverage report,
// the promotion gate decision, the offer changes, and discovery candidates.
//
// The run status becomes candidate_ready when the gate passes, or failed
// when AC-4 blocks promotion (the offer changes still persist: the stale
// counters are durable state the next run needs).
function reduceLanes(runId, runDir, options = {}) {
  const paths = db.resolvePaths(options);
  const providers = loadRegistryProviders(paths.registryPath);
  const regByKey = Object.fromEntries(providers.map((p) => [p.key, p]));
  const now = options.now || nowIso();

  const { run, tasks } = db.loadRunCandidate(runId, options);
  const database = db.openCollectorDb(options);
  let priorOffers;
  try {
    priorOffers = database.prepare(
      'SELECT * FROM offers ORDER BY provider_key, exact_model_id'
    ).all().map((row) => db.parseRow('offers', row));
  } finally {
    database.close();
  }

  const offerByKey = new Map(priorOffers.map((o) => [offerChangeKey(o.provider_key, o.exact_model_id), o]));
  const changes = new Map();
  const sourceCache = [];
  const discoveryCandidates = [];
  const coverage = {
    known: { assigned: 0, verified: 0, stale: 0, removed: 0, failed: 0 },
    discovery: { assigned: 0, complete: 0, partial: 0, failed: 0 },
    catalog: { available: [], unavailable: [] },
  };

  function changeFor(prior) {
    const key = offerChangeKey(prior.provider_key, prior.exact_model_id);
    let change = changes.get(key);
    if (!change) {
      change = {
        provider_key: prior.provider_key,
        exact_model_id: prior.exact_model_id,
        canonical_model_id: prior.canonical_model_id,
        source_kind: prior.source_kind,
        status: prior.status,
        consecutive_failures: prior.consecutive_failures,
        first_seen_at: prior.first_seen_at,
        last_attempted_at: prior.last_attempted_at,
        last_verified_at: prior.last_verified_at,
        last_seen_run_id: runId,
        pricing_hash: prior.pricing_hash,
        removal_evidence_json: prior.removal_evidence_json ?? null,
        facts_json: prior.facts_json ?? null,
      };
      changes.set(key, change);
    }
    return change;
  }

  function markVerified(change, modelFacts, sourceKind) {
    change.status = 'verified';
    change.consecutive_failures = 0;
    change.last_attempted_at = now;
    change.last_verified_at = now;
    change.source_kind = sourceKind;
    change.removal_evidence_json = null;
    const priorFacts = change.facts_json && typeof change.facts_json === 'object' && !Array.isArray(change.facts_json)
      ? change.facts_json
      : {};
    change.facts_json = { ...priorFacts, ...(modelFacts || {}) };
  }

  function markStale(change) {
    if (change.status === 'confirmed_removed') return; // removed stays removed
    change.status = 'stale';
    change.consecutive_failures = (change.consecutive_failures || 0) + 1;
    change.last_attempted_at = now;
    // Facts, pricing hash, and last_verified_at carry forward unchanged.
  }

  function removalEvidence(reason, sourceUrl, taskId, extra) {
    return {
      reason,
      source_url: sourceUrl,
      task_id: taskId,
      run_id: runId,
      observed_at: now,
      ...(extra || {}),
    };
  }

  const catalogTasks = tasks.filter((t) => t.kind === 'catalog');
  const knownTasks = tasks.filter((t) => t.kind === 'known_refresh');
  const discoveryTasks = tasks.filter((t) => t.kind === 'discovery');

  // ── Catalog lane (AC-6, AC-5) ──────────────────────────────────
  for (const task of catalogTasks) {
    const providerKey = task.provider_key;
    const assigned = Array.isArray(task.assigned_json) ? task.assigned_json : [];
    coverage.known.assigned += assigned.length;
    const result = task.result_json;
    const available = task.status === 'complete' &&
      !!result && result.available === true && Array.isArray(result.models) && result.models.length > 0;

    if (available) {
      coverage.catalog.available.push(providerKey);
      const catalogUrl = result.catalog_url ||
        (regByKey[providerKey] && regByKey[providerKey].api_catalog_url) || null;
      const entriesById = new Map(result.models.map((m) => [m.model_id, m]));
      const freeModelNames = sortedUniqueModelIds(
        result.models.filter((model) => model && model.is_free === true)
      );

      // Every prior offer for this provider takes part, not just the
      // assigned (verified and stale) ones: a reappearing exact id returns
      // a confirmed_removed offer to verified (AC-5).
      for (const prior of priorOffers) {
        if (prior.provider_key !== providerKey) continue;
        const entry = entriesById.get(prior.exact_model_id);
        if (prior.status === 'confirmed_removed') {
          if (entry && entry.is_free === true) {
            const change = changeFor(prior);
            markVerified(
              change,
              catalogModelFacts(result, entry, freeModelNames, catalogUrl),
              'catalog'
            );
            if (entry.pricing_hash) change.pricing_hash = entry.pricing_hash;
            coverage.known.verified += 1;
          }
          // Still absent or now paid: the original removal evidence stands.
          continue;
        }
        const exactId = prior.exact_model_id;
        const change = changeFor(prior);
        if (!entry) {
          // Omitted from a successful exhaustive official catalog (AC-5).
          change.status = 'confirmed_removed';
          change.last_attempted_at = now;
          change.removal_evidence_json = removalEvidence(
            'omitted from exhaustive official catalog', catalogUrl, task.task_id
          );
          coverage.known.removed += 1;
        } else if (entry.is_free === true) {
          // A reappearing exact id returns to verified (AC-5), including
          // offers previously confirmed_removed.
          markVerified(
            change,
            catalogModelFacts(result, entry, freeModelNames, catalogUrl),
            'catalog'
          );
          if (prior.pricing_hash && entry.pricing_hash &&
              prior.pricing_hash !== entry.pricing_hash) {
            discoveryCandidates.push({
              provider_key: providerKey,
              exact_model_id: exactId,
              canonical_model_id: db.canonicalModelId(exactId),
              source: 'pricing_change',
              prior_pricing_hash: prior.pricing_hash,
              pricing_hash: entry.pricing_hash,
              detected_at: now,
            });
          }
          if (entry.pricing_hash) change.pricing_hash = entry.pricing_hash;
          coverage.known.verified += 1;
        } else {
          // Present but no longer free: official free to paid change (AC-5).
          change.status = 'confirmed_removed';
          change.last_attempted_at = now;
          change.removal_evidence_json = removalEvidence(
            'official catalog pricing is no longer free', catalogUrl, task.task_id,
            { pricing: entry.pricing || null }
          );
          coverage.known.removed += 1;
        }
      }

      // A valid catalog is also the deterministic admission path for every
      // previously unseen free exact ID. Keep a discovery record for audit
      // visibility, but persist the offer change in the same finalizeRun
      // transaction as existing liveness changes.
      for (const entry of result.models) {
        if (entry.is_free !== true) continue;
        const identity = offerChangeKey(providerKey, entry.model_id);
        if (offerByKey.has(identity) || changes.has(identity)) continue;
        const facts = catalogModelFacts(result, entry, freeModelNames, catalogUrl);
        const change = {
          provider_key: providerKey,
          exact_model_id: entry.model_id,
          canonical_model_id: db.canonicalModelId(entry.model_id),
          source_kind: 'catalog',
          status: 'verified',
          consecutive_failures: 0,
          first_seen_at: now,
          last_attempted_at: now,
          last_verified_at: now,
          last_seen_run_id: runId,
          pricing_hash: entry.pricing_hash || null,
          removal_evidence_json: null,
          facts_json: facts,
        };
        changes.set(identity, change);
        offerByKey.set(identity, change);
        // Discovery output can still explain where the row first appeared;
        // it is no longer the only representation of a catalog delta.
        discoveryCandidates.push({
          provider_key: providerKey,
          exact_model_id: entry.model_id,
          canonical_model_id: db.canonicalModelId(entry.model_id),
          model_name: entry.model_name || entry.model_id,
          source: 'catalog_delta',
          pricing_hash: entry.pricing_hash || null,
          facts: entry,
          detected_at: now,
        });
      }

      // Successful catalog and docs fetches become cache evidence (AC-16).
      for (const fetch of result.fetches || []) {
        if (!fetch || typeof fetch.url !== 'string' || !fetch.url) continue;
        if (!Number.isInteger(fetch.http_status) || typeof fetch.content_hash !== 'string') continue;
        sourceCache.push({
          url: fetch.url,
          subject_key: fetch.subject_key || `catalog:${providerKey}`,
          provider_key: providerKey,
          exact_model_id: null,
          fetched_at: fetch.fetched_at || now,
          http_status: fetch.http_status,
          content_hash: fetch.content_hash,
        });
      }
    } else {
      // Unavailable: preserve prior offers (AC-6) via stale carry forward
      // (AC-3). A failed fetch never proves removal (AC-5).
      const reason = (task.error_json && task.error_json.message) ||
        (result && Array.isArray(result.errors) && result.errors.join('; ')) ||
        `catalog task ${task.status}`;
      coverage.catalog.unavailable.push({ provider_key: providerKey, reason });
      for (const exactId of assigned) {
        const prior = offerByKey.get(offerChangeKey(providerKey, exactId));
        if (!prior) continue;
        markStale(changeFor(prior));
        coverage.known.stale += 1;
        coverage.known.failed += 1;
      }
    }
  }

  // ── Known refresh lane (AC-3, AC-5, AC-11) ─────────────────────
  for (const task of knownTasks) {
    const providerKey = task.provider_key;
    const assigned = Array.isArray(task.assigned_json) ? task.assigned_json : [];
    coverage.known.assigned += assigned.length;
    const result = task.result_json;
    const hasFacts = (task.status === 'complete' || task.status === 'partial') &&
      !!result && Array.isArray(result.models);
    const modelsById = new Map();
    if (hasFacts) {
      for (const model of result.models) {
        if (model && typeof model.model_id === 'string') modelsById.set(model.model_id, model);
      }
    }

    // Explicit removal declarations (AC-5 official statement). Validated
    // strictly: assigned id, http(s) source URL, non empty reason. Anything
    // weaker is ignored and the offer falls back to normal verification.
    const removalsById = new Map();
    if (hasFacts && Array.isArray(result.removals)) {
      for (const removal of result.removals) {
        if (!removal || typeof removal.model_id !== 'string') continue;
        if (!assigned.includes(removal.model_id)) continue;
        if (typeof removal.source_url !== 'string' || !/^https?:\/\//.test(removal.source_url)) continue;
        if (typeof removal.reason !== 'string' || !removal.reason.trim()) continue;
        removalsById.set(removal.model_id, removal);
      }
    }

    if (hasFacts) {
      for (const exactId of assigned) {
        const prior = offerByKey.get(offerChangeKey(providerKey, exactId));
        if (!prior) continue;
        const change = changeFor(prior);
        const model = modelsById.get(exactId);
        const removal = removalsById.get(exactId);
        if (removal && (!model || model.offer_ended)) {
          change.status = 'confirmed_removed';
          change.last_attempted_at = now;
          change.removal_evidence_json = removalEvidence(
            removal.reason, removal.source_url, task.task_id
          );
          coverage.known.removed += 1;
        } else if (removal && model && !model.offer_ended) {
          // Contradictory evidence (listed live AND declared ended) is not
          // verification and not removal proof.
          markStale(change);
          coverage.known.stale += 1;
          coverage.known.failed += 1;
        } else if (model) {
          markVerified(change, model, 'official_page');
          if (typeof model.pricing_text === 'string' && model.pricing_text.trim()) {
            change.pricing_hash = db.pricingHashFromText(model.pricing_text);
          }
          coverage.known.verified += 1;
        } else {
          // Omitted from a partial result, or the task failed: carry forward
          // as stale (AC-3, AC-11).
          markStale(change);
          coverage.known.stale += 1;
          coverage.known.failed += 1;
        }
      }
      // Models outside the assignment are addition only: discovery input.
      for (const model of result.models) {
        if (!model || typeof model.model_id !== 'string') continue;
        if (assigned.includes(model.model_id)) continue;
        discoveryCandidates.push({
          provider_key: providerKey,
          exact_model_id: model.model_id,
          canonical_model_id: db.canonicalModelId(model.model_id),
          model_name: model.model_name || model.model_id,
          source: 'known_refresh_extra',
          facts: model,
          detected_at: now,
        });
      }
    } else {
      for (const exactId of assigned) {
        const prior = offerByKey.get(offerChangeKey(providerKey, exactId));
        if (!prior) continue;
        markStale(changeFor(prior));
        coverage.known.stale += 1;
        coverage.known.failed += 1;
      }
    }
  }

  // ── Discovery lane (AC-2: nonfatal, addition only) ─────────────
  for (const task of discoveryTasks) {
    coverage.discovery.assigned += 1;
    if (task.status === 'complete') coverage.discovery.complete += 1;
    else if (task.status === 'partial') coverage.discovery.partial += 1;
    else coverage.discovery.failed += 1;

    const result = task.result_json;
    if ((task.status === 'complete' || task.status === 'partial') &&
        result && Array.isArray(result.models)) {
      for (const model of result.models) {
        if (!model || typeof model.model_id !== 'string' || !model.model_id) continue;
        const providerKey = typeof model.provider_key === 'string' && model.provider_key
          ? model.provider_key
          : null;
        // Discovery never mutates known offers: live ids (verified or
        // stale) are owned by their own lane and skipped. A removed id
        // resurfaces as a reappearance candidate so later stages can
        // reverify it (AC-5), still without any offer mutation here (AC-2).
        const existing = providerKey
          ? offerByKey.get(offerChangeKey(providerKey, model.model_id))
          : null;
        if (existing && existing.status !== 'confirmed_removed') continue;
        discoveryCandidates.push({
          provider_key: providerKey,
          exact_model_id: model.model_id,
          canonical_model_id: db.canonicalModelId(model.model_id),
          model_name: model.model_name || model.model_id,
          source: 'discovery',
          reappearance: existing ? true : false,
          facts: model,
          detected_at: now,
        });
      }
    }
  }

  // ── Promotion gate (AC-4) ──────────────────────────────────────
  let canPromote = true;
  let gateReason = null;
  if (coverage.known.assigned > 0 && coverage.known.verified === 0) {
    canPromote = false;
    gateReason = `zero verified known offers out of ${coverage.known.assigned} assigned; previous report and durable state remain current (AC-4)`;
  } else if (coverage.known.assigned === 0 && catalogTasks.length > 0 &&
             coverage.catalog.available.length < catalogTasks.length) {
    canPromote = false;
    gateReason = 'bootstrap run with no assigned known offers requires deterministic catalog success before promotion (AC-4)';
  }

  // Stale disclosure: runs one through three stay ranked, run four moves to
  // caution (AC-3). The status stays stale; caution is report placement.
  const offerChanges = [...changes.values()].map((change) => ({
    ...change,
    in_caution: change.status === 'stale' && change.consecutive_failures >= CAUTION_FAILURES,
  }));
  const caution = offerChanges
    .filter((change) => change.in_caution)
    .map((change) => ({
      provider_key: change.provider_key,
      exact_model_id: change.exact_model_id,
      consecutive_failures: change.consecutive_failures,
    }));

  const runStatus = canPromote ? 'candidate_ready' : 'failed';
  const updatedRun = db.finalizeRun(runId, {
    offers: offerChanges,
    sourceCache,
    runStatus,
    error: gateReason || undefined,
  }, options);

  // Run local outputs for the later stages (classifier, editorial, assembly).
  if (runDir) {
    const reducedDir = path.join(runDir, 'reduced');
    fs.mkdirSync(reducedDir, { recursive: true });
    fs.writeFileSync(
      path.join(reducedDir, 'lane-coverage.json'),
      `${JSON.stringify({
        run_id: runId,
        reduced_at: now,
        can_promote: canPromote,
        gate_reason: gateReason,
        coverage,
        caution,
      }, null, 2)}\n`
    );
    fs.writeFileSync(
      path.join(reducedDir, 'discovery-candidates.json'),
      `${JSON.stringify({
        run_id: runId,
        generated_at: now,
        candidates: discoveryCandidates,
      }, null, 2)}\n`
    );
  }

  return {
    run: updatedRun,
    coverage,
    caution,
    canPromote,
    gateReason,
    offerChanges,
    discoveryCandidates,
    sourceCache,
  };
}

module.exports = {
  CAUTION_FAILURES,
  buildLaneManifest,
  toStartRunTasks,
  validateTaskArtifact,
  ingestTaskArtifacts,
  reduceLanes,
};
