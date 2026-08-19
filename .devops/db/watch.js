'use strict';

// Spec 0008 Phase 1: deterministic research watch. Fetches the research
// watchlist channels (vendor channels, community feeds, coding products,
// credit programs, provider monitors, plus fixed public API feeds), records
// per-run snapshots in watch_facts, and derives hash based change signals.
// No LLM: this module is deterministic code with an injectable fetch, so the
// whole phase is testable offline. A signal only becomes an LLM task (news
// scan, vendor deep dive, model fan out) downstream.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const db = require('./collector-db');
const { loadWatchlist } = require('../../build/research-watchlist');

const FETCH_TIMEOUT_MS = 25000;
const RETRIES = 2;
const SUMMARY_CHARS = 600;
const MAX_ITEMS = 200;

// Fixed public API feeds that are always watched (spec 0008: Hugging Face and
// GitHub public API forms). Not in the JSON watchlist because they are part of
// the collector, not operator managed configuration.
const FIXED_API_CHANNELS = [
  {
    task_id: 'watch:api:hf-new-models',
    domain: 'vendor_channel',
    entity_key: 'api:hf-new-models',
    channel: 'hf_new_models',
    url: 'https://huggingface.co/api/models?sort=createdAt&direction=-1&limit=200',
  },
];

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

function watchlistPathFor(baseOpts = {}) {
  const { projectRoot } = db.resolvePaths(baseOpts);
  return path.join(projectRoot, 'build', 'research-watchlist.json');
}

// Builds the deterministic watch task plan from the watchlist. Every channel
// becomes one task; the task id is stable so artifact names and watch_facts
// entity keys stay comparable across runs.
function buildWatchPlan(watchlist) {
  const tasks = [];
  const push = (task) => tasks.push({
    provider_key: null,
    base_url: null,
    docs_url: null,
    api_catalog_url: null,
    assigned_model_ids: [],
    cached_urls: [],
    kind: 'watch',
    output: `artifacts/${db.sanitizeTaskId(task.task_id)}.json`,
    ...task,
  });

  for (const vendor of watchlist.vendors || []) {
    for (const [channel, value] of Object.entries(vendor.channels || {})) {
      if (typeof value !== 'string' || !value.trim()) continue;
      if (channel === 'hf_org') {
        push({
          task_id: `watch:vendor:${vendor.key}:hf_org`,
          domain: 'vendor_channel',
          entity_key: `vendor:${vendor.key}:hf_org`,
          channel: 'hf_org',
          url: `https://huggingface.co/api/models?author=${encodeURIComponent(value)}&sort=createdAt&direction=-1&limit=50`,
          watchlist_ref: `vendors.${vendor.key}.channels.hf_org`,
        });
        continue;
      }
      if (channel === 'github_orgs') {
        const orgs = Array.isArray(value) ? value : [value];
        for (const org of orgs) {
          const name = String(org).replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
          push({
            task_id: `watch:vendor:${vendor.key}:gh-${name}`,
            domain: 'vendor_channel',
            entity_key: `vendor:${vendor.key}:github:${name}`,
            channel: 'github_orgs',
            url: `https://api.github.com/orgs/${encodeURIComponent(name)}/repos?sort=pushed&per_page=10`,
            watchlist_ref: `vendors.${vendor.key}.channels.github_orgs`,
          });
        }
        continue;
      }
      push({
        task_id: `watch:vendor:${vendor.key}:${channel}`,
        domain: 'vendor_channel',
        entity_key: `vendor:${vendor.key}:${channel}`,
        channel,
        url: value,
        watchlist_ref: `vendors.${vendor.key}.channels.${channel}`,
      });
    }
  }

  for (const entry of watchlist.community || []) {
    if (entry.kind === 'reddit') {
      for (const sub of entry.subreddits || []) {
        push({
          task_id: `watch:community:reddit-${sub}`,
          domain: 'community',
          entity_key: `community:reddit:${sub}`,
          channel: 'reddit',
          url: `https://www.reddit.com/r/${encodeURIComponent(sub)}/new.json?limit=50`,
          watchlist_ref: 'community.reddit',
        });
      }
    } else if (entry.kind === 'hn') {
      for (const query of entry.queries || []) {
        const q = encodeURIComponent(query);
        push({
          task_id: `watch:community:hn-${db.sanitizeTaskId(query)}`,
          domain: 'community',
          entity_key: `community:hn:${query}`,
          channel: 'hn',
          url: `https://hn.algolia.com/api/v1/search_by_date?query=${q}&tags=story&hitsPerPage=30`,
          watchlist_ref: 'community.hn',
        });
      }
    } else if (entry.kind === 'github') {
      for (const repo of entry.repos || []) {
        push({
          task_id: `watch:community:gh-repo-${repo}`,
          domain: 'community',
          entity_key: `community:github:repo:${repo}`,
          channel: 'github',
          url: `https://api.github.com/repos/${encodeURIComponent(repo)}/releases?per_page=10`,
          watchlist_ref: 'community.github',
        });
      }
      for (const org of entry.orgs || []) {
        push({
          task_id: `watch:community:gh-org-${org}`,
          domain: 'community',
          entity_key: `community:github:org:${org}`,
          channel: 'github',
          url: `https://api.github.com/orgs/${encodeURIComponent(org)}/repos?sort=pushed&per_page=10`,
          watchlist_ref: 'community.github',
        });
      }
    }
  }

  for (const product of watchlist.coding_products || []) {
    const urls = {
      pricing: product.pricing_url,
      changelog: product.changelog_url,
    };
    for (const [channel, url] of Object.entries(urls)) {
      if (typeof url !== 'string' || !url.trim()) continue;
      push({
        task_id: `watch:product:${product.key}:${channel}`,
        domain: 'product',
        entity_key: `product:${product.key}:${channel}`,
        channel,
        url,
        watchlist_ref: `coding_products.${product.key}`,
      });
    }
  }

  for (const program of watchlist.credit_programs || []) {
    if (typeof program.url !== 'string' || !program.url.trim()) continue;
    push({
      task_id: `watch:program:${program.key}`,
      domain: 'program',
      entity_key: `program:${program.key}`,
      channel: 'program',
      url: program.url,
      watchlist_ref: `credit_programs.${program.key}`,
    });
  }

  for (const monitor of watchlist.provider_monitors || []) {
    for (const [channel, url] of Object.entries(monitor.watch || {})) {
      if (typeof url !== 'string' || !url.trim()) continue;
      push({
        task_id: `watch:monitor:${monitor.provider_key}:${channel}`,
        domain: 'provider_watch',
        entity_key: `monitor:${monitor.provider_key}:${channel}`,
        channel,
        url,
        provider_key: monitor.provider_key,
        watchlist_ref: `provider_monitors.${monitor.provider_key}`,
      });
    }
  }

  for (const fixed of FIXED_API_CHANNELS) {
    push({ ...fixed });
  }

  tasks.sort((a, b) => a.task_id.localeCompare(b.task_id));
  return tasks;
}

// ---------------------------------------------------------------------------
// Fetch + content normalization
// ---------------------------------------------------------------------------

async function fetchWithRetry(url, fetchImpl, attempts = RETRIES) {
  const doFetch = fetchImpl || fetch;
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await doFetch(url, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; free-api-news/1.0; +https://github.com)',
          accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
        },
      });
      const body = await res.text();
      clearTimeout(timer);
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (i + 1 < attempts) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastError || new Error(`fetch failed: ${url}`);
}

// Strips an HTML document down to visible text plus its title.
function htmlToText(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/\s+/g, ' ').trim() : '';
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const text = noScript
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return { title, text };
}

// Generic deterministic item extraction for JSON feeds. Items are stable
// strings so the change signal can diff them across runs without an LLM.
function extractJsonItems(parsed) {
  let entries = null;
  if (Array.isArray(parsed)) entries = parsed;
  else if (parsed && typeof parsed === 'object') {
    if (Array.isArray(parsed.data) && parsed.data.length > 0) {
      entries = Array.isArray(parsed.data.children) ? parsed.data.children : parsed.data;
    } else if (Array.isArray(parsed.hits)) entries = parsed.hits;
    else if (Array.isArray(parsed.models)) entries = parsed.models;
    else if (Array.isArray(parsed.items)) entries = parsed.items;
    else if (Array.isArray(parsed.releases)) entries = parsed.releases;
  }
  if (!entries) return { title: '', items: [] };
  const items = [];
  for (const entry of entries.slice(0, MAX_ITEMS)) {
    const obj = entry && entry.data ? entry.data : entry;
    if (!obj || typeof obj !== 'object') continue;
    const key = obj.id ?? obj.model_id ?? obj.full_name ?? obj.name ?? obj.title ?? obj.slug;
    if (key === undefined || key === null) continue;
    const extra = [];
    if (obj.created_at || obj.createdAt || obj.published_at || obj.pushed_at) {
      extra.push(`created=${obj.created_at || obj.createdAt || obj.published_at || obj.pushed_at}`);
    }
    if (typeof obj.title === 'string' && obj.title !== key) extra.push(obj.title.slice(0, 160));
    items.push({ key: String(key), text: `${key} ${extra.join(' ')}`.trim() });
  }
  return { title: '', items };
}

function sha256Hex(text) {
  return `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

// Normalizes one fetched body into { content_type, content_hash, title,
// summary, items }.
function normalizeContent(body) {
  const trimmed = String(body || '').trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(body);
      const { title, items } = extractJsonItems(parsed);
      const canonical = JSON.stringify(items.map((i) => i.text));
      return {
        content_type: 'json',
        content_hash: sha256Hex(canonical),
        title,
        summary: items.slice(0, 10).map((i) => i.text).join(' | ').slice(0, SUMMARY_CHARS),
        items,
      };
    } catch {
      // JSON that failed to parse is hashed as text so changes still register.
    }
  }
  const { title, text } = htmlToText(body);
  return {
    content_type: 'html',
    content_hash: sha256Hex(text),
    title,
    summary: text.slice(0, SUMMARY_CHARS),
    items: [],
  };
}

// Fetches one watch task and returns its artifact (schema_version 1, kind
// watch). The artifact is written by the caller so dry runs and tests can
// inspect the file layout.
async function fetchWatchTask(task, options = {}) {
  const now = options.now || new Date().toISOString();
  const base = {
    schema_version: 1,
    task_id: task.task_id,
    kind: 'watch',
    domain: task.domain,
    entity_key: task.entity_key,
    url: task.url,
    channel: task.channel,
    fetched_at: now,
    errors: [],
  };
  try {
    const { ok, status, body } = await fetchWithRetry(task.url, options.fetchImpl);
    if (!ok && status < 200) {
      return { ...base, status: 'failed', http_status: status, content_hash: null,
        errors: [`http ${status}`] };
    }
    const content = normalizeContent(body);
    return {
      ...base,
      status: ok ? 'complete' : 'partial',
      http_status: status,
      content_type: content.content_type,
      content_hash: content.content_hash,
      title: content.title || null,
      summary: content.summary,
      items: content.items,
    };
  } catch (err) {
    return { ...base, status: 'failed', http_status: null, content_hash: null,
      errors: [err.message || String(err)] };
  }
}

// ---------------------------------------------------------------------------
// Phase driver
// ---------------------------------------------------------------------------

// Runs the whole watch phase: fetch every planned channel, record one
// watch_facts row per channel for this run, derive change signals against the
// previous run, and write reduced/watch-signals.json. Returns the signals and
// a summary. Fetch failures are signals too (fetch_failed) and never fail the
// run: the watch lane is addition only.
async function runWatchPhase(options = {}) {
  const {
    runId,
    runDir,
    baseOpts = {},
    fetchImpl,
    now,
    concurrency = 6,
    log = () => {},
    watchlist,
  } = options;
  if (!runId || !runDir) throw new Error('runWatchPhase requires runId and runDir');
  const list = watchlist || loadWatchlist(watchlistPathFor(baseOpts));
  const plan = buildWatchPlan(list);
  const stampedNow = now || new Date().toISOString();

  const artifacts = new Array(plan.length);
  let next = 0;
  async function lane() {
    while (next < plan.length) {
      const i = next;
      next += 1;
      artifacts[i] = await fetchWatchTask(plan[i], { fetchImpl, now: stampedNow });
    }
  }
  const laneCount = Math.max(1, Math.min(concurrency, plan.length));
  await Promise.all(Array.from({ length: laneCount }, lane));

  const reducedDir = path.join(runDir, 'reduced');
  fs.mkdirSync(reducedDir, { recursive: true });

  const signals = [];
  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < plan.length; i += 1) {
    const task = plan[i];
    const artifact = artifacts[i];
    const artifactPath = db.artifactPathFor(runDir, task.task_id);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);

    const previous = artifact.status === 'failed'
      ? latestPreviousFact(task, runId, baseOpts)
      : db.recordWatchFact({
        domain: task.domain,
        entity_key: task.entity_key,
        url: task.url,
        run_id: runId,
        fetched_at: stampedNow,
        http_status: artifact.http_status,
        content_hash: artifact.content_hash,
        facts_json: {
          channel: task.channel,
          title: artifact.title || null,
          summary: artifact.summary || null,
          items: (artifact.items || []).slice(0, MAX_ITEMS),
        },
      }, baseOpts).previous;

    const signal = deriveSignal(task, artifact, previous);
    signals.push(signal);
    if (artifact.status === 'failed') failCount += 1; else okCount += 1;
    log(`  watch ${signal.status} ${task.entity_key}${artifact.http_status ? ` (http ${artifact.http_status})` : ''}`
      + (signal.new_items && signal.new_items.length > 0 ? ` +${signal.new_items.length} new item(s)` : ''));
  }

  const summary = {
    run_id: runId,
    generated_at: stampedNow,
    channels: plan.length,
    ok: okCount,
    failed: failCount,
    changed: signals.filter((s) => s.status === 'changed').length,
    first_seen: signals.filter((s) => s.status === 'first_seen').length,
    fetch_failed: signals.filter((s) => s.status === 'fetch_failed').length,
  };
  fs.writeFileSync(path.join(reducedDir, 'watch-signals.json'),
    `${JSON.stringify({ ...summary, signals }, null, 2)}\n`);
  return { signals, summary };
}

function latestPreviousFact(task, runId, baseOpts) {
  const rows = db.latestWatchFacts(baseOpts)
    .filter((row) => row.domain === task.domain && row.entity_key === task.entity_key
      && row.run_id !== runId);
  return rows[0] || null;
}

// Derives the deterministic change signal for one channel against its
// previous snapshot: first_seen (no previous), changed (hash differs),
// unchanged, or fetch_failed. Changed channels also carry the item diff (new
// items not present before), which downstream workers use for triage.
function deriveSignal(task, artifact, previous) {
  const base = {
    task_id: task.task_id,
    domain: task.domain,
    entity_key: task.entity_key,
    url: task.url,
    channel: task.channel,
    http_status: artifact.http_status,
    content_hash: artifact.content_hash || null,
    previous_hash: previous && previous.content_hash ? previous.content_hash : null,
    new_items: [],
    summary: artifact.summary || null,
  };
  if (artifact.status === 'failed') {
    return { ...base, status: 'fetch_failed', error: (artifact.errors || [])[0] || 'fetch failed' };
  }
  if (!previous) return { ...base, status: 'first_seen' };
  if (previous.content_hash !== artifact.content_hash) {
    const prevItems = new Set((previous.facts_json && previous.facts_json.items || [])
      .map((i) => (typeof i === 'string' ? i : i.text || i.key || '')));
    const newItems = (artifact.items || [])
      .map((i) => i.text)
      .filter((text) => text && !prevItems.has(text));
    return { ...base, status: 'changed', new_items: newItems.slice(0, 50) };
  }
  return { ...base, status: 'unchanged' };
}

// ---------------------------------------------------------------------------
// Worker selection from signals (spec 0008 §4.4)
// ---------------------------------------------------------------------------

// Tier 1 vendors rotate on a 7 day cycle: 3 per day, deterministic from the
// epoch day so quiet channels still get covered without a signal.
function vendorRotationKeys(watchlist, now = new Date()) {
  const tier1 = (watchlist.vendors || [])
    .filter((v) => (v.tier ?? 99) === 1)
    .sort((a, b) => a.key.localeCompare(b.key));
  if (tier1.length === 0) return [];
  const day = Math.floor(now.getTime() / 86400000);
  const start = day % tier1.length;
  const keys = [];
  for (let i = 0; i < Math.min(3, tier1.length); i += 1) {
    keys.push(tier1[(start + i) % tier1.length].key);
  }
  return keys;
}

// Selects the vendor deep dive tasks for this run: any vendor with a channel
// that CHANGED this run, plus the deterministic tier 1 rotation. first_seen is
// not a dispatch trigger (no baseline to diff against yet). Bounded by a
// per day cap, ordered by tier then key so the same signals pick the same
// tasks. Returns { key, reason: 'signal' | 'rotation' | 'signal+rotation' }.
const MAX_VENDOR_TASKS_PER_DAY = 8;

function planVendorTasks(signals, watchlist, now = new Date()) {
  const signalKeys = new Set();
  for (const s of signals || []) {
    if (s.status !== 'changed') continue;
    if (s.domain === 'vendor_channel' && typeof s.entity_key === 'string' &&
        s.entity_key.startsWith('vendor:')) {
      const key = s.entity_key.split(':')[1];
      if (key) signalKeys.add(key);
    }
  }
  const rotationKeys = new Set(vendorRotationKeys(watchlist, now));
  const vendors = [...(watchlist.vendors || [])]
    .sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99) || a.key.localeCompare(b.key));
  const tasks = [];
  for (const v of vendors) {
    if (tasks.length >= MAX_VENDOR_TASKS_PER_DAY) break;
    const signal = signalKeys.has(v.key);
    const rotation = rotationKeys.has(v.key);
    if (!signal && !rotation) continue;
    tasks.push({
      key: v.key,
      reason: signal && rotation ? 'signal+rotation'
        : signal ? 'signal' : 'rotation',
      changed_urls: (signals || [])
        .filter((s) => s.status === 'changed' && s.domain === 'vendor_channel'
          && typeof s.entity_key === 'string'
          && s.entity_key.startsWith(`vendor:${v.key}:`))
        .map((s) => s.url),
    });
  }
  return tasks;
}

// The news scan always runs once per run. Its input is the vendor name list,
// the recency windows, and the full signal set (with URLs). The worker decides
// which signals are real news; a quiet day simply produces zero announcements.
function planNewsScanTask(watchlist) {
  return {
    task_id: 'news_scan',
    kind: 'news_scan',
    provider_key: null,
    assigned_model_ids: [],
    vendor_keys: (watchlist.vendors || []).map((v) => v.key),
  };
}

// The community worker always runs once per run (spec 0008: 常時 1 本). It
// receives the changed community feed URLs as a prefilter; an empty prefilter
// means it can complete with zero leads after a light check.
function planCommunityTask(signals) {
  const prefilter = (signals || [])
    .filter((s) => s.domain === 'community' && (s.status === 'changed' || s.status === 'first_seen'))
    .map((s) => ({ entity_key: s.entity_key, url: s.url, status: s.status, new_items: s.new_items || [] }));
  return {
    task_id: 'community',
    kind: 'community',
    provider_key: null,
    assigned_model_ids: [],
    prefilter,
  };
}

module.exports = {
  FIXED_API_CHANNELS,
  buildWatchPlan,
  watchlistPathFor,
  fetchWatchTask,
  normalizeContent,
  runWatchPhase,
  deriveSignal,
  vendorRotationKeys,
  planVendorTasks,
  planNewsScanTask,
  planCommunityTask,
  MAX_VENDOR_TASKS_PER_DAY,
};
