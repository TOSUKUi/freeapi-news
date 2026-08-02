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
const { isPriceEligible: isSharedPriceEligible } = require('../../build/ranking-policy');

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

// Loads the active discovery assignment snapshot for the single daily
// discovery task: discovery_sources, search_terms, and search_windows rows
// (spec 0004 AC-13: the former YAML configuration is SQLite owned). Inactive
// rows are excluded. Sources sort by priority ASC, then last_attempted_at ASC
// with NULL first, then source_key; terms by priority ASC, then last_used_at
// ASC with NULL first, then category/locale/term; windows by priority ASC
// then window_key. SQLite sorts NULL before any value in ascending order, so
// the plain column orders implement the "NULL first" rule.
function loadDiscoveryAssignment(database) {
  const sources = database.prepare(
    'SELECT source_key, category, label, source_url, parent_label, active, priority, ' +
    'added_from, created_at, last_attempted_at, last_success_at, consecutive_failures ' +
    'FROM discovery_sources WHERE active = 1 ' +
    'ORDER BY priority ASC, last_attempted_at ASC, source_key ASC'
  ).all().map((row) => ({ ...row }));
  const terms = database.prepare(
    'SELECT category, locale, term, active, priority, added_from, created_at, last_used_at ' +
    'FROM search_terms WHERE active = 1 ' +
    'ORDER BY priority ASC, last_used_at ASC, category ASC, locale ASC, term ASC'
  ).all().map((row) => ({ ...row }));
  const windows = database.prepare(
    'SELECT window_key, amount, unit, active, priority ' +
    'FROM search_windows WHERE active = 1 ' +
    'ORDER BY priority ASC, window_key ASC'
  ).all().map((row) => ({ ...row }));
  return { sources, terms, windows };
}

// Builds one manifest with two logical lane groups from current SQLite state:
//   catalog:<key>   one per registry provider with api_catalog_url. Assigned
//                   model ids are that provider's current known offers.
//   known:<key>     one per provider with known offers and no catalog.
//                   Carries cached_urls from source_cache so workers try
//                   known good pages first.
//   discovery       exactly one general LLM discovery task, addition only.
//                   Carries the active discovery assignment snapshot
//                   (discovery_sources, search_terms, search_windows) so the
//                   worker searches exactly the sources, terms, and recency
//                   windows this run assigned.
// confirmed_removed offers are never assigned; a catalog can still surface
// them again, which the reducer turns back into verified (AC-5).
function buildLaneManifest(options = {}) {
  const paths = db.resolvePaths(options);
  const providers = loadRegistryProviders(paths.registryPath);
  const regByKey = Object.fromEntries(providers.map((p) => [p.key, p]));

  const database = db.openCollectorDb(options);
  let offers;
  let cacheRows;
  let discoveryAssignment;
  try {
    offers = database.prepare(
      'SELECT * FROM offers ORDER BY provider_key, exact_model_id'
    ).all().map((row) => db.parseRow('offers', row));
    cacheRows = database.prepare(
      'SELECT url, subject_key, provider_key, exact_model_id, fetched_at, http_status ' +
      'FROM source_cache ORDER BY fetched_at DESC'
    ).all();
    discoveryAssignment = loadDiscoveryAssignment(database);
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
    discovery_sources: discoveryAssignment.sources,
    search_terms: discoveryAssignment.terms,
    search_windows: discoveryAssignment.windows,
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
    assigned_model_ids: task.kind === 'discovery' ? undefined : task.assigned_model_ids,
    assigned_json: task.kind === 'discovery'
      ? {
        discovery_sources: task.discovery_sources || [],
        search_terms: task.search_terms || [],
        search_windows: task.search_windows || [],
      }
      : undefined,
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
  const onlyTaskIds = options.onlyTaskIds instanceof Set
    ? options.onlyTaskIds
    : Array.isArray(options.onlyTaskIds) ? new Set(options.onlyTaskIds) : null;
  for (const task of tasks) {
    if (onlyTaskIds && !onlyTaskIds.has(task.task_id)) {
      summary.skipped.push({ task_id: task.task_id, status: task.status || 'pending' });
      continue;
    }
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
// (Removed: free_model_names inventory is gone per spec 0004 AC-2.)

// Spec 0004 AC-4 admission: an exact catalog model is price eligible when
// its effective input is at most 0.2 USD and effective output at most 0.4
// USD per million tokens, or both are positive zero (FREE). Unknown prices
// are never eligible. This is a deterministic derivation; the assembler
// re-derives access_kind from the typed columns. Input values are already
// normalized to USD per million before this check (see normalizeCatalogPrice).
function isPriceEligible(promptPrice, completionPrice) {
  return isSharedPriceEligible(Number(promptPrice), Number(completionPrice));
}

// Catalog price normalization (spec 0004 AC-3, AC-4). Official catalogs such
// as OpenRouter price per TOKEN, while this system stores and compares USD
// per MILLION tokens. The deterministic catalog path knows the unit from the
// provider source (per_token for OpenRouter style catalogs) and multiplies
// by 1,000,000 before any threshold, storage, or report. Raw source amounts
// are preserved in source_amount_* so the evidence stays auditable. A unit
// already in per million tokens passes through unchanged.
function normalizeCatalogPrice(value, unit) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (unit === 'per_token') return n * 1000000;
  // per_million_tokens and unknown units are stored as given; unknown units
  // from the deterministic catalog path are treated as per million because
  // that is the contract every provider registry row follows.
  return n;
}

// The exact catalog unit for the provider registry. Only the OpenRouter
// style official catalog is known to quote per token; every other registered
// catalog provider is expected to quote per million tokens.
function catalogSourceUnit(providerKey) {
  return providerKey === 'openrouter' ? 'per_token' : 'per_million_tokens';
}

// Persists the typed price columns (spec 0004 AC-3) from a catalog model
// entry onto an offer change. Catalog source prices are normalized to USD
// per million tokens before storage (per_token × 1,000,000). The raw source
// amounts and the source unit stay in source_amount_* / source_unit so the
// evidence remains auditable. The catalog URL is the price source.
function applyCatalogPrices(change, entry, catalogUrl, sourceUnit) {
  const unit = sourceUnit || 'per_million_tokens';
  const input = normalizeCatalogPrice(entry.prompt_price, unit);
  const output = normalizeCatalogPrice(entry.completion_price, unit);
  const rawInput = Number(entry.prompt_price);
  const rawOutput = Number(entry.completion_price);
  if (input !== null && input >= 0) {
    change.normal_input_price_usd = input;
    change.effective_input_price_usd = input;
  }
  if (output !== null && output >= 0) {
    change.normal_output_price_usd = output;
    change.effective_output_price_usd = output;
  }
  if (Number.isFinite(rawInput) && rawInput >= 0) {
    change.source_amount_input = rawInput;
    change.normal_source_amount_input = rawInput;
    change.effective_source_amount_input = rawInput;
  }
  if (Number.isFinite(rawOutput) && rawOutput >= 0) {
    change.source_amount_output = rawOutput;
    change.normal_source_amount_output = rawOutput;
    change.effective_source_amount_output = rawOutput;
  }
  if (isHttpUrl(catalogUrl)) {
    change.price_source_url = catalogUrl;
  }
  change.source_currency = 'USD';
  change.source_unit = unit;
}

// Persists the typed price columns (spec 0004 AC-3) from structured worker
// facts (crawl-facts.schema.json price fields) when present.
//
// Worker supplied *_price_usd values are NOT trusted as authoritative USD
// per million. The deterministic code derives USD/M from the raw source
// amount and a recognized token unit:
//   * USD per_token        -> amount × 1,000,000
//   * USD per_million_tokens -> amount as stored
//   * other currency       -> amount × conversion_rate × (1,000,000 when
//     per_token) and only when a positive finite conversion rate, an http(s)
//     conversion source, and an ISO confirmation time are all present. The
//     caller must also set the internal evidence marker after deterministic
//     2xx body checks; URLs, rates, and dates alone are never sufficient.
// Non token units (request, image, search) are never converted to a token
// price. A worker supplied price_verified_at is ignored: the confirmation
// date refreshes only on real fetched price evidence (AC-8).
//
// Returns true when this run derived fresh effective prices from source
// amounts (that is price evidence the caller may use to refresh
// price_verified_at), false otherwise.
function applyStructuredPrices(change, model) {
  if (!model || typeof model !== 'object' || model._price_evidence_verified !== true) return false;
  const hasNew = ['normal', 'effective'].some((tier) => ['input', 'output', 'cache_read', 'cache_write']
    .some((kind) => model[`${tier}_source_amount_${kind}`] !== undefined && model[`${tier}_source_amount_${kind}`] !== null));
  const hasLegacy = model.source_amount_input !== undefined || model.source_amount_output !== undefined;
  // The compatibility shape is all or nothing and only represents an
  // undiscounted price. Mixing it with the new shape creates ambiguous state.
  if (hasNew && hasLegacy) return false;
  const sourceUnit = stringOrNull(model.source_unit);
  const sourceCurrency = stringOrNull(model.source_currency);
  const conversionRate = numberOrNull(model.conversion_rate);
  const conversionSource = stringOrNull(model.conversion_source);
  const conversionConfirmedAt = stringOrNull(model.conversion_confirmed_at);
  const derive = (input, output) => deriveUsdPerMillion({
    sourceAmountInput: numberOrNull(input), sourceAmountOutput: numberOrNull(output),
    sourceUnit, sourceCurrency, conversionRate, conversionSource, conversionConfirmedAt,
  });
  const setRaw = (tier, kind, value) => {
    const n = numberOrNull(value);
    if (n !== null && n >= 0) change[`${tier}_source_amount_${kind}`] = n;
    return n;
  };
  if (hasLegacy) {
    const input = numberOrNull(model.source_amount_input);
    const output = numberOrNull(model.source_amount_output);
    const derived = derive(input, output);
    if (!derived) return false;
    change.source_amount_input = input;
    change.source_amount_output = output;
    change.normal_source_amount_input = input;
    change.normal_source_amount_output = output;
    change.effective_source_amount_input = input;
    change.effective_source_amount_output = output;
    change.normal_input_price_usd = change.effective_input_price_usd = derived.inputPerM;
    change.normal_output_price_usd = change.effective_output_price_usd = derived.outputPerM;
  } else {
    for (const tier of ['normal', 'effective']) {
      const input = setRaw(tier, 'input', model[`${tier}_source_amount_input`]);
      const output = setRaw(tier, 'output', model[`${tier}_source_amount_output`]);
      const derived = derive(input, output);
      if (derived) {
        change[`${tier}_input_price_usd`] = derived.inputPerM;
        change[`${tier}_output_price_usd`] = derived.outputPerM;
      }
      for (const kind of ['cache_read', 'cache_write']) {
        const raw = setRaw(tier, kind, model[`${tier}_source_amount_${kind}`]);
        if (raw !== null) {
          const cacheDerived = derive(raw, raw);
          if (!cacheDerived) return false;
          change[`${tier}_cache_${kind.replace('cache_', '')}_price_usd`] = cacheDerived.inputPerM;
        }
      }
    }
  }
  if (sourceCurrency !== null) change.source_currency = sourceCurrency;
  if (sourceUnit !== null) change.source_unit = sourceUnit;
  if (conversionRate !== null) change.conversion_rate = conversionRate;
  if (conversionSource !== null) change.conversion_source = conversionSource;
  if (conversionConfirmedAt !== null) change.conversion_confirmed_at = conversionConfirmedAt;
  for (const field of ['price_source_url', 'discount_start_at', 'discount_end_at']) {
    const value = stringOrNull(model[field]);
    if (value !== null) change[field] = value;
  }
  return Number.isFinite(change.effective_input_price_usd) && Number.isFinite(change.effective_output_price_usd);
}

// Recognized token price units for deterministic conversion.
const TOKEN_UNIT_ALIASES = {
  per_token: 'per_token',
  'per-token': 'per_token',
  pertoken: 'per_token',
  token: 'per_token',
  per_million_tokens: 'per_million_tokens',
  'per-million-tokens': 'per_million_tokens',
  per_million: 'per_million_tokens',
  per_1m_tokens: 'per_million_tokens',
};

function normalizeSourceUnit(value) {
  const u = stringOrNull(value);
  if (!u) return null;
  const key = String(u).trim().toLowerCase();
  return TOKEN_UNIT_ALIASES[key] || null;
}

function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

// Deterministic USD per million derivation. Returns null unless both input
// and output can be derived with complete evidence. Non USD requires a
// positive finite conversion rate, an http(s) conversion source, and an ISO
// confirmation time. Non token units never convert.
function deriveUsdPerMillion(evidence) {
  const {
    sourceAmountInput,
    sourceAmountOutput,
    sourceUnit,
    sourceCurrency,
    conversionRate,
    conversionSource,
    conversionConfirmedAt,
  } = evidence;
  if (sourceAmountInput === null || sourceAmountOutput === null) return null;
  if (sourceAmountInput < 0 || sourceAmountOutput < 0) return null;
  const unit = normalizeSourceUnit(sourceUnit);
  if (!unit) return null;
  const currency = sourceCurrency ? String(sourceCurrency).trim().toUpperCase() : 'USD';
  let perMillionFactor = unit === 'per_token' ? 1000000 : 1;
  if (currency !== 'USD') {
    if (typeof conversionRate !== 'number' || !Number.isFinite(conversionRate) || conversionRate <= 0) return null;
    if (!conversionSource || !/^https?:\/\//.test(conversionSource)) return null;
    if (!conversionConfirmedAt || Number.isNaN(Date.parse(conversionConfirmedAt))) return null;
  }
  const inputPerM = sourceAmountInput * perMillionFactor * (currency === 'USD' ? 1 : conversionRate);
  const outputPerM = sourceAmountOutput * perMillionFactor * (currency === 'USD' ? 1 : conversionRate);
  if (!Number.isFinite(inputPerM) || !Number.isFinite(outputPerM)) return null;
  return { inputPerM, outputPerM };
}

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

// Spec 0004 AC-11: an unregistered API provider found by a worker becomes a
// validated candidate Registry entry only when the official connection
// instructions are present (fetched base_url, docs_url, label, and a model id
// form). The deterministic reducer validates the shape; a failed validation
// drops the candidate and leaves the canonical Registry unchanged.
function validateProviderCandidate(candidate, knownKeys) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'provider_candidate is not an object' };
  }
  const key = typeof candidate.provider_key === 'string' ? candidate.provider_key.trim() : '';
  if (!/^[a-z][a-z0-9_]*$/.test(key)) {
    return { ok: false, reason: `provider_key ${JSON.stringify(key)} must be a lowercase identifier` };
  }
  if (knownKeys.has(key)) {
    return { ok: false, reason: `provider ${key} is already registered` };
  }
  if (typeof candidate.label !== 'string' || !candidate.label.trim()) {
    return { ok: false, reason: `provider ${key} requires a label` };
  }
  if (!isHttpUrl(candidate.base_url)) {
    return { ok: false, reason: `provider ${key} requires an http(s) base_url` };
  }
  if (!isHttpUrl(candidate.docs_url)) {
    return { ok: false, reason: `provider ${key} requires an http(s) docs_url` };
  }
  if (typeof candidate.model_id_pattern !== 'string' || !candidate.model_id_pattern.trim()) {
    return { ok: false, reason: `provider ${key} requires a model_id pattern` };
  }
  // In the live pipeline the evidence auditor sets _evidence_verified. The
  // undefined case remains readable for legacy direct reducer callers; worker
  // schema validation requires model_id_example before a real run proceeds.
  if (candidate._evidence_verified === false) {
    return { ok: false, reason: `provider ${key} lacks deterministic fetched docs evidence` };
  }
  let pattern;
  try {
    pattern = new RegExp(candidate.model_id_pattern);
  } catch {
    return { ok: false, reason: `provider ${key} model_id_pattern is not a valid regex` };
  }
  // A deterministic base_url_pattern anchors the endpoint match used by the
  // validator (spec 0004 AC-11): the candidate base_url must be a literal
  // official host+path prefix.
  let baseUrlPattern;
  try {
    const u = new URL(candidate.base_url);
    if (!['http:', 'https:'].includes(u.protocol)) {
      return { ok: false, reason: `provider ${key} base_url protocol must be http(s)` };
    }
    const escaped = candidate.base_url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    baseUrlPattern = `^${escaped}/?$`;
  } catch {
    return { ok: false, reason: `provider ${key} base_url is not a valid URL` };
  }
  const modelIdExample = typeof candidate.model_id_example === 'string' && candidate.model_id_example.trim()
    ? candidate.model_id_example.trim()
    : `${key}/example-model`;
  if (!pattern.test(modelIdExample)) {
    return { ok: false, reason: `provider ${key} model_id_pattern does not match model_id_example` };
  }
  return { ok: true, entry: {
    key,
    label: candidate.label.trim(),
    base_url: candidate.base_url.trim(),
    base_url_pattern: baseUrlPattern,
    docs_url: candidate.docs_url.trim(),
    model_id_pattern: candidate.model_id_pattern.trim(),
    model_id_example: modelIdExample,
    delivery_type: (candidate.delivery_type || 'official').trim(),
    notes: typeof candidate.notes === 'string' && candidate.notes.trim() ? candidate.notes.trim() : null,
    added_from: candidate.docs_url.trim(),
    added_at: nowIso().slice(0, 10),
  } };
}

// Collects and validates provider registration candidates from one task
// artifact (spec 0004 AC-11). Only fetched official instructions with a
// documented base URL and model id form are accepted; anything weaker is
// dropped and does not change the canonical Registry.
function collectProviderCandidates(result, task, knownProviderKeys, out) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.provider_candidates)) return;
  const seen = new Set(out.map((entry) => String(entry.provider_key || '')));
  for (const candidate of result.provider_candidates) {
    const stableKey = String(candidate && candidate.provider_key || '');
    if (!stableKey || seen.has(stableKey)) continue;
    seen.add(stableKey);
    const check = validateProviderCandidate(candidate, knownProviderKeys);
    if (!check.ok) {
      out.push({
        provider_key: candidate && candidate.provider_key,
        task_id: task && task.task_id,
        accepted: false,
        reason: check.reason,
        detected_at: nowIso(),
      });
      continue;
    }
    knownProviderKeys.add(check.entry.key);
    out.push({
      provider_key: check.entry.key,
      task_id: task && task.task_id,
      accepted: true,
      entry: check.entry,
      detected_at: nowIso(),
    });
  }
}

// Allowed discovery_sources categories (must match migration 0003 CHECK).
const SOURCE_CATEGORIES = new Set([
  'vendor', 'router', 'host', 'product', 'discovery',
  'community', 'benchmark', 'watchlist', 'other',
]);

// Spec 0004 AC-10: a discovery source candidate becomes durable only when it
// is a well formed http(s) URL with a category and label. The reducer
// inserts it into discovery_sources idempotently and never removes an
// existing row. An unknown category is rejected (not silently remapped),
// so a worker mistake can never crash the finalize transaction.
function validateSourceCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, reason: 'source_candidate is not an object' };
  }
  const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
  const url = typeof candidate.source_url === 'string' ? candidate.source_url.trim() : '';
  if (!label) return { ok: false, reason: 'source_candidate requires a label' };
  if (!isHttpUrl(url)) return { ok: false, reason: `source ${label} requires an http(s) source_url` };
  const category = typeof candidate.category === 'string' && candidate.category.trim()
    ? candidate.category.trim()
    : 'other';
  if (!SOURCE_CATEGORIES.has(category)) {
    return { ok: false, reason: `source ${label} category ${JSON.stringify(category)} is not one of ${[...SOURCE_CATEGORIES].join(', ')}` };
  }
  return { ok: true, entry: {
    source_key: `${category}:${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}`,
    category,
    label,
    source_url: url,
    parent_label: typeof candidate.parent_label === 'string' && candidate.parent_label.trim()
      ? candidate.parent_label.trim()
      : null,
    added_from: candidate.reason || 'discovery',
  } };
}

// Collects validated source candidates from a task artifact into a Map keyed
// by source_key (deduplication across lanes and runs).
function collectSourceCandidates(result, task, out) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.source_candidates)) return;
  for (const candidate of result.source_candidates) {
    if (!candidate || candidate._evidence_verified === false) continue;
    const check = validateSourceCandidate(candidate);
    if (!check.ok) continue;
    const key = check.entry.source_key;
    if (!out.has(key)) out.set(key, check.entry);
  }
}

// Keep catalog offer facts limited to values in the deterministic artifact.
// In particular, do not create quota or rate-limit claims from a zero price.
function catalogModelFacts(result, entry, catalogUrl) {
  const facts = {
    ...(entry || {}),
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
  const providerCandidates = [];
  const sourceCandidates = new Map();
  const knownProviderKeys = new Set(providers.map((p) => p.key));
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
      // Spec 0004 AC-3/AC-8: typed price columns carry forward on a failed
      // fetch so the last verified price and confirmation date stay live.
      for (const column of db.OFFER_PRICE_COLUMNS) {
        if (prior[column] !== undefined && prior[column] !== null) {
          change[column] = prior[column];
        }
      }
      changes.set(key, change);
    }
    return change;
  }

  // Refreshes price_verified_at only when this run produced fresh price
  // evidence (AC-8). Catalog success is price evidence; a known refresh that
  // derived prices from structured facts is price evidence; an endpoint only
  // refresh or a carry forward keeps the prior confirmation date.
  function markVerified(change, modelFacts, sourceKind, priceEvidence) {
    change.status = 'verified';
    change.consecutive_failures = 0;
    change.last_attempted_at = now;
    change.last_verified_at = now;
    change.source_kind = sourceKind;
    change.removal_evidence_json = null;
    // A verified check that carried effective prices also confirms the price
    // confirmation date (AC-8) only when the caller says this run produced
    // the prices (catalog fetch success or fresh derived structured prices).
    if (priceEvidence === true) {
      change.price_verified_at = now;
    }
    const priorFacts = change.facts_json && typeof change.facts_json === 'object' && !Array.isArray(change.facts_json)
      ? change.facts_json
      : {};
    const durableFacts = { ...(modelFacts || {}) };
    delete durableFacts._price_evidence_verified;
    change.facts_json = { ...priorFacts, ...durableFacts };
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
      const sourceUnit = catalogSourceUnit(providerKey);
      const entriesById = new Map(result.models.map((m) => [m.model_id, m]));
      const priceEligibleIds = new Set(
        result.models
          .filter((model) => model && isPriceEligible(
            normalizeCatalogPrice(model.prompt_price, sourceUnit),
            normalizeCatalogPrice(model.completion_price, sourceUnit)
          ))
          .map((model) => model.model_id)
      );

      // Every prior offer for this provider takes part, not just the
      // assigned (verified and stale) ones: a reappearing exact id returns
      // a confirmed_removed offer to verified (AC-5).
      for (const prior of priorOffers) {
        if (prior.provider_key !== providerKey) continue;
        const entry = entriesById.get(prior.exact_model_id);
        const priceEligible = !!entry && priceEligibleIds.has(entry.model_id);
        if (prior.status === 'confirmed_removed') {
          if (priceEligible) {
            const change = changeFor(prior);
            applyCatalogPrices(change, entry, catalogUrl, sourceUnit);
            if (entry.pricing_hash) change.pricing_hash = entry.pricing_hash;
            markVerified(
              change,
              catalogModelFacts(result, entry, catalogUrl),
              'catalog',
              true
            );
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
        } else if (priceEligible) {
          // A reappearing exact id returns to verified (AC-5), including
          // offers previously confirmed_removed.
          applyCatalogPrices(change, entry, catalogUrl, sourceUnit);
          markVerified(
            change,
            catalogModelFacts(result, entry, catalogUrl),
            'catalog',
            true
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
          // Present but no longer free or ultra low: official price change
          // (AC-5) and the price gate (AC-4) both exclude the offer. Keep
          // the confirmed price in the evidence so a later decrease can
          // restore it deterministically.
          change.status = 'confirmed_removed';
          change.last_attempted_at = now;
          change.removal_evidence_json = removalEvidence(
            'official catalog pricing is no longer free or ultra low', catalogUrl, task.task_id,
            { pricing: entry.pricing || null }
          );
          coverage.known.removed += 1;
        }
      }

      // A valid catalog is also the deterministic admission path for every
      // previously unseen price-eligible exact ID (free or ultra low). Keep a
      // discovery record for audit visibility, but persist the offer change in
      // the same finalizeRun transaction as existing liveness changes.
      for (const entry of result.models) {
        if (!priceEligibleIds.has(entry.model_id)) continue;
        const identity = offerChangeKey(providerKey, entry.model_id);
        if (offerByKey.has(identity) || changes.has(identity)) continue;
        const facts = catalogModelFacts(result, entry, catalogUrl);
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
        applyCatalogPrices(change, entry, catalogUrl, sourceUnit);
        change.price_verified_at = now;
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

    // Explicit removal declarations (AC-5 official statement). The evidence
    // auditor must first prove a fetched 2xx body contains this exact model id
    // and termination language; reducer callers cannot bypass that gate.
    const removalsById = new Map();
    if (hasFacts && Array.isArray(result.removals)) {
      for (const removal of result.removals) {
        if (!removal || removal._evidence_verified !== true || typeof removal.model_id !== 'string') continue;
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
          const priceEvidence = applyStructuredPrices(change, model);
          markVerified(change, model, 'official_page', priceEvidence);
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

  // Collect provider and source candidates from every lane artifact exactly
  // once. Evidence auditing has already removed unverified claims.
  for (const task of [...knownTasks, ...catalogTasks, ...discoveryTasks]) {
    collectProviderCandidates(task.result_json, task, knownProviderKeys, providerCandidates);
    collectSourceCandidates(task.result_json, task, sourceCandidates);
  }

  // Collect provider registration candidates from every lane artifact
  // (spec 0004 AC-11). Deterministic validation keeps the canonical Registry
  // unchanged on any failure.
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
  const audited = [];
  for (const task of tasks) {
    const audit = task.result_json && task.result_json._evidence;
    if (audit) audited.push(audit);
  }
  const auditedCache = audited.flatMap((a) => a.source_cache || []);
  const auditedHealth = audited.flatMap((a) => a.source_health || []);
  const assignmentTask = discoveryTasks[0];
  const assignment = assignmentTask && assignmentTask.assigned_json && !Array.isArray(assignmentTask.assigned_json)
    ? assignmentTask.assigned_json : {};
  const updatedRun = db.finalizeRun(runId, {
    offers: offerChanges,
    sourceCache: sourceCache.concat(auditedCache),
    discoverySources: [...sourceCandidates.values()],
    discoveryAssignments: {
      attempted_at: now,
      sources: assignment.discovery_sources || [],
      terms: assignment.search_terms || [],
      health: auditedHealth,
    },
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
    fs.writeFileSync(
      path.join(reducedDir, 'provider-candidates.json'),
      `${JSON.stringify({
        run_id: runId,
        generated_at: now,
        candidates: providerCandidates,
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
    providerCandidates,
    sourceCandidates: [...sourceCandidates.values()],
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
  isPriceEligible,
  normalizeCatalogPrice,
  catalogSourceUnit,
  deriveUsdPerMillion,
  applyCatalogPrices,
  applyStructuredPrices,
  validateProviderCandidate,
  collectProviderCandidates,
  validateSourceCandidate,
  collectSourceCandidates,
};
