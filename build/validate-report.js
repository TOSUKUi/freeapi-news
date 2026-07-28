#!/usr/bin/env node
/**
 * validate-report.js
 *
 * Makes report.json renderable. Two actions, no "downgrade" concept:
 *
 *   auto-fix  — rewrite the field in place (state merge, tier restore,
 *               allowance default, tier cap to B when TB 2.1 missing/low)
 *   exclude   — move the offer to excluded_offers (fake URL, lying
 *               citation, paid API dressed as free, sub-30B without S/A)
 *
 * After all fixes/excludes, report.json is rewritten and the build can
 * proceed. A JSON fix-report is emitted on stderr so the LLM knows what
 * happened and can improve next run.
 *
 * Schema violations at the offer level are also auto-fixed or excluded.
 * Top-level schema violations (missing required arrays etc.) hard-fail.
 *
 * Usage:
 *   node build/validate-report.js <report.json> <schema.json>
 *   SKIP_CITATION_CHECK=1  — skip live citation re-fetch (offline dev)
 */

const fs = require('fs');
const path = require('path');
const { loadRegistry, matchProvider } = require('./provider-registry');

const BENCHMARK_STATE_PATH = path.join(
  __dirname, '..', '.agents', 'skills', 'llm-deals-intelligence-skill', 'state', 'benchmarks.json'
);

async function main() {
  const reportPath = process.argv[2];
  const schemaPath = process.argv[3];
  if (!reportPath || !schemaPath) {
    console.error('Usage: node validate-report.js <report.json> <schema.json>');
    process.exit(1);
  }
  if (!fs.existsSync(reportPath)) { console.error(`Not found: ${reportPath}`); process.exit(1); }
  if (!fs.existsSync(schemaPath)) { console.error(`Not found: ${schemaPath}`); process.exit(1); }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  const fixLog = []; // what we did, for the LLM

  // ── 1. Schema check (top-level = hard fail, offer-level = fix/exclude) ──
  checkSchema(report, schema, fixLog);

  // ── 2. Auto-fix what we can ────────────────────────────────────
  const providers = loadRegistry();
  let models = [];
  try { models = JSON.parse(fs.readFileSync(BENCHMARK_STATE_PATH, 'utf8')).models || []; } catch {}

  autoFixState(report, models, fixLog);
  autoFixTier(report, fixLog);
  autoFixAllowance(report, fixLog);

  // ── 3. Exclude what we can't fix ───────────────────────────────
  excludeBadEndpoints(report, providers, fixLog);
  await excludeBadCitations(report, fixLog);
  await excludeOpenRouterGhost(report, fixLog);
  excludePaidApis(report, fixLog);
  excludeTooSmall(report, fixLog);

  // ── 4. Rewrite report.json ─────────────────────────────────────
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');

  // ── 5. Emit fix log ────────────────────────────────────────────
  if (fixLog.length > 0) {
    console.warn('__FIX_REPORT_START__');
    console.warn(JSON.stringify(fixLog, null, 2));
    console.warn('__FIX_REPORT_END__');
  }

  // ── 6. Summary ─────────────────────────────────────────────────
  const ranked = (report.ranked_offers || []).filter(o => o.ranking_eligible === true);
  const fixed = fixLog.filter(f => f.action === 'auto-fix').length;
  const excluded = fixLog.filter(f => f.action === 'exclude').length;
  console.log('✅ Report is renderable.');
  console.log(`   Ranked: ${ranked.length} | Excluded: ${(report.excluded_offers || []).length}`);
  console.log(`   Auto-fixed: ${fixed} | Excluded this run: ${excluded}`);
  process.exit(0);
}

// ══════════════════════════════════════════════════════════════════
// Schema
// ══════════════════════════════════════════════════════════════════

function checkSchema(report, schema, fixLog) {
  let valid = true;
  let errors = [];
  try {
    const { Ajv2020 } = require('ajv/dist/2020');
    const addFormats = require('ajv-formats');
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    valid = validate(report);
    if (!valid) errors = validate.errors || [];
  } catch {
    valid = basicValidate(report, schema);
  }
  if (valid) return;

  const offerPat = /^\/(ranked_offers|conditional_credits|caution_offers)\/(\d+)/;
  const topLevel = [];
  const offerErrs = new Map();
  for (const err of errors) {
    const m = (err.instancePath || '').match(offerPat);
    if (m) {
      const key = `${m[1]}/${m[2]}`;
      if (!offerErrs.has(key)) offerErrs.set(key, []);
      offerErrs.get(key).push(err);
    } else {
      topLevel.push(err);
    }
  }
  if (topLevel.length > 0) {
    console.error('❌ Top-level schema error (cannot auto-fix):');
    for (const e of topLevel) console.error(`   ${e.instancePath}: ${e.message}`);
    process.exit(1);
  }
  // Offer-level schema violations → exclude (we can't guess the right value).
  for (const [key, errs] of offerErrs) {
    const [arrName, idxStr] = key.split('/');
    const arr = report[arrName] || [];
    const o = arr[parseInt(idxStr, 10)];
    if (!o) continue;
    const label = o.name || '?';
    const detail = errs.map(e => `${e.instancePath}: ${e.message}`).join('; ');
    moveToExcluded(report, arrName, o, `[schema] ${detail}`, fixLog);
  }
}

// ══════════════════════════════════════════════════════════════════
// Auto-fix: state regression
// ══════════════════════════════════════════════════════════════════

function autoFixState(report, models, fixLog) {
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    const entry = matchBenchmarkEntry(o, models);
    if (!entry) continue;
    const stateScores = (entry.benchmarks || []).filter(b => b && b.score != null);
    if (stateScores.length === 0) continue;

    const offerScore = o.benchmark && o.benchmark.score != null ? o.benchmark.score : null;
    if (offerScore == null) {
      // Merge from state: pick the best score as representative.
      const best = stateScores.reduce((a, b) => b.score > a.score ? b : a);
      o.benchmark = { score: best.score, benchmark_name: best.name, tier: entry.tier || (o.benchmark && o.benchmark.tier) || 'B' };
      o.benchmarks = mergeBenchmarks(o.benchmarks, stateScores);
      fixLog.push({ offer: o.name, action: 'auto-fix', gate: 'state',
        detail: `benchmark.score was null; merged from state (${stateScores.map(b => `${b.name}=${b.score}`).join(', ')})` });
    }

    // Also merge any state benchmarks not yet in the offer.
    const merged = mergeBenchmarks(o.benchmarks, stateScores);
    if (merged.length > (o.benchmarks || []).length) {
      o.benchmarks = merged;
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// Auto-fix: tier (restore from state, cap to B if TB 2.1 missing/low)
// ══════════════════════════════════════════════════════════════════

function autoFixTier(report, fixLog) {
  const TB_PAT = /terminal[\s-]*bench[\s-]*v?2(\.1)?/i;
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    const tier = o.benchmark && o.benchmark.tier;
    if (tier !== 'S' && tier !== 'A') continue;

    const tb = (o.benchmarks || []).find(b => b && TB_PAT.test(b.name || ''));
    if (!tb || tb.score == null) {
      o.benchmark.tier = 'B';
      fixLog.push({ offer: o.name, action: 'auto-fix', gate: 'tier',
        detail: `tier ${tier} → B: no Terminal-Bench 2.1 score on record` });
    } else if (tb.score < 50) {
      o.benchmark.tier = 'B';
      fixLog.push({ offer: o.name, action: 'auto-fix', gate: 'tier',
        detail: `tier ${tier} → B: Terminal-Bench 2.1 = ${tb.score} < 50%` });
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// Auto-fix: allowance default
// ══════════════════════════════════════════════════════════════════

function autoFixAllowance(report, fixLog) {
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) continue;
    if (!o.free_allowance_rank || !['AMPLE', 'NORMAL', 'TIGHT', 'TINY'].includes(o.free_allowance_rank)) {
      o.free_allowance_rank = 'NORMAL';
      fixLog.push({ offer: o.name, action: 'auto-fix', gate: 'allowance',
        detail: 'free_allowance_rank missing → defaulted to NORMAL' });
    }
  }
}

// ══════════════════════════════════════════════════════════════════
// Exclude: bad endpoints
// ══════════════════════════════════════════════════════════════════

function excludeBadEndpoints(report, providers, fixLog) {
  const remaining = [];
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) { remaining.push(o); continue; }
    const label = o.name || '?';

    if (!o.base_url || typeof o.base_url !== 'string') {
      moveToExcluded(report, 'ranked_offers', o, '[endpoint] missing base_url', fixLog);
      continue;
    }
    if (!o.endpoint_source || typeof o.endpoint_source !== 'string' || !/^https?:\/\//.test(o.endpoint_source)) {
      moveToExcluded(report, 'ranked_offers', o, '[endpoint] missing endpoint_source', fixLog);
      continue;
    }
    const hit = matchProvider(o, providers);
    if (!hit) {
      moveToExcluded(report, 'ranked_offers', o,
        `[endpoint] provider "${o.provider}" not in registry — add it from official docs first`, fixLog);
      continue;
    }
    if (!hit.byUrl) {
      moveToExcluded(report, 'ranked_offers', o,
        `[endpoint] base_url "${o.base_url}" contradicts official ${hit.entry.label} endpoint (${hit.entry.base_url}). Re-fetch ${hit.entry.docs_url}`, fixLog);
      continue;
    }
    remaining.push(o);
  }
  report.ranked_offers = remaining;
}

// ══════════════════════════════════════════════════════════════════
// Exclude: bad citations (live fetch)
// ══════════════════════════════════════════════════════════════════

async function excludeBadCitations(report, fixLog) {
  if (process.env.SKIP_CITATION_CHECK === '1') return;
  const offers = (report.ranked_offers || []).filter(
    o => o.ranking_eligible === true && typeof o.endpoint_source === 'string' && /^https?:\/\//.test(o.endpoint_source)
  );
  if (offers.length === 0) return;

  const byUrl = new Map();
  for (const o of offers) {
    if (!byUrl.has(o.endpoint_source)) byUrl.set(o.endpoint_source, []);
    byUrl.get(o.endpoint_source).push(o);
  }

  const badNames = new Set();
  for (const [url, group] of byUrl) {
    let html = null;
    try { html = await fetchText(url); } catch { continue; } // network fail = skip, don't exclude
    for (const o of group) {
      if (!citationSupports(html, o.base_url)) {
        badNames.add(o.name);
        moveToExcluded(report, 'ranked_offers', o,
          `[citation] ${url} does not document base_url "${o.base_url}"`, fixLog);
      }
    }
  }
  if (badNames.size > 0) {
    report.ranked_offers = report.ranked_offers.filter(o => !badNames.has(o.name));
  }
}

// ══════════════════════════════════════════════════════════════════
// Exclude: paid API dressed as free
// ══════════════════════════════════════════════════════════════════

// ── Exclude: OpenRouter model_id not in live catalog ────────────
// The /api/v1/models catalog is the ground truth for what OpenRouter
// actually serves. A :free variant that is absent from the catalog is
// not served by any provider — never trust the web page's shared FAQ
// component (it can show the paid base model's provider count).
// Fail-safe: if the catalog fetch/parse fails, exclude NOTHING.
async function excludeOpenRouterGhost(report, fixLog) {
  if (process.env.SKIP_CITATION_CHECK === '1') return;
  const isOpenRouter = o =>
    /openrouter\.ai/i.test(o.base_url || '') ||
    (o.delivery_type === 'router' && /openrouter/i.test(o.provider || ''));
  const targets = (report.ranked_offers || []).filter(o => o.ranking_eligible === true && isOpenRouter(o));
  if (targets.length === 0) return;

  let raw;
  try {
    raw = await fetchJson('https://openrouter.ai/api/v1/models');
  } catch (e) {
    console.warn(`  ⚠️  OpenRouter catalog fetch failed (${e.message}); skipping ghost check.`);
    return;
  }
  let ids;
  try {
    ids = new Set((JSON.parse(raw).data || []).map(m => m.id));
  } catch {
    console.warn('  ⚠️  OpenRouter catalog parse failed; skipping ghost check.');
    return;
  }

  const bad = new Set();
  for (const o of targets) {
    if (!o.model_id || !ids.has(o.model_id)) {
      bad.add(o.name);
      moveToExcluded(report, 'ranked_offers', o,
        `[openrouter-ghost] model_id "${o.model_id}" is absent from OpenRouter /api/v1/models — not actually served by any provider`, fixLog);
    }
  }
  if (bad.size > 0) {
    report.ranked_offers = report.ranked_offers.filter(o => !bad.has(o.name));
  }
}

function excludePaidApis(report, fixLog) {
  const paidApi = /\bapi is paid\b|\bpaid api\b|\bapi access is paid\b|\bapi costs \$[1-9]/i;
  const remaining = [];
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) { remaining.push(o); continue; }
    const limits = `${o.free_limits || ''} ${o.rate_limits || ''}`;
    if (paidApi.test(limits)) {
      moveToExcluded(report, 'ranked_offers', o,
        `[free-claim] free_limits says API is paid — not a free API offer`, fixLog);
    } else {
      remaining.push(o);
    }
  }
  report.ranked_offers = remaining;
}

// ══════════════════════════════════════════════════════════════════
// Exclude: sub-30B without S/A
// ══════════════════════════════════════════════════════════════════

function excludeTooSmall(report, fixLog) {
  const MAX = 30;
  const COMPETITIVE = ['S', 'A'];
  const remaining = [];
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) { remaining.push(o); continue; }
    const total = o.total_parameters_b;
    const tier = o.benchmark && o.benchmark.tier;
    if (typeof total === 'number' && total < MAX && !COMPETITIVE.includes(tier)) {
      moveToExcluded(report, 'ranked_offers', o,
        `[size] ${total}B total is local-run territory and tier ${tier} doesn't show competitiveness`, fixLog);
    } else {
      remaining.push(o);
    }
  }
  report.ranked_offers = remaining;
}

// ══════════════════════════════════════════════════════════════════
// Helpers
// ══════════════════════════════════════════════════════════════════

function moveToExcluded(report, arrName, offer, reason, fixLog) {
  offer.ranking_eligible = false;
  offer.exclusion_reason = reason;
  report.excluded_offers = report.excluded_offers || [];
  report.excluded_offers.push({ name: offer.name || '?', reason });
  fixLog.push({ offer: offer.name || '?', action: 'exclude', gate: reason.split(']')[0].replace('[', ''), detail: reason });
}

function mergeBenchmarks(existing, fromState) {
  const map = new Map();
  const norm = s => String(s).toLowerCase().replace(/[\s-]/g, '');
  for (const b of (existing || [])) map.set(norm(b.name), b);
  for (const b of fromState) {
    const k = norm(b.name);
    if (!map.has(k)) map.set(k, { name: b.name, score: b.score });
  }
  return [...map.values()];
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

async function fetchJson(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; freeapi-news-validator/1.0)', 'Accept': 'application/json,*/*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

async function fetchText(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; freeapi-news-validator/1.0)', 'Accept': 'text/html,*/*' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.text()).slice(0, 3_000_000);
}

function citationSupports(html, baseUrl) {
  if (!baseUrl) return false;
  if (html.includes(baseUrl)) return true;
  const noScheme = baseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (html.includes(noScheme)) return true;
  try { const host = new URL(baseUrl).host; return host.length > 0 && html.includes(host); } catch { return false; }
}

function basicValidate(report, schema) {
  for (const req of schema.required || []) {
    if (!(req in report)) { console.error(`Missing: ${req}`); return false; }
  }
  for (const k of ['new_models', 'changes', 'ranked_offers', 'excluded_offers', 'sources']) {
    if (!Array.isArray(report[k])) return false;
  }
  return true;
}

main();
