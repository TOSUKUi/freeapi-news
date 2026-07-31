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

const db = require('./collector-db');
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

test('buildLaneManifest splits catalog, known refresh, and discovery lanes', (t) => {
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

  assert.deepEqual(Object.keys(byId).sort(), ['catalog:openrouter', 'discovery', 'known:google']);

  assert.equal(byId['catalog:openrouter'].kind, 'catalog');
  assert.deepEqual(byId['catalog:openrouter'].assigned_model_ids, ['acme/a:free', 'acme/b:free'], 'stale offers are still assigned');
  assert.equal(byId['catalog:openrouter'].api_catalog_url, 'https://openrouter.ai/api/v1/models');

  assert.equal(byId['known:google'].kind, 'known_refresh');
  assert.deepEqual(byId['known:google'].assigned_model_ids, ['gemini-2.5-pro-free'], 'confirmed_removed offers are never assigned');
  assert.equal(byId['known:google'].cached_urls.length, 1);
  assert.equal(byId['known:google'].cached_urls[0].url, 'https://ai.google.dev/gemini-api/docs/pricing');

  assert.equal(byId.discovery.kind, 'discovery');
  assert.equal(manifest.lanes.known.assigned_offers, 3);
  assert.deepEqual(manifest.lanes.catalog.providers, ['openrouter']);

  // startRun accepts the slim rows.
  db.startRun('manifest-run', lanes.toStartRunTasks(manifest), ctx.options);
  const { tasks } = db.loadRunCandidate('manifest-run', ctx.options);
  assert.equal(tasks.length, 3);
  const known = tasks.find((task) => task.task_id === 'known:google');
  assert.deepEqual(known.assigned_json, ['gemini-2.5-pro-free']);
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
  // discovery omits an assigned offer while claiming complete... discovery
  // has no assignment; use a second run for the demotion case instead.
  writeArtifact(ctx, runDir, 'discovery', { task_id: 'discovery', status: 'failed', models: [], errors: ['nothing found'] });

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
  writeArtifact(ctx, runDir2, 'discovery', { task_id: 'discovery', status: 'complete', models: [] });
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
  // known:google, and discovery all lack artifacts.
  assert.equal(summary.recorded.length, 3);
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
    discovery: { task_id: 'discovery', status: 'failed', models: [], errors: [] },
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
  assert.deepEqual(newlyAdmitted.facts_json.free_model_names, ['acme/a:free', 'acme/new:free']);
  assert.equal(newlyAdmitted.facts_json.endpoint_source, 'https://openrouter.ai/docs/quickstart');
  assert.equal(newlyAdmitted.facts_json.rate_limits, undefined);

  // The successful catalog fetch became cache evidence (AC-16).
  assert.equal(reduce.sourceCache.length, 1);
  assert.equal(reduce.sourceCache[0].subject_key, 'catalog:openrouter');
});

test('a successful catalog persists the complete sorted free ID list on every admitted offer', (t) => {
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
  });

  const expected = ['alpha/model:free', 'openrouter/free', 'zeta/model:free'];
  for (const exactModelId of expected) {
    const row = offerRow(ctx, 'openrouter', exactModelId);
    assert.equal(row.status, 'verified');
    assert.equal(row.source_kind, 'catalog');
    assert.equal(row.canonical_model_id, db.canonicalModelId(exactModelId));
    assert.deepEqual(row.facts_json.free_model_names, expected);
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
  });

  const row = offerRow(ctx, 'openrouter', 'acme/a:free');
  assert.equal(row.status, 'confirmed_removed');
  assert.equal(row.removal_evidence_json.reason, 'official catalog pricing is no longer free');
  assert.deepEqual(row.removal_evidence_json.pricing, { prompt: '0.5', completion: '1.5' });
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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

test('a changed pricing hash verifies the offer and queues a pricing change candidate', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'openrouter', exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a', pricing_hash: 'old'.padEnd(64, '0') }),
  ]);

  const { reduce } = runCycle(ctx, 'run-price', {
    'catalog:openrouter': catalogArtifact({ models: [catalogModel('acme/a:free', { pricingHash: 'new'.padEnd(64, '1') })] }),
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
        { model_id: 'model-two', source_url: 'https://ai.google.dev/announcement', reason: 'free API ended on 2026-07-30' },
      ],
    }),
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
  });
  const row2 = offerRow(ctx2, 'google', 'model-two');
  assert.equal(row2.status, 'stale');
  assert.equal(row2.removal_evidence_json, null);
  fs.rmSync(ctx2.root, { recursive: true, force: true });
});

// ── Discovery isolation (AC-2) ───────────────────────────────────

test('discovery failure never removes or changes a known offer (AC-2)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);

  const { reduce } = runCycle(ctx, 'run-disc-fail', {
    'known:google': knownArtifact({ models: [knownModel('gemini-2.5-pro-free')] }),
    discovery: { task_id: 'discovery', status: 'failed', models: [], errors: ['search quota exhausted'] },
  });

  assert.equal(reduce.coverage.discovery.failed, 1);
  assert.equal(reduce.canPromote, true, 'discovery failure does not block promotion');
  const row = offerRow(ctx, 'google', 'gemini-2.5-pro-free');
  assert.equal(row.status, 'verified');
  assert.equal(row.consecutive_failures, 0);
});

test('discovery models matching known offers are not duplicated into candidates (AC-2)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);

  const { reduce } = runCycle(ctx, 'run-disc', {
    'known:google': knownArtifact({ models: [knownModel('gemini-2.5-pro-free')] }),
    discovery: {
      task_id: 'discovery',
      status: 'complete',
      models: [
        { model_id: 'gemini-2.5-pro-free', provider_key: 'google', model_name: 'known one' },
        { model_id: 'brand-new-model', provider_key: 'google', model_name: 'Brand New' },
      ],
    },
  });

  assert.equal(reduce.discoveryCandidates.length, 1);
  assert.equal(reduce.discoveryCandidates[0].exact_model_id, 'brand-new-model');
  assert.equal(reduce.discoveryCandidates[0].source, 'discovery');
});

// ── Promotion gate (AC-4) ────────────────────────────────────────

test('zero verified known offers with assignments blocks promotion but persists stale state (AC-4)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);

  const { reduce } = runCycle(ctx, 'run-gate', {
    'known:google': knownArtifact({ status: 'failed', models: [], errors: ['all pages down'] }),
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
    discovery: { task_id: 'discovery', status: 'failed', models: [], errors: [] },
  });
  assert.equal(ok.manifest.lanes.known.assigned_offers, 0);
  assert.equal(ok.reduce.canPromote, true);
  assert.equal(ok.reduce.run.status, 'candidate_ready');

  // Catalog unavailable blocks the bootstrap promotion.
  const ctx2 = tmpProject();
  setup(ctx2);
  const bad = runCycle(ctx2, 'run-boot-bad', {
    'catalog:openrouter': catalogArtifact({ status: 'failed', available: false, models: [], errors: ['HTTP 500'] }),
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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

  const { runDir, reduce } = runCycle(ctx, 'run-out', {
    'catalog:openrouter': catalogArtifact({ models: [catalogModel('acme/a:free')] }),
    'known:google': knownArtifact({ models: [knownModel('model-one')] }),
    discovery: { task_id: 'discovery', status: 'complete', models: [{ model_id: 'fresh', provider_key: 'google' }] },
  });

  const coverageFile = path.join(runDir, 'reduced', 'lane-coverage.json');
  const candidatesFile = path.join(runDir, 'reduced', 'discovery-candidates.json');
  assert.ok(fs.existsSync(coverageFile));
  assert.ok(fs.existsSync(candidatesFile));

  const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
  assert.equal(coverage.can_promote, true);
  assert.deepEqual(coverage.coverage.known, { assigned: 2, verified: 2, stale: 0, removed: 0, failed: 0 });
  assert.deepEqual(coverage.coverage.discovery, { assigned: 1, complete: 1, partial: 0, failed: 0 });
  assert.deepEqual(coverage.coverage.catalog.available, ['openrouter']);

  const candidates = JSON.parse(fs.readFileSync(candidatesFile, 'utf8'));
  assert.equal(candidates.candidates.length, 1);
  assert.equal(candidates.candidates[0].exact_model_id, 'fresh');
  assert.equal(reduce.run.status, 'candidate_ready');
});
