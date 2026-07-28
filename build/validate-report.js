#!/usr/bin/env node
/**
 * validate-report.js
 *
 * Validates a report.json against the daily_report.schema.json schema,
 * then enforces the provider endpoint gate against provider-registry.json:
 *
 *   - A ranked offer whose base_url contradicts the official endpoint of a
 *     listed provider HARD-FAILS (this is how fabricated URLs are caught).
 *   - A ranked offer from a provider missing from the registry HARD-FAILS:
 *     the skill must research the connection method from official docs and
 *     add the provider to the registry before the offer can be ranked.
 *   - Ranked offers must carry base_url and endpoint_source.
 *   - Citation re-check (online): the validator itself fetches every
 *     endpoint_source page and requires the claimed base_url to appear in
 *     it. The model cannot approve its own fabrication because it cannot
 *     forge third-party documentation. Fetch succeeds + URL not found =
 *     hard error; fetch fails = warning (offline dev: SKIP_CITATION_CHECK=1).
 *   - Benchmark state gate: regeneration must not lose verified data. A
 *     ranked offer whose model has scores in state/benchmarks.json but a
 *     null benchmark.score HARD-FAILS (regression), and a ranked offer with
 *     a score that is NOT persisted in state/benchmarks.json HARD-FAILS
 *     (next run would lose it).
 *
 * Usage:
 *   node build/validate-report.js <report.json> <schema.json>
 */

const fs = require('fs');
const path = require('path');
const { loadRegistry, matchProvider } = require('./provider-registry');

async function main() {
  const reportPath = process.argv[2];
  const schemaPath = process.argv[3];

  if (!reportPath || !schemaPath) {
    console.error('Usage: node validate-report.js <report.json> <schema.json>');
    process.exit(1);
  }

  if (!fs.existsSync(reportPath)) {
    console.error(`Report file not found: ${reportPath}`);
    process.exit(1);
  }

  if (!fs.existsSync(schemaPath)) {
    console.error(`Schema file not found: ${schemaPath}`);
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  // Try to use ajv for validation
  let valid = true;
  let errors = [];

  try {
    const { Ajv2020 } = require('ajv/dist/2020');
    const addFormats = require('ajv-formats');
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    valid = validate(report);
    if (!valid) {
      errors = validate.errors || [];
    }
  } catch (e) {
    // ajv not installed or failed, do basic validation
    console.warn('ajv validation unavailable, doing basic validation...');
    valid = basicValidate(report, schema);
  }

  // Endpoint gate: runs regardless of ajv availability. Fabricated or
  // stale base_url values fail here even when the schema passes.
  const endpointResult = validateEndpoints(report);

  // Citation gate: the validator verifies the evidence itself by fetching
  // the cited docs pages. This is what makes "go look it up every time"
  // mechanically enforceable for unattended local-model runs.
  const citationResult = await validateCitations(report);

  // State gate: daily regeneration must never lose verified benchmark data.
  const stateResult = validateBenchmarkState(report);

  // Free-claim gate: a paid API dressed up as free (e.g. free app quota
  // misreported as a free API) must not reach the ranking.
  const freeClaimResult = validateFreeClaim(report);

  // Size gate: sub-30B total-parameter models are local-run territory and
  // do not belong in a free-API ranking.
  const sizeResult = validateModelSize(report);

  const gateErrors = [...endpointResult.errors, ...citationResult.errors, ...stateResult.errors, ...freeClaimResult.errors, ...sizeResult.errors];
  const gateWarnings = [...endpointResult.warnings, ...citationResult.warnings, ...stateResult.warnings, ...freeClaimResult.warnings, ...sizeResult.warnings];

  if (valid && gateErrors.length === 0) {
    console.log('✅ Report is valid against the schema.');
    console.log(`   Report: ${reportPath}`);
    console.log(`   Schema: ${schemaPath}`);
    console.log(`   Generated at: ${report.generated_at || 'unknown'}`);
    console.log(`   New models: ${report.new_models?.length || 0}`);
    console.log(`   Changes: ${report.changes?.length || 0}`);
    console.log(`   Ranked offers: ${report.ranked_offers?.length || 0}`);
    console.log(`   Excluded: ${report.excluded_offers?.length || 0}`);
    const fieldReport = reportNewFields(report);
    console.log(`   Ranking eligible with last_verified: ${fieldReport.verified}/${fieldReport.eligible}`);
    console.log(`   Router offers with free_model_names: ${fieldReport.routersWithModels}/${fieldReport.routers}`);
    console.log(`   Endpoint gate: ${endpointResult.checked} checked. Citation gate: ${citationResult.checked} verified online.`);
    for (const w of gateWarnings) console.warn(`   ⚠️  ${w}`);
    process.exit(0);
  } else {
    console.error('❌ Report validation failed!');
    console.error(`   Report: ${reportPath}`);
    console.error(`   Schema: ${schemaPath}`);
    if (errors.length > 0) {
      console.error('   Errors:');
      errors.forEach(err => {
        console.error(`     - ${err.instancePath || 'root'}: ${err.message}`);
      });
    }
    for (const e of gateErrors) console.error(`     - ${e}`);
    for (const w of gateWarnings) console.warn(`   ⚠️  ${w}`);
    process.exit(1);
  }
}

// ── Endpoint gate ─────────────────────────────────────────────────
// Every ranked offer is matched against build/provider-registry.json.
// Known provider + non-matching base_url = hard error: the URL was either
// fabricated from memory or the provider changed and the registry/report
// must be updated from official docs. Unknown provider = hard error until
// the skill researches it and adds a registry entry (dynamic growth, but
// only together with a verified citation).
function validateEndpoints(report) {
  const providers = loadRegistry();
  const offers = report.ranked_offers || [];
  const errors = [];
  const warnings = [];
  let checked = 0;

  for (const o of offers) {
    if (o.ranking_eligible !== true) continue;
    checked++;
    const label = o.name || o.provider || 'unnamed offer';

    if (!o.base_url || typeof o.base_url !== 'string') {
      errors.push(`"${label}": ranked offer is missing base_url. Verify the endpoint on the provider's official docs and set it.`);
      continue;
    }
    if (!o.endpoint_source || typeof o.endpoint_source !== 'string' || !/^https?:\/\//.test(o.endpoint_source)) {
      errors.push(`"${label}": ranked offer is missing endpoint_source (the official docs URL where base_url was verified this run). Fabrication from memory is not allowed.`);
    }

    const hit = matchProvider(o, providers);
    if (!hit) {
      errors.push(
        `"${label}": provider "${o.provider || '?'}" is not in build/provider-registry.json. ` +
        `Research the connection method on the provider's official docs, add the provider to the registry ` +
        `(key, label, match, base_url, base_url_pattern, env, docs_url, added_at, added_from), cite the docs URL ` +
        `as endpoint_source, and only then rank the offer.`
      );
      continue;
    }
    const { entry, byUrl } = hit;
    if (!byUrl) {
      errors.push(
        `"${label}": base_url "${o.base_url}" does NOT match the official ${entry.label} endpoint ` +
        `(expected pattern ${entry.base_url_pattern}, canonical ${entry.base_url}). ` +
        `Re-verify on ${entry.docs_url} and fix report.json — or update the registry if the official docs really changed.`
      );
    }
  }

  return { errors, warnings, checked };
}

// ── Citation gate (online re-verification) ────────────────────────
// For every ranked offer, fetch the endpoint_source page and require the
// claimed base_url to appear in it (full URL, scheme-less, or host form).
// The batch machine talks to the real web; the LLM does not get a say in
// whether its citation supports its claim.
async function validateCitations(report) {
  const errors = [];
  const warnings = [];
  const skip = process.env.SKIP_CITATION_CHECK === '1';
  const offers = (report.ranked_offers || []).filter(
    o => o.ranking_eligible === true && typeof o.endpoint_source === 'string' && /^https?:\/\//.test(o.endpoint_source)
  );
  if (skip || offers.length === 0) {
    if (skip) warnings.push('Citation re-check skipped (SKIP_CITATION_CHECK=1).');
    return { errors, warnings, checked: 0 };
  }

  // Deduplicate by citation URL (router cards share one docs page).
  const byUrl = new Map();
  for (const o of offers) {
    if (!byUrl.has(o.endpoint_source)) byUrl.set(o.endpoint_source, []);
    byUrl.get(o.endpoint_source).push(o);
  }

  let checked = 0;
  for (const [url, group] of byUrl) {
    let html = null;
    try {
      html = await fetchText(url);
    } catch (e) {
      for (const o of group) {
        warnings.push(`"${o.name}": could not fetch citation ${url} (${String(e.message || e)}). Verify manually.`);
      }
      continue;
    }
    for (const o of group) {
      checked++;
      if (!citationSupports(html, o.base_url)) {
        errors.push(
          `"${o.name}": citation ${url} does not document base_url "${o.base_url}". ` +
          `The cited page must actually state the endpoint — re-fetch the official docs and copy the documented URL verbatim.`
        );
      }
    }
  }

  return { errors, warnings, checked };
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; freeapi-news-validator/1.0)', 'Accept': 'text/html,application/xhtml+xml,*/*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text.slice(0, 3_000_000);
}

function citationSupports(html, baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') return false;
  if (html.includes(baseUrl)) return true;
  const noScheme = baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (html.includes(noScheme)) return true;
  try {
    const host = new URL(baseUrl).host;
    return host.length > 0 && html.includes(host);
  } catch {
    return false;
  }
}

// ── Model size gate ───────────────────────────────────────────────
// A free API of a model anyone can run at home is not news. Total
// parameters decide (MoE must load every expert locally; active params
// only bound compute). Under 30B total = hard fail UNLESS the benchmarks
// prove the model is genuinely competitive (tier S/A): a small model that
// performs like a much larger one is still worth featuring. Unknown
// size = warning.
const LOCAL_TOTAL_MAX_B = 30;
const COMPETITIVE_TIERS = ['S', 'A'];

function validateModelSize(report) {
  const errors = [];
  const warnings = [];
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    const label = o.name || o.provider || 'unnamed offer';
    const total = o.total_parameters_b;
    const tier = o.benchmark && o.benchmark.tier;
    if (typeof total === 'number' && total < LOCAL_TOTAL_MAX_B) {
      if (COMPETITIVE_TIERS.includes(tier)) {
        warnings.push(`"${label}": sub-${LOCAL_TOTAL_MAX_B}B model kept because tier ${tier} shows it is competitive.`);
      } else {
        errors.push(
          `"${label}": ${total}B total parameters is local-run territory (under ${LOCAL_TOTAL_MAX_B}B) and tier ${tier || '?'} ` +
          `does not show exceptional competitiveness (needs S/A). Exclude it.`
        );
      }
      continue;
    }
    if (total == null) {
      warnings.push(`"${label}": total_parameters_b unknown — confirm on the model card that this is not a sub-${LOCAL_TOTAL_MAX_B}B model.`);
    }
  }
  return { errors, warnings };
}

// ── Free-claim gate ───────────────────────────────────────────────
// The site ranks free/discounted API access. A free consumer app does not
// make the API free. Hard-fail ranked offers whose own free_limits text
// admits the API is paid; warn when the free quota is app-scoped so a
// human (or the next run) checks the pricing page.
function validateFreeClaim(report) {
  const errors = [];
  const warnings = [];
  const paidApi = /\bapi is paid\b|\bpaid api\b|\bapi access is paid\b|\bapi costs \$[1-9]/i;
  const appScoped = /\bfree\b[\s\S]{0,60}\bapp\b|\bapp\b[\s\S]{0,60}\bfree\b/i;
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    const label = o.name || o.provider || 'unnamed offer';
    const limits = `${o.free_limits || ''} ${o.rate_limits || ''}`;
    if (paidApi.test(limits)) {
      errors.push(
        `"${label}": free_limits says the API is paid ("${(o.free_limits || '').slice(0, 100)}"). ` +
        `A free app/web quota is NOT a free API. Exclude this offer (ranking_eligible: false) with the real API price.`
      );
      continue;
    }
    if (appScoped.test(limits)) {
      warnings.push(`"${label}": free quota mentions an app — confirm on the pricing page that the API itself is free, not just the app.`);
    }
  }
  return { errors, warnings };
}

// ── Benchmark state gate ──────────────────────────────────────────
// state/benchmarks.json is the persistent cache of verified scores across
// runs. Two failures are enforced:
//   1. Regression: state has scores for the model, report says null.
//   2. Non-persistence: report has a score, state does not (the skill must
//      write new scores to state, or the next regeneration loses them).
const BENCHMARK_STATE_PATH = path.join(
  __dirname, '..', '.agents', 'skills', 'llm-deals-intelligence-skill', 'state', 'benchmarks.json'
);

function validateBenchmarkState(report) {
  const errors = [];
  const warnings = [];
  let models = [];
  try {
    models = JSON.parse(fs.readFileSync(BENCHMARK_STATE_PATH, 'utf8')).models || [];
  } catch {
    warnings.push(`Could not read ${BENCHMARK_STATE_PATH}; benchmark state gate skipped.`);
    return { errors, warnings };
  }

  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    const label = o.name || o.provider || 'unnamed offer';
    const entry = matchBenchmarkEntry(o, models);
    const stateScores = entry ? (entry.benchmarks || []).filter(b => b && b.score != null) : [];
    const offerScore = o.benchmark && o.benchmark.score != null ? o.benchmark.score : null;

    if (stateScores.length > 0 && offerScore == null) {
      errors.push(
        `"${label}": benchmark regression — state/benchmarks.json has scores for ${entry.canonical_name} ` +
        `(${stateScores.map(b => `${b.name}=${b.score}`).join(', ')}), but the report's benchmark.score is null. ` +
        `Regeneration must not lose verified data: merge from state/benchmarks.json.`
      );
      continue;
    }
    if (offerScore != null && stateScores.length === 0) {
      errors.push(
        `"${label}": benchmark score ${offerScore} is not persisted in state/benchmarks.json ` +
        `(no scored entry for model_id "${o.model_id || '?'}"). Write it to state so the next run cannot lose it.`
      );
    }
  }
  return { errors, warnings };
}

function matchBenchmarkEntry(o, models) {
  const mid = String(o.model_id || '').toLowerCase();
  if (mid) {
    for (const m of models) {
      if ((m.model_ids || []).some(id => String(id).toLowerCase() === mid)) return m;
    }
  }
  const name = String(o.model_name || o.name || '').toLowerCase();
  if (name) {
    for (const m of models) {
      const cn = String(m.canonical_name || '').toLowerCase();
      if (cn && (name.includes(cn) || cn.includes(name))) return m;
    }
  }
  return null;
}

// Summarise the two fields added by spec 0002 (last_verified, free_model_names).
function reportNewFields(report) {
  const offers = report.ranked_offers || [];
  const eligible = offers.filter(o => o.ranking_eligible === true);
  const verified = eligible.filter(o => typeof o.last_verified === 'string' && o.last_verified.length > 0);
  const routers = offers.filter(o => o.delivery_type === 'router');
  const routersWithModels = routers.filter(o => Array.isArray(o.free_model_names) && o.free_model_names.length > 0);
  return { eligible: eligible.length, verified: verified.length, routers: routers.length, routersWithModels: routersWithModels.length };
}

function basicValidate(report, schema) {
  // Check required fields
  for (const req of schema.required || []) {
    if (!(req in report)) {
      console.error(`Missing required field: ${req}`);
      return false;
    }
  }
  // Spec 0002 invariants (mirrors the schema allOf, for the no-ajv fallback path).
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible === true && !(typeof o.last_verified === 'string' && o.last_verified.length > 0)) {
      console.error(`Ranking eligible offer missing last_verified: ${o.name}`);
      return false;
    }
    if (o.ranking_eligible === true && !(typeof o.endpoint_source === 'string' && /^https?:\/\//.test(o.endpoint_source))) {
      console.error(`Ranking eligible offer missing endpoint_source citation: ${o.name}`);
      return false;
    }
    if (o.delivery_type === 'router' && !(Array.isArray(o.free_model_names) && o.free_model_names.length > 0)) {
      console.error(`Router offer missing non-empty free_model_names: ${o.name}`);
      return false;
    }
  }
  // Check types
  if (typeof report.generated_at !== 'string') {
    console.error('generated_at must be a string');
    return false;
  }
  if (typeof report.timezone !== 'string') {
    console.error('timezone must be a string');
    return false;
  }
  if (!Array.isArray(report.new_models)) {
    console.error('new_models must be an array');
    return false;
  }
  if (!Array.isArray(report.changes)) {
    console.error('changes must be an array');
    return false;
  }
  if (!Array.isArray(report.ranked_offers)) {
    console.error('ranked_offers must be an array');
    return false;
  }
  if (!Array.isArray(report.excluded_offers)) {
    console.error('excluded_offers must be an array');
    return false;
  }
  if (!Array.isArray(report.sources)) {
    console.error('sources must be an array');
    return false;
  }
  return true;
}


main();
