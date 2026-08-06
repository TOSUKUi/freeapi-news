#!/usr/bin/env node
/**
 * validate-report.js
 *
 * Makes report.json renderable. Two actions, no "downgrade" concept:
 *
 *   auto-fix  — rewrite the field in place (allowance default)
 *   exclude   — move the offer to excluded_offers (fake URL, lying
 *               citation, paid API dressed as free, sub-30B without S/A,
 *               no qualifying Terminal Bench, no derived access kind)
 *
 * The legacy state/benchmarks.json and known_offers.json files are no
 * longer read: SQLite owns benchmark facts and the candidate path validates
 * before promotion. A missing or invalid report input fails hard instead of
 * generating dummy output.
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
const { buildReportSummary } = require('./summary-text');
const rankingPolicy = require('./ranking-policy');

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

  autoFixAllowance(report, fixLog);
  autoFixPaidClassification(report, fixLog);

  // ── 3. Exclude what we can't fix ───────────────────────────────
  excludeBadEndpoints(report, providers, fixLog);
  await excludeBadCitations(report, fixLog);
  excludePaidApis(report, fixLog);
  excludeTooSmall(report, fixLog);
  excludeNoTerminalBench(report, fixLog);
  excludeNoAccessKind(report, fixLog);
  excludeMismatchedPrices(report, fixLog);

  // ── 4. Rewrite report.json ─────────────────────────────────────
  // This is the final authority: all auto-fixes and exclusions, including
  // async citation gates, have finished before the summary is set.
  report.summary = buildReportSummary(report);
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
    const Ajv = require('ajv');
    const addFormats = require('ajv-formats');
    const ajv = new Ajv({ allErrors: true, strict: false });
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

// A non-zero ULTRA_LOW price is a paid API offer. It cannot carry a free
// mechanism classification, even if a stale classifier artifact assigned one
// to the same display name. The assembler now keys classifications by exact
// offer identity; this remains a final publication guard for old snapshots.
function autoFixPaidClassification(report, fixLog) {
  const freeClassifications = new Set([
    'A_TRUE_FREE', 'B_PERMANENT_FREE_TIER', 'C_LIMITED_FREE',
  ]);
  for (const section of ['ranked_offers', 'conditional_credits', 'caution_offers']) {
    for (const o of report[section] || []) {
      if (!freeClassifications.has(o.classification)) continue;
      const price = o.effective_price_per_million;
      if (!price || typeof price !== 'object') continue;
      const accessKind = rankingPolicy.deriveAccessKind(price.input, price.output);
      if (accessKind !== 'ULTRA_LOW' || (price.input === 0 && price.output === 0)) continue;
      const priorClassification = o.classification;
      o.classification = 'E_DISCOUNT';
      fixLog.push({
        offer: o.name,
        action: 'auto-fix',
        gate: 'classification',
        detail: `non-zero ULTRA_LOW price cannot be ${priorClassification}; set to E_DISCOUNT`,
      });
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
// Exclude: no qualifying Terminal-Bench (the ranking admission gate)
// ══════════════════════════════════════════════════════════════════

// Ranking admits an offer only with a verified Terminal Bench 2.0 or 2.1
// score at or above the shared 50 gate (spec 0004 AC-5). The shared policy
// is the single source of truth; a score below 50 never becomes rankable
// tier B, and other benchmarks never substitute. The offer's representative
// benchmark_key + score must both qualify.
function excludeNoTerminalBench(report, fixLog) {
  const remaining = [];
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) { remaining.push(o); continue; }
    const key = o.benchmark_key || (o.benchmark && null);
    const score = o.benchmark && o.benchmark.score != null ? o.benchmark.score : null;
    if (!rankingPolicy.qualifiesTerminalBench(key, score)) {
      moveToExcluded(report, 'ranked_offers', o,
        `[no-terminal-bench] no verified Terminal Bench 2.0/2.1 at or above 50 on record — cannot verify competitiveness (AC-5)`, fixLog);
    } else {
      remaining.push(o);
    }
  }
  report.ranked_offers = remaining;
}

// ── Exclude: no derived access kind (spec 0004 AC-4) ─────────────
// A ranked offer must have an access_kind of FREE or ULTRA_LOW derived from
// known effective prices. A missing access_kind (unknown or over-limit
// prices) cannot rank. The effective price object must be present and
// non-null with finite non-negative input/output matching the access kind.
function excludeNoAccessKind(report, fixLog) {
  const remaining = [];
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) { remaining.push(o); continue; }
    if (o.access_kind !== 'FREE' && o.access_kind !== 'ULTRA_LOW') {
      moveToExcluded(report, 'ranked_offers', o,
        `[access-kind] access_kind ${JSON.stringify(o.access_kind)} is not FREE or ULTRA_LOW — unknown or over-limit prices (AC-4)`, fixLog);
    } else {
      remaining.push(o);
    }
  }
  report.ranked_offers = remaining;
}

// ── Exclude: effective prices contradict the access kind (AC-4) ──
// A ranked offer must carry a non-null effective_price_per_million object
// with finite non-negative input and output that derive exactly to its
// access_kind. A FREE offer with a non-zero price, or an ULTRA_LOW offer
// whose prices exceed the 0.2/0.4 limits, cannot rank.
function excludeMismatchedPrices(report, fixLog) {
  const remaining = [];
  for (const o of report.ranked_offers || []) {
    if (o.ranking_eligible !== true) { remaining.push(o); continue; }
    const eff = o.effective_price_per_million;
    if (!eff || typeof eff !== 'object' ||
        !rankingPolicy.accessKindMatches(o.access_kind, eff.input, eff.output)) {
      moveToExcluded(report, 'ranked_offers', o,
        `[access-prices] effective prices ${JSON.stringify(eff)} do not match access_kind ${JSON.stringify(o.access_kind)} (AC-4)`, fixLog);
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

if (require.main === module) {
  main().catch((error) => {
    console.error(`❌ Report validation failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  rankingPolicy,
  excludeNoTerminalBench,
  excludeNoAccessKind,
  excludeMismatchedPrices,
};
