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
// tasks. The cap favors signal-driven dives over the rotation: rotation is
// picked only after signals, so a heavy signal day never queues 8 sessions.
// Cap 2 (operator 2026-08-25): each dive is a ~10 min browser session; the
// rotation stretches across days automatically when signals consume the cap.
// Returns { key, reason: 'signal' | 'rotation' | 'signal+rotation' }.
const MAX_VENDOR_TASKS_PER_DAY = 2;

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
function planCommunityTask(signals, prefilterCandidates = []) {
  const prefilter = (signals || [])
    .filter((s) => s.domain === 'community' && (s.status === 'changed' || s.status === 'first_seen'))
    .map((s) => ({ entity_key: s.entity_key, url: s.url, status: s.status, new_items: s.new_items || [] }));
  const candidates = (prefilterCandidates || []).map((c) => ({
    entity: c.source,
    url: c.url,
    status: 'candidate',
    new_items: [c.title, c.snippet].filter(Boolean),
    title: c.title || null,
    snippet: c.snippet || null,
    created_at: c.created_at || null,
  }));
  return {
    task_id: 'community',
    kind: 'community',
    provider_key: null,
    assigned_model_ids: [],
    prefilter,
    candidates,
  };
}

// ---------------------------------------------------------------------------
// Phase 2 deterministic observation (spec 0008 §4.3-3/4/5, §4.4)
// ---------------------------------------------------------------------------

const OR_ENDPOINTS_BASE = 'https://openrouter.ai/api/v1/models';
const OR_ENDPOINTS_MAX_PER_DAY = 120;
const OR_ENDPOINTS_INTERVAL_MS = 250;
const OR_ENDPOINTS_CACHE_MS = 24 * 60 * 60 * 1000;
const PREFILTER_MAX_CANDIDATES = 40;
const PREFILTER_SLEEP_MS = 250;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Check list for the router endpoints observer: every free model in this
// run's OpenRouter catalog plus every non-removed known OR offer. Both sets
// are deterministically known before any fetch.
function orEndpointChecklist(catalogArtifact, offers = []) {
  const ids = new Set();
  for (const m of (catalogArtifact && catalogArtifact.models) || []) {
    if (m.is_free) ids.add(m.model_id);
  }
  for (const o of offers || []) {
    if (o.provider_key === 'openrouter' && o.status !== 'confirmed_removed') ids.add(o.exact_model_id);
  }
  return [...ids].sort();
}

// Extracts the Gate 3 evidence from one OR /endpoints response: provider
// count, provider names, top provider (highest 1d uptime), uptime, context.
function endpointObservation(modelId, body) {
  // The endpoints API answers { data: { id, endpoints: [...] } }; tolerate a
  // bare { endpoints: [...] } shape too.
  const data = (body && body.data) || body || {};
  const endpoints = data.endpoints || [];
  const providers = [...new Set(endpoints.map((e) => e.provider_name).filter(Boolean))].sort();
  let top = null;
  for (const e of endpoints) {
    const up = typeof e.uptime_last_1d === 'number' ? e.uptime_last_1d : null;
    if (top === null || (up !== null && (top.uptime === null || up > top.uptime))) {
      top = { uptime: up, provider: e.provider_name || null };
    }
  }
  const contexts = endpoints.map((e) => e.context_length).filter((n) => typeof n === 'number' && Number.isFinite(n));
  return {
    model_id: modelId,
    provider_count: endpoints.length,
    providers,
    top_provider: top ? top.provider : null,
    uptime_percent: top && top.uptime !== null ? Math.round(top.uptime * 10) / 10 : null,
    context_length: contexts.length ? Math.max(...contexts) : null,
  };
}

// Deterministic router market observer (D5). Unauthenticated GET per model,
// capped at 120 calls/day with a 250ms interval and a 24h watch_facts cache
// (domain provider_watch, entity or_endpoints:<model>). Observations are
// facts: the lane reducer applies them to offers, never this module.
async function observeOrEndpoints(options = {}) {
  const {
    runId, runDir, baseOpts = {}, fetchImpl, now,
    catalogArtifact = null, offers = [], log = () => {},
  } = options;
  if (!runId || !runDir) throw new Error('observeOrEndpoints requires runId and runDir');
  const stampedNow = now || new Date().toISOString();
  const nowMs = Date.parse(stampedNow);
  const checklist = orEndpointChecklist(catalogArtifact, offers).slice(0, OR_ENDPOINTS_MAX_PER_DAY);
  const cached = new Map(db.latestWatchFacts(baseOpts)
    .filter((f) => f.domain === 'provider_watch' && (f.entity_key || '').startsWith('or_endpoints:'))
    .map((f) => [f.entity_key, f]));

  const reducedDir = path.join(runDir, 'reduced');
  fs.mkdirSync(reducedDir, { recursive: true });
  const observations = [];
  let fetched = 0;
  let fromCache = 0;
  let failed = 0;
  for (const modelId of checklist) {
    const entityKey = `or_endpoints:${modelId}`;
    const url = `${OR_ENDPOINTS_BASE}/${modelId}/endpoints`;
    const prev = cached.get(entityKey);
    if (prev && prev.facts_json && prev.http_status === 200 && prev.fetched_at
        && nowMs - Date.parse(prev.fetched_at) < OR_ENDPOINTS_CACHE_MS) {
      observations.push({ ...prev.facts_json, model_id: modelId, source: 'cache', error: null });
      fromCache += 1;
      continue;
    }
    let obs;
    let httpStatus = null;
    let error = null;
    try {
      const res = await fetchWithRetry(url, fetchImpl);
      httpStatus = res.status;
      if (res.ok && res.status >= 200) {
        obs = endpointObservation(modelId, JSON.parse(res.body));
        fetched += 1;
        db.recordWatchFact({
          domain: 'provider_watch', entity_key: entityKey, url,
          run_id: runId, fetched_at: stampedNow, http_status: httpStatus,
          content_hash: null, facts_json: obs,
        }, baseOpts);
      } else {
        obs = { model_id: modelId, provider_count: null, providers: [], top_provider: null, uptime_percent: null, context_length: null };
        error = `http ${res.status}`;
      }
    } catch (err) {
      obs = { model_id: modelId, provider_count: null, providers: [], top_provider: null, uptime_percent: null, context_length: null };
      error = (err && err.message) || String(err);
    }
    if (error) failed += 1;
    observations.push({ ...obs, source: error ? 'failed' : 'fetched', http_status: httpStatus, error });
    log(`  or_endpoints ${modelId} -> ${obs.provider_count === null ? 'error' : `${obs.provider_count} provider(s)`}`);
    if (fetched > 0 && fetched < OR_ENDPOINTS_MAX_PER_DAY) await sleepMs(OR_ENDPOINTS_INTERVAL_MS);
  }
  const summary = { run_id: runId, models: checklist.length, fetched, cached: fromCache, failed };
  fs.writeFileSync(path.join(reducedDir, 'or-endpoints.json'),
    `${JSON.stringify({ ...summary, observations }, null, 2)}\n`);
  return { observations, summary };
}

// ---------------------------------------------------------------------------
// NIM free endpoint check list (§4.3-4). build.nvidia.com overview pages are
// client rendered (verified 2026-08-19: no Free Endpoint / API calls data in
// the server HTML), so the deterministic side only builds the check list and
// the nim_verify browser worker reads the pages. The list is nvidia offers
// that are not confirmed removed (they entered via the free / ultra-low
// catalog lane) plus any free model in this run's NIM catalog.
// ---------------------------------------------------------------------------

function nvidiaOverviewUrl(exactModelId) {
  // nvidia/nemotron-3-ultra-550b-a55b -> build.nvidia.com/models/nvidia/nemotron-3-ultra-550b-a55b/overview
  // deepseek/deepseek-chat -> build.nvidia.com/models/deepseek/deepseek-chat/overview
  const slash = String(exactModelId || '').indexOf('/');
  if (slash <= 0) return `https://build.nvidia.com/models/${exactModelId}/overview`;
  return `https://build.nvidia.com/models/${exactModelId}/overview`;
}

function planNimVerifyTask(baseOpts = {}, catalogArtifact = null) {
  const ids = new Set();
  try {
    for (const o of db.listNimCandidateOffers(baseOpts)) ids.add(o.exact_model_id);
  } catch { /* table absent in fresh fixtures: catalog only */ }
  for (const m of (catalogArtifact && catalogArtifact.models) || []) {
    if (m.is_free) ids.add(m.model_id);
  }
  const models = [...ids].sort();
  if (models.length === 0) return null;
  return {
    task_id: 'nim_verify',
    kind: 'nim_verify',
    provider_key: 'nvidia',
    assigned_model_ids: models,
    check_urls: models.map(nvidiaOverviewUrl),
  };
}

// ---------------------------------------------------------------------------
// Community prefilter (deterministic, §4.3-5). Fetches the reddit / HN /
// GitHub community surfaces from the watchlist and keeps only items whose
// text names a known model (display name, alias, canonical id), a registry
// provider, or a watchlist keyword. The remaining 10-40 candidates (url +
// title + snippet) are the community worker's input; the LLM extracts leads
// only and does no fetching itself.
// ---------------------------------------------------------------------------

function prefilterTermSet(models = [], providerNames = []) {
  const terms = new Set();
  const add = (v) => {
    const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (s.length >= 3) terms.add(s);
  };
  for (const m of models || []) {
    add(m.display_name);
    add(m.canonical_model_id);
    for (const a of m.aliases_json || []) add(a);
  }
  for (const p of providerNames || []) add(p);
  return terms;
}

// A candidate is kept when it names a known model, alias, or registry
// provider. Keywords alone ("free" in LocalLLaMA) are noise; the name is
// the signal. The snippet carries the keyword context for the worker.
function prefilterMatch(text, terms, keywords = []) {
  const lower = String(text || '').toLowerCase();
  if ([...terms].some((t) => lower.includes(t))) return true;
  return false;
}

async function prefilterCommunity(options = {}) {
  const {
    runId, runDir, baseOpts = {}, fetchImpl, now,
    watchlist, models = [], providerNames = [], log = () => {},
  } = options;
  if (!runId || !runDir) throw new Error('prefilterCommunity requires runId and runDir');
  const list = watchlist || loadWatchlist(watchlistPathFor(baseOpts));
  const stampedNow = now || new Date().toISOString();
  const terms = prefilterTermSet(models, providerNames);
  const entries = list.community || [];
  const keywords = entries.flatMap((e) => e.keywords || []);
  const seen = new Set();
  const candidates = [];
  const push = (candidate) => {
    const url = candidate.url;
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push(candidate);
  };

  for (const entry of entries) {
    if (entry.kind === 'reddit') {
      for (const sub of entry.subreddits || []) {
        const url = `https://www.reddit.com/r/${sub}/new.json?limit=100&t=day`;
        try {
          const res = await fetchWithRetry(url, fetchImpl);
          if (!res.ok) { log(`  prefilter reddit r/${sub}: http ${res.status}`); continue; }
          const parsed = JSON.parse(res.body);
          for (const child of (parsed && parsed.data && parsed.data.children) || []) {
            const d = child && child.data;
            if (!d) continue;
            const text = `${d.title || ''} ${d.selftext || ''}`;
            if (!prefilterMatch(text, terms, keywords)) continue;
            push({
              source: `reddit:${sub}`, kind: 'reddit',
              url: d.permalink ? `https://www.reddit.com${d.permalink}` : null,
              title: d.title || null,
              snippet: String(d.selftext || d.title || '').slice(0, 300),
              created_at: d.created_utc ? new Date(d.created_utc * 1000).toISOString() : null,
            });
          }
        } catch { /* best effort: one board down is not a run failure */ }
        await sleepMs(PREFILTER_SLEEP_MS);
      }
    } else if (entry.kind === 'hn') {
      const since = Math.floor((Date.parse(stampedNow) - 72 * 3600 * 1000) / 1000);
      for (const q of entry.queries || []) {
        const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}`
          + `&tags=story&numericFilters=created_at_i%3E${since}`;
        try {
          const res = await fetchWithRetry(url, fetchImpl);
          if (!res.ok) { log(`  prefilter hn ${q}: http ${res.status}`); continue; }
          const parsed = JSON.parse(res.body);
          for (const hit of (parsed && parsed.hits) || []) {
            const text = `${hit.title || ''} ${hit.story_text || ''} ${hit.url || ''}`;
            if (!prefilterMatch(text, terms, keywords)) continue;
            push({
              source: `hn:${q}`, kind: 'hn',
              url: hit.url || (hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : null),
              title: hit.title || null,
              snippet: String(hit.story_text || hit.title || '').slice(0, 300),
              created_at: hit.created_at || null,
            });
          }
        } catch { /* best effort */ }
        await sleepMs(PREFILTER_SLEEP_MS);
      }
    } else if (entry.kind === 'github') {
      for (const repo of entry.repos || []) {
        const url = `https://api.github.com/repos/${repo}/releases?per_page=10`;
        try {
          const res = await fetchWithRetry(url, fetchImpl);
          if (!res.ok) { log(`  prefilter github ${repo}: http ${res.status}`); continue; }
          const parsed = JSON.parse(res.body);
          for (const rel of Array.isArray(parsed) ? parsed : []) {
            const text = `${rel.name || ''} ${rel.body || ''}`;
            if (!prefilterMatch(text, terms, keywords)) continue;
            push({
              source: `github:${repo}`, kind: 'github',
              url: rel.html_url || null,
              title: rel.name || rel.tag_name || null,
              snippet: String(rel.body || rel.name || '').slice(0, 300),
              created_at: rel.published_at || null,
            });
          }
        } catch { /* best effort */ }
        await sleepMs(PREFILTER_SLEEP_MS);
      }
    }
  }

  const artifact = {
    schema_version: 1,
    task_id: 'community_prefilter',
    generated_at: stampedNow,
    terms: [...terms],
    candidates: candidates.slice(0, PREFILTER_MAX_CANDIDATES),
  };
  const artifactPath = path.join(runDir, 'artifacts', 'community-prefilter.json');
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  log(`  prefilter community: ${artifact.candidates.length} candidate(s)`);
  return artifact.candidates;
}

// ---------------------------------------------------------------------------
// Provider monitor planning (§4.4): the LLM-side providers (watchlist
// provider_monitors with watch URLs) are batched into up to 5 sessions of
// 4-6 providers each (PROVIDER_MONITOR_BATCH, default 5). They always run.
// A watch signal (hash change) on one of their channels is passed so the
// worker knows which page changed; a discount_signal from the catalog lane
// is passed for the provider it names. Sessions run in parallel under
// GLOBAL_CONCURRENCY, so covering all 25 providers in 5 sessions costs the
// same wall time as 4 and drops no provider.
// ---------------------------------------------------------------------------

const PROVIDER_MONITOR_MAX_SESSIONS = 2;

function planProviderMonitorTasks(watchlist, signals, discountSignals = {}, opts = {}) {
  const batch = Math.max(1, Math.min(25, opts.batch || Number(process.env.PROVIDER_MONITOR_BATCH) || 13));
  const monitors = (watchlist.provider_monitors || []).filter((m) => m && m.watch && Object.keys(m.watch).length > 0);
  // Providers the aggregated-index lane verified this run with a fresh,
  // verified free-model baseline. Their LLM sessions can run at a spot check
  // visit budget (verify only changed signals) instead of a full sweep.
  const indexedVerified = opts.indexed_providers instanceof Set ? opts.indexed_providers : new Set();
  const tasks = [];
  for (let i = 0; i < monitors.length; i += batch) {
    if (tasks.length >= PROVIDER_MONITOR_MAX_SESSIONS) break;
    const slice = monitors.slice(i, i + batch);
    const providerKeys = slice.map((m) => m.provider_key);
    const watchUrls = slice.flatMap((m) => Object.entries(m.watch).map(([channel, url]) => ({
      provider_key: m.provider_key, channel, url,
    })));
    const changedUrls = (signals || [])
      .filter((s) => s.domain === 'provider_watch'
        && typeof s.entity_key === 'string' && s.entity_key.startsWith('monitor:')
        && providerKeys.includes(s.entity_key.split(':')[1]))
      .filter((s) => s.status === 'changed')
      .map((s) => s.url);
    const discounts = providerKeys
      .map((k) => discountSignals[k])
      .flat()
      .filter(Boolean);
    // When the deterministic index today verified every provider in this
    // session and nothing changed (no changed watch URLs, no discount
    // signal), the LLM session adds verification the index already did.
    // It becomes a cheap spot check: 3 visits, not 12.
    const allIndexed = providerKeys.every((k) => indexedVerified.has(k));
    const nothingToCheck = changedUrls.length === 0 && discounts.length === 0;
    const spotCheck = allIndexed && nothingToCheck;
    tasks.push({
      task_id: `provider_monitor:${tasks.length + 1}`,
      kind: 'provider_monitor',
      provider_key: providerKeys.length === 1 ? providerKeys[0] : null,
      assigned_model_ids: [],
      provider_keys: providerKeys,
      watch_urls: watchUrls,
      changed_urls: changedUrls,
      discount_signals: discounts,
      visit_budget: spotCheck ? 3 : 12,
      spot_check: spotCheck,
    });
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Product / program monitor planning (spec 0008 Phase 3): a coding-product or
// credit-program channel whose content hash changed this run triggers ONE
// bundled LLM session per domain (all changed entries in one task, 0 search /
// 8 visits). No hash change means no task at all.
// ---------------------------------------------------------------------------

function planProductProgramTasks(signals, watchlist) {
  const tasks = [];
  const productSignals = (signals || [])
    .filter((s) => s.domain === 'product' && s.status === 'changed');
  const programSignals = (signals || [])
    .filter((s) => s.domain === 'program' && s.status === 'changed');
  const products = (watchlist.coding_products || []).filter((p) => p && p.key);
  const programs = (watchlist.credit_programs || []).filter((p) => p && p.key);

  // Chunk the changed entries so the LLM sessions run in parallel instead of
  // one long sequential session (a signal-heavy day can change 8+ entries).
  // Each chunk keeps its own visit budget, so a chunk of 3 entries costs no
  // more wall time than a single entry. Task IDs carry a :N suffix; the
  // observe stage merges every chunk of the same kind.
  const PRODUCT_CHUNK = 8;
  const PROGRAM_CHUNK = 8;

  const buildProductEntries = () => productSignals.map((s) => {
    const key = (s.entity_key || '').split(':')[1] || null;
    const product = products.find((p) => p.key === key) || {};
    return {
      key,
      label: product.label || key,
      url: s.url,
      channel: s.channel || ((s.entity_key || '').split(':').pop() || null),
      watchlist_urls: {
        pricing_url: product.pricing_url || null,
        changelog_url: product.changelog_url || null,
      },
      new_items: (s.new_items || []).slice(0, 10),
    };
  }).filter((e) => e.key);
  const buildProgramEntries = () => programSignals.map((s) => {
    const key = (s.entity_key || '').split(':')[1] || null;
    const program = programs.find((p) => p.key === key) || {};
    return {
      key,
      label: program.label || key,
      url: s.url,
      channel: s.channel || ((s.entity_key || '').split(':').pop() || null),
      watchlist_urls: { url: program.url || null },
      new_items: (s.new_items || []).slice(0, 10),
    };
  }).filter((e) => e.key);

  const productEntries = buildProductEntries();
  for (let i = 0; i < productEntries.length; i += PRODUCT_CHUNK) {
    const chunk = productEntries.slice(i, i + PRODUCT_CHUNK);
    tasks.push({
      task_id: `product_monitor:${Math.floor(i / PRODUCT_CHUNK) + 1}`,
      kind: 'product_monitor',
      provider_key: null,
      assigned_model_ids: [],
      domain: 'product',
      entries: chunk,
      search_budget: 0,
      visit_budget: 8,
    });
  }
  const programEntries = buildProgramEntries();
  for (let i = 0; i < programEntries.length; i += PROGRAM_CHUNK) {
    const chunk = programEntries.slice(i, i + PROGRAM_CHUNK);
    tasks.push({
      task_id: `program_monitor:${Math.floor(i / PROGRAM_CHUNK) + 1}`,
      kind: 'program_monitor',
      provider_key: null,
      assigned_model_ids: [],
      domain: 'program',
      entries: chunk,
      search_budget: 0,
      visit_budget: 8,
    });
  }
  return tasks;
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
  // spec 0008 Phase 2 observation
  OR_ENDPOINTS_BASE,
  OR_ENDPOINTS_MAX_PER_DAY,
  orEndpointChecklist,
  endpointObservation,
  observeOrEndpoints,
  nvidiaOverviewUrl,
  planNimVerifyTask,
  PREFILTER_MAX_CANDIDATES,
  prefilterTermSet,
  prefilterMatch,
  prefilterCommunity,
  PROVIDER_MONITOR_MAX_SESSIONS,
  planProviderMonitorTasks,
  // spec 0008 Phase 3 product / program monitors
  planProductProgramTasks,
};
