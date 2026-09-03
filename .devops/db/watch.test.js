'use strict';

// Spec 0008 Phase 1 tests: the deterministic research watch. Proves the plan
// builder, the fetch/record/triage loop with an injected fetch, the vendor
// dispatch policy (changed only, rotation for tier 1, a quiet day costs zero
// vendor sessions), and the news scan / community planning. No network: every
// fetch is stubbed. State lives in a fresh temp directory per test.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const db = require('./collector-db');
const watch = require('./watch');
const { validateWatchlist } = require('../../build/research-watchlist');

const WATCHLIST = {
  version: 1,
  windows: { hot_days: 1, warm_days: 3, catchup_days: 30 },
  frontier_vendors: ['openai', 'zai'],
  vendors: [
    {
      key: 'openai', label: 'OpenAI', tier: 1,
      channels: {
        blog: 'https://openai.com/blog',
        changelog: 'https://openai.com/changelog',
        hf_org: null,
        github_orgs: [],
      },
    },
    {
      key: 'zai', label: 'Z.ai', tier: 2,
      channels: { changelog: 'https://z.ai/changelog' },
    },
    {
      key: 'mistral', label: 'Mistral', tier: 3,
      channels: { blog: 'https://mistral.ai/news' },
    },
  ],
  provider_monitors: [
    { provider_key: 'openrouter', watch: { new_models: 'https://openrouter.ai/models' } },
    { provider_key: 'groq', watch: { pricing: 'https://groq.com/pricing' } },
  ],
  community: [
    {
      kind: 'reddit',
      subreddits: ['LocalLLaMA', 'OpenRouter'],
      keywords: ['free', '$0', 'discount'],
    },
  ],
  coding_products: [],
  credit_programs: [],
};

let root;
let stateDir;
let options;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-test-'));
  stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  options = { projectRoot: root, stateDir };
  db.applyMigrations(options);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function makeFetch(bodies) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const entry = bodies[url];
    if (entry === undefined) {
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    const body = typeof entry === 'string' ? entry : entry.body;
    const status = typeof entry === 'object' && entry.status ? entry.status : 200;
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { fetchImpl, calls };
}

function startWatchRun(runId) {
  const plan = watch.buildWatchPlan(WATCHLIST);
  const runDir = path.join(root, 'runs', runId);
  fs.mkdirSync(runDir, { recursive: true });
  db.startRun(runId, [], options);
  db.addRunTasks(runId, plan, options);
  return { plan, runDir };
}

function allBodies(overrides = {}) {
  return {
    'https://openai.com/blog': 'openai blog v1',
    'https://openai.com/changelog': 'openai changelog v1',
    'https://z.ai/changelog': 'zai changelog v1',
    'https://mistral.ai/news': 'mistral news v1',
    'https://openrouter.ai/models': JSON.stringify({ data: [{ id: 'acme/fresh' }] }),
    'https://groq.com/pricing': 'groq pricing v1',
    'https://www.reddit.com/r/LocalLLaMA/new.json?limit=50': JSON.stringify({ data: { children: [{ data: { id: 'r1', title: 'free tier rumor' } }] } }),
    'https://www.reddit.com/r/OpenRouter/new.json?limit=50': JSON.stringify({ data: { children: [] } }),
    'https://huggingface.co/api/models?sort=createdAt&direction=-1&limit=200': JSON.stringify({
      data: [{ id: 'org/new-model' }],
    }),
    ...overrides,
  };
}

describe('watchlist fixture', () => {
  it('is a valid operator watchlist', () => {
    assert.equal(validateWatchlist(WATCHLIST).ok, true, JSON.stringify(validateWatchlist(WATCHLIST).errors));
  });
});

describe('buildWatchPlan', () => {
  it('emits stable ids per channel plus the fixed HF new-models feed', () => {
    const plan = watch.buildWatchPlan(WATCHLIST);
    const ids = plan.map((t) => t.task_id);
    assert.ok(ids.includes('watch:vendor:openai:blog'));
    assert.ok(ids.includes('watch:vendor:zai:changelog'));
    assert.ok(ids.includes('watch:monitor:openrouter:new_models'));
    assert.ok(ids.includes('watch:community:reddit-LocalLLaMA'));
    assert.ok(ids.includes('watch:api:hf-new-models'));
    // deterministic order for the same watchlist
    const again = watch.buildWatchPlan(WATCHLIST);
    assert.deepEqual(again.map((t) => t.task_id), ids);
    const monitor = plan.find((t) => t.task_id === 'watch:monitor:openrouter:new_models');
    assert.equal(monitor.provider_key, 'openrouter');
    assert.equal(monitor.domain, 'provider_watch');
    const api = plan.find((t) => t.task_id === 'watch:api:hf-new-models');
    assert.equal(api.channel, 'hf_new_models');
  });

  it('skips null channel values (unfetchable) instead of inventing urls', () => {
    const wl = {
      ...WATCHLIST,
      frontier_vendors: ['acme'],
      vendors: [{
        key: 'acme', label: 'Acme', tier: 3,
        channels: { blog: 'https://acme.example/blog', changelog: null },
      }],
    };
    const plan = watch.buildWatchPlan(wl);
    const ids = plan.map((t) => t.task_id);
    assert.ok(ids.includes('watch:vendor:acme:blog'));
    assert.ok(!ids.some((id) => id === 'watch:vendor:acme:changelog'));
  });

  it('keeps the slash in github repo urls (owner%2Fname 404s on the API)', () => {
    const wl = {
      ...WATCHLIST,
      community: [{ kind: 'github', repos: ['anthropics/claude-code'], orgs: ['OpenRouterTeam'] }],
    };
    const plan = watch.buildWatchPlan(wl);
    const repo = plan.find((t) => t.entity_key === 'community:github:repo:anthropics/claude-code');
    const org = plan.find((t) => t.entity_key === 'community:github:org:OpenRouterTeam');
    assert.equal(repo.url, 'https://api.github.com/repos/anthropics/claude-code/releases?per_page=10');
    assert.equal(org.url, 'https://api.github.com/orgs/OpenRouterTeam/repos?sort=pushed&per_page=10');
  });
});

describe('runWatchPhase', () => {
  it('first run: every channel is first_seen and facts are recorded', async () => {
    const { plan, runDir } = startWatchRun('run1');
    const { fetchImpl } = makeFetch(allBodies());
    const result = await watch.runWatchPhase({
      runId: 'run1', runDir, baseOpts: options, watchlist: WATCHLIST, fetchImpl,
    });
    assert.equal(result.summary.channels, plan.length);
    assert.equal(result.summary.ok, plan.length);
    assert.equal(result.summary.fetch_failed, 0);
    for (const s of result.signals) assert.equal(s.status, 'first_seen');
    const facts = db.latestWatchFacts(options);
    assert.equal(facts.length, plan.length);
    assert.ok(fs.existsSync(path.join(runDir, 'reduced', 'watch-signals.json')));
  });

  it('second run: changed content with new items is a changed signal; unchanged stays unchanged', async () => {
    const { runDir: dir1 } = startWatchRun('run1');
    await watch.runWatchPhase({
      runId: 'run1', runDir: dir1, baseOpts: options, watchlist: WATCHLIST,
      fetchImpl: makeFetch(allBodies()).fetchImpl,
    });
    const { runDir } = startWatchRun('run2');
    const bodies = allBodies({
      'https://openrouter.ai/models': JSON.stringify({
        data: [{ id: 'acme/fresh' }, { id: 'acme/fresher', created: new Date().toISOString() }],
      }),
      'https://openai.com/blog': 'openai blog v1', // unchanged
    });
    const result2 = await watch.runWatchPhase({
      runId: 'run2', runDir, baseOpts: options, watchlist: WATCHLIST, fetchImpl: makeFetch(bodies).fetchImpl,
    });
    const byEntity = new Map(result2.signals.map((s) => [s.entity_key, s]));
    const monitor = byEntity.get('monitor:openrouter:new_models');
    assert.equal(monitor.status, 'changed');
    assert.ok(monitor.new_items.some((i) => i.includes('acme/fresher')));
    assert.ok(!monitor.new_items.some((i) => i.includes('acme/fresh ')));
    assert.equal(byEntity.get('vendor:openai:blog').status, 'unchanged');
  });

  it('fetch failures are signals, never run failures', async () => {
    const { plan, runDir } = startWatchRun('run1');
    const result = await watch.runWatchPhase({
      runId: 'run1', runDir, baseOpts: options, watchlist: WATCHLIST,
      fetchImpl: async () => { throw new Error('network down'); },
    });
    assert.equal(result.summary.ok, 0);
    assert.equal(result.summary.fetch_failed, plan.length);
    for (const s of result.signals) assert.equal(s.status, 'fetch_failed');
  });

  it('http error responses are fetch failures too, not quiet healthy channels', async () => {
    // 2026-09-03: docs.anthropic.com/models and every reddit feed return 403/404
    // with an HTML error body. Hashing that body used to make a dead channel look
    // "unchanged" forever, so the watch lane reported 158/158 ok while silently
    // seeing nothing.
    const { runDir } = startWatchRun('run1');
    await watch.runWatchPhase({
      runId: 'run1', runDir, baseOpts: options, watchlist: WATCHLIST,
      fetchImpl: makeFetch(allBodies()).fetchImpl,
    });

    const { runDir: dir2 } = startWatchRun('run2');
    const blocked = allBodies({
      'https://z.ai/changelog': { status: 404, body: '<html>Documentation | Claude</html>' },
      'https://www.reddit.com/r/LocalLLaMA/new.json?limit=50': { status: 403, body: 'blocked by network security' },
    });
    const result = await watch.runWatchPhase({
      runId: 'run2', runDir: dir2, baseOpts: options, watchlist: WATCHLIST, fetchImpl: makeFetch(blocked).fetchImpl,
    });

    const byEntity = new Map(result.signals.map((s) => [s.entity_key, s]));
    assert.equal(byEntity.get('vendor:zai:changelog').status, 'fetch_failed');
    assert.equal(byEntity.get('vendor:zai:changelog').http_status, 404);
    assert.equal(byEntity.get('community:reddit:LocalLLaMA').status, 'fetch_failed');
    assert.equal(byEntity.get('vendor:openai:blog').status, 'unchanged', 'healthy channels are unaffected');
    assert.equal(result.summary.fetch_failed, 2);
    assert.deepEqual(result.summary.failing.map((f) => f.entity_key).sort(),
      ['community:reddit:LocalLLaMA', 'vendor:zai:changelog']);
    assert.equal(result.summary.failed, 2);
    // the error page is never recorded as channel content
    const facts = db.latestWatchFacts(options);
    const zai = facts.find((f) => f.entity_key === 'vendor:zai:changelog');
    assert.equal(zai.run_id, 'run1', 'the last good body stays current');
    assert.ok(!JSON.stringify(zai.facts_json).includes('Claude'));

    // and once the channel recovers, the diff is against the last good body
    const { runDir: dir3 } = startWatchRun('run3');
    const recovered = await watch.runWatchPhase({
      runId: 'run3', runDir: dir3, baseOpts: options, watchlist: WATCHLIST,
      fetchImpl: makeFetch(allBodies({ 'https://z.ai/changelog': 'zai changelog v2' })).fetchImpl,
    });
    const third = new Map(recovered.signals.map((s) => [s.entity_key, s]));
    assert.equal(third.get('vendor:zai:changelog').status, 'changed');
  });
});

describe('provider monitor planning (spec 0008 Phase 2)', () => {
  it('bundles providers into a single session with a full 12-visit budget by default', () => {
    const monitors = [
      { provider_key: 'a', watch: { m: 'https://a.com/models' } },
      { provider_key: 'b', watch: { p: 'https://b.com/pricing' } },
      { provider_key: 'c', watch: { m: 'https://c.com/models' } },
      { provider_key: 'd', watch: { p: 'https://d.com/pricing' } },
      { provider_key: 'e', watch: { m: 'https://e.com/models' } },
      { provider_key: 'f', watch: { p: 'https://f.com/pricing' } },
    ];
    const wl = { ...WATCHLIST, provider_monitors: monitors };
    const tasks = watch.planProviderMonitorTasks(wl, [], {});
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].provider_keys.slice(0, 6).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
    assert.equal(tasks[0].visit_budget, 12);
    assert.equal(tasks[0].spot_check, false);
  });

  it('indexed providers with no signal become cheap spot-checks (3 visits)', () => {
    const monitors = WATCHLIST.provider_monitors; // openrouter, groq
    const tasks = watch.planProviderMonitorTasks(WATCHLIST, [], {}, {
      indexed_providers: new Set(['openrouter', 'groq']),
    });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].visit_budget, 3);
    assert.equal(tasks[0].spot_check, true);
  });

  it('a changed signal forces a full-sweep visit budget even when indexed', () => {
    const signals = [{
      domain: 'provider_watch',
      entity_key: 'monitor:openrouter:new_models',
      url: 'https://openrouter.ai/models',
      status: 'changed',
      new_items: ['acme/glm-5.2'],
    }];
    const tasks = watch.planProviderMonitorTasks(WATCHLIST, signals, {}, {
      indexed_providers: new Set(['openrouter', 'groq']),
    });
    assert.equal(tasks[0].changed_urls.length, 1);
    assert.equal(tasks[0].visit_budget, 12);
    assert.equal(tasks[0].spot_check, false);
  });
});

describe('vendor dispatch policy', () => {
  it('quiet day: no signals, only the tier 1 rotation runs', () => {
    const tasks = watch.planVendorTasks([], WATCHLIST, new Date('2026-08-05T00:00:00Z'));
    const keys = tasks.map((t) => t.key);
    // openai is the only tier 1 vendor in the fixture
    assert.deepEqual(keys, ['openai']);
    assert.equal(tasks[0].reason, 'rotation');
    assert.deepEqual(tasks[0].changed_urls, []);
  });

  it('first_seen is not a dispatch trigger (no baseline to diff against yet)', () => {
    const signals = [
      { entity_key: 'vendor:zai:changelog', domain: 'vendor_channel', url: 'https://z.ai/changelog', status: 'first_seen' },
    ];
    const tasks = watch.planVendorTasks(signals, WATCHLIST, new Date('2026-08-05T00:00:00Z'));
    assert.deepEqual(tasks.map((t) => t.key), ['openai']);
  });

  it('a changed vendor channel dispatches that vendor; signal and rotation merge without duplicates', () => {
    const signals = [
      { entity_key: 'vendor:zai:changelog', domain: 'vendor_channel', url: 'https://z.ai/changelog', status: 'changed' },
      { entity_key: 'vendor:openai:blog', domain: 'vendor_channel', url: 'https://openai.com/blog', status: 'changed' },
    ];
    const tasks = watch.planVendorTasks(signals, WATCHLIST, new Date('2026-08-05T00:00:00Z'));
    const byKey = new Map(tasks.map((t) => [t.key, t]));
    assert.equal(byKey.get('zai').reason, 'signal');
    assert.deepEqual(byKey.get('zai').changed_urls, ['https://z.ai/changelog']);
    assert.ok(['signal', 'signal+rotation'].includes(byKey.get('openai').reason));
    assert.equal(tasks.filter((t) => t.key === 'openai').length, 1);
  });

  it('respects the per day vendor task cap', () => {
    const wl = {
      ...WATCHLIST,
      frontier_vendors: [],
      vendors: Array.from({ length: 10 }, (_, i) => ({
        key: `v${i}`, label: `V${i}`, tier: 1,
        channels: { blog: `https://v${i}.example/blog` },
      })),
    };
    const signals = wl.vendors.map((v) => ({
      entity_key: `vendor:${v.key}:blog`,
      domain: 'vendor_channel',
      url: `https://${v.key}.example/blog`,
      status: 'changed',
    }));
    const tasks = watch.planVendorTasks(signals, wl, new Date('2026-08-05T00:00:00Z'));
    assert.equal(tasks.length, watch.MAX_VENDOR_TASKS_PER_DAY);
  });
});

describe('news scan and community planning', () => {
  it('news scan always runs once with the vendor list', () => {
    const task = watch.planNewsScanTask(WATCHLIST);
    assert.equal(task.kind, 'news_scan');
    assert.equal(task.task_id, 'news_scan');
    assert.deepEqual(task.vendor_keys, ['openai', 'zai', 'mistral']);
  });

  it('community always runs once; the prefilter carries only changed community signals', () => {
    const task = watch.planCommunityTask([
      { entity_key: 'community:reddit:LocalLLaMA', domain: 'community', url: 'u1', status: 'unchanged' },
      { entity_key: 'community:reddit:OpenRouter', domain: 'community', url: 'u2', status: 'changed', new_items: ['a', 'b'] },
      { entity_key: 'vendor:zai:changelog', domain: 'vendor_channel', url: 'u3', status: 'changed' },
    ]);
    assert.equal(task.kind, 'community');
    assert.equal(task.task_id, 'community');
    assert.equal(task.prefilter.length, 1);
    assert.equal(task.prefilter[0].entity_key, 'community:reddit:OpenRouter');
    const empty = watch.planCommunityTask([]);
    assert.deepEqual(empty.prefilter, []);
  });
});

describe('product / program monitor planning (spec 0008 Phase 3)', () => {
  const WL = {
    ...WATCHLIST,
    coding_products: [
      { key: 'claude_code', label: 'Claude Code', pricing_url: 'https://www.anthropic.com/pricing', changelog_url: 'https://docs.anthropic.com/en/release-notes' },
      { key: 'codex', label: 'Codex', pricing_url: 'https://openai.com/codex/pricing', changelog_url: 'https://github.com/openai/codex/releases' },
    ],
    credit_programs: [
      { key: 'google_for_startups', label: 'Google for Startups Cloud', url: 'https://cloud.google.com/startup' },
    ],
  };

  it('no hash change means zero product or program LLM tasks (AC)', () => {
    const signals = [
      { entity_key: 'product:claude_code:pricing', domain: 'product', url: 'https://www.anthropic.com/pricing', status: 'unchanged' },
      { entity_key: 'product:codex:changelog', domain: 'product', url: 'https://github.com/openai/codex/releases', status: 'first_seen' },
      { entity_key: 'program:google_for_startups', domain: 'program', url: 'https://cloud.google.com/startup', status: 'unchanged' },
      { entity_key: 'vendor:openai:blog', domain: 'vendor_channel', url: 'https://openai.com/blog', status: 'changed' },
    ];
    assert.deepEqual(watch.planProductProgramTasks(signals, WL), []);
  });

  it('all changed product channels bundle into one product_monitor chunk (≤3 entries)', () => {
    const signals = [
      { entity_key: 'product:claude_code:pricing', domain: 'product', url: 'https://www.anthropic.com/pricing', status: 'changed', new_items: ['Free plan now includes 50 messages', 'x'] },
      { entity_key: 'product:codex:changelog', domain: 'product', url: 'https://github.com/openai/codex/releases', status: 'changed', new_items: ['v0.49.0'] },
      { entity_key: 'product:claude_code:changelog', domain: 'product', url: 'https://docs.anthropic.com/en/release-notes', status: 'changed' },
    ];
    const tasks = watch.planProductProgramTasks(signals, WL);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].kind, 'product_monitor');
    assert.equal(tasks[0].task_id, 'product_monitor:1');
    assert.equal(tasks[0].search_budget, 0);
    assert.equal(tasks[0].visit_budget, 8);
    assert.deepEqual(tasks[0].entries.map((e) => e.key), ['claude_code', 'codex', 'claude_code']);
    const cc = tasks[0].entries[0];
    assert.equal(cc.label, 'Claude Code');
    assert.equal(cc.channel, 'pricing');
    assert.equal(cc.watchlist_urls.changelog_url, 'https://docs.anthropic.com/en/release-notes');
    assert.deepEqual(cc.new_items, ['Free plan now includes 50 messages', 'x']);
  });

  it('a changed program channel yields a program_monitor chunk with the watchlist entry', () => {
    const signals = [
      { entity_key: 'program:google_for_startups', domain: 'program', url: 'https://cloud.google.com/startup', status: 'changed', new_items: ['$300 -> $500'] },
    ];
    const tasks = watch.planProductProgramTasks(signals, WL);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].kind, 'program_monitor');
    assert.equal(tasks[0].task_id, 'program_monitor:1');
    assert.equal(tasks[0].entries[0].key, 'google_for_startups');
    assert.equal(tasks[0].entries[0].label, 'Google for Startups Cloud');
    assert.equal(tasks[0].entries[0].watchlist_urls.url, 'https://cloud.google.com/startup');
  });

  it('more than 8 changed entries chunk into parallel sessions of the same kind', () => {
    const signals = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((k, i) => ({
      entity_key: `product:${k}:pricing`, domain: 'product',
      url: `https://pricing.example/${k}`, status: 'changed', new_items: [`item ${i}`],
    }));
    const tasks = watch.planProductProgramTasks(signals, WL);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].task_id, 'product_monitor:1');
    assert.equal(tasks[1].task_id, 'product_monitor:2');
    assert.ok(tasks.every((t) => t.kind === 'product_monitor' && t.entries.length <= 8));
    assert.deepEqual([...tasks[0].entries, ...tasks[1].entries].map((e) => e.key), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  });

  it('fetch_failed product channels are not a dispatch trigger', () => {
    const signals = [
      { entity_key: 'product:claude_code:pricing', domain: 'product', url: 'https://www.anthropic.com/pricing', status: 'fetch_failed' },
    ];
    assert.deepEqual(watch.planProductProgramTasks(signals, WL), []);
  });
});
