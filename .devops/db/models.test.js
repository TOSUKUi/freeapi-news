'use strict';

// Spec 0008 Phase 1 tests: the deterministic model lane. Proves new model
// detection (dated in window becomes a candidate, undated stays baseline,
// existing models and non-watchlist HF orgs are skipped, the 3 per day cap),
// fan out task planning with catalog verdicts, source tier assignment, and
// applyModelFacts (fetch-verified announcements and distribution verdicts
// reach the models table, unverifiable items never do, leads dedupe and
// expire). No network: every fetch is stubbed. Fresh temp state per test.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const db = require('./collector-db');
const models = require('./models');
const assemble = require('./assemble');

const NOW = '2026-08-05T12:00:00.000Z';

const WATCHLIST = {
  version: 1,
  windows: { hot_days: 1, warm_days: 3, catchup_days: 30 },
  frontier_vendors: ['zai'],
  vendors: [
    { key: 'zai', label: 'Z.ai', tier: 1, channels: { hf_org: 'zai-org', blog: 'https://z.ai/blog' } },
  ],
  provider_monitors: [
    { provider_key: 'openrouter', watch: { new_models: 'https://openrouter.ai/models' } },
    { provider_key: 'groq', watch: { pricing: 'https://groq.com/pricing' } },
    { provider_key: 'fireworks', watch: { pricing: 'https://fireworks.ai/pricing' } },
  ],
  community: [],
  coding_products: [],
  credit_programs: [],
};

let root;
let stateDir;
let options;
let runDir;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'models-test-'));
  stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  options = { projectRoot: root, stateDir };
  db.applyMigrations(options);
  runDir = path.join(root, 'runs', 'runM');
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'reduced'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function textFetch(bodies) {
  const fetchImpl = async (url) => {
    const body = bodies[url];
    if (body === undefined) return { ok: false, status: 404, text: async () => 'nope' };
    return { ok: true, status: 200, text: async () => body };
  };
  return fetchImpl;
}

function writeCatalogArtifact(providerKey, modelRows) {
  const artifact = {
    schema_version: 1,
    task_id: `catalog:${providerKey}`,
    kind: 'catalog',
    provider_key: providerKey,
    status: 'complete',
    models: modelRows,
  };
  fs.writeFileSync(path.join(runDir, 'artifacts', `catalog-${providerKey}.json`),
    `${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

function writeHfFeed(items) {
  fs.writeFileSync(path.join(runDir, 'reduced', 'watch-signals.json'), JSON.stringify({
    run_id: 'runM', signals: [{ entity_key: 'api:hf-new-models', status: 'first_seen', new_items: [] }],
  }));
  fs.writeFileSync(
    path.join(runDir, 'artifacts', 'watch-api-hf-new-models.json'),
    JSON.stringify({ schema_version: 1, task_id: 'watch:api:hf-new-models', kind: 'watch', status: 'complete', items })
  );
}

describe('sourceTierFromUrl', () => {
  it('assigns deterministic tiers from url patterns (1 strongest, 11 weakest)', () => {
    assert.equal(models.sourceTierFromUrl('https://www.reddit.com/r/LocalLLaMA/comments/1/abc/'), 9);
    assert.equal(models.sourceTierFromUrl('https://news.ycombinator.com/item?id=1'), 9);
    assert.equal(models.sourceTierFromUrl('https://github.com/zai-org/zai/releases/tag/v1'), 5);
    assert.equal(models.sourceTierFromUrl('https://github.com/zai-org/zai'), 7);
    assert.equal(models.sourceTierFromUrl('https://huggingface.co/zai-org/zai-x'), 7);
    assert.equal(models.sourceTierFromUrl('https://groq.com/pricing'), 2);
    assert.equal(models.sourceTierFromUrl('https://openai.com/api/pricing/'), 2);
    assert.equal(models.sourceTierFromUrl('https://developers.openai.com/api/docs/changelog'), 5);
    assert.equal(models.sourceTierFromUrl('https://z.ai/blog'), 6);
    assert.equal(models.sourceTierFromUrl('https://blog.google/technology/ai/'), 6);
    assert.equal(models.sourceTierFromUrl('https://ai.google.dev/gemini-api/docs/models'), 3);
    assert.equal(models.sourceTierFromUrl('https://openrouter.ai/models'), 8);
    assert.equal(models.sourceTierFromUrl('https://example.com/'), 11);
    assert.equal(models.sourceTierFromUrl(null), 11);
  });
});

describe('detectNewModels', () => {
  it('dated in-window catalog newcomers become candidates; undated and old stay baseline', () => {
    writeCatalogArtifact('openrouter', [
      { model_id: 'acme/fresh', model_name: 'Acme Fresh', created: '2026-08-03T00:00:00Z' },
      { model_id: 'acme/undated', model_name: 'Acme Undated' },
      { model_id: 'acme/old', model_name: 'Acme Old', created: '2026-06-01T00:00:00Z' },
      { model_id: 'acme/known', model_name: 'Acme Known', created: '2026-08-03T00:00:00Z' },
    ]);
    db.upsertModel('acme/known', { display_name: 'Acme Known' }, options);
    const { candidates, baselines } = models.detectNewModels({
      runDir, baseOpts: options, now: NOW, windowDays: 7, watchlist: WATCHLIST,
    });
    assert.deepEqual(candidates.map((c) => c.model_id), ['acme/fresh']);
    assert.deepEqual(baselines.map((b) => b.model_id).sort(), ['acme/old', 'acme/undated']);
  });

  it('HF feed newcomers count only for watchlist orgs and must be dated in window', () => {
    writeCatalogArtifact('openrouter', [{ model_id: 'acme/fresh', created: '2026-08-03T00:00:00Z' }]);
    writeHfFeed([
      { key: 'zai-org/zai-x', text: 'zai-org/zai-x created=2026-08-04T00:00:00.000Z' },
      { key: 'zai-org/zai-undated', text: 'zai-org/zai-undated' },
      { key: 'stranger-org/foo', text: 'stranger-org/foo created=2026-08-04T00:00:00.000Z' },
    ]);
    const { candidates, baselines } = models.detectNewModels({
      runDir, baseOpts: options, now: NOW, windowDays: 7, watchlist: WATCHLIST,
    });
    const ids = candidates.map((c) => c.model_id);
    assert.ok(ids.includes('zai-org/zai-x'));
    assert.ok(!ids.includes('stranger-org/foo'));
    assert.ok(baselines.some((b) => b.model_id === 'zai-org/zai-undated'));
    assert.ok(!ids.some((id) => id.includes('stranger-org')));
  });

  it('caps fan out at three per day, frontier orgs and newest first', () => {
    writeCatalogArtifact('openrouter', [
      { model_id: 'zai-org/one', created: '2026-08-01T00:00:00Z' },
      { model_id: 'zai-org/two', created: '2026-08-02T00:00:00Z' },
      { model_id: 'acme/a', created: '2026-08-03T00:00:00Z' },
      { model_id: 'acme/b', created: '2026-08-04T00:00:00Z' },
      { model_id: 'acme/c', created: '2026-08-05T00:00:00Z' },
    ]);
    const { candidates, deferred_candidates } = models.detectNewModels({
      runDir, baseOpts: options, now: NOW, windowDays: 7, watchlist: WATCHLIST,
    });
    assert.equal(candidates.length, models.FANOUT_MAX_PER_DAY);
    assert.equal(deferred_candidates.length, 2);
    // frontier (zai-org) candidates outrank acme regardless of date
    assert.ok(candidates[0].model_id.startsWith('zai-org/'));
    assert.ok(candidates[1].model_id.startsWith('zai-org/'));
  });

  it('ignores failed catalog artifacts and failed hf watch signals', () => {
    fs.writeFileSync(path.join(runDir, 'artifacts', 'catalog-groq.json'), JSON.stringify({
      kind: 'catalog', provider_key: 'groq', status: 'failed', models: [],
    }));
    fs.writeFileSync(path.join(runDir, 'reduced', 'watch-signals.json'),
      JSON.stringify({ signals: [{ entity_key: 'api:hf-new-models', status: 'fetch_failed' }] }));
    const { candidates, baselines } = models.detectNewModels({
      runDir, baseOpts: options, now: NOW, windowDays: 7, watchlist: WATCHLIST,
    });
    assert.deepEqual(candidates, []);
    assert.deepEqual(baselines, []);
  });
});

describe('planFanoutTasks', () => {
  it('carries deterministic catalog verdicts and the remaining routes to check', () => {
    writeCatalogArtifact('openrouter', [{ model_id: 'acme/fresh', created: '2026-08-03T00:00:00Z' }]);
    const detection = models.detectNewModels({
      runDir, baseOpts: options, now: NOW, windowDays: 7, watchlist: WATCHLIST,
    });
    const tasks = models.planFanoutTasks(detection.candidates, models.readCatalogArtifacts(runDir), WATCHLIST);
    assert.equal(tasks.length, 1);
    const task = tasks[0];
    assert.equal(task.kind, 'model_fanout');
    assert.equal(task.task_id, `model_fanout:${db.canonicalModelId('acme/fresh')}`);
    const verdicts = new Map(task.catalog_verdicts.map((v) => [v.provider_key, v.verdict]));
    assert.equal(verdicts.get('openrouter'), 'present');
    // groq and fireworks have no catalog lane: the worker checks them
    assert.deepEqual(task.routes_to_check, ['fireworks', 'groq']);
  });
});

describe('applyModelFacts', () => {
  function recordTask(taskRow, artifact) {
    db.addRunTasks('runM', [taskRow], options);
    fs.writeFileSync(db.artifactPathFor(runDir, taskRow.task_id), `${JSON.stringify(artifact, null, 2)}\n`);
    db.recordTaskResult('runM', taskRow.task_id, { status: 'complete', result: artifact }, options);
  }

  it('writes fetch-verified announcements and served routes; skips unverifiable ones', async () => {
    db.startRun('runM', [], options);
    const vendorArtifact = {
      schema_version: 1,
      task_id: 'vendor:zai',
      status: 'complete',
      crawled_at: NOW,
      vendor_key: 'zai',
      announcements: [{
        model_name: 'Zai X',
        model_id: 'zai-x',
        vendor_key: 'zai',
        announcement_url: 'https://z.ai/blog/launch',
        announcement_date: '2026-08-01',
        release_status: 'announced',
        open_weight: false,
      }],
      distribution: [
        { model_id: 'zai-x', provider_key: 'openrouter', status: 'served', evidence_url: 'https://openrouter.ai/models/zai-x' },
        { model_id: 'zai-x', provider_key: 'cerebras', status: 'served', evidence_url: 'https://cerebras.ai/pricing' },
        { model_id: 'zai-x', provider_key: 'fireworks', status: 'unconfirmed' },
      ],
      leads: [{
        claim_text: 'zai-x is free on groq for a week',
        source_url: 'https://www.reddit.com/r/LocalLLaMA/comments/1/abc/',
        model_name: 'zai-x',
        provider_key: 'groq',
        claim_kind: 'free_access',
      }],
    };
    recordTask(
      { task_id: 'vendor:zai', kind: 'vendor_deep_dive', provider_key: null, assigned_model_ids: [] },
      vendorArtifact
    );
    const communityArtifact = {
      schema_version: 1,
      task_id: 'community',
      status: 'complete',
      crawled_at: NOW,
      leads: [
        {
          claim_text: 'zai-x is free on groq for a week',
          source_url: 'https://www.reddit.com/r/LocalLLaMA/comments/1/abc/',
          model_name: 'zai-x',
          provider_key: 'groq',
        },
        {
          claim_text: 'zai-x unlimited flash on sambanova',
          source_url: 'https://news.ycombinator.com/item?id=42',
          model_name: 'zai-x',
          provider_key: 'sambanova',
        },
      ],
    };
    recordTask(
      { task_id: 'community', kind: 'community', provider_key: null, assigned_model_ids: [] },
      communityArtifact
    );

    // An old lead that must expire during this apply.
    const oldLead = db.addLead({
      run_id: 'runM',
      source_url: 'https://www.reddit.com/r/LocalLLaMA/comments/1/old/',
      claim_text: 'stale claim',
      detected_at: '2026-07-20T00:00:00.000Z',
    }, options);
    assert.equal(oldLead.created, true);

    const fetchImpl = textFetch({
      'https://z.ai/blog/launch': '<html><body>We introduce ZAI-X today.</body></html>',
      'https://openrouter.ai/models/zai-x': '<html><body>zai-x is live</body></html>',
      'https://cerebras.ai/pricing': '<html><body>pricing page without the model</body></html>',
    });

    const summary = await models.applyModelFacts({
      runId: 'runM', runDir, baseOpts: options, fetchImpl, now: NOW, watchlist: WATCHLIST,
    });
    assert.equal(summary.announcements_verified, 1);
    assert.equal(summary.distribution_notes, 3);
    assert.equal(summary.distribution_served_verified, 1);
    assert.equal(summary.leads_reported, 3);
    assert.equal(summary.leads_created, 2);
    assert.equal(summary.leads_expired, 1);

    const found = db.findModelsByIds(['zai-x'], options);
    assert.equal(found.length, 1);
    const row = found[0];
    assert.equal(row.display_name, 'Zai X');
    assert.equal(row.vendor_key, 'zai');
    assert.equal(row.source_url, 'https://z.ai/blog/launch');
    assert.equal(row.release_date, '2026-08-01');
    assert.ok(row.known_providers_json.includes('openrouter'));
    assert.ok(!row.known_providers_json.includes('cerebras'));

    const open = db.listOpenLeads(options);
    assert.equal(open.length, 2);
    const reddit = open.find((l) => l.source_url.includes('reddit'));
    assert.equal(reddit.source_tier, 9);
    const allLeads = [];
    for (const l of db.listOpenLeads(options)) allLeads.push(l.lead_id);
    assert.ok(!allLeads.includes(oldLead.lead_id));

    // Reduced files exist and are json.
    for (const file of ['model-updates.json', 'distribution-notes.json', 'vendor-pricing-news.json', 'leads-summary.json']) {
      const data = JSON.parse(fs.readFileSync(path.join(runDir, 'reduced', file), 'utf8'));
      assert.ok(data.run_id === 'runM' || data.generated_at);
    }
    const notes = JSON.parse(fs.readFileSync(path.join(runDir, 'reduced', 'distribution-notes.json'), 'utf8'));
    const byProvider = new Map(notes.notes.map((n) => [n.provider_key, n]));
    assert.equal(byProvider.get('openrouter').verified, true);
    assert.equal(byProvider.get('cerebras').verified, false);
    assert.equal(byProvider.get('fireworks').verified, false);
  });

  it('does not create a model row for an announcement the cited page does not show', async () => {
    db.startRun('runM', [], options);
    const artifact = {
      schema_version: 1,
      task_id: 'vendor:zai',
      status: 'complete',
      crawled_at: NOW,
      vendor_key: 'zai',
      announcements: [{
        model_name: 'Ghost Model',
        model_id: 'ghost-model',
        announcement_url: 'https://z.ai/blog/somewhere',
      }],
      distribution: [],
      leads: [],
    };
    db.addRunTasks('runM', [{ task_id: 'vendor:zai', kind: 'vendor_deep_dive', provider_key: null, assigned_model_ids: [] }], options);
    fs.writeFileSync(db.artifactPathFor(runDir, 'vendor:zai'), `${JSON.stringify(artifact, null, 2)}\n`);
    db.recordTaskResult('runM', 'vendor:zai', { status: 'complete', result: artifact }, options);
    const summary = await models.applyModelFacts({
      runId: 'runM', runDir, baseOpts: options,
      fetchImpl: textFetch({ 'https://z.ai/blog/somewhere': '<html><body>unrelated page</body></html>' }),
      now: NOW, watchlist: WATCHLIST,
    });
    assert.equal(summary.announcements_verified, 0);
    assert.equal(summary.announcements_unverified, 1);
    assert.deepEqual(db.findModelsByIds(['ghost-model'], options), []);
  });

  it('dedupes the same model reported by a second task (alias never fragments)', async () => {
    db.startRun('runM', [], options);
    const mk = (taskId, modelId) => ({
      schema_version: 1,
      task_id: taskId,
      status: 'complete',
      crawled_at: NOW,
      vendor_key: 'zai',
      announcements: [{ model_name: 'Zai X', model_id: modelId, announcement_url: 'https://z.ai/blog/launch' }],
      distribution: [],
      leads: [],
    });
    db.addRunTasks('runM', [
      { task_id: 'vendor:zai', kind: 'vendor_deep_dive', provider_key: null, assigned_model_ids: [] },
      { task_id: 'model_fanout:zai-x', kind: 'model_fanout', provider_key: null, assigned_model_ids: ['zai-x'] },
    ], options);
    fs.writeFileSync(db.artifactPathFor(runDir, 'vendor:zai'), `${JSON.stringify(mk('vendor:zai', 'zai-x'), null, 2)}\n`);
    db.recordTaskResult('runM', 'vendor:zai', { status: 'complete', result: mk('vendor:zai', 'zai-x') }, options);
    fs.writeFileSync(db.artifactPathFor(runDir, 'model_fanout:zai-x'), `${JSON.stringify(mk('model_fanout:zai-x', 'zai-x'), null, 2)}\n`);
    db.recordTaskResult('runM', 'model_fanout:zai-x', { status: 'complete', result: mk('model_fanout:zai-x', 'zai-x') }, options);
    const summary = await models.applyModelFacts({
      runId: 'runM', runDir, baseOpts: options,
      fetchImpl: textFetch({ 'https://z.ai/blog/launch': 'ZAI-X launch page' }),
      now: NOW, watchlist: WATCHLIST,
    });
    assert.equal(summary.announcements_verified, 2);
    const rows = db.listModels(options);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].canonical_model_id, 'zai-x');
  });
});

describe('buildNewModels (assemble)', () => {
  it('merges announcements and discovery candidates with window tags and distribution notes', () => {
    const models = [
      {
        canonical_name: 'Zai X',
        aliases: ['zai-x'],
        vendor: 'zai',
        status: 'announced',
        release_date: '2026-08-04',
        official_source: 'https://z.ai/blog/launch',
        api_available: true,
        open_weight: null,
        known_providers: [],
      },
    ];
    fs.writeFileSync(path.join(runDir, 'reduced', 'model-updates.json'), JSON.stringify({
      announcements: [
        { model_name: 'Zai X', canonical_model_id: 'zai-x', created: true, source_url: 'https://z.ai/blog/launch', release_date: '2026-08-04', vendor_key: 'zai', aliases: ['zai-x'] },
        { model_name: 'Old Catchup', canonical_model_id: 'old-catchup', created: true, source_url: 'https://z.ai/blog/old', release_date: '2026-07-20', vendor_key: 'zai', aliases: [] },
      ],
    }));
    fs.writeFileSync(path.join(runDir, 'reduced', 'distribution-notes.json'), JSON.stringify({
      notes: [
        { model_id: 'zai-x', provider_key: 'openrouter', status: 'served', verified: true },
        { model_id: 'zai-x', provider_key: 'fireworks', status: 'unconfirmed', verified: false },
      ],
    }));
    fs.writeFileSync(path.join(runDir, 'reduced', 'discovery-candidates.json'), JSON.stringify({
      candidates: [
        {
          model_name: 'Zai X', // duplicate of the announcement entry
          canonical_model_id: 'zai-x',
          provider_key: 'openrouter',
          reappearance: false,
          facts: { model_vendor: 'zai', release_date: '2026-08-04', endpoint_source: 'https://openrouter.ai/docs' },
        },
        {
          model_name: 'Hot New Model',
          canonical_model_id: 'hot/new',
          provider_key: 'sambanova',
          reappearance: false,
          facts: { model_vendor: 'sambanova', release_date: NOW.slice(0, 10), endpoint_source: 'https://docs.sambanova.ai' },
        },
        {
          model_name: 'Undated Model',
          canonical_model_id: 'undated/model',
          provider_key: 'sambanova',
          reappearance: false,
          facts: { model_vendor: 'sambanova', endpoint_source: 'https://docs.sambanova.ai' },
        },
      ],
    }));
    const now = '2026-08-05T12:00:00.000Z';
    const built = assemble.buildNewModels(runDir, now);
    assert.deepEqual(built.map((m) => m.canonical_name), ['Zai X', 'Old Catchup', 'Hot New Model', 'Undated Model']);
    const byName = new Map(built.map((m) => [m.canonical_name, m]));
    assert.equal(byName.get('Zai X').window, 'warm');
    assert.equal(byName.get('Zai X').distribution_note, 'served: openrouter; unconfirmed: fireworks');
    assert.equal(byName.get('Old Catchup').window, 'catchup');
    assert.equal(byName.get('Old Catchup').distribution_note, 'unconfirmed (no route verification this run)');
    assert.equal(byName.get('Hot New Model').window, 'hot');
    assert.equal(byName.get('Undated Model').window, 'undated');
    // the duplicate announcement entry won the dedupe (vendor from the models lane)
    assert.equal(byName.get('Zai X').vendor, 'zai');
  });

  it('returns an empty list when no reduced files exist', () => {
    assert.deepEqual(assemble.buildNewModels(path.join(runDir, 'missing')), []);
  });
});
