#!/usr/bin/env node
/**
 * build-manifest.js — Generate the crawl task manifest for a run.
 *
 * Reads provider-registry.json, known_offers.json, benchmarks.json and
 * produces state/crawl/<run_id>/manifest.json.
 *
 * Tasks:
 *   discovery       — always 1. Finds new models/providers.
 *   refresh:<key>   — per provider with known offers. Re-verify only.
 *   crawl:<key>     — per provider without known offers (or all for OpenRouter).
 *
 * Usage: node .devops/batch/build-manifest.js <crawl_dir>
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const REGISTRY = path.join(ROOT, 'build', 'provider-registry.json');
const KNOWN = path.join(ROOT, '.agents', 'skills', 'llm-deals-intelligence-skill', 'state', 'known_offers.json');
const BENCHMARKS = path.join(ROOT, '.agents', 'skills', 'llm-deals-intelligence-skill', 'state', 'benchmarks.json');

const crawlDir = process.argv[2];
if (!crawlDir) { console.error('Usage: build-manifest.js <crawl_dir>'); process.exit(1); }

const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
let known = { offers: [] };
try { known = JSON.parse(fs.readFileSync(KNOWN, 'utf8')); } catch {}
let benchmarks = { models: [] };
try { benchmarks = JSON.parse(fs.readFileSync(BENCHMARKS, 'utf8')); } catch {}

// Index known offers by provider key.
const knownByProvider = new Map();
for (const o of known.offers || []) {
  const key = (o.provider || '').toLowerCase();
  if (!knownByProvider.has(key)) knownByProvider.set(key, []);
  knownByProvider.get(key).push(o);
}

// Index benchmark models by canonical name for quick lookup.
const benchmarkNames = new Set((benchmarks.models || []).map(m => (m.canonical_name || '').toLowerCase()));

const tasks = [];

// Task 1: Discovery (always).
tasks.push({
  task_id: 'discovery',
  kind: 'discovery',
  status: 'pending',
  output: 'discovery/task-discovery.json',
});

// Tasks 2+: Per-provider refresh or crawl.
for (const p of registry.providers || []) {
  const key = p.key;
  const knownOffers = knownByProvider.get(key) || [];
  // Also match by label (case-insensitive).
  const knownByLabel = knownByProvider.get((p.label || '').toLowerCase()) || [];
  const allKnown = [...knownOffers, ...knownByLabel];

  if (allKnown.length > 0) {
    tasks.push({
      task_id: `refresh:${key}`,
      kind: 'refresh',
      provider_key: key,
      provider_label: p.label,
      base_url: p.base_url,
      docs_url: p.docs_url,
      known_offers: allKnown.map(o => o.name),
      status: 'pending',
      output: `refresh/task-${key}.json`,
    });
  } else {
    tasks.push({
      task_id: `crawl:${key}`,
      kind: 'crawl',
      provider_key: key,
      provider_label: p.label,
      base_url: p.base_url,
      docs_url: p.docs_url,
      status: 'pending',
      output: `offers/task-${key}.json`,
    });
  }
}

// OpenRouter is always a full crawl (model catalog changes frequently).
// Upgrade its task from refresh to crawl if it was classified as refresh.
const orTask = tasks.find(t => t.provider_key === 'openrouter');
if (orTask && orTask.kind === 'refresh') {
  orTask.kind = 'crawl';
  orTask.task_id = 'crawl:openrouter';
  orTask.output = 'offers/task-openrouter.json';
}

const manifest = {
  run_id: path.basename(crawlDir),
  created_at: new Date().toISOString(),
  concurrency: parseInt(process.env.CRAWL_CONCURRENCY || '2', 10),
  provider_count: (registry.providers || []).length,
  known_offer_count: (known.offers || []).length,
  benchmark_model_count: (benchmarks.models || []).length,
  tasks,
};

fs.mkdirSync(crawlDir, { recursive: true });
fs.writeFileSync(path.join(crawlDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Manifest: ${tasks.length} tasks (${tasks.filter(t => t.kind === 'discovery').length} discovery, ${tasks.filter(t => t.kind === 'refresh').length} refresh, ${tasks.filter(t => t.kind === 'crawl').length} crawl)`);
console.log(`Concurrency: ${manifest.concurrency}`);
