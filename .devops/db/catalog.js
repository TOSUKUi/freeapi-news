'use strict';

// Deterministic catalog ownership. Spec 0003 fail safe collection pipeline,
// child 0002 (AC-6).
//
// Providers with an exhaustive official model catalog (registry
// api_catalog_url, e.g. OpenRouter GET /api/v1/models) are enumerated by this
// module, never by an LLM. A weak local model can derail, narrate instead of
// calling the API, and emit a schema valid but empty "failure" that silently
// drops the whole provider; the catalog is mechanical, so code owns it. No
// LLM fallback may reconstruct the catalog.
//
// Rules (AC-6):
//   * Validate HTTP success, JSON object shape, nonempty data, unique string
//     ids, and paired prices when a catalog publishes them. Prices may be
//     decimal strings or JSON numbers. Invalid pairs make the catalog
//     unavailable and preserve prior offers; entries without prices remain
//     present for liveness but cannot be admitted.
//   * Free means parsed prompt price equals positive zero AND parsed
//     completion price equals positive zero. "0", "0.0", and "0.00000000"
//     are equivalent; "-0" is not positive zero.
//   * A nonempty valid catalog with zero free offers is authoritative (after
//     the normal same run retry) and may confirm prior free offer removal.
//     An empty data array is invalid and can never confirm removal.
//   * The registry base_url is the endpoint. The registry docs_url is fetched
//     and used as endpoint_source because it documents the base URL. The
//     catalog URL stays separate as pricing and liveness evidence. A generated
//     model page URL is never endpoint or successful cache evidence (AC-16).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

const db = require('./collector-db');

// Catalogs commonly serialize prices as decimal strings (OpenRouter), but
// some official OpenAI compatible catalogs serialize the same per-million
// values as JSON numbers (NanoGPT). Accept both representations while still
// rejecting NaN, Infinity, hex, bare signs, and non-finite values before the
// free check.
const DECIMAL_PATTERN = /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/;

function parseDecimalPrice(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!DECIMAL_PATTERN.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// Positive zero only: Object.is style check via 1/n so "-0" is not free.
function isPositiveZero(n) {
  return n === 0 && 1 / n === Infinity;
}

function sha256Text(body) {
  return crypto.createHash('sha256').update(body).digest('hex');
}

function cleanModelName(name) {
  return String(name || '').replace(/\s*\(free\)\s*$/i, '').trim();
}

// Validates the whole catalog response shape. Strict on purpose: one entry
// with a non string or unparseable price means the response is not the shape
// removal proof depends on, so the whole catalog is unavailable and prior
// offers are preserved (fail safe, never a false removal).
// Returns { ok, errors, entries } where entries carry parsed prices, the
// is_free flag, and the canonical numeric pricing hash.
function validateCatalogResponse(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, errors: ['catalog response is not a JSON object'], entries: [] };
  }
  if (!Array.isArray(json.data)) {
    return { ok: false, errors: ['catalog response has no data array'], entries: [] };
  }
  if (json.data.length === 0) {
    // An empty catalog cannot confirm removal (AC-6).
    return { ok: false, errors: ['catalog data array is empty (invalid, cannot confirm removal)'], entries: [] };
  }
  const errors = [];
  const seen = new Set();
  const entries = [];
  json.data.forEach((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`data[${index}] is not an object`);
      return;
    }
    if (typeof item.id !== 'string' || item.id.length === 0) {
      errors.push(`data[${index}].id is not a non empty string`);
      return;
    }
    if (seen.has(item.id)) {
      errors.push(`duplicate model id ${item.id}`);
      return;
    }
    seen.add(item.id);
    const pricing = item.pricing && typeof item.pricing === 'object' ? item.pricing : {};
    const hasPrompt = pricing.prompt !== undefined && pricing.prompt !== null;
    const hasCompletion = pricing.completion !== undefined && pricing.completion !== null;
    const prompt = hasPrompt ? parseDecimalPrice(pricing.prompt) : null;
    const completion = hasCompletion ? parseDecimalPrice(pricing.completion) : null;
    if (hasPrompt && prompt === null) {
      errors.push(`data[${index}] (${item.id}) prompt price is not a parseable decimal value: ${JSON.stringify(pricing.prompt)}`);
    }
    if (hasCompletion && completion === null) {
      errors.push(`data[${index}] (${item.id}) completion price is not a parseable decimal value: ${JSON.stringify(pricing.completion)}`);
    }
    if ((hasPrompt && prompt === null) || (hasCompletion && completion === null)) return;
    if (hasPrompt !== hasCompletion) {
      errors.push(`data[${index}] (${item.id}) must provide both prompt and completion prices or neither`);
      return;
    }
    const priceKnown = hasPrompt && hasCompletion;
    const entry = {
      exact_model_id: item.id,
      model_name: typeof item.name === 'string' && item.name ? item.name : item.id,
      prompt,
      completion,
      prompt_raw: priceKnown ? pricing.prompt : null,
      completion_raw: priceKnown ? pricing.completion : null,
      price_known: priceKnown,
      is_free: priceKnown && isPositiveZero(prompt) && isPositiveZero(completion),
      pricing_hash: priceKnown ? db.pricingHash(prompt, completion) : null,
    };
    // Preserve optional detailed catalog facts as evidence. These fields are
    // additive and provider neutral: they let the assembler show conditions
    // such as training-data opt in instead of reducing a rich catalog row to
    // only its price.
    if (typeof item.description === 'string' && item.description.trim()) {
      entry.description = item.description.trim();
    }
    if (typeof item.owned_by === 'string' && item.owned_by.trim()) {
      entry.owned_by = item.owned_by.trim();
    }
    if (Number.isInteger(item.context_length) && item.context_length >= 0) {
      entry.context_tokens = item.context_length;
    }
    if (Number.isInteger(item.max_output_tokens) && item.max_output_tokens >= 0) {
      entry.max_output_tokens = item.max_output_tokens;
    }
    if (item.capabilities && typeof item.capabilities === 'object' && !Array.isArray(item.capabilities)) {
      entry.capabilities = { ...item.capabilities };
    }
    if (item.pricing && typeof item.pricing.unit === 'string') {
      entry.pricing_unit = item.pricing.unit;
    }
    if (item.pricing && typeof item.pricing.currency === 'string') {
      entry.pricing_currency = item.pricing.currency;
    }
    // Some official catalogs publish a release date. Preserve it as raw
    // evidence when present; missing dates remain unknown and are handled by
    // the benchmark queue's fail-safe policy. OpenAI compatible catalogs may
    // expose only a Unix created timestamp, which is equivalent evidence.
    if (typeof item.release_date === 'string' && item.release_date.trim()) {
      entry.release_date = item.release_date.trim();
    } else if (Number.isFinite(item.created)) {
      const created = new Date(Number(item.created) * 1000);
      if (!Number.isNaN(created.getTime())) entry.release_date = created.toISOString().slice(0, 10);
    }
    entries.push(entry);
  });
  if (errors.length > 0) {
    return { ok: false, errors, entries: [] };
  }
  return { ok: true, errors: [], entries };
}

// Default HTTP fetch: no deps, follows up to 3 redirects, 30s timeout.
// Resolves { status, body } for any completed HTTP response; rejects on
// network errors and timeouts.
function defaultFetch(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('https:') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'free-api-news-collector/2.0 (deterministic catalog)',
        Accept: 'application/json',
      },
    }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(defaultFetch(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error(`timeout fetching ${url}`)));
  });
}

// Fetches and validates one provider catalog. Never throws for ordinary
// fetch or validation failure: it returns a task artifact with
// status/available describing the outcome, so the lane reducer can apply
// AC-6 (unavailable preserves prior offers, authoritative confirms removal).
//
// task: manifest task { task_id, provider_key, api_catalog_url }
// registryEntry: provider registry row { base_url, docs_url, api_catalog_url }
// options: { now?, fetchImpl?, attempts? } (attempts defaults to 2: the
// normal same run retry)
async function fetchCatalogForProvider(task, registryEntry, options = {}) {
  const now = options.now || new Date().toISOString();
  const fetchImpl = options.fetchImpl || defaultFetch;
  const attempts = Number.isInteger(options.attempts) && options.attempts > 0 ? options.attempts : 2;
  const reg = registryEntry || {};
  const catalogUrl = task.api_catalog_url || reg.api_catalog_url || null;
  const providerKey = task.provider_key || null;

  const base = {
    schema_version: 1,
    task_id: task.task_id,
    kind: 'catalog',
    provider_key: providerKey,
    crawled_at: now,
    catalog_url: catalogUrl,
    base_url: reg.base_url || null,
  };

  if (!catalogUrl) {
    return { ...base, status: 'failed', available: false, http_status: null, content_hash: null, endpoint_source: null, endpoint_source_hash: null, models: [], fetches: [], errors: ['no api_catalog_url configured'] };
  }

  // Same run retry: transient failures get a second attempt before the
  // catalog is declared unavailable.
  let body = null;
  let httpStatus = null;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetchImpl(catalogUrl);
      httpStatus = res.status;
      if (res.status === 200) {
        body = res.body;
        lastError = null;
        break;
      }
      lastError = new Error(`HTTP ${res.status} for ${catalogUrl}`);
    } catch (err) {
      lastError = err;
    }
  }

  if (body === null) {
    return {
      ...base,
      status: 'failed',
      available: false,
      http_status: httpStatus,
      content_hash: null,
      endpoint_source: null,
      endpoint_source_hash: null,
      models: [],
      fetches: [],
      errors: [`catalog fetch failed after ${attempts} attempts: ${lastError ? lastError.message : 'unknown error'}`],
    };
  }

  const contentHash = sha256Text(body);
  let json;
  try {
    json = JSON.parse(body);
  } catch (err) {
    return {
      ...base,
      status: 'failed',
      available: false,
      http_status: httpStatus,
      content_hash: contentHash,
      endpoint_source: null,
      endpoint_source_hash: null,
      models: [],
      fetches: [],
      errors: [`catalog response is not valid JSON: ${err.message}`],
    };
  }

  const check = validateCatalogResponse(json);
  if (!check.ok) {
    // Invalid shape: unavailable. No cache entry (not a known good page),
    // no removal proof. Prior offers are preserved by the lane reducer.
    return {
      ...base,
      status: 'failed',
      available: false,
      http_status: httpStatus,
      content_hash: contentHash,
      endpoint_source: null,
      endpoint_source_hash: null,
      models: [],
      fetches: [],
      errors: check.errors,
    };
  }

  // The registry docs page documents the base URL; fetch it and use it as
  // endpoint_source. Failure is not fatal: the catalog stays authoritative
  // for liveness and pricing, and prior endpoint facts carry forward.
  let endpointSource = null;
  let endpointHash = null;
  let endpointStatus = null;
  const docsUrl = reg.docs_url || null;
  if (docsUrl) {
    try {
      const res = await fetchImpl(docsUrl);
      endpointStatus = res.status;
      if (res.status === 200) {
        endpointSource = docsUrl;
        endpointHash = sha256Text(res.body);
      }
    } catch {
      endpointSource = null;
    }
  }

  const models = check.entries.map((entry) => ({
    model_id: entry.exact_model_id,
    model_name: cleanModelName(entry.model_name),
    pricing: {
      prompt: entry.prompt_raw,
      completion: entry.completion_raw,
      ...(entry.pricing_currency ? { currency: entry.pricing_currency } : {}),
      ...(entry.pricing_unit ? { unit: entry.pricing_unit } : {}),
    },
    prompt_price: entry.prompt,
    completion_price: entry.completion,
    price_known: entry.price_known,
    is_free: entry.is_free,
    pricing_hash: entry.pricing_hash,
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.owned_by ? { owned_by: entry.owned_by } : {}),
    ...(entry.context_tokens !== undefined ? { context_tokens: entry.context_tokens } : {}),
    ...(entry.max_output_tokens !== undefined ? { max_output_tokens: entry.max_output_tokens } : {}),
    ...(entry.capabilities ? { capabilities: entry.capabilities } : {}),
    ...(entry.release_date ? { release_date: entry.release_date } : {}),
  }));

  // Only actually successful fetches become cache evidence (AC-16). The
  // catalog URL is pricing and liveness evidence; the docs URL is endpoint
  // evidence. Generated model page URLs are deliberately absent.
  const fetches = [{
    url: catalogUrl,
    subject_key: `catalog:${providerKey}`,
    http_status: httpStatus,
    content_hash: contentHash,
    fetched_at: now,
  }];
  if (endpointSource) {
    fetches.push({
      url: docsUrl,
      subject_key: `endpoint:${providerKey}`,
      http_status: endpointStatus,
      content_hash: endpointHash,
      fetched_at: now,
    });
  }

  return {
    ...base,
    status: 'complete',
    available: true,
    http_status: httpStatus,
    content_hash: contentHash,
    endpoint_source: endpointSource,
    endpoint_source_hash: endpointHash,
    models,
    fetches,
    errors: [],
  };
}

function loadRegistryProviders(registryPath) {
  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const providers = Array.isArray(raw) ? raw : raw.providers;
  if (!Array.isArray(providers)) {
    throw new Error(`provider registry has no providers array: ${registryPath}`);
  }
  return providers;
}

// CLI: fetch every catalog task in a run manifest and write the artifacts.
//   node .devops/db/catalog.js <run_dir>
// The manifest is <run_dir>/manifest.json (written by the orchestrator from
// buildLaneManifest). Artifacts land at <run_dir>/artifacts/<task_id>.json.
async function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('usage: node .devops/db/catalog.js <run_dir>');
    process.exit(1);
  }
  db.assertRuntime();
  const manifestPath = path.join(runDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const paths = db.resolvePaths({});
  const providers = loadRegistryProviders(paths.registryPath);
  const regByKey = Object.fromEntries(providers.map((p) => [p.key, p]));

  const catalogTasks = (manifest.tasks || []).filter((t) => t.kind === 'catalog');
  if (catalogTasks.length === 0) {
    console.log('catalog: no catalog tasks in manifest. Nothing to do.');
    return;
  }
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  for (const task of catalogTasks) {
    const artifact = await fetchCatalogForProvider(task, regByKey[task.provider_key] || {});
    const outPath = db.artifactPathFor(runDir, task.task_id);
    fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
    if (artifact.available) {
      const free = artifact.models.filter((m) => m.is_free).length;
      console.log(`  ✅ ${task.provider_key}: ${artifact.models.length} model(s), ${free} free → ${path.relative(runDir, outPath)}`);
    } else {
      console.log(`  ❌ ${task.provider_key}: catalog unavailable (${(artifact.errors[0] || 'unknown')}); prior offers preserved`);
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`catalog fetch aborted: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  DECIMAL_PATTERN,
  parseDecimalPrice,
  isPositiveZero,
  validateCatalogResponse,
  fetchCatalogForProvider,
  defaultFetch,
  cleanModelName,
};
