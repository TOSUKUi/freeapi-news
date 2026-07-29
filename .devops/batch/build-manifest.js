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
const PAGE_CACHE = path.join(ROOT, '.agents', 'skills', 'llm-deals-intelligence-skill', 'state', 'page_cache.json');

const crawlDir = process.argv[2];
if (!crawlDir) { console.error('Usage: build-manifest.js <crawl_dir>'); process.exit(1); }

const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
let known = { offers: [] };
try { known = JSON.parse(fs.readFileSync(KNOWN, 'utf8')); } catch {}
let benchmarks = { models: [] };
try { benchmarks = JSON.parse(fs.readFileSync(BENCHMARKS, 'utf8')); } catch {}

// Page cache: URLs the workers successfully fetched, with when. The manifest
// hands each task the still-fresh URLs so workers re-use a known-good page
// ("継続してあったらそのまま継続") instead of re-discovering it, and only fall
// back to web_search/browser when a cached URL is stale or dead.
let pageCache = {};
try { pageCache = JSON.parse(fs.readFileSync(PAGE_CACHE, 'utf8')); } catch {}
const FRESH_MS = 24 * 3600 * 1000;
const freshUrls = urls => [...new Set((urls || []).filter(Boolean))].filter(u => {
  const c = pageCache[u];
  if (!c || c.http_ok === false) return false;
  return Date.now() - new Date(c.fetched_at || 0).getTime() < FRESH_MS;
});
// Index cached URLs by provider so a task gets its provider's known-good
// pages even when known_offers.json does not carry sources/endpoint_source.
const cacheByProvider = new Map();
for (const [url, c] of Object.entries(pageCache)) {
  if (!c.provider_key) continue;
  if (!cacheByProvider.has(c.provider_key)) cacheByProvider.set(c.provider_key, []);
  cacheByProvider.get(c.provider_key).push(url);
}

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
      api_catalog_url: p.api_catalog_url || null,
      known_offers: allKnown.map(o => o.name),
      cached_urls: freshUrls([...allKnown.flatMap(o => [...(o.sources || []).map(s => s.url), o.endpoint_source]), ...(cacheByProvider.get(key) || [])]),
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
      api_catalog_url: p.api_catalog_url || null,
      cached_urls: [],
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
  concurrency: parseInt(process.env.GLOBAL_CONCURRENCY || '2', 10),
  provider_count: (registry.providers || []).length,
  known_offer_count: (known.offers || []).length,
  benchmark_model_count: (benchmarks.models || []).length,
  tasks,
};

fs.mkdirSync(crawlDir, { recursive: true });
fs.writeFileSync(path.join(crawlDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Manifest: ${tasks.length} tasks (${tasks.filter(t => t.kind === 'discovery').length} discovery, ${tasks.filter(t => t.kind === 'refresh').length} refresh, ${tasks.filter(t => t.kind === 'crawl').length} crawl)`);
console.log(`Concurrency: ${manifest.concurrency}`);
