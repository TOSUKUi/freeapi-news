#!/usr/bin/env node
/**
 * validate-report.js
 *
 * Validates report.json against the schema, then runs mechanical gates.
 *
 * Two modes:
 *   (default)  Schema + gate check. Gate violations = hard fail.
 *   --fix      Schema check (hard fail if broken). Gate violations =
 *              auto-downgrade the offending offer to excluded_offers with
 *              a structured exclusion_reason, rewrite report.json, and
 *              emit a JSON fix-report on stderr so the LLM can correct
 *              the data in one pass next run.
 *
 * Gates (each produces a structured fix entry):
 *   endpoint   — base_url contradicts registry or provider not registered
 *   citation   — endpoint_source page does not document the claimed base_url
 *   state      — benchmark regression (state has scores, report says null)
 *                or score not persisted to state
 *   free_claim — paid API dressed up as free
 *   size       — sub-30B total-parameter model (unless tier S/A)
 *   tier       — tier S/A without Terminal-Bench 2.1 >= 50%
 *   allowance  — missing free_allowance_rank
 *
 * Usage:
 *   node build/validate-report.js <report.json> <schema.json> [--fix]
 */

const fs = require('fs');
const path = require('path');
const { loadRegistry, matchProvider } = require('./provider-registry');

const FIX_MODE = process.argv.includes('--fix');

async function main() {
  const args = process.argv.slice(2).filter(a => a !== '--fix');
  const reportPath = args[0];
  const schemaPath = args[1];

  if (!reportPath || !schemaPath) {
    console.error('Usage: node validate-report.js <report.json> <schema.json> [--fix]');
    process.exit(1);
  }
  if (!fs.existsSync(reportPath)) { console.error(`Report not found: ${reportPath}`); process.exit(1); }
  if (!fs.existsSync(schemaPath)) { console.error(`Schema not found: ${schemaPath}`); process.exit(1); }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

  // ── Schema validation (structural — always hard fail) ──────────
  let schemaValid = true;
  let schemaErrors = [];
  try {
    const { Ajv2020 } = require('ajv/dist/2020');
    const addFormats = require('ajv-formats');
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    schemaValid = validate(report);
    if (!schemaValid) schemaErrors = validate.errors || [];
  } catch (e) {
    console.warn('ajv unavailable, basic validation...');
    schemaValid = basicValidate(report, schema);
  }

  if (!schemaValid) {
    console.error('❌ Schema validation failed (structural — cannot auto-fix):');
    for (const err of schemaErrors) console.error(`   - ${err.instancePath || 'root'}: ${err.message}`);
    process.exit(1);
  }

  // ── Mechanical gates ───────────────────────────────────────────
  const fixReport = []; // structured fix entries for the LLM
  const providers = loadRegistry();

  runEndpointGate(report, providers, fixReport);
  await runCitationGate(report, fixReport);
  runStateGate(report, fixReport);
  runFreeClaimGate(report, fixReport);
  runSizeGate(report, fixReport);
  runTierGate(report, fixReport);
  runAllowanceGate(report, fixReport);

  // ── Apply auto-downgrades in --fix mode ────────────────────────
  if (FIX_MODE && fixReport.length > 0) {
    applyDowngrades(report, fixReport);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
    console.log(`🔧 --fix: ${fixReport.length} offer(s) auto-downgraded to excluded_offers.`);
    console.log(`   Report rewritten: ${reportPath}`);
  }

  // ── Emit structured fix report ─────────────────────────────────
  if (fixReport.length > 0) {
    const json = JSON.stringify(fixReport, null, 2);
    if (FIX_MODE) {
      console.warn('\n📋 Fix report (for next collection run):\n' + json);
    } else {
      console.error('\n❌ Gate violations found:\n' + json);
      process.exit(1);
    }
  }

  // ── Summary ────────────────────────────────────────────────────
  const ranked = (report.ranked_offers || []).filter(o => o.ranking_eligible === true);
  const fieldReport = reportNewFields(report);
  console.log('✅ Report is valid.');
  console.log(`   Generated at: ${report.generated_at || 'unknown'}`);
  console.log(`   Ranked offers: ${ranked.length}`);
  console.log(`   Excluded: ${(report.excluded_offers || []).length}`);
  console.log(`   Ranking eligible with last_verified: ${fieldReport.verified}/${fieldReport.eligible}`);
  console.log(`   Router offers with free_model_names: ${fieldReport.routersWithModels}/${fieldReport.routers}`);
  if (fixReport.length > 0) console.log(`   Auto-downgraded: ${fixReport.length}`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════
// Gate implementations — each pushes structured fix entries
// ══════════════════════════════════════════════════════════════════

function runEndpointGate(report, providers, fixReport) {
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    const label = o.name || o.provider || '?';

    if (!o.base_url || typeof o.base_url !== 'string') {
      fixReport.push({
        offer: label, gate: 'endpoint',
        field: 'base_url', current: null,
        action: 'fetch the provider\'s official API docs and set base_url to the documented value',
        source_hint: 'provider official docs (search "<provider> API quickstart")',
        downgrade: true,
      });
      continue;
    }
    if (!o.endpoint_source || typeof o.endpoint_source !== 'string' || !/^https?:\/\//.test(o.endpoint_source)) {
      fixReport.push({
        offer: label, gate: 'endpoint',
        field: 'endpoint_source', current: o.endpoint_source || null,
        action: 'set endpoint_source to the exact official docs URL where base_url was verified this run',
        source_hint: 'the docs page you fetched to confirm the base_url',
        downgrade: true,
      });
    }

    const hit = matchProvider(o, providers);
    if (!hit) {
      fixReport.push({
        offer: label, gate: 'endpoint',
        field: 'provider', current: o.provider,
        action: `provider "${o.provider}" not in registry. Fetch official docs, add entry to build/provider-registry.json (key, label, match, base_url, base_url_pattern, env, docs_url, added_at, added_from), then set endpoint_source to the docs URL`,
        source_hint: `search "${o.provider} API documentation" on the vendor's official domain`,
        downgrade: true,
      });
      continue;
    }
    if (!hit.byUrl) {
      fixReport.push({
        offer: label, gate: 'endpoint',
        field: 'base_url', current: o.base_url,
        action: `base_url does not match official ${hit.entry.label} endpoint. Re-fetch ${hit.entry.docs_url} and set base_url to the documented value (canonical: ${hit.entry.base_url})`,
        source_hint: hit.entry.docs_url,
        downgrade: true,
      });
    }
  }
}

async function runCitationGate(report, fixReport) {
  const skip = process.env.SKIP_CITATION_CHECK === '1';
  const offers = (report.ranked_offers || []).filter(
    o => o.ranking_eligible === true && typeof o.endpoint_source === 'string' && /^https?:\/\//.test(o.endpoint_source)
  );
  if (skip || offers.length === 0) return;

  const byUrl = new Map();
  for (const o of offers) {
    if (!byUrl.has(o.endpoint_source)) byUrl.set(o.endpoint_source, []);
    byUrl.get(o.endpoint_source).push(o);
  }

  for (const [url, group] of byUrl) {
    let html = null;
    try { html = await fetchText(url); } catch (e) {
      for (const o of group) {
        fixReport.push({
          offer: o.name || '?', gate: 'citation',
          field: 'endpoint_source', current: url,
          action: `could not fetch citation (${String(e.message || e)}). Re-verify manually and update endpoint_source if the page moved`,
          source_hint: url,
          downgrade: false, // network issue — warn only, don't downgrade
        });
      }
      continue;
    }
    for (const o of group) {
      if (!citationSupports(html, o.base_url)) {
        fixReport.push({
          offer: o.name || '?', gate: 'citation',
          field: 'base_url', current: o.base_url,
          action: `citation ${url} does not document base_url "${o.base_url}". Re-fetch official docs and copy the documented URL verbatim`,
          source_hint: url,
          downgrade: true,
        });
      }
    }
  }
}

function runStateGate(report, fixReport) {
  let models = [];
  try {
    models = JSON.parse(fs.readFileSync(BENCHMARK_STATE_PATH, 'utf8')).models || [];
  } catch { return; }

  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    const label = o.name || '?';
    const entry = matchBenchmarkEntry(o, models);
    const stateScores = entry ? (entry.benchmarks || []).filter(b => b && b.score != null) : [];
    const offerScore = o.benchmark && o.benchmark.score != null ? o.benchmark.score : null;

    if (stateScores.length > 0 && offerScore == null) {
      fixReport.push({
        offer: label, gate: 'state',
        field: 'benchmark.score', current: null,
        action: `regression — state has scores for ${entry.canonical_name} (${stateScores.map(b => `${b.name}=${b.score}`).join(', ')}). Merge from state/benchmarks.json into the offer's benchmark and benchmarks array`,
        source_hint: '.agents/skills/llm-deals-intelligence-skill/state/benchmarks.json',
        downgrade: true,
      });
    } else if (offerScore != null && stateScores.length === 0) {
      fixReport.push({
        offer: label, gate: 'state',
        field: 'state/benchmarks.json', current: 'missing entry',
        action: `score ${offerScore} not persisted. Write it to state/benchmarks.json (merge by canonical_name, include model_id "${o.model_id}" in model_ids)`,
        source_hint: '.agents/skills/llm-deals-intelligence-skill/state/benchmarks.json',
        downgrade: true,
      });
    }
  }
}

function runFreeClaimGate(report, fixReport) {
  const paidApi = /\bapi is paid\b|\bpaid api\b|\bapi access is paid\b|\bapi costs \$[1-9]/i;
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    const limits = `${o.free_limits || ''} ${o.rate_limits || ''}`;
    if (paidApi.test(limits)) {
      fixReport.push({
        offer: o.name || '?', gate: 'free_claim',
        field: 'free_limits', current: (o.free_limits || '').slice(0, 100),
        action: 'free_limits says the API is paid. Set ranking_eligible: false, classification: G_FREE_LIKE, move to excluded_offers with the real API price',
        source_hint: 'provider pricing page',
        downgrade: true,
      });
    }
  }
}

function runSizeGate(report, fixReport) {
  const MAX = 30;
  const COMPETITIVE = ['S', 'A'];
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    const total = o.total_parameters_b;
    const tier = o.benchmark && o.benchmark.tier;
    if (typeof total === 'number' && total < MAX && !COMPETITIVE.includes(tier)) {
      fixReport.push({
        offer: o.name || '?', gate: 'size',
        field: 'total_parameters_b', current: total,
        action: `${total}B total is local-run territory and tier ${tier} doesn't show competitiveness (needs S/A). Move to excluded_offers`,
        source_hint: 'model card (huggingface.co/{vendor}/{model})',
        downgrade: true,
      });
    }
  }
}

function runTierGate(report, fixReport) {
  const TB_PAT = /terminal[\s-]*bench[\s-]*v?2(\.1)?/i;
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    const tier = o.benchmark && o.benchmark.tier;
    if (tier !== 'S' && tier !== 'A') continue;
    const tb = (o.benchmarks || []).find(b => b && TB_PAT.test(b.name || ''));
    if (!tb || tb.score == null) {
      fixReport.push({
        offer: o.name || '?', gate: 'tier',
        field: 'benchmarks[].Terminal-Bench 2.1', current: null,
        action: `tier ${tier} requires Terminal-Bench 2.1 >= 50%. Check state/benchmarks.json first, then llm-stats.com/benchmarks/terminal-bench-2.1, benchlm.ai, snorkel.ai. If truly unpublished, cap tier at B`,
        source_hint: 'state/benchmarks.json → llm-stats → benchlm → snorkel → model card',
        downgrade: true,
      });
    } else if (tb.score < 50) {
      fixReport.push({
        offer: o.name || '?', gate: 'tier',
        field: 'benchmarks[].Terminal-Bench 2.1', current: tb.score,
        action: `Terminal-Bench 2.1 = ${tb.score} < 50%. Cap tier at B`,
        source_hint: 'llm-stats.com/benchmarks/terminal-bench-2.1',
        downgrade: true,
      });
    }
  }
}

function runAllowanceGate(report, fixReport) {
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    if (!o.free_allowance_rank || !['AMPLE', 'NORMAL', 'TIGHT', 'TINY'].includes(o.free_allowance_rank)) {
      fixReport.push({
        offer: o.name || '?', gate: 'allowance',
        field: 'free_allowance_rank', current: o.free_allowance_rank || null,
        action: 'set free_allowance_rank from documented limits: AMPLE (hundreds req/day), NORMAL (~20-100), TIGHT (few/day), TINY (prototype-only)',
        source_hint: 'provider pricing/limits page',
        downgrade: true,
      });
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// Auto-downgrade: move violating offers from ranked to excluded
// ══════════════════════════════════════════════════════════════════

function applyDowngrades(report, fixReport) {
  const downgradeOffers = new Set();
  for (const f of fixReport) {
    if (f.downgrade) downgradeOffers.add(f.offer);
  }
  if (downgradeOffers.size === 0) return;

  const reasons = new Map();
  for (const f of fixReport) {
    if (!f.downgrade) continue;
    if (!reasons.has(f.offer)) reasons.set(f.offer, []);
    reasons.get(f.offer).push(`[${f.gate}] ${f.action}`);
  }

  report.excluded_offers = report.excluded_offers || [];
  const remaining = [];
  for (const o of report.ranked_offers || []) {
    const label = o.name || o.provider || '?';
    if (downgradeOffers.has(label)) {
      o.ranking_eligible = false;
      o.exclusion_reason = reasons.get(label).join(' | ');
      report.excluded_offers.push({ name: label, reason: o.exclusion_reason });
    } else {
      remaining.push(o);
    }
  }
  report.ranked_offers = remaining;
}

// ══════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════

const BENCHMARK_STATE_PATH = path.join(
  __dirname, '..', '.agents', 'skills', 'llm-deals-intelligence-skill', 'state', 'benchmarks.json'
);

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
  } catch { return false; }
}

function reportNewFields(report) {
  const offers = report.ranked_offers || [];
  const eligible = offers.filter(o => o.ranking_eligible === true);
  const verified = eligible.filter(o => typeof o.last_verified === 'string' && o.last_verified.length > 0);
  const routers = offers.filter(o => o.delivery_type === 'router');
  const routersWithModels = routers.filter(o => Array.isArray(o.free_model_names) && o.free_model_names.length > 0);
  return { eligible: eligible.length, verified: verified.length, routers: routers.length, routersWithModels: routersWithModels.length };
}

function basicValidate(report, schema) {
  for (const req of schema.required || []) {
    if (!(req in report)) { console.error(`Missing required: ${req}`); return false; }
  }
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible === true && !(typeof o.last_verified === 'string' && o.last_verified.length > 0)) {
      console.error(`Missing last_verified: ${o.name}`); return false;
    }
    // endpoint_source and free_allowance_rank are enforced by the gate
    // functions (runEndpointGate, runAllowanceGate), not by basicValidate.
    // This allows --fix to auto-downgrade offers missing these fields.
    if (o.delivery_type === 'router' && !(Array.isArray(o.free_model_names) && o.free_model_names.length > 0)) {
      console.error(`Router missing free_model_names: ${o.name}`); return false;
    }
  }
  if (typeof report.generated_at !== 'string') return false;
  if (typeof report.timezone !== 'string') return false;
  for (const k of ['new_models', 'changes', 'ranked_offers', 'excluded_offers', 'sources']) {
    if (!Array.isArray(report[k])) return false;
  }
  return true;
}

main();
