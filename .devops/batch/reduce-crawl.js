#!/usr/bin/env node
/**
 * reduce-crawl.js — Deterministic reducer. No LLM, no network.
 *
 * Reads all task artifacts from a crawl run directory, validates them,
 * merges benchmark/registry deltas, and produces a compact candidates
 * file for the editor agent.
 *
 * Fail-safe: if artifacts are missing or broken, they are reported as
 * failures. The reducer never invents data. If too many tasks failed,
 * it exits non-zero so the batch stops before deploy.
 *
 * Usage: node .devops/batch/reduce-crawl.js <crawl_dir>
 * Exit:  0 = candidates ready, 1 = too many failures
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
    results.failed.push({ task_id: task.task_id, reason: artifact.error || 'worker reported failure' });
    continue;
  }
  if (artifact.status === 'partial') {
    results.partial.push({ task_id: task.task_id, artifact, warnings: artifact.errors || [] });
  } else {
    results.complete.push({ task_id: task.task_id, artifact });
  }
}

// ── Merge benchmark deltas ───────────────────────────────────────
let benchmarks = { models: [] };
try { benchmarks = JSON.parse(fs.readFileSync(BENCHMARKS_PATH, 'utf8')); } catch {}

const norm = s => String(s).toLowerCase().replace(/[\s-]/g, '');
let benchmarkMerges = 0;

for (const { artifact } of [...results.complete, ...results.partial]) {
  for (const delta of artifact.benchmark_deltas || []) {
    if (!delta.canonical_name) continue;
    const key = norm(delta.canonical_name);
    let model = benchmarks.models.find(m => norm(m.canonical_name) === key);
    if (!model) {
      model = { canonical_name: delta.canonical_name, model_ids: delta.model_ids || [], benchmarks: [], tier: null };
      benchmarks.models.push(model);
    }
    for (const b of delta.benchmarks || []) {
      if (!b.name || b.score == null) continue;
      const bk = norm(b.name);
      const existing = (model.benchmarks || []).find(x => norm(x.name) === bk);
      if (!existing) {
        model.benchmarks = model.benchmarks || [];
        model.benchmarks.push({ name: b.name, score: b.score, source: b.source || 'crawl' });
        benchmarkMerges++;
      } else if (b.score > existing.score) {
        existing.score = b.score;
        existing.source = b.source || 'crawl';
        benchmarkMerges++;
      }
    }
    if (delta.tier && !model.tier) model.tier = delta.tier;
    if (delta.model_ids) {
      model.model_ids = [...new Set([...(model.model_ids || []), ...delta.model_ids])];
    }
  }
}

// ── Merge registry deltas ────────────────────────────────────────
let registry = { providers: [] };
try { registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); } catch {}

let registryMerges = 0;
for (const { artifact } of [...results.complete, ...results.partial]) {
  for (const delta of artifact.registry_deltas || []) {
    if (!delta.key || !delta.base_url) continue;
    const existing = registry.providers.find(p => p.key === delta.key);
    if (!existing) {
      registry.providers.push(delta);
      registryMerges++;
    }
  }
}

// ── Build candidates ─────────────────────────────────────────────
const candidates = [];
const excluded = [];

for (const { task_id, artifact } of [...results.complete, ...results.partial]) {
  for (const offer of artifact.offers || []) {
    offer._task_id = task_id;
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

// Previous known offers that disappeared.
let known = { offers: [] };
try { known = JSON.parse(fs.readFileSync(KNOWN_PATH, 'utf8')); } catch {}
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
  benchmark_merges: benchmarkMerges,
  registry_merges: registryMerges,
  candidates,
  excluded,
};

fs.writeFileSync(path.join(reducedDir, 'candidates.json'), JSON.stringify(output, null, 2) + '\n');

// Write merged state files to reduced/ (editor promotes them later).
fs.writeFileSync(path.join(reducedDir, 'benchmarks.json'), JSON.stringify(benchmarks, null, 2) + '\n');
fs.writeFileSync(path.join(reducedDir, 'provider-registry.json'), JSON.stringify(registry, null, 2) + '\n');

// ── Report ───────────────────────────────────────────────────────
console.log(`Reducer: ${completedTasks}/${expectedTasks} tasks completed, ${failedTasks} failed`);
console.log(`  Candidates: ${candidates.length} | Excluded: ${excluded.length}`);
console.log(`  Benchmark merges: ${benchmarkMerges} | Registry merges: ${registryMerges}`);
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
// Stop if more than half the tasks failed, or if ALL tasks failed.
if (failedTasks > expectedTasks / 2) {
  console.error(`\n❌ REDUCER ABORT: ${failedTasks}/${expectedTasks} tasks failed. Not safe to proceed.`);
  process.exit(1);
}
// Stop if zero candidates and zero excluded (nothing was collected).
if (candidates.length === 0 && excluded.length === 0) {
  console.error('\n❌ REDUCER ABORT: zero candidates and zero exclusions. Nothing was collected.');
  process.exit(1);
}

// Write sentinel.
fs.writeFileSync(path.join(crawlDir, 'REDUCED'), new Date().toISOString() + '\n');
console.log('✅ Reducer complete. candidates.json ready for editor.');
