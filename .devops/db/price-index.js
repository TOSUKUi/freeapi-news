'use strict';

// Deterministic price-index lane (operator decision 2026-08-20: the
// deterministic collection lanes are pure code, no LLM).
//
// llmpricing.dev is a static, CDN-served pricing index (models.dev +
// Artificial Analysis + OpenRouter, CC-BY-4.0, no API key):
//
//   GET /api/models.json  every model with the official (lab) reference
//                         price and the cheapest channel price
//   GET /m/<model-id>/    static page whose embedded Next.js RSC payload
//                         carries the full per-provider quote array
//                         (provider / modelId / input / output / cacheRead /
//                         official, per 1M tokens)
//
// This module fetches the index, selects the discount candidates (an
// official reference with a cheaper channel, plus models that carried a
// discount in the previous snapshot so endings are detected), fetches only
// those model pages, parses the quote arrays, and writes one artifact the
// lanes reducer ingests. lanes.js then turns a registered provider quoting
// >= 10% below the official reference into a verified DISCOUNTED offer
// (or ends one that is no longer discounted). Nothing here calls an LLM.

const fs = require('node:fs');
const path = require('node:path');
const db = require('./collector-db');
const catalog = require('./catalog');

const INDEX_URL = 'https://llmpricing.dev/api/models.json';
const pageUrlFor = (modelId) => `https://llmpricing.dev/m/${modelId}/`;

// Cap on model-page fetches per run (static CDN, no rate limit, but be
// polite): active models (by OpenRouter usage rank) first.
const MAX_PAGES_PER_RUN = 80;

// A quote at most 90% of the official reference in at least one direction
// is a real discount, not a rounding artifact.
const DISCOUNT_GAP = 0.9;

function numberOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function sha256Text(body) {
  return catalog.sha256Text ? catalog.sha256Text(body)
    : require('node:crypto').createHash('sha256').update(body).digest('hex');
}

// The model page is a Next.js app: data arrives as a sequence of
// self.__next_f.push([1, "<escaped string>"]) payloads. Unescaping each
// payload with JSON.parse('"…"') is the correct inverse (handles \uXXXX,
// \", \\, \n exactly as JS string literals do).
function rscBlob(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      chunks.push(JSON.parse(`"${m[1]}"`));
    } catch {
      // Tolerate one malformed payload: the quote array usually survives.
      chunks.push(m[1]);
    }
  }
  return chunks.join('');
}

// Extract every quote object {"provider": …, "modelId": …, "input": …, …}
// from the RSC blob by brace matching. Returns [] on any parse problem.
function parseQuotesFromPage(html) {
  if (typeof html !== 'string' || !html) return [];
  const blob = rscBlob(html);
  const quotes = [];
  const re = /\{"provider":"[^"]*","modelId":/g;
  let m;
  while ((m = re.exec(blob)) !== null) {
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < Math.min(m.index + 8000, blob.length); i += 1) {
      const c = blob[i];
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end < 0) continue;
    try {
      const q = JSON.parse(blob.slice(m.index, end));
      if (q && typeof q.provider === 'string' && typeof q.modelId === 'string') {
        quotes.push({
          provider: q.provider,
          modelId: q.modelId,
          input: numberOrNull(q.input),
          output: numberOrNull(q.output),
          cacheRead: numberOrNull(q.cacheRead),
          official: q.official === true,
          context: numberOrNull(q.context),
        });
      }
    } catch {
      // Skip one malformed object; keep the rest.
    }
    re.lastIndex = end;
  }
  return quotes;
}

// Discount candidates for page fetches, in priority order:
//  1. models that carried a discount in the previous snapshot (the ending
//     has to be re-observed to be acted on),
//  2. index models with an official reference and a cheaper channel,
//     active models first (OpenRouter usage rank, then cheapest blend).
function selectCandidates(models = [], recheckModelIds = new Set(), { limit = MAX_PAGES_PER_RUN } = {}) {
  const picked = [];
  const seen = new Set();
  const push = (id) => {
    if (typeof id !== 'string' || !id || seen.has(id)) return;
    seen.add(id);
    picked.push(id);
  };
  for (const id of recheckModelIds) push(id);
  const byActivity = (a, b) => {
    const ra = a && a.usage && Number.isInteger(a.usage.rank) ? a.usage.rank : Number.MAX_SAFE_INTEGER;
    const rb = b && b.usage && Number.isInteger(b.usage.rank) ? b.usage.rank : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    const ba = typeof a && a.blendedMin === 'number' ? a.blendedMin : Number.MAX_SAFE_NUMBER;
    const bb = typeof b && b.blendedMin === 'number' ? b.blendedMin : Number.MAX_SAFE_NUMBER;
    return ba - bb;
  };
  const discounted = models
    .filter((m) => {
      const ref = m && m.reference;
      const cheap = m && m.cheapest;
      if (!ref || ref.official !== true || !cheap) return false;
      const rIn = numberOrNull(ref.input);
      const rOut = numberOrNull(ref.output);
      const cIn = numberOrNull(cheap.input);
      const cOut = numberOrNull(cheap.output);
      return (rIn !== null && cIn !== null && cIn <= rIn * DISCOUNT_GAP)
        || (rOut !== null && cOut !== null && cOut <= rOut * DISCOUNT_GAP);
    })
    .sort(byActivity);
  for (const m of discounted) {
    if (picked.length >= limit) break;
    push(m.id);
  }
  return picked.slice(0, limit);
}

// Fetches the index, selects candidates, fetches their pages, and returns
// the lane artifact. fetchImpl is injectable for tests (url -> {status, body}).
async function fetchPriceIndex(options = {}) {
  const fetchImpl = options.fetchImpl || catalog.defaultFetch;
  const errors = [];
  const fetches = [];
  const record = (url, status, body) => {
    fetches.push({
      url,
      http_status: status,
      content_hash: typeof body === 'string' ? sha256Text(body) : null,
      fetched_at: new Date().toISOString(),
      subject_key: 'price_index:llmpricing',
    });
  };

  let indexJson;
  try {
    const res = await fetchImpl(INDEX_URL);
    record(INDEX_URL, res.status, typeof res.body === 'string' ? res.body : '');
    indexJson = JSON.parse(res.body);
  } catch (err) {
    errors.push(`index fetch failed: ${err.message}`);
    return {
      schema_version: 1,
      kind: 'price_index',
      provider_key: null,
      status: 'failed',
      available: false,
      source: INDEX_URL,
      synced_at: null,
      models: [],
      fetches,
      errors,
    };
  }

  const models = Array.isArray(indexJson && indexJson.models) ? indexJson.models : [];
  if (models.length === 0) {
    errors.push('index response carried no models');
    return {
      schema_version: 1,
      kind: 'price_index',
      provider_key: null,
      status: 'failed',
      available: false,
      source: INDEX_URL,
      synced_at: indexJson && indexJson.meta && indexJson.meta.syncedAt || null,
      models: [],
      fetches,
      errors,
    };
  }

  // Explicit recheck list (tests) wins over the snapshot query; an empty
  // array still means "no rechecks" and skips the DB entirely.
  let recheck;
  if (Array.isArray(options.recheckIds)) {
    recheck = new Set(options.recheckIds);
  } else {
    try {
      recheck = new Set(db.listDiscountedLlmpricingQuotes(options).map((r) => r.model_id));
    } catch {
      // Snapshot table absent (pre-migration fixture): candidates only.
      recheck = new Set();
    }
  }

  const candidateIds = selectCandidates(models, recheck);
  const out = [];
  for (const id of candidateIds) {
    const entry = models.find((m) => m && m.id === id) || { id };
    let quotes = [];
    const url = pageUrlFor(id);
    try {
      const res = await fetchImpl(url);
      record(url, res.status, typeof res.body === 'string' ? res.body : '');
      if (res.status >= 200 && res.status < 300) {
        // Keep only quotes for this canonical model: provider pages quote
        // alias ids (gpt-5-6-sol, gpt-5.6-sol, openai/gpt-5.6-sol), so match
        // on the alphanumeric core with an endsWith fallback.
        const alnum = (s) => String(s).replace(/[^a-z0-9]/g, '').toLowerCase();
        const core = alnum(id);
        quotes = parseQuotesFromPage(res.body).filter((q) => {
          const a = alnum(q.modelId);
          return a === core || core.endsWith(a);
        });
      } else {
        errors.push(`model page ${id}: HTTP ${res.status}`);
      }
    } catch (err) {
      errors.push(`model page ${id}: ${err.message}`);
    }
    const official = quotes.find((q) => q.official) || null;
    out.push({
      model_id: id,
      name: entry.name || id,
      lab: entry.lab || null,
      url,
      release_date: entry.releaseDate || null,
      usage_rank: entry.usage && Number.isInteger(entry.usage.rank) ? entry.usage.rank : null,
      reference: official
        ? { provider: official.provider, input: official.input, output: official.output }
        : (entry.reference && entry.reference.official === true
          ? { provider: entry.reference.provider, input: numberOrNull(entry.reference.input), output: numberOrNull(entry.reference.output) }
          : null),
      cheapest: entry.cheapest || null,
      quotes,
    });
  }

  const available = out.length > 0;
  return {
    schema_version: 1,
    kind: 'price_index',
    provider_key: null,
    status: available ? 'complete' : 'failed',
    available,
    source: INDEX_URL,
    synced_at: indexJson.meta && indexJson.meta.syncedAt || null,
    license: indexJson.meta && indexJson.meta.license || null,
    index_model_count: models.length,
    models: out,
    fetches,
    errors,
  };
}

async function main() {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('usage: node .devops/db/price-index.js <run_dir>');
    process.exit(1);
  }
  db.assertRuntime();
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  const artifact = await fetchPriceIndex({});
  const outPath = db.artifactPathFor(runDir, 'price_index:llmpricing');
  artifact.task_id = 'price_index:llmpricing';
  fs.writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  if (artifact.available) {
    console.log(`  ✅ price_index: ${artifact.models.length} model page(s) from ${artifact.index_model_count} indexed`);
  } else {
    console.log(`  ❌ price_index unavailable (${artifact.errors[0] || 'unknown'}); prior offers preserved`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`price-index fetch aborted: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  INDEX_URL,
  pageUrlFor,
  DISCOUNT_GAP,
  MAX_PAGES_PER_RUN,
  parseQuotesFromPage,
  selectCandidates,
  fetchPriceIndex,
};
