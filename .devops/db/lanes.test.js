'use strict';

// Collection lane tests for spec 0003 child 0002 (AC-2 through AC-6, AC-11,
// and the lane portions of AC-18): separate lane coverage, stale carry
// forward, the zero verified promotion gate, confirmed removal and
// reappearance, authoritative zero free catalogs, strict artifact identity,
// and discovery isolation. Every test runs in a fresh temp directory and
// never touches live project state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Ajv = require('ajv');
const db = require('./collector-db');
const evidence = require('./evidence');
const lanes = require('./lanes');

const FIXTURE_REGISTRY = {
  version: 1,
  providers: [
    {
      key: 'openrouter',
      label: 'OpenRouter',
      match: ['openrouter'],
      base_url: 'https://openrouter.ai/api/v1',
      docs_url: 'https://openrouter.ai/docs/quickstart',
      api_catalog_url: 'https://openrouter.ai/api/v1/models',
    },
    {
      key: 'google',
      label: 'Google Gemini',
      match: ['google', 'gemini'],
      base_url: 'https://generativelanguage.googleapis.com/v1beta',
      docs_url: 'https://ai.google.dev/gemini-api/docs',
    },
    {
      key: 'vercel',
      label: 'Vercel AI Gateway',
      match: ['vercel'],
      base_url: 'https://ai-gateway.vercel.sh/v1',
      docs_url: 'https://vercel.com/docs/ai-gateway',
    },
  ],
};

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-lanes-test-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'build', 'provider-registry.json'),
    JSON.stringify(FIXTURE_REGISTRY)
  );
  return { root, stateDir, options: { projectRoot: root, stateDir } };
}

function setup(ctx) {
  db.applyMigrations(ctx.options);
}

function seedOffers(ctx, offers) {
  // Seed current offers through one promoted run so the state is exactly
  // what finalizeRun produces in production.
  db.startRun('seed-run', [], ctx.options);
  db.finalizeRun('seed-run', { offers, runStatus: 'promoted' }, ctx.options);
}

function offerSeed(overrides = {}) {
  return {
    provider_key: 'google',
    exact_model_id: 'gemini-2.5-pro-free',
    canonical_model_id: 'gemini-2.5-pro-free',
    source_kind: 'official_page',
    status: 'verified',
    consecutive_failures: 0,
    first_seen_at: '2026-07-01T00:00:00.000Z',
    last_attempted_at: '2026-07-30T00:00:00.000Z',
    last_verified_at: '2026-07-30T00:00:00.000Z',
    pricing_hash: null,
    removal_evidence_json: null,
    facts_json: { free_quota_text: 'free tier, 100 requests per day' },
    ...overrides,
  };
}

function offerRow(ctx, providerKey, exactModelId) {
  const database = db.openCollectorDb(ctx.options);
  try {
    const row = database.prepare(
      'SELECT * FROM offers WHERE provider_key = ? AND exact_model_id = ?'
    ).get(providerKey, exactModelId);
    return row ? db.parseRow('offers', row) : null;
  } finally {
    database.close();
  }
}

function runDirFor(ctx, runId) {
  const dir = path.join(ctx.stateDir, 'crawl', runId);
  fs.mkdirSync(path.join(dir, 'artifacts'), { recursive: true });
  return dir;
}

function writeArtifact(ctx, runDir, taskId, artifact) {
  const file = db.artifactPathFor(runDir, taskId);
  fs.writeFileSync(file, JSON.stringify(artifact, null, 2));
  return file;
}

// Runs one full lane cycle: manifest from current state, start run, write the
// supplied artifacts (keyed by task id), ingest, reduce.
function runCycle(ctx, runId, artifactsByTask, options = {}) {
  const manifest = lanes.buildLaneManifest({ ...ctx.options, runId });
  const runDir = runDirFor(ctx, runId);
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  db.startRun(runId, lanes.toStartRunTasks(manifest), ctx.options);
  for (const [taskId, artifact] of Object.entries(artifactsByTask)) {
    writeArtifact(ctx, runDir, taskId, artifact);
  }
  const ingest = lanes.ingestTaskArtifacts(runId, runDir, ctx.options);
  const reduce = lanes.reduceLanes(runId, runDir, {
    ...ctx.options,
    now: options.now || '2026-07-31T00:00:00.000Z',
  });
  return { manifest, runDir, ingest, reduce };
}

function catalogArtifact(overrides = {}) {
  return {
    schema_version: 1,
    task_id: 'catalog:openrouter',
    kind: 'catalog',
    provider_key: 'openrouter',
    status: 'complete',
    crawled_at: '2026-07-31T00:00:00.000Z',
    catalog_url: 'https://openrouter.ai/api/v1/models',
    available: true,
    http_status: 200,
    content_hash: 'a'.repeat(64),
    endpoint_source: 'https://openrouter.ai/docs/quickstart',
    endpoint_source_hash: 'b'.repeat(64),
    base_url: 'https://openrouter.ai/api/v1',
    models: [],
    fetches: [{
      url: 'https://openrouter.ai/api/v1/models',
      subject_key: 'catalog:openrouter',
      http_status: 200,
      content_hash: 'a'.repeat(64),
      fetched_at: '2026-07-31T00:00:00.000Z',
    }],
    errors: [],
    ...overrides,
  };
}

function catalogModel(id, { free = true, pricingHash } = {}) {
  return {
    model_id: id,
    model_name: id.replace(/:free$/, ''),
    pricing: free ? { prompt: '0', completion: '0' } : { prompt: '0.5', completion: '1.5' },
    prompt_price: free ? 0 : 0.5,
    completion_price: free ? 0 : 1.5,
    is_free: free,
    pricing_hash: pricingHash || (free ? 'f'.repeat(64) : 'p'.repeat(64)),
  };
}

function knownArtifact(overrides = {}) {
  return {
    schema_version: 1,
    task_id: 'known:google',
    kind: 'known_refresh',
    provider_key: 'google',
    status: 'complete',
    crawled_at: '2026-07-31T00:00:00.000Z',
    models: [],
    errors: [],
    ...overrides,
  };
}

function knownModel(id, overrides = {}) {
  return {
    model_id: id,
    model_name: id,
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    endpoint_source: 'https://ai.google.dev/gemini-api/docs/pricing',
    free_quota_text: 'free tier, 100 requests per day',
    pricing_text: 'free',
    ...overrides,
  };
}

// ── Manifest ─────────────────────────────────────────────────────

test('buildLaneManifest splits catalog and known refresh lanes only (spec 0008 Phase 5)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'openrouter', exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
    offerSeed({ provider_key: 'openrouter', exact_model_id: 'acme/b:free', canonical_model_id: 'acme/b', status: 'stale', consecutive_failures: 2 }),
    offerSeed({ provider_key: 'google', exact_model_id: 'gemini-2.5-pro-free' }),
    offerSeed({ provider_key: 'google', exact_model_id: 'gone-model', status: 'confirmed_removed', consecutive_failures: 5 }),
  ]);
  // A cached source page for the google lane.
  db.startRun('cache-run', [], ctx.options);
  db.finalizeRun('cache-run', {
    sourceCache: [{
      url: 'https://ai.google.dev/gemini-api/docs/pricing',
      subject_key: 'google:gemini-2.5-pro-free',
      provider_key: 'google',
      exact_model_id: 'gemini-2.5-pro-free',
      fetched_at: '2026-07-30T00:00:00.000Z',
      http_status: 200,
      content_hash: 'c'.repeat(64),
    }],
  }, ctx.options);

  const manifest = lanes.buildLaneManifest(ctx.options);
  const byId = Object.fromEntries(manifest.tasks.map((task) => [task.task_id, task]));

  // Spec 0008 Phase 5: the legacy discovery goal crawlers are retired; the
  // research sessions (news scan, vendor deep dive, model fan out) are
  // planned at runtime and registered after the static manifest.
  assert.equal(manifest.tasks.filter((task) => task.kind === 'discovery').length, 0,
    'no legacy discovery tasks in the manifest');
  assert.ok(!('discovery' in manifest.lanes), 'no discovery lane in the manifest');
  assert.deepEqual(
    Object.keys(byId).sort(),
    ['catalog:openrouter', 'known:google', 'price_index:llmpricing'].sort()
  );

  assert.equal(byId['catalog:openrouter'].kind, 'catalog');
  assert.deepEqual(byId['catalog:openrouter'].assigned_model_ids, ['acme/a:free', 'acme/b:free'], 'stale offers are still assigned');
  assert.equal(byId['catalog:openrouter'].api_catalog_url, 'https://openrouter.ai/api/v1/models');

  assert.equal(byId['known:google'].kind, 'known_refresh');
  assert.deepEqual(byId['known:google'].assigned_model_ids, ['gemini-2.5-pro-free'], 'confirmed_removed offers are never assigned');
  assert.equal(byId['known:google'].cached_urls.length, 1);
  assert.equal(byId['known:google'].cached_urls[0].url, 'https://ai.google.dev/gemini-api/docs/pricing');

  assert.equal(manifest.lanes.known.assigned_offers, 3);
  assert.deepEqual(manifest.lanes.catalog.providers, ['openrouter']);
  // startRun accepts the slim rows.
  db.startRun('manifest-run', lanes.toStartRunTasks(manifest), ctx.options);
  const { tasks } = db.loadRunCandidate('manifest-run', ctx.options);
  assert.equal(tasks.length, 3);
  const known = tasks.find((task) => task.task_id === 'known:google');
  assert.deepEqual(known.assigned_json, ['gemini-2.5-pro-free']);
});


test('the legacy discovery goal crawlers are retired (spec 0008 Phase 5)', () => {
  assert.equal(lanes.buildDiscoveryTasks, undefined, 'buildDiscoveryTasks is removed');
  assert.equal(lanes.discoveryGoalOfTask, undefined, 'discoveryGoalOfTask is removed');
  assert.equal(lanes.DISCOVERY_GOALS, undefined, 'DISCOVERY_GOALS is removed');
});


test('research lane facts about a live known offer never become candidates or offer changes (spec 0007 AC-2 carried over)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);

  const manifest = lanes.buildLaneManifest({ ...ctx.options, runId: 'run-research' });
  const runDir = runDirFor(ctx, 'run-research');
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  db.startRun('run-research', lanes.toStartRunTasks(manifest), ctx.options);
  db.addRunTasks('run-research', [{
    task_id: 'model_fanout:google/gemini-2.5-pro-free',
    kind: 'model_fanout',
    provider_key: null,
    assigned_model_ids: ['gemini-2.5-pro-free'],
  }], ctx.options);
  writeArtifact(ctx, runDir, 'known:google', knownArtifact({ models: [knownModel('gemini-2.5-pro-free')] }));
  writeArtifact(ctx, runDir, 'model_fanout:google/gemini-2.5-pro-free', {
    schema_version: 1,
    task_id: 'model_fanout:google/gemini-2.5-pro-free',
    status: 'complete',
    crawled_at: '2026-07-31T00:00:00.000Z',
    vendor_key: 'google',
    announcements: [],
    pricing_claims: [{
      model_id: 'gemini-2.5-pro-free',
      provider_key: 'google',
      pricing_text: 'Gemini 2.5 Pro input is now $0.50 per 1M tokens',
    }],
    distribution: [],
    models: [{
      model_id: 'gemini-2.5-pro-free',
      provider_key: 'google',
      model_name: 'Gemini 2.5 Pro',
      pricing_text: 'Gemini 2.5 Pro input is now $0.50 per 1M tokens',
    }],
    leads: [],
    errors: [],
  });

  lanes.ingestTaskArtifacts('run-research', runDir, ctx.options);
  const reduce = lanes.reduceLanes('run-research', runDir, {
    ...ctx.options,
    now: '2026-07-31T00:00:00.000Z',
  });

  // The fact matches a live known offer: it must not become a candidate,
  // and the offer state must be untouched by the research lanes.
  assert.equal(reduce.discoveryCandidates.length, 0, 'research facts about a live known offer never become candidates');
  const offer = offerRow(ctx, 'google', 'gemini-2.5-pro-free');
  assert.equal(offer.status, 'verified');
  assert.equal(offer.consecutive_failures, 0);
});


test('fan out vendor-facts offers become discovery candidates (spec 0008 AC)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);

  const manifest = lanes.buildLaneManifest({ ...ctx.options, runId: 'run-fanout' });
  const runDir = runDirFor(ctx, 'run-fanout');
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  db.startRun('run-fanout', lanes.toStartRunTasks(manifest), ctx.options);
  // The fan out task is planned at runtime, so it is registered in the run
  // after the static manifest (same path the orchestrator takes).
  db.addRunTasks('run-fanout', [{
    task_id: 'model_fanout:acme/fresh',
    kind: 'model_fanout',
    provider_key: null,
    assigned_model_ids: ['acme/fresh'],
  }], ctx.options);
  writeArtifact(ctx, runDir, 'known:google', knownArtifact({ models: [knownModel('gemini-2.5-pro-free')] }));
  const fanoutArtifact = {
    schema_version: 1,
    task_id: 'model_fanout:acme/fresh',
    status: 'complete',
    crawled_at: '2026-07-31T00:00:00.000Z',
    vendor_key: 'acme',
    announcements: [{
      model_name: 'Acme Fresh',
      model_id: 'acme/fresh',
      announcement_url: 'https://acme.example/blog/fresh',
    }],
    pricing_claims: [],
    distribution: [
      { model_id: 'acme/fresh', provider_key: 'groq', status: 'served', evidence_url: 'https://groq.com/docs/models/acme-fresh' },
      { model_id: 'acme/fresh', provider_key: 'fireworks', status: 'not_served' },
      { model_id: 'acme/fresh', provider_key: 'cerebras', status: 'unconfirmed' },
    ],
    models: [{
      model_id: 'acme/fresh:free',
      model_name: 'Acme Fresh (free)',
      provider_key: 'groq',
      base_url: 'https://api.groq.com/openai/v1',
      endpoint_source: 'https://groq.com/docs/models/acme-fresh',
      pricing_text: 'free tier while beta',
      free_quota_text: 'unlimited during beta',
    }],
    leads: [],
    errors: [],
  };
  writeArtifact(ctx, runDir, 'model_fanout:acme/fresh', fanoutArtifact);

  lanes.ingestTaskArtifacts('run-fanout', runDir, ctx.options);
  const reduce = lanes.reduceLanes('run-fanout', runDir, {
    ...ctx.options,
    now: '2026-07-31T00:00:00.000Z',
  });

  const candidates = reduce.discoveryCandidates.filter((c) => c.exact_model_id === 'acme/fresh:free');
  assert.equal(candidates.length, 1, 'fan out offer fact becomes one discovery candidate');
  assert.equal(candidates[0].provider_key, 'groq');
  assert.equal(candidates[0].canonical_model_id, 'acme/fresh');
  assert.equal(candidates[0].facts.free_quota_text, 'unlimited during beta');

  const file = JSON.parse(fs.readFileSync(path.join(runDir, 'reduced', 'discovery-candidates.json'), 'utf8'));
  assert.ok(file.candidates.some((c) => c.model_name === 'Acme Fresh (free)'));

  // The known offer lane is untouched by the research lane (additions only).
  const offer = offerRow(ctx, 'google', 'gemini-2.5-pro-free');
  assert.equal(offer.status, 'verified');
});

// ── Strict artifact identity (AC-11) ─────────────────────────────

test('ingest rejects identity mismatch and demotes incomplete complete artifacts (AC-11)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'model-one' }),
    offerSeed({ exact_model_id: 'model-two', canonical_model_id: 'model-two' }),
  ]);

  const manifest = lanes.buildLaneManifest({ ...ctx.options, runId: 'run-id' });
  const runDir = runDirFor(ctx, 'run-id');
  db.startRun('run-id', lanes.toStartRunTasks(manifest), ctx.options);

  // known:google claims the wrong task id.
  writeArtifact(ctx, runDir, 'known:google', knownArtifact({ task_id: 'known:somebody-else' }));

  lanes.ingestTaskArtifacts('run-id', runDir, ctx.options);
  const { tasks } = db.loadRunCandidate('run-id', ctx.options);
  const known = tasks.find((task) => task.task_id === 'known:google');
  assert.equal(known.status, 'failed', 'task_id mismatch fails the artifact');
  assert.match(known.error_json.message, /identity or shape validation/);

  // Second run: complete artifact missing one assigned offer demotes to partial.
  db.startRun('run-2', lanes.toStartRunTasks(manifest), ctx.options);
  const runDir2 = runDirFor(ctx, 'run-2');
  writeArtifact(ctx, runDir2, 'known:google', knownArtifact({
    models: [knownModel('model-one')], // model-two omitted
  }));
  lanes.ingestTaskArtifacts('run-2', runDir2, ctx.options);
  const { tasks: tasks2 } = db.loadRunCandidate('run-2', ctx.options);
  const known2 = tasks2.find((task) => task.task_id === 'known:google');
  assert.equal(known2.status, 'partial');
  assert.match(known2.error_json.problems.join(' '), /model-two/);
});

test('missing artifact files become explicit failed task rows', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);
  const manifest = lanes.buildLaneManifest({ ...ctx.options, runId: 'run-empty' });
  const runDir = runDirFor(ctx, 'run-empty');
  db.startRun('run-empty', lanes.toStartRunTasks(manifest), ctx.options);
  const summary = lanes.ingestTaskArtifacts('run-empty', runDir, ctx.options);
  // catalog:openrouter (registry catalog provider, zero assigned),
  // known:google, and every discovery chunk task all lack artifacts.
  assert.equal(summary.recorded.length, manifest.tasks.length);
  assert.ok(summary.recorded.every((r) => r.status === 'failed'));
  const { tasks } = db.loadRunCandidate('run-empty', ctx.options);
  assert.ok(tasks.every((task) => task.status === 'failed'));
});

// ── Stale carry forward and caution (AC-3, AC-5) ─────────────────

test('a failed known refresh carries the offer forward as stale, not removed (AC-3, AC-5)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ last_verified_at: '2026-07-30T00:00:00.000Z' })]);

  const { reduce } = runCycle(ctx, 'run-fail', {
    'known:google': knownArtifact({ status: 'failed', models: [], errors: ['page moved, search found nothing'] }),
  }, { now: '2026-07-31T00:00:00.000Z' });

  assert.equal(reduce.coverage.known.assigned, 1);
  assert.equal(reduce.coverage.known.stale, 1);
  assert.equal(reduce.coverage.known.removed, 0, 'a fetch failure never proves removal');
  assert.equal(reduce.canPromote, false, 'zero verified with one assigned blocks promotion');

  const row = offerRow(ctx, 'google', 'gemini-2.5-pro-free');
  assert.equal(row.status, 'stale');
  assert.equal(row.consecutive_failures, 1);
  assert.equal(row.last_verified_at, '2026-07-30T00:00:00.000Z', 'prior verification time preserved');
  assert.equal(row.facts_json.free_quota_text, 'free tier, 100 requests per day', 'prior facts preserved');
  assert.equal(row.last_attempted_at, '2026-07-31T00:00:00.000Z');
  assert.equal(row.removal_evidence_json, null);
});

test('four consecutive failed runs move stale to caution without removal, then success recovers (AC-3)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);

  const failedArtifacts = {
    'known:google': knownArtifact({ status: 'failed', models: [], errors: ['timeout'] }),
  };
  const cautionStates = [];
  for (const runId of ['run-1', 'run-2', 'run-3', 'run-4']) {
    const { reduce } = runCycle(ctx, runId, failedArtifacts, { now: `2026-08-0${runId.slice(-1)}T00:00:00.000Z` });
    const row = offerRow(ctx, 'google', 'gemini-2.5-pro-free');
    cautionStates.push({ failures: row.consecutive_failures, status: row.status, caution: reduce.caution.length });
  }

  assert.deepEqual(cautionStates, [
    { failures: 1, status: 'stale', caution: 0 },
    { failures: 2, status: 'stale', caution: 0 },
    { failures: 3, status: 'stale', caution: 0 },
    { failures: 4, status: 'stale', caution: 1 }, // run four moves to caution
  ], 'runs one through three stay ranked; run four is caution; never removed');
  assert.equal(offerRow(ctx, 'google', 'gemini-2.5-pro-free').removal_evidence_json, null);

  // A later successful verification resets everything.
  const { reduce } = runCycle(ctx, 'run-5', {
    'known:google': knownArtifact({ models: [knownModel('gemini-2.5-pro-free', { free_quota_text: 'free tier, 200 requests per day' })] }),
  }, { now: '2026-08-05T00:00:00.000Z' });
  const row = offerRow(ctx, 'google', 'gemini-2.5-pro-free');
  assert.equal(row.status, 'verified');
  assert.equal(row.consecutive_failures, 0);
  assert.equal(row.last_verified_at, '2026-08-05T00:00:00.000Z');
  assert.equal(row.facts_json.free_quota_text, 'free tier, 200 requests per day', 'success refreshes facts');
  assert.equal(reduce.canPromote, true);
  assert.equal(reduce.coverage.known.verified, 1);
});

test('a partial artifact verifies covered offers and stales omitted ones (AC-11)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'model-one' }),
    offerSeed({ exact_model_id: 'model-two', canonical_model_id: 'model-two' }),
  ]);

  const { reduce } = runCycle(ctx, 'run-partial', {
    'known:google': knownArtifact({
      status: 'partial',
      models: [knownModel('model-one')],
      errors: ['model-two page unreachable'],
    }),
  });

  assert.equal(offerRow(ctx, 'google', 'model-one').status, 'verified');
  const two = offerRow(ctx, 'google', 'model-two');
  assert.equal(two.status, 'stale');
  assert.equal(two.consecutive_failures, 1);
  assert.equal(reduce.coverage.known.verified, 1);
  assert.equal(reduce.coverage.known.stale, 1);
  assert.equal(reduce.canPromote, true, 'one verified offer lifts the zero verified gate');
});

// ── Catalog lane (AC-5, AC-6) ────────────────────────────────────

test('a valid catalog verifies present free offers and removes omitted exact ids (AC-5, AC-6)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'openrouter', exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a', pricing_hash: 'f'.repeat(64) }),
    offerSeed({ provider_key: 'openrouter', exact_model_id: 'acme/b:free', canonical_model_id: 'acme/b', pricing_hash: 'f'.repeat(64) }),
  ]);

  const { reduce } = runCycle(ctx, 'run-cat', {
    'catalog:openrouter': catalogArtifact({ models: [catalogModel('acme/a:free'), catalogModel('acme/new:free')] }),
  }, { now: '2026-07-31T00:00:00.000Z' });

  const a = offerRow(ctx, 'openrouter', 'acme/a:free');
  assert.equal(a.status, 'verified');
  assert.equal(a.source_kind, 'catalog');
  assert.equal(a.consecutive_failures, 0);

  const b = offerRow(ctx, 'openrouter', 'acme/b:free');
  assert.equal(b.status, 'confirmed_removed');
  assert.equal(b.removal_evidence_json.reason, 'omitted from exhaustive official catalog');
  assert.equal(b.removal_evidence_json.source_url, 'https://openrouter.ai/api/v1/models');
  assert.equal(b.removal_evidence_json.task_id, 'catalog:openrouter');
  assert.equal(b.removal_evidence_json.run_id, 'run-cat');
  assert.equal(b.removal_evidence_json.observed_at, '2026-07-31T00:00:00.000Z');

  assert.equal(reduce.coverage.known.verified, 1);
  assert.equal(reduce.coverage.known.removed, 1);
  assert.deepEqual(reduce.coverage.catalog.available, ['openrouter']);

  // New free catalog ids are admitted as verified catalog offers while the
  // discovery output retains their first-seen provenance.
  const delta = reduce.discoveryCandidates.find((c) => c.exact_model_id === 'acme/new:free');
  assert.ok(delta);
  assert.equal(delta.source, 'catalog_delta');
  const newlyAdmitted = offerRow(ctx, 'openrouter', 'acme/new:free');
  assert.equal(newlyAdmitted.status, 'verified');
  assert.equal(newlyAdmitted.source_kind, 'catalog');
  assert.equal(newlyAdmitted.canonical_model_id, 'acme/new');
  assert.equal(newlyAdmitted.first_seen_at, '2026-07-31T00:00:00.000Z');
  assert.equal(newlyAdmitted.last_attempted_at, '2026-07-31T00:00:00.000Z');
  assert.equal(newlyAdmitted.last_verified_at, '2026-07-31T00:00:00.000Z');
  assert.equal(newlyAdmitted.pricing_hash, 'f'.repeat(64));
  assert.equal(newlyAdmitted.facts_json.model_id, 'acme/new:free');
  // Spec 0004: typed price columns, no free_model_names inventory.
  assert.equal(newlyAdmitted.effective_input_price_usd, 0);
  assert.equal(newlyAdmitted.effective_output_price_usd, 0);
  assert.equal(newlyAdmitted.facts_json.free_model_names, undefined);
  assert.equal(newlyAdmitted.facts_json.endpoint_source, 'https://openrouter.ai/docs/quickstart');
  assert.equal(newlyAdmitted.facts_json.rate_limits, undefined);

  // The successful catalog fetch became cache evidence (AC-16).
  assert.equal(reduce.sourceCache.length, 1);
  assert.equal(reduce.sourceCache[0].subject_key, 'catalog:openrouter');
});

test('a successful catalog persists typed prices on every admitted offer (AC-3)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);

  runCycle(ctx, 'run-full-list', {
    'catalog:openrouter': catalogArtifact({ models: [
      catalogModel('zeta/model:free'),
      catalogModel('openrouter/free'),
      catalogModel('alpha/model:free'),
      catalogModel('zeta/model:free'),
    ] }),
  });

  const expected = ['alpha/model:free', 'openrouter/free', 'zeta/model:free'];
  for (const exactModelId of expected) {
    const row = offerRow(ctx, 'openrouter', exactModelId);
    assert.equal(row.status, 'verified');
    assert.equal(row.source_kind, 'catalog');
    assert.equal(row.canonical_model_id, db.canonicalModelId(exactModelId));
    assert.equal(row.effective_input_price_usd, 0);
    assert.equal(row.effective_output_price_usd, 0);
    assert.equal(row.source_currency, 'USD');
    assert.equal(row.facts_json.free_model_names, undefined, 'no inventory list in facts');
  }
});

test('an exact id that became paid is confirmed removed with pricing evidence (AC-5)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'openrouter', exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
  ]);

  runCycle(ctx, 'run-paid', {
    'catalog:openrouter': catalogArtifact({ models: [catalogModel('acme/a:free', { free: false })] }),
  });

  const row = offerRow(ctx, 'openrouter', 'acme/a:free');
  assert.equal(row.status, 'confirmed_removed');
  assert.equal(row.removal_evidence_json.reason, 'official catalog pricing is no longer free or ultra low');
  assert.deepEqual(row.removal_evidence_json.pricing, { prompt: '0.5', completion: '1.5' });
});

test('a listed model without pricing stays stale instead of being falsely removed', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'openrouter', exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
  ]);

  const unpriced = catalogModel('acme/a:free');
  delete unpriced.prompt_price;
  delete unpriced.completion_price;
  delete unpriced.pricing;
  unpriced.price_known = false;
  unpriced.pricing_hash = null;
  const { reduce } = runCycle(ctx, 'run-unpriced', {
    'catalog:openrouter': catalogArtifact({ models: [unpriced] }),
  });

  const row = offerRow(ctx, 'openrouter', 'acme/a:free');
  assert.equal(row.status, 'stale');
  assert.equal(row.consecutive_failures, 1);
  assert.equal(row.removal_evidence_json, null);
  assert.equal(reduce.coverage.known.stale, 1);
  assert.equal(reduce.coverage.known.removed, 0);
});

test('a reappearing exact id returns from confirmed_removed to verified (AC-5)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({
      provider_key: 'openrouter', exact_model_id: 'acme/b:free', canonical_model_id: 'acme/b',
      status: 'confirmed_removed', consecutive_failures: 0,
      removal_evidence_json: { reason: 'omitted from exhaustive official catalog', source_url: 'https://openrouter.ai/api/v1/models', task_id: 'catalog:openrouter', run_id: 'old-run', observed_at: '2026-07-20T00:00:00.000Z' },
    }),
  ]);

  runCycle(ctx, 'run-back', {
    'catalog:openrouter': catalogArtifact({ models: [catalogModel('acme/b:free')] }),
  });

  const row = offerRow(ctx, 'openrouter', 'acme/b:free');
  assert.equal(row.status, 'verified');
  assert.equal(row.consecutive_failures, 0);
  assert.equal(row.removal_evidence_json, null, 'removal evidence cleared on return');
});

test('a valid catalog with zero free offers authoritatively removes prior free offers (AC-5, AC-6)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'openrouter', exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
  ]);

  const { reduce } = runCycle(ctx, 'run-zero-free', {
    'catalog:openrouter': catalogArtifact({ models: [catalogModel('acme/a:free', { free: false }), catalogModel('acme/other', { free: false })] }),
  });

  assert.equal(reduce.coverage.catalog.available.length, 1, 'nonempty valid catalog stays authoritative');
  assert.equal(offerRow(ctx, 'openrouter', 'acme/a:free').status, 'confirmed_removed');
});

test('an unavailable catalog preserves prior offers as stale and never removes (AC-3, AC-6)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'openrouter', exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
  ]);

  const { reduce } = runCycle(ctx, 'run-down', {
    'catalog:openrouter': catalogArtifact({ status: 'failed', available: false, models: [], errors: ['catalog fetch failed after 2 attempts: timeout'] }),
  });

  const row = offerRow(ctx, 'openrouter', 'acme/a:free');
  assert.equal(row.status, 'stale');
  assert.equal(row.consecutive_failures, 1);
  assert.equal(row.removal_evidence_json, null, 'catalog failure never confirms removal');
  assert.equal(reduce.coverage.catalog.unavailable.length, 1);
  assert.match(reduce.coverage.catalog.unavailable[0].reason, /timeout/);
  assert.equal(offerRow(ctx, 'openrouter', 'acme/new:free'), null, 'unavailable catalog cannot admit unseen ids');
  assert.equal(reduce.canPromote, false, 'zero verified blocks promotion');
});

test('a failed price fetch keeps the last verified price and date (AC-8)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({
      provider_key: 'openrouter', exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a',
      effective_input_price_usd: 0.1, effective_output_price_usd: 0.2,
      normal_input_price_usd: 0.1, normal_output_price_usd: 0.2,
      source_currency: 'USD', source_unit: 'per_million_tokens',
      price_source_url: 'https://openrouter.ai/api/v1/models',
      price_verified_at: '2026-07-28T00:00:00.000Z',
    }),
  ]);

  // Known refresh fails for the assigned offer: stale carry forward must
  // keep the typed prices and the price confirmation date.
  const { reduce } = runCycle(ctx, 'run-fetch-fail', {
    'known:google': knownArtifact({ status: 'failed', models: [], errors: ['simulated outage'] }),
  });

  assert.equal(reduce.canPromote, false, 'zero verified blocks promotion');
  const row = offerRow(ctx, 'openrouter', 'acme/a:free');
  assert.equal(row.status, 'stale');
  assert.equal(row.effective_input_price_usd, 0.1, 'price survives the failed fetch (AC-8)');
  assert.equal(row.effective_output_price_usd, 0.2);
  assert.equal(row.price_verified_at, '2026-07-28T00:00:00.000Z', 'confirmation date survives');
  assert.equal(row.price_source_url, 'https://openrouter.ai/api/v1/models');
});

test('an expired discounted price update is rejected and the prior prices and date are retained', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({
      provider_key: 'google', exact_model_id: 'gemini-2.5-pro-free', canonical_model_id: 'gemini-2.5-pro-free',
      effective_input_price_usd: 0, effective_output_price_usd: 0,
      normal_input_price_usd: 0, normal_output_price_usd: 0,
      source_currency: 'USD', source_unit: 'per_million_tokens',
      price_source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      price_verified_at: '2026-07-28T00:00:00.000Z',
      discount_start_at: '2026-07-01T00:00:00.000Z',
      discount_end_at: '2026-08-01T00:00:00.000Z',
    }),
  ]);

  // The worker rechecks the official page: the limited discount is over and
  // only the end date is published. The evidence audit rejects the fresh
  // discounted update (end date cannot confirm the start claim), so the
  // reducer must keep the prior typed prices, source, and confirmation date.
  const { reduce } = runCycle(ctx, 'run-expired-discount', {
    'known:google': knownArtifact({ models: [knownModel('gemini-2.5-pro-free', {
      normal_source_amount_input: 5, normal_source_amount_output: 10,
      effective_source_amount_input: 0.5, effective_source_amount_output: 1,
      source_currency: 'USD', source_unit: 'per_million_tokens',
      price_source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
      discount_start_at: '2026-07-01T00:00:00.000Z',
      discount_end_at: '2026-08-01T00:00:00.000Z',
    })], errors: [] }),
  }, { now: '2026-08-15T00:00:00.000Z' });

  assert.equal(reduce.canPromote, true);
  const row = offerRow(ctx, 'google', 'gemini-2.5-pro-free');
  assert.equal(row.status, 'verified');
  assert.equal(row.effective_input_price_usd, 0, 'prior price is retained');
  assert.equal(row.effective_output_price_usd, 0);
  assert.equal(row.normal_input_price_usd, 0);
  assert.equal(row.price_verified_at, '2026-07-28T00:00:00.000Z', 'prior confirmation date is retained');
  assert.equal(row.price_source_url, 'https://ai.google.dev/gemini-api/docs/pricing');
  assert.equal(row.discount_start_at, '2026-07-01T00:00:00.000Z', 'prior discount period is retained');
  assert.equal(row.discount_end_at, '2026-08-01T00:00:00.000Z');
});

test('a confirmed price increase removes the offer; a later decrease restores it (AC-8)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({
      provider_key: 'openrouter', exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a',
      effective_input_price_usd: 0, effective_output_price_usd: 0,
      normal_input_price_usd: 0, normal_output_price_usd: 0,
      source_currency: 'USD', source_unit: 'per_million_tokens',
      price_source_url: 'https://openrouter.ai/api/v1/models',
      price_verified_at: '2026-07-28T00:00:00.000Z',
    }),
  ]);

  // Catalog now lists the same id at a price above the ULTRA_LOW ceiling.
  runCycle(ctx, 'run-increase', {
    'catalog:openrouter': catalogArtifact({ models: [catalogModel('acme/a:free', { free: false })] }),
  });
  assert.equal(offerRow(ctx, 'openrouter', 'acme/a:free').status, 'confirmed_removed');

  // Later the price drops back to free: the offer returns to verified.
  runCycle(ctx, 'run-decrease', {
    'catalog:openrouter': catalogArtifact({ models: [catalogModel('acme/a:free', { free: true })] }),
  });
  const restored = offerRow(ctx, 'openrouter', 'acme/a:free');
  assert.equal(restored.status, 'verified');
  assert.equal(restored.effective_input_price_usd, 0);
  assert.equal(restored.effective_output_price_usd, 0);
});

test('a changed pricing hash verifies the offer and queues a pricing change candidate', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'openrouter', exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a', pricing_hash: 'old'.padEnd(64, '0') }),
  ]);

  const { reduce } = runCycle(ctx, 'run-price', {
    'catalog:openrouter': catalogArtifact({ models: [catalogModel('acme/a:free', { pricingHash: 'new'.padEnd(64, '1') })] }),
  });

  const row = offerRow(ctx, 'openrouter', 'acme/a:free');
  assert.equal(row.status, 'verified');
  assert.equal(row.pricing_hash, 'new'.padEnd(64, '1'));
  const change = reduce.discoveryCandidates.find((c) => c.source === 'pricing_change');
  assert.ok(change);
  assert.equal(change.exact_model_id, 'acme/a:free');
});

// ── Explicit removal statements (AC-5) ───────────────────────────

test('a valid official removal statement confirms removal; an invalid one is ignored (AC-5)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ exact_model_id: 'model-one' }),
    offerSeed({ exact_model_id: 'model-two', canonical_model_id: 'model-two' }),
  ]);

  runCycle(ctx, 'run-removal', {
    'known:google': knownArtifact({
      status: 'complete',
      models: [knownModel('model-one')],
      removals: [
        { model_id: 'model-two', source_url: 'https://ai.google.dev/announcement', reason: 'free API ended on 2026-07-30', _evidence_verified: true },
      ],
    }),
  });

  const two = offerRow(ctx, 'google', 'model-two');
  assert.equal(two.status, 'confirmed_removed');
  assert.equal(two.removal_evidence_json.reason, 'free API ended on 2026-07-30');
  assert.equal(two.removal_evidence_json.source_url, 'https://ai.google.dev/announcement');
  assert.equal(offerRow(ctx, 'google', 'model-one').status, 'verified');

  // Invalid evidence (non http URL) with no live model: stale, not removed.
  const ctx2 = tmpProject();
  setup(ctx2);
  seedOffers(ctx2, [offerSeed({ exact_model_id: 'model-two', canonical_model_id: 'model-two' })]);
  runCycle(ctx2, 'run-bad-removal', {
    'known:google': knownArtifact({
      status: 'partial',
      models: [],
      removals: [{ model_id: 'model-two', source_url: 'ftp://nope.example', reason: 'ended' }],
    }),
  });
  const row2 = offerRow(ctx2, 'google', 'model-two');
  assert.equal(row2.status, 'stale');
  assert.equal(row2.removal_evidence_json, null);
  fs.rmSync(ctx2.root, { recursive: true, force: true });
});

test('official removals pass schema, evidence audit, and reducer gates', async (t) => {
  const schemaPath = path.join(__dirname, '..', '..', '.agents/skills/llm-deals-intelligence-skill/schemas/crawl-facts.schema.json');
  const validate = new Ajv({ allErrors: true, strict: false }).compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
  const validShape = {
    schema_version: 1, task_id: 'known:google', status: 'complete',
    crawled_at: '2026-07-31T00:00:00.000Z', provider_key: 'google', models: [],
    removals: [{ model_id: 'model-two', source_url: 'https://ai.google.dev/announcement', reason: 'API ended' }],
    errors: [],
  };
  assert.equal(validate(validShape), true);
  assert.equal(validate({ ...validShape, removals: [{ ...validShape.removals[0], extra: true }] }), false);

  async function auditArtifact(artifact, response) {
    const audited = await evidence.auditRunEvidence([{
      kind: 'known_refresh', result_json: artifact,
    }], {
      attempts: 1,
      now: '2026-07-31T00:00:00Z',
      fetchImpl: async () => ({ status: response.status, headers: new Map(), url: artifact.removals[0].source_url, body: response.body }),
    });
    return audited.tasks[0].result_json;
  }

  const official = await auditArtifact(knownArtifact({
    models: [],
    removals: [{ model_id: 'model-two', source_url: 'https://ai.google.dev/announcement', reason: 'free to paid transition' }],
  }), { status: 200, body: 'model-two switched from free to paid on 2026-07-30' });
  assert.equal(official.removals.length, 1);
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({ exact_model_id: 'model-two', canonical_model_id: 'model-two' })]);
  runCycle(ctx, 'run-audited-removal', {
    'known:google': official,
  });
  assert.equal(offerRow(ctx, 'google', 'model-two').status, 'confirmed_removed');

  for (const response of [
    { status: 200, body: 'model-two pricing remains live; welcome' },
    { status: 200, body: 'model-other was removed from the service' },
    { status: 503, body: 'model-two was removed from the service' },
  ]) {
    const bad = await auditArtifact(knownArtifact({
      models: [],
      removals: [{ model_id: 'model-two', source_url: 'https://ai.google.dev/announcement', reason: 'API ended' }],
    }), response);
    assert.equal(bad.removals.length, 0);
    const badCtx = tmpProject();
    setup(badCtx);
    seedOffers(badCtx, [offerSeed({ exact_model_id: 'model-two', canonical_model_id: 'model-two' })]);
    runCycle(badCtx, 'run-rejected-removal', {
      'known:google': bad,
    });
    assert.equal(offerRow(badCtx, 'google', 'model-two').status, 'stale');
    fs.rmSync(badCtx.root, { recursive: true, force: true });
  }

  const contradictory = await auditArtifact(knownArtifact({
    models: [knownModel('model-two', { offer_ended: false })],
    removals: [{ model_id: 'model-two', source_url: 'https://ai.google.dev/announcement', reason: 'API ended' }],
  }), { status: 200, body: 'model-two is no longer available according to the official announcement' });
  const contradictionCtx = tmpProject();
  setup(contradictionCtx);
  seedOffers(contradictionCtx, [offerSeed({ exact_model_id: 'model-two', canonical_model_id: 'model-two' })]);
  runCycle(contradictionCtx, 'run-contradictory-removal', {
    'known:google': contradictory,
  });
  assert.equal(offerRow(contradictionCtx, 'google', 'model-two').status, 'stale');
  fs.rmSync(contradictionCtx.root, { recursive: true, force: true });
});

// ── Discovery isolation (AC-2) ───────────────────────────────────

test('research lane failure never removes or changes a known offer (spec 0007 AC-2 carried over)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);

  const manifest = lanes.buildLaneManifest({ ...ctx.options, runId: 'run-research-fail' });
  const runDir = runDirFor(ctx, 'run-research-fail');
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  db.startRun('run-research-fail', lanes.toStartRunTasks(manifest), ctx.options);
  db.addRunTasks('run-research-fail', [{
    task_id: 'news_scan',
    kind: 'news_scan',
    provider_key: null,
  }], ctx.options);
  writeArtifact(ctx, runDir, 'known:google', knownArtifact({ models: [knownModel('gemini-2.5-pro-free')] }));
  // No artifact for the research task: ingest marks it failed.
  lanes.ingestTaskArtifacts('run-research-fail', runDir, ctx.options);
  const reduce = lanes.reduceLanes('run-research-fail', runDir, {
    ...ctx.options,
    now: '2026-07-31T00:00:00.000Z',
  });

  assert.equal(reduce.coverage.research.assigned, 1);
  assert.equal(reduce.coverage.research.failed, 1, 'the failed research session is counted');
  assert.equal(reduce.canPromote, true, 'research failure does not block promotion');
  const row = offerRow(ctx, 'google', 'gemini-2.5-pro-free');
  assert.equal(row.status, 'verified');
  assert.equal(row.consecutive_failures, 0);
});

test('research lane models matching known offers are not duplicated into candidates (spec 0007 AC-2 carried over)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);

  const manifest = lanes.buildLaneManifest({ ...ctx.options, runId: 'run-research-dedupe' });
  const runDir = runDirFor(ctx, 'run-research-dedupe');
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  db.startRun('run-research-dedupe', lanes.toStartRunTasks(manifest), ctx.options);
  db.addRunTasks('run-research-dedupe', [{
    task_id: 'vendor_deep_dive:acme',
    kind: 'vendor_deep_dive',
    provider_key: null,
  }], ctx.options);
  writeArtifact(ctx, runDir, 'known:google', knownArtifact({ models: [knownModel('gemini-2.5-pro-free')] }));
  writeArtifact(ctx, runDir, 'vendor_deep_dive:acme', {
    schema_version: 1,
    task_id: 'vendor_deep_dive:acme',
    status: 'complete',
    crawled_at: '2026-07-31T00:00:00.000Z',
    vendor_key: 'google',
    announcements: [],
    pricing_claims: [],
    distribution: [],
    models: [
      { model_id: 'gemini-2.5-pro-free', provider_key: 'google', model_name: 'known one' },
      { model_id: 'brand-new-model', provider_key: 'google', model_name: 'Brand New' },
    ],
    leads: [],
    errors: [],
  });

  lanes.ingestTaskArtifacts('run-research-dedupe', runDir, ctx.options);
  const reduce = lanes.reduceLanes('run-research-dedupe', runDir, {
    ...ctx.options,
    now: '2026-07-31T00:00:00.000Z',
  });

  assert.equal(reduce.discoveryCandidates.length, 1, 'only the genuinely new model becomes a candidate');
  assert.equal(reduce.discoveryCandidates[0].exact_model_id, 'brand-new-model');
  assert.equal(reduce.discoveryCandidates[0].source, 'research');
});

// ── Promotion gate (AC-4) ────────────────────────────────────────

test('zero verified known offers with assignments blocks promotion but persists stale state (AC-4)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);

  const { reduce } = runCycle(ctx, 'run-gate', {
    'known:google': knownArtifact({ status: 'failed', models: [], errors: ['all pages down'] }),
  });

  assert.equal(reduce.canPromote, false);
  assert.match(reduce.gateReason, /AC-4/);
  assert.equal(reduce.run.status, 'failed');
  assert.equal(offerRow(ctx, 'google', 'gemini-2.5-pro-free').consecutive_failures, 1, 'stale counters persist even when promotion is blocked');
});

test('a bootstrap run with no known offers needs deterministic catalog success (AC-4)', (t) => {
  // No seeded offers: the manifest has a catalog task with zero assignments
  // plus discovery. Catalog success allows promotion.
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);

  const ok = runCycle(ctx, 'run-boot-ok', {
    'catalog:openrouter': catalogArtifact({ models: [catalogModel('acme/a:free')] }),
  });
  assert.equal(ok.manifest.lanes.known.assigned_offers, 0);
  assert.equal(ok.reduce.canPromote, true);
  assert.equal(ok.reduce.run.status, 'candidate_ready');

  // Catalog unavailable blocks the bootstrap promotion.
  const ctx2 = tmpProject();
  setup(ctx2);
  const bad = runCycle(ctx2, 'run-boot-bad', {
    'catalog:openrouter': catalogArtifact({ status: 'failed', available: false, models: [], errors: ['HTTP 500'] }),
  });
  assert.equal(bad.reduce.canPromote, false);
  assert.match(bad.reduce.gateReason, /catalog success/);
  fs.rmSync(ctx2.root, { recursive: true, force: true });
});

// ── Coverage report and run local outputs ────────────────────────

test('reduceLanes writes the coverage report and discovery candidates to the run directory', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'openrouter', exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
    offerSeed({ exact_model_id: 'model-one' }),
  ]);

  const manifest = lanes.buildLaneManifest({ ...ctx.options, runId: 'run-out' });
  const runDir = runDirFor(ctx, 'run-out');
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  db.startRun('run-out', lanes.toStartRunTasks(manifest), ctx.options);
  db.addRunTasks('run-out', [{
    task_id: 'model_fanout:acme/new',
    kind: 'model_fanout',
    provider_key: null,
    assigned_model_ids: ['acme/new'],
  }], ctx.options);
  writeArtifact(ctx, runDir, 'catalog:openrouter', catalogArtifact({ models: [catalogModel('acme/a:free')] }));
  writeArtifact(ctx, runDir, 'known:google', knownArtifact({ models: [knownModel('model-one')] }));
  writeArtifact(ctx, runDir, 'model_fanout:acme/new', {
    schema_version: 1,
    task_id: 'model_fanout:acme/new',
    status: 'complete',
    crawled_at: '2026-07-31T00:00:00.000Z',
    vendor_key: 'acme',
    announcements: [],
    pricing_claims: [],
    distribution: [],
    models: [{ model_id: 'fresh', provider_key: 'google' }],
    leads: [],
    errors: [],
  });
  lanes.ingestTaskArtifacts('run-out', runDir, ctx.options);
  const reduce = lanes.reduceLanes('run-out', runDir, {
    ...ctx.options,
    now: '2026-07-31T00:00:00.000Z',
  });

  const coverageFile = path.join(runDir, 'reduced', 'lane-coverage.json');
  const candidatesFile = path.join(runDir, 'reduced', 'discovery-candidates.json');
  assert.ok(fs.existsSync(coverageFile));
  assert.ok(fs.existsSync(candidatesFile));

  const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
  assert.equal(coverage.can_promote, true);
  assert.deepEqual(coverage.coverage.known, { assigned: 2, verified: 2, stale: 0, removed: 0, failed: 0 });
  assert.deepEqual(coverage.coverage.research, { assigned: 1, complete: 1, partial: 0, failed: 0 });
  assert.deepEqual(coverage.coverage.catalog.available, ['openrouter']);

  const candidates = JSON.parse(fs.readFileSync(candidatesFile, 'utf8'));
  assert.equal(candidates.candidates.length, 1);
  assert.equal(candidates.candidates[0].exact_model_id, 'fresh');
  assert.equal(reduce.run.status, 'candidate_ready');
});

// ── Provider registration candidates (spec 0004 AC-11) ──────────

test('a valid unregistered provider candidate is accepted and written to the run output (AC-11)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'google', exact_model_id: 'model-one' }),
  ]);

  const { runDir, reduce } = runCycle(ctx, 'run-provider', {
    'known:google': knownArtifact({
      models: [knownModel('model-one')],
      provider_candidates: [{
        provider_key: 'neonstack',
        label: 'NeonStack AI',
        base_url: 'https://api.neonstack.example/v1',
        docs_url: 'https://docs.neonstack.example/quickstart',
        model_id_pattern: '^neonstack/[a-z0-9-]+$',
        delivery_type: 'official',
      }],
    }),
  });

  assert.equal(reduce.providerCandidates.length, 1);
  assert.equal(reduce.providerCandidates[0].accepted, true);
  assert.equal(reduce.providerCandidates[0].entry.key, 'neonstack');
  assert.equal(reduce.providerCandidates[0].entry.base_url, 'https://api.neonstack.example/v1');
  assert.equal(reduce.providerCandidates[0].entry.base_url_pattern, '^https://api\\.neonstack\\.example/v1/?$');
  assert.equal(reduce.providerCandidates[0].entry.added_from, 'https://docs.neonstack.example/quickstart');

  const file = path.join(runDir, 'reduced', 'provider-candidates.json');
  assert.ok(fs.existsSync(file), 'provider-candidates.json is written for the assembler');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.candidates.length, 1);
  assert.equal(parsed.candidates[0].accepted, true);
});

test('a malformed provider candidate is rejected and never touches the canonical registry (AC-11)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'google', exact_model_id: 'model-one' }),
  ]);

  const { reduce } = runCycle(ctx, 'run-bad-provider', {
    'known:google': knownArtifact({
      models: [knownModel('model-one')],
      provider_candidates: [
        { provider_key: 'no-label', base_url: 'https://x.example/v1', docs_url: 'https://docs.x.example', model_id_pattern: '^x/' },
        { provider_key: 'Bad Key!', label: 'Bad', base_url: 'https://bad.example/v1', docs_url: 'https://docs.bad.example', model_id_pattern: '^bad/' },
        { provider_key: 'openrouter', label: 'Duplicate', base_url: 'https://openrouter.ai/api/v1', docs_url: 'https://openrouter.ai/docs/quickstart', model_id_pattern: '^openrouter/' },
        { provider_key: 'nobase', label: 'No Base', base_url: 'not-a-url', docs_url: 'https://docs.nobase.example', model_id_pattern: '^nb/' },
      ],
    }),
  });

  assert.equal(reduce.providerCandidates.length, 4);
  for (const candidate of reduce.providerCandidates) {
    assert.equal(candidate.accepted, false, `${candidate.provider_key} must be rejected`);
  }
  const registry = JSON.parse(fs.readFileSync(
    path.join(ctx.root, 'build', 'provider-registry.json'), 'utf8'
  ));
  assert.equal(registry.providers.length, 3, 'canonical registry unchanged');
  assert.equal(registry.providers.some((p) => p.key === 'Bad Key!'), false);
});

// ── Discovery source growth (spec 0004 AC-10) ───────────────────

test('normalizeCatalogPrice converts per_token to per million and passes per million through', () => {
  assert.equal(lanes.normalizeCatalogPrice(0.00000125, 'per_token'), 1.25);
  assert.equal(lanes.normalizeCatalogPrice(0.00001, 'per_token'), 10);
  assert.equal(lanes.normalizeCatalogPrice(0.0000006, 'per_token'), 0.6);
  assert.equal(lanes.normalizeCatalogPrice(0, 'per_token'), 0);
  assert.equal(lanes.normalizeCatalogPrice(0.2, 'per_million_tokens'), 0.2);
  assert.equal(lanes.normalizeCatalogPrice(1e-9, 'per_token'), 0.001);
  assert.equal(lanes.normalizeCatalogPrice(null, 'per_token'), null);
  assert.equal(lanes.normalizeCatalogPrice('x', 'per_token'), null);
});

test('isPriceEligible rejects paid per-token prices after normalization', () => {
  // OpenRouter Kimi K3: 0.000003 / 0.000015 per token = 3 / 15 per million,
  // which is above the ULTRA_LOW ceiling and must not admit.
  const input = lanes.normalizeCatalogPrice(0.000003, 'per_token');
  const output = lanes.normalizeCatalogPrice(0.000015, 'per_token');
  assert.equal(input, 3);
  assert.equal(output, 15);
  assert.equal(lanes.isPriceEligible(input, output), false);
  // Boundary per-token values that normalize to exactly 0.2 / 0.4 admit.
  const lo = lanes.normalizeCatalogPrice(0.0000002, 'per_token');
  const hi = lanes.normalizeCatalogPrice(0.0000004, 'per_token');
  assert.equal(lanes.isPriceEligible(lo, hi), true);
  // A hair above the boundary after normalization is excluded.
  const over = lanes.normalizeCatalogPrice(0.0000002000001, 'per_token');
  assert.ok(Math.abs(over - 0.2000001) < 1e-12, `over normalized to ${over}`);
  assert.equal(lanes.isPriceEligible(over, hi), false);
});

test('applyCatalogPrices persists normalized USD/M and raw source evidence', () => {
  const change = {};
  lanes.applyCatalogPrices(change, {
    prompt_price: 0.00000125,
    completion_price: 0.000004,
  }, 'https://openrouter.ai/api/v1/models', 'per_token');
  assert.equal(change.effective_input_price_usd, 1.25);
  assert.equal(change.effective_output_price_usd, 4);
  assert.equal(change.source_amount_input, 0.00000125);
  assert.equal(change.source_amount_output, 0.000004);
  assert.equal(change.source_unit, 'per_token');
  assert.equal(change.source_currency, 'USD');
  assert.equal(change.price_source_url, 'https://openrouter.ai/api/v1/models');
});

test('deriveUsdPerMillion requires complete conversion evidence for non USD', () => {
  // USD per token converts without a rate.
  assert.deepEqual(
    lanes.deriveUsdPerMillion({
      sourceAmountInput: 0.000001, sourceAmountOutput: 0.000002,
      sourceUnit: 'per_token', sourceCurrency: 'USD',
      conversionRate: null, conversionSource: null, conversionConfirmedAt: null,
    }),
    { inputPerM: 1, outputPerM: 2 }
  );
  // USD per million passes through.
  assert.deepEqual(
    lanes.deriveUsdPerMillion({
      sourceAmountInput: 0.1, sourceAmountOutput: 0.2,
      sourceUnit: 'per_million_tokens', sourceCurrency: 'USD',
      conversionRate: null, conversionSource: null, conversionConfirmedAt: null,
    }),
    { inputPerM: 0.1, outputPerM: 0.2 }
  );
  // JPY with complete evidence converts.
  assert.deepEqual(
    lanes.deriveUsdPerMillion({
      sourceAmountInput: 50, sourceAmountOutput: 100,
      sourceUnit: 'per_million_tokens', sourceCurrency: 'JPY',
      conversionRate: 0.0067, conversionSource: 'https://example.test/rates',
      conversionConfirmedAt: '2026-08-01T00:00:00.000Z',
    }),
    { inputPerM: 0.335, outputPerM: 0.67 }
  );
  // Missing rate, source, or time never converts.
  assert.equal(
    lanes.deriveUsdPerMillion({
      sourceAmountInput: 50, sourceAmountOutput: 100,
      sourceUnit: 'per_million_tokens', sourceCurrency: 'JPY',
      conversionRate: null, conversionSource: 'https://example.test/rates',
      conversionConfirmedAt: '2026-08-01T00:00:00.000Z',
    }),
    null
  );
  assert.equal(
    lanes.deriveUsdPerMillion({
      sourceAmountInput: 50, sourceAmountOutput: 100,
      sourceUnit: 'per_million_tokens', sourceCurrency: 'JPY',
      conversionRate: 0.0067, conversionSource: 'not a url',
      conversionConfirmedAt: '2026-08-01T00:00:00.000Z',
    }),
    null
  );
  assert.equal(
    lanes.deriveUsdPerMillion({
      sourceAmountInput: 50, sourceAmountOutput: 100,
      sourceUnit: 'per_million_tokens', sourceCurrency: 'JPY',
      conversionRate: 0.0067, conversionSource: 'https://example.test/rates',
      conversionConfirmedAt: 'not-a-date',
    }),
    null
  );
  // Non token units never convert.
  assert.equal(
    lanes.deriveUsdPerMillion({
      sourceAmountInput: 1, sourceAmountOutput: 2,
      sourceUnit: 'per_request', sourceCurrency: 'USD',
      conversionRate: null, conversionSource: null, conversionConfirmedAt: null,
    }),
    null
  );
  // A worker supplied USD total is never used as the derivation.
  assert.equal(
    lanes.deriveUsdPerMillion({
      sourceAmountInput: null, sourceAmountOutput: null,
      sourceUnit: 'per_token', sourceCurrency: 'USD',
      conversionRate: null, conversionSource: null, conversionConfirmedAt: null,
    }),
    null
  );
});

test('applyStructuredPrices ignores worker supplied price_verified_at and *_price_usd', () => {
  const change = {};
  const priceEvidence = lanes.applyStructuredPrices(change, {
    model_id: 'acme/m',
    _price_evidence_verified: true,
    source_amount_input: 0.000001,
    source_amount_output: 0.000002,
    source_currency: 'USD',
    source_unit: 'per_token',
    price_source_url: 'https://example.test/pricing',
    effective_input_price_usd: 999,
    effective_output_price_usd: 999,
    price_verified_at: '2020-01-01T00:00:00.000Z',
  });
  assert.equal(priceEvidence, true);
  assert.equal(change.effective_input_price_usd, 1);
  assert.equal(change.effective_output_price_usd, 2);
  assert.equal(change.price_verified_at, undefined, 'worker supplied date is ignored');
  assert.equal(change.normal_input_price_usd, 1);
});

test('applyStructuredPrices returns false when no price evidence and keeps prior date', () => {
  const change = { price_verified_at: '2026-07-28T00:00:00.000Z' };
  const priceEvidence = lanes.applyStructuredPrices(change, {
    model_id: 'acme/m',
    source_currency: 'USD',
    source_unit: 'per_token',
  });
  assert.equal(priceEvidence, false);
  assert.equal(change.price_verified_at, '2026-07-28T00:00:00.000Z', 'prior date is preserved');
  assert.equal(change.effective_input_price_usd, undefined);
});

test('a catalog model at per-token prices that normalize over the limit is never admitted', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);

  // Kimi K3 style: 0.000003 / 0.000015 per token = 3 / 15 per million.
  const { reduce } = runCycle(ctx, 'run-over-limit', {
    'catalog:openrouter': catalogArtifact({ models: [
      {
        model_id: 'moonshotai/kimi-k3',
        model_name: 'moonshotai/kimi-k3',
        pricing: { prompt: '0.000003', completion: '0.000015' },
        prompt_price: 0.000003,
        completion_price: 0.000015,
        is_free: false,
        pricing_hash: 'x'.repeat(64),
      },
    ] }),
  });

  // No offer row is created for a model whose normalized price is over limit.
  const row = offerRow(ctx, 'openrouter', 'moonshotai/kimi-k3');
  assert.equal(row, null);
  assert.equal(reduce.offerChanges.length, 0);
});

// ── Data policy re-verification (spec 0008 Phase 3) ──────────────────────

test('known refresh stores data policy condition facts on verification', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({})]);
  const policy = 'We may use prompts to improve the service on free tier.';
  runCycle(ctx, 'run-dp-store', {
    'known:google': knownArtifact({
      models: [knownModel('gemini-2.5-pro-free', {
        data_policy_text: policy,
        data_policy_url: 'https://ai.google.dev/gemini-api/docs/data-governance',
      })],
    }),
  });
  const row = offerRow(ctx, 'google', 'gemini-2.5-pro-free');
  assert.equal(row.status, 'verified');
  assert.equal(row.data_policy_hash, db.pricingHashFromText(policy));
  assert.deepEqual(row.data_policy_json, {
    text: policy,
    url: 'https://ai.google.dev/gemini-api/docs/data-governance',
  });
  assert.equal(row.data_policy_verified_at, '2026-07-31T00:00:00.000Z');
});

test('an omitted data policy keeps the prior value (fail-safe carry over)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({})]);
  const priorPolicy = 'No training use, one year retention.';
  db.setOfferConditionFacts('google', 'gemini-2.5-pro-free', {
    data_policy_json: { text: priorPolicy, url: 'https://ai.google.dev/gemini-api/docs/data-governance' },
    data_policy_hash: db.pricingHashFromText(priorPolicy),
    data_policy_verified_at: '2026-07-20T00:00:00.000Z',
  }, ctx.options);
  runCycle(ctx, 'run-dp-carry', {
    'known:google': knownArtifact({
      models: [knownModel('gemini-2.5-pro-free')],
    }),
  });
  const row = offerRow(ctx, 'google', 'gemini-2.5-pro-free');
  assert.equal(row.status, 'verified');
  assert.equal(row.data_policy_hash, db.pricingHashFromText(priorPolicy), 'prior hash carried over');
  assert.equal(row.data_policy_json.text, priorPolicy, 'prior text carried over');
  assert.equal(row.data_policy_verified_at, '2026-07-20T00:00:00.000Z', 'verification date unchanged');
});

test('a failed known refresh keeps the data policy and marks stale', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed({})]);
  const priorPolicy = 'No training use, one year retention.';
  db.setOfferConditionFacts('google', 'gemini-2.5-pro-free', {
    data_policy_json: { text: priorPolicy, url: 'https://ai.google.dev/gemini-api/docs/data-governance' },
    data_policy_hash: db.pricingHashFromText(priorPolicy),
    data_policy_verified_at: '2026-07-20T00:00:00.000Z',
  }, ctx.options);
  runCycle(ctx, 'run-dp-fail', {
    'known:google': { task_id: 'known:google', status: 'failed', error: { message: 'fetch failed' } },
  });
  const row = offerRow(ctx, 'google', 'gemini-2.5-pro-free');
  assert.equal(row.status, 'stale');
  assert.equal(row.data_policy_hash, db.pricingHashFromText(priorPolicy));
});

// ── 0013 price-index lane (deterministic discount lane, no LLM) ──────

function priceIndexArtifact({ vercelInput, vercelOutput } = {}) {
  const vi = vercelInput === undefined ? 2.5 : vercelInput;
  const vo = vercelOutput === undefined ? 15 : vercelOutput;
  return {
    schema_version: 1,
    task_id: 'price_index:llmpricing',
    kind: 'price_index',
    provider_key: null,
    status: 'complete',
    available: true,
    source: 'https://llmpricing.dev/api/models.json',
    synced_at: '2026-08-20T02:00:00.000Z',
    license: 'CC-BY-4.0',
    index_model_count: 1,
    models: [{
      model_id: 'openai/gpt-5.6-sol',
      name: 'GPT-5.6 Sol',
      lab: 'openai',
      url: 'https://llmpricing.dev/m/openai%2Fgpt-5.6-sol/',
      release_date: '2026-07-09',
      usage_rank: 5,
      reference: { provider: 'openai', input: 5, output: 30 },
      cheapest: { provider: 'vercel', input: vi, output: vo, official: false },
      quotes: [
        { provider: 'openai', modelId: 'gpt-5.6-sol', input: 5, output: 30, cacheRead: 0.5, official: true, context: 1050000 },
        { provider: 'vercel', modelId: 'openai/gpt-5.6-sol', input: vi, output: vo, cacheRead: 0.25, official: false, context: 1050000 },
        // Catalog-owned provider (openrouter) and unregistered host quotes
        // must never create or mutate offers here.
        { provider: 'openrouter', modelId: 'openai/gpt-5.6-sol', input: 2.5, output: 15, official: false },
        { provider: 'unknown-host', modelId: 'openai/gpt-5.6-sol', input: 0.5, output: 2, official: false },
      ],
    }],
    fetches: [],
    errors: [],
  };
}

function priceIndexEmptyArtifact() {
  return {
    schema_version: 1,
    task_id: 'price_index:llmpricing',
    kind: 'price_index',
    provider_key: null,
    status: 'complete',
    available: true,
    source: 'https://llmpricing.dev/api/models.json',
    synced_at: '2026-08-21T02:00:00.000Z',
    license: 'CC-BY-4.0',
    index_model_count: 0,
    models: [],
    fetches: [],
    errors: [],
  };
}

function solSeed(overrides = {}) {
  return {
    provider_key: 'vercel',
    exact_model_id: 'openai/gpt-5.6-sol',
    canonical_model_id: 'openai/gpt-5.6-sol',
    source_kind: 'price_index',
    status: 'confirmed_removed',
    consecutive_failures: 0,
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_attempted_at: '2026-08-01T00:00:00.000Z',
    last_verified_at: null,
    pricing_hash: null,
    removal_evidence_json: {
      reason: 'official catalog pricing is no longer free or ultra low',
      source_url: null,
      task_id: 'catalog:old',
      run_id: 'old-run',
      observed_at: '2026-08-01T00:00:00.000Z',
    },
    facts_json: { name: 'GPT-5.6 Sol' },
    ...overrides,
  };
}

test('price index lane revives a confirmed_removed frontier offer as a verified discount', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  db.upsertModel('openai/gpt-5.6-sol', { name: 'GPT-5.6 Sol', frontier: true }, ctx.options);
  seedOffers(ctx, [solSeed({})]);
  runCycle(ctx, 'run-pi-revive', { 'price_index:llmpricing': priceIndexArtifact() });
  const row = offerRow(ctx, 'vercel', 'openai/gpt-5.6-sol');
  assert.equal(row.status, 'verified');
  assert.equal(row.source_kind, 'price_index');
  assert.equal(row.removal_evidence_json, null);
  // Normal = official reference quote; effective = provider quote (per 1M).
  assert.equal(row.normal_input_price_usd, 5);
  assert.equal(row.normal_output_price_usd, 30);
  assert.equal(row.effective_input_price_usd, 2.5);
  assert.equal(row.effective_output_price_usd, 15);
  assert.equal(row.source_unit, 'per_million_tokens');
  assert.ok(row.price_verified_at, 'price confirmation date set on fetched quote evidence');
  assert.match(row.facts_json.pricing_text, /llmpricing\.dev index/);
  assert.equal(row.facts_json.endpoint_source, 'https://vercel.com/docs/ai-gateway');
  assert.equal(row.facts_json.discount_source_url, 'https://llmpricing.dev/m/openai%2Fgpt-5.6-sol/');
  // Catalog-owned and unregistered providers never become offers here.
  assert.equal(offerRow(ctx, 'openrouter', 'openai/gpt-5.6-sol'), null);
  assert.equal(offerRow(ctx, 'unknown-host', 'openai/gpt-5.6-sol'), null);
});

test('price index lane creates a new verified offer for a frontier model with no prior offer', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  db.upsertModel('openai/gpt-5.6-sol', { name: 'GPT-5.6 Sol', frontier: true }, ctx.options);
  runCycle(ctx, 'run-pi-new', { 'price_index:llmpricing': priceIndexArtifact() });
  const row = offerRow(ctx, 'vercel', 'openai/gpt-5.6-sol');
  assert.equal(row.status, 'verified');
  assert.equal(row.canonical_model_id, 'openai/gpt-5.6-sol');
  assert.equal(row.effective_input_price_usd, 2.5);
});

test('price index lane ends a discount once the quote is no longer below the reference', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  db.upsertModel('openai/gpt-5.6-sol', { name: 'GPT-5.6 Sol', frontier: true }, ctx.options);
  runCycle(ctx, 'run-pi-on', { 'price_index:llmpricing': priceIndexArtifact() });
  let row = offerRow(ctx, 'vercel', 'openai/gpt-5.6-sol');
  assert.equal(row.status, 'verified');
  // Next run: vercel back to the official price -> the discount ended.
  runCycle(ctx, 'run-pi-off', { 'price_index:llmpricing': priceIndexArtifact({ vercelInput: 5, vercelOutput: 30 }) });
  row = offerRow(ctx, 'vercel', 'openai/gpt-5.6-sol');
  assert.equal(row.status, 'confirmed_removed');
  assert.match(row.removal_evidence_json.reason, /discount ended/);
});

test('price index lane keeps a verified discount when the model page is absent from the artifact', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  db.upsertModel('openai/gpt-5.6-sol', { name: 'GPT-5.6 Sol', frontier: true }, ctx.options);
  runCycle(ctx, 'run-pi-on', { 'price_index:llmpricing': priceIndexArtifact() });
  assert.equal(offerRow(ctx, 'vercel', 'openai/gpt-5.6-sol').status, 'verified');
  // No model page this run: no evidence, the offer must survive (fail-safe).
  // The known lane still re-verifies it like any other verified offer.
  runCycle(ctx, 'run-pi-absent', {
    'price_index:llmpricing': priceIndexEmptyArtifact(),
    'known:vercel': knownArtifact({
      task_id: 'known:vercel',
      provider_key: 'vercel',
      models: [knownModel('openai/gpt-5.6-sol', {
        base_url: 'https://ai-gateway.vercel.sh/v1',
        endpoint_source: 'https://vercel.com/docs/ai-gateway',
      })],
    }),
  });
  assert.equal(offerRow(ctx, 'vercel', 'openai/gpt-5.6-sol').status, 'verified');
});
