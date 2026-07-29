#!/usr/bin/env node
/**
 * reduce-crawl.js — Deterministic merger. No LLM, no network.
 *
 * Reads all task artifacts from a crawl run directory and MERGES them
 * into ranking-ready candidates. Workers emit raw FACTS (schemas/crawl-facts.schema.json:
 * verbatim quota/pricing text, model ids, benchmark finds). This merger
 * derives every enum the report needs — delivery_type, free_allowance_rank,
 * tier, classification — deterministically from those facts, so the LLM
 * never writes an enum and never gets one wrong.
 *
 * Passes:
 *   1. collect artifacts (facts `models[]` or legacy `offers[]`)
 *   2. merge benchmark finds into benchmark state
 *   3. derive offer fields from facts (delivery_type from registry,
 *      allowance/params/tier/classification from text)
 *   4. deterministic quality gate (paid-API, app-only, sub-30B, tier)
 *   5. coverage + disappeared-known-offer check
 *
 * Fail-safe: aborts only when nothing usable was collected. Offer QUALITY
 * beyond the deterministic gates is the validator's job.
 *
 * Usage: node .devops/batch/reduce-crawl.js <crawl_dir>
 * Exit:  0 = candidates ready, 1 = nothing usable
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REGISTRY_PATH = path.join(ROOT, 'build', 'provider-registry.json');
const BENCHMARKS_PATH = path.join(ROOT, '.agents', 'skills', 'llm-deals-intelligence-skill', 'state', 'benchmarks.json');
const KNOWN_PATH = path.join(ROOT, '.agents', 'skills', 'llm-deals-intelligence-skill', 'state', 'known_offers.json');

const crawlDir = process.argv[2];
if (!crawlDir) { console.error('Usage: reduce-crawl.js <crawl_dir>'); process.exit(1); }

const manifest = JSON.parse(fs.readFileSync(path.join(crawlDir, 'manifest.json'), 'utf8'));
const tasks = manifest.tasks || [];

// ── Load shared state (read-only inputs) ─────────────────────────
let registry = { providers: [] };
try { registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch {}
const registryByKey = Object.fromEntries((registry.providers || []).map(p => [p.key, p]));

let benchmarks = { models: [] };
try { benchmarks = JSON.parse(fs.readFileSync(BENCHMARKS_PATH, 'utf8')); } catch {}

let known = { offers: [] };
try { known = JSON.parse(fs.readFileSync(KNOWN_PATH, 'utf8')); } catch {}

// ── Collect artifacts ────────────────────────────────────────────
const results = { complete: [], partial: [], failed: [], missing: [] };

for (const task of tasks) {
  const artifactPath = path.join(crawlDir, task.output);
  if (!fs.existsSync(artifactPath)) {
    results.missing.push({ task_id: task.task_id, reason: 'artifact file not found' });
    continue;
  }
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  } catch (e) {
    results.failed.push({ task_id: task.task_id, reason: `invalid JSON: ${e.message}` });
    continue;
  }
  if (!artifact.status || !['complete', 'partial', 'failed'].includes(artifact.status)) {
    results.failed.push({ task_id: task.task_id, reason: `missing or invalid status field: ${artifact.status}` });
    continue;
  }
  if (artifact.status === 'failed') {
    results.failed.push({ task_id: task.task_id, reason: (artifact.errors || []).join('; ') || 'worker reported failure' });
    continue;
  }
  if (artifact.status === 'partial') {
    results.partial.push({ task_id: task.task_id, artifact, warnings: artifact.errors || [] });
  } else {
    results.complete.push({ task_id: task.task_id, artifact });
  }
}

// ── Deterministic derivation helpers ─────────────────────────────
const norm = s => String(s).toLowerCase().replace(/[\s-]/g, '');

// delivery_type comes straight from the registry. Workers never write it.
function deriveDeliveryType(providerKey) {
  const p = registryByKey[providerKey];
  return (p && p.delivery_type) || 'official';
}

// free_allowance_rank from verbatim quota text. Keyword-first, else NORMAL.
function deriveAllowance(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return 'NORMAL';
  if (/unlimited|no limit|no quota|制限なし|無制限/.test(t)) return 'AMPLE';
  if (/prototype|preview|early access|beta|very limited|tiny/.test(t)) return 'TINY';
  // Rough monthly USD value if present.
  const usd = t.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:\/|per\s*)?(?:month|mo\b)/);
  if (usd) {
    const v = parseFloat(usd[1]);
    if (v >= 5) return 'AMPLE';
    if (v >= 1) return 'NORMAL';
    if (v >= 0.1) return 'TIGHT';
    return 'TINY';
  }
  if (/generous|ample|large|high limit/.test(t)) return 'AMPLE';
  if (/tight|limited|small|low limit|only \d/.test(t)) return 'TIGHT';
  return 'NORMAL';
}

// total_parameters_b from verbatim params text. MoE → total, not active.
function deriveParamsB(text) {
  const t = String(text || '');
  const total = t.match(/(\d+(?:\.\d+)?)\s*B\s*(?:total|parameters|param|MoE)?/i);
  const totalExplicit = t.match(/(\d+(?:\.\d+)?)\s*B\s*total/i);
  if (totalExplicit) return parseFloat(totalExplicit[1]);
  if (total) return parseFloat(total[1]);
  return null;
}

// tier from Terminal-Bench 2.1 (the S/A admission gate). >=65 S, >=50 A, else B.
function deriveTier(finds) {
  const list = finds || [];
  const tb = list.find(b => /terminal[\s-]?bench/i.test(b.name || ''));
  let score = null, name = null;
  if (list.length > 0) {
    const best = list.reduce((a, b) => (b.score > (a ? a.score : -1) ? b : a), null);
    if (best) { score = best.score; name = best.name; }
  }
  let tier = 'B';
  if (tb && tb.score >= 65) tier = 'S';
  else if (tb && tb.score >= 50) tier = 'A';
  return { tier, score, benchmark_name: name, terminal_bench: tb ? tb.score : null };
}

// classification — provisional keyword pass. The classification agent
// (Slice C) makes the final call; this only keeps obviously-conditional
// or obviously-trial offers out of the true-free bucket.
function deriveClassification(m, errs) {
  const text = `${m.free_quota_text || ''} ${m.pricing_text || ''} ${m.params_text || ''}`.toLowerCase();
  if ((errs || []).some(e => /APP_ONLY/i.test(e))) return 'G_FREE_LIKE';
  if (/data[\s-]?sharing|share.*data|opt[\s-]?in.*data|training data/.test(text)) return 'F_CONDITIONAL';
  // Recurrent free quota (per month / per day) = a standing free tier, not
  // a one-time trial. This is provisional; the classification agent (Slice C)
  // makes the final call.
  const recurrent = /per (?:month|day|mo\b)|monthly|daily|every (?:month|day)|毎月|毎日/.test(text);
  if (recurrent && /free|credit|quota|tier/.test(text)) return 'B_PERMANENT_FREE_TIER';
  if (/trial|launch credit|one[\s-]?time|\$?\d+\s*free credit/.test(text)) return 'D_TRIAL_CREDIT';
  if (/discount|\d+\s*% off|limited[\s-]?time.*off/.test(text)) return 'E_DISCOUNT';
  if (/free (?:api|tier|quota|access)|永久.*無料|always[\s-]?free/.test(text)) return 'B_PERMANENT_FREE_TIER';
  return 'G_FREE_LIKE';
}

// ── Merge benchmark finds into state ─────────────────────────────
let benchmarkMerges = 0;
function mergeFinds(modelName, modelIds, finds) {
  if (!modelName || !Array.isArray(finds) || finds.length === 0) return;
  const key = norm(modelName);
  let model = benchmarks.models.find(m => norm(m.canonical_name) === key);
  if (!model) {
    model = { canonical_name: modelName, model_ids: modelIds, benchmarks: [], tier: null };
    benchmarks.models.push(model);
  }
  for (const b of finds) {
    if (!b.name || b.score == null) continue;
    const bk = norm(b.name);
    const existing = (model.benchmarks || []).find(x => norm(x.name) === bk);
    if (!existing) {
      model.benchmarks = model.benchmarks || [];
      model.benchmarks.push({ name: b.name, score: b.score, source: b.source_url || 'crawl' });
      benchmarkMerges++;
    } else if (b.score > existing.score) {
      existing.score = b.score;
      existing.source = b.source_url || 'crawl';
      benchmarkMerges++;
    }
  }
  model.model_ids = [...new Set([...(model.model_ids || []), ...(modelIds || [])])];
}

// ── Build candidates ─────────────────────────────────────────────
const candidates = [];
const excluded = [];
const newProviders = [];

function exclude(m, task_id, reason) {
  excluded.push({ name: m.model_name || m.model_id || '?', reason, _task_id: task_id });
}

for (const { task_id, artifact } of [...results.complete, ...results.partial]) {
  const errs = artifact.errors || [];
  for (const e of errs) {
    const np = String(e).match(/^NEW_PROVIDER:\s*(\S+)\s+(\S+)/);
    if (np) newProviders.push({ key: np[1], docs_url: np[2], _task_id: task_id });
  }

  const providerKey = artifact.provider_key || (tasks.find(t => t.task_id === task_id) || {}).provider_key;
  const reg = registryByKey[providerKey] || {};
  const crawledAt = artifact.crawled_at || new Date().toISOString();

  // ── Facts path (new): artifact.models[] ──
  for (const m of artifact.models || []) {
    const pkey = m.provider_key || providerKey;
    const finds = m.benchmark_finds || [];
    mergeFinds(m.model_name || m.model_id, [m.model_id].filter(Boolean), finds);
    const tier = deriveTier(finds);
    const totalB = deriveParamsB(m.params_text);

    // Deterministic quality gate.
    if (m.is_free_signal === false) { exclude(m, task_id, '[paid-api] is_free_signal=false — no free access documented'); continue; }
    if (errs.some(e => /APP_ONLY/i.test(e))) { exclude(m, task_id, '[app-only] free access is inside an app/chat, not a public API'); continue; }
    if (totalB != null && totalB < 30 && tier.tier !== 'S' && tier.tier !== 'A') {
      exclude(m, task_id, `[local-run] total ${totalB}B < 30B and tier ${tier.tier} (not S/A competitive)`); continue;
    }

    candidates.push({
      name: m.model_name || m.model_id,
      provider: (registryByKey[pkey] || {}).label || pkey,
      provider_key: pkey,
      model_id: m.model_id,
      model_name: m.model_name || m.model_id,
      base_url: m.base_url || reg.base_url || null,
      endpoint_source: m.endpoint_source || m.docs_url || null,
      classification: deriveClassification(m, errs),
      free_limits: m.free_quota_text || '',
      rate_limits: '',
      free_allowance_rank: deriveAllowance(m.free_quota_text),
      total_parameters_b: totalB,
      active_parameters_b: null,
      delivery_type: deriveDeliveryType(pkey),
      free_model_names: [m.model_id].filter(Boolean),
      benchmark: { score: tier.score, benchmark_name: tier.benchmark_name, tier: tier.tier },
      benchmarks: finds.map(b => ({ name: b.name, score: b.score, source: b.source_url || 'crawl' })),
      operational_confidence: 'MEDIUM',
      information_confidence: (m.endpoint_source || m.docs_url) ? 'HIGH' : 'MEDIUM',
      suspicion_score: 0,
      training_use: '',
      registration_conditions: [],
      end_at: null,
      end_timezone_known: false,
      last_verified: crawledAt,
      sources: [{ url: m.endpoint_source || m.docs_url || '', accessed_at: crawledAt, source_type: 'official' }],
      notes: '',
      _task_id: task_id,
      _from_facts: true,
    });
  }

  // ── Legacy path (discovery / old artifacts): artifact.offers[] ──
  for (const offer of artifact.offers || []) {
    offer._task_id = task_id;
    if (offer.delivery_type == null) offer.delivery_type = deriveDeliveryType(offer.provider_key || providerKey);
    if (offer.free_allowance_rank == null) offer.free_allowance_rank = deriveAllowance(offer.free_limits);
    candidates.push(offer);
  }
  for (const ex of artifact.excluded || []) {
    ex._task_id = task_id;
    excluded.push(ex);
  }
}

// ── Coverage check ───────────────────────────────────────────────
const expectedTasks = tasks.length;
const completedTasks = results.complete.length + results.partial.length;
const failedTasks = results.failed.length + results.missing.length;
const coverageRate = expectedTasks > 0 ? completedTasks / expectedTasks : 0;

const candidateNames = new Set(candidates.map(c => (c.name || '').toLowerCase()));
const disappeared = (known.offers || []).filter(o =>
  o.operational_confidence !== 'LOW' && !candidateNames.has((o.name || '').toLowerCase())
);

// ── Write outputs ────────────────────────────────────────────────
const reducedDir = path.join(crawlDir, 'reduced');
fs.mkdirSync(reducedDir, { recursive: true });

const output = {
  run_id: manifest.run_id,
  reduced_at: new Date().toISOString(),
  coverage: {
    expected: expectedTasks,
    completed: completedTasks,
    failed: failedTasks,
    rate: Math.round(coverageRate * 100) + '%',
  },
  failures: [...results.failed, ...results.missing],
  warnings: results.partial.map(p => ({ task_id: p.task_id, warnings: p.warnings })),
  disappeared_known_offers: disappeared.map(o => o.name),
  new_providers: newProviders,
  benchmark_merges: benchmarkMerges,
  candidates,
  excluded,
};

fs.writeFileSync(path.join(reducedDir, 'candidates.json'), JSON.stringify(output, null, 2) + '\n');
fs.writeFileSync(path.join(reducedDir, 'benchmarks.json'), JSON.stringify(benchmarks, null, 2) + '\n');
fs.writeFileSync(path.join(reducedDir, 'provider-registry.json'), JSON.stringify(registry, null, 2) + '\n');

// ── Report ───────────────────────────────────────────────────────
console.log(`Merger: ${completedTasks}/${expectedTasks} tasks completed, ${failedTasks} failed`);
console.log(`  Candidates: ${candidates.length} | Excluded: ${excluded.length}`);
console.log(`  Benchmark merges: ${benchmarkMerges} | New providers: ${newProviders.length}`);
if (disappeared.length > 0) {
  console.log(`  ⚠️  Known offers not found in candidates: ${disappeared.map(o => o.name).join(', ')}`);
}
if (results.failed.length > 0 || results.missing.length > 0) {
  console.log('  Failures:');
  for (const f of [...results.failed, ...results.missing]) {
    console.log(`    ❌ ${f.task_id}: ${f.reason}`);
  }
}

// ── Fail-safe gate ───────────────────────────────────────────────
// Abort ONLY when nothing usable was collected. A high task-failure rate
// is not fatal: many targets are providers with no free offer, and a
// local model legitimately finds nothing there. Offer quality beyond the
// deterministic gates is the validator's job.
if (completedTasks === 0) {
  console.error('\n❌ MERGER ABORT: zero tasks completed. Nothing to work with.');
  process.exit(1);
}
if (candidates.length === 0 && excluded.length === 0) {
  console.error('\n❌ MERGER ABORT: zero candidates and zero exclusions. Nothing was collected.');
  process.exit(1);
}
if (failedTasks > expectedTasks / 2) {
  console.warn(`\n⚠️  WARNING: ${failedTasks}/${expectedTasks} tasks failed/missing (likely no-offer providers or local-model timeouts). Proceeding with ${candidates.length} candidate(s); coverage gaps will be noted in the report.`);
}

fs.writeFileSync(path.join(crawlDir, 'REDUCED'), new Date().toISOString() + '\n');
console.log('✅ Merger complete. candidates.json ready for editor.');
