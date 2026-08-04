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
    if (taskId === 'discovery') {
      // Spec 0005: the discovery lane is chunked; the legacy single artifact
      // applies to every discovery chunk task, re-stamped with each task id.
      for (const task of manifest.tasks.filter((t) => t.kind === 'discovery')) {
        writeArtifact(ctx, runDir, task.task_id, { ...artifact, task_id: task.task_id });
      }
    } else {
      writeArtifact(ctx, runDir, taskId, artifact);
    }
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

  // Spec 0005: the discovery lane is chunked (migration seeds 138 sources /
  // 66 terms; default budgets 20/12 and chunks 5/4 give 4 + 3 tasks).
  const discoveryIds = manifest.tasks
    .filter((task) => task.kind === 'discovery')
    .map((task) => task.task_id)
    .sort();
  assert.deepEqual(discoveryIds, [
    'discovery:sources:1', 'discovery:sources:2', 'discovery:sources:3', 'discovery:sources:4',
    'discovery:terms:1', 'discovery:terms:2', 'discovery:terms:3',
  ]);
  assert.deepEqual(
    Object.keys(byId).sort(),
    ['catalog:openrouter', 'known:google', ...discoveryIds].sort()
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
  assert.equal(manifest.lanes.discovery.assigned, discoveryIds.length);
  assert.equal(manifest.lanes.discovery.assigned_sources, 20, 'source budget caps the daily slice');
  assert.equal(manifest.lanes.discovery.assigned_terms, 12, 'term budget caps the daily slice');
  const sourceChunks = discoveryIds.filter((id) => id.startsWith('discovery:sources:'));
  for (const id of sourceChunks) {
    assert.ok(byId[id].discovery_sources.length > 0 && byId[id].discovery_sources.length <= 5);
    assert.deepEqual(byId[id].search_terms, [], 'source chunks carry no terms');
  }

  // startRun accepts the slim rows.
  db.startRun('manifest-run', lanes.toStartRunTasks(manifest), ctx.options);
  const { tasks } = db.loadRunCandidate('manifest-run', ctx.options);
  assert.equal(tasks.length, 2 + discoveryIds.length);
  const known = tasks.find((task) => task.task_id === 'known:google');
  assert.deepEqual(known.assigned_json, ['gemini-2.5-pro-free']);
  const sourceTask = tasks.find((task) => task.task_id === 'discovery:sources:1');
  assert.ok(sourceTask.assigned_json.discovery_sources.length > 0, 'chunk snapshot persists');
  assert.deepEqual(sourceTask.assigned_json.search_terms, []);
});

// ── Discovery assignment (spec 0004 AC-13) ──────────────────────

// Overrides the migration seed rows for one run-local snapshot so ordering and
// inactive exclusion are exercised exactly. Writes the rows directly with the
// same columns migration 0003 created; the tables already exist after setup.
function seedDiscoveryConfig(ctx, { sources, terms, windows }) {
  const database = db.openCollectorDb(ctx.options);
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      if (sources) {
        database.exec('DELETE FROM discovery_sources');
        const insert = database.prepare(
          'INSERT INTO discovery_sources ' +
          '(source_key, category, label, source_url, parent_label, active, priority, ' +
          'added_from, created_at, last_attempted_at, last_success_at, consecutive_failures) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const s of sources) insert.run(
          s.source_key, s.category, s.label, s.source_url ?? null, s.parent_label ?? null,
          s.active, s.priority, s.added_from ?? 'test', s.created_at,
          s.last_attempted_at ?? null, s.last_success_at ?? null, s.consecutive_failures ?? 0
        );
      }
      if (terms) {
        database.exec('DELETE FROM search_terms');
        const insert = database.prepare(
          'INSERT INTO search_terms (category, locale, term, active, priority, added_from, created_at, last_used_at) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        );
        for (const t of terms) insert.run(
          t.category, t.locale, t.term, t.active, t.priority,
          t.added_from ?? 'test', t.created_at, t.last_used_at ?? null
        );
      }
      if (windows) {
        database.exec('DELETE FROM search_windows');
        const insert = database.prepare(
          'INSERT INTO search_windows (window_key, amount, unit, active, priority) ' +
          'VALUES (?, ?, ?, ?, ?)'
        );
        for (const w of windows) insert.run(
          w.window_key, w.amount, w.unit, w.active, w.priority
        );
      }
      database.exec('COMMIT');
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch { /* connection state already reset */ }
      throw err;
    }
  } finally {
    database.close();
  }
}

function seedSource(key, overrides = {}) {
  return {
    source_key: key,
    category: 'community',
    label: key,
    source_url: `https://example.test/${key}`,
    parent_label: null,
    active: 1,
    priority: 100,
    added_from: 'test',
    created_at: '2026-08-01T00:00:00.000Z',
    last_attempted_at: null,
    last_success_at: null,
    consecutive_failures: 0,
    ...overrides,
  };
}

function seedTerm(category, locale, term, overrides = {}) {
  return {
    category,
    locale,
    term,
    active: 1,
    priority: 100,
    added_from: 'test',
    created_at: '2026-08-01T00:00:00.000Z',
    last_used_at: null,
    ...overrides,
  };
}

function seedWindow(key, amount, unit, overrides = {}) {
  return {
    window_key: key,
    amount,
    unit,
    active: 1,
    priority: 100,
    ...overrides,
  };
}

test('the discovery task carries the active discovery assignment snapshot (AC-13)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);

  seedDiscoveryConfig(ctx, {
    sources: [
      seedSource('host:groq', { category: 'host', priority: 7, label: 'Groq' }),
      seedSource('vendor:openai', { category: 'vendor', priority: 1, label: 'OpenAI' }),
      seedSource('vendor:deepseek', {
        category: 'vendor', priority: 1, label: 'DeepSeek',
        last_attempted_at: '2026-07-30T00:00:00.000Z',
      }),
    ],
    terms: [
      seedTerm('offer', 'en', 'free API', { priority: 5 }),
      seedTerm('new_model', 'ja', '新モデル', { priority: 1 }),
      seedTerm('new_model', 'en', 'new model', { priority: 1 }),
    ],
    windows: [
      seedWindow('30d', 30, 'day', { priority: 2 }),
      seedWindow('24h', 24, 'hour', { priority: 0 }),
      seedWindow('72h', 72, 'hour', { priority: 1 }),
    ],
  });

  const manifest = lanes.buildLaneManifest(ctx.options);
  const discoveryTasks = manifest.tasks.filter((task) => task.kind === 'discovery');
  const sourcesTask = manifest.tasks.find((task) => task.task_id === 'discovery:sources:1');
  const termsTask = manifest.tasks.find((task) => task.task_id === 'discovery:terms:1');
  assert.ok(sourcesTask, 'one source chunk covers the small assignment');
  assert.ok(termsTask, 'one term chunk covers the small assignment');
  assert.equal(manifest.lanes.discovery.assigned, discoveryTasks.length);
  assert.equal(discoveryTasks.length, 2);

  // Sources: priority ASC, then last_attempted_at ASC with NULL first, then key.
  assert.deepEqual(sourcesTask.discovery_sources.map((s) => s.source_key), [
    'vendor:openai',   // priority 1, NULL attempt sorts before the attempted row
    'vendor:deepseek', // priority 1, attempted 2026-07-30
    'host:groq',       // priority 7
  ]);
  assert.deepEqual(sourcesTask.search_terms, [], 'source chunks carry no terms');

  // Terms: priority ASC, then last_used_at ASC with NULL first, then category/locale/term.
  assert.deepEqual(termsTask.search_terms.map((t) => t.term), [
    'new model', // priority 1, NULL last_used, category new_model < offer
    '新モデル',   // priority 1, NULL last_used, category new_model, ja > en
    'free API',  // priority 5
  ]);
  assert.deepEqual(termsTask.discovery_sources, [], 'term chunks carry no sources');

  // Windows: priority ASC then key; both chunk kinds carry all active windows.
  assert.deepEqual(sourcesTask.search_windows.map((w) => w.window_key), ['24h', '72h', '30d']);
  assert.deepEqual(termsTask.search_windows.map((w) => w.window_key), ['24h', '72h', '30d']);

  // Each row carries its full configuration, not just the key.
  assert.deepEqual(sourcesTask.discovery_sources[0], {
    source_key: 'vendor:openai',
    category: 'vendor',
    label: 'OpenAI',
    source_url: 'https://example.test/vendor:openai',
    parent_label: null,
    active: 1,
    priority: 1,
    added_from: 'test',
    created_at: '2026-08-01T00:00:00.000Z',
    last_attempted_at: null,
    last_success_at: null,
    consecutive_failures: 0,
  });
  assert.deepEqual(termsTask.search_windows[0], {
    window_key: '24h', amount: 24, unit: 'hour', active: 1, priority: 0,
  });
});

test('the discovery assignment excludes inactive rows and orders by last used times (AC-13)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);

  seedDiscoveryConfig(ctx, {
    sources: [
      seedSource('vendor:inactive', { category: 'vendor', active: 0, priority: 1, label: 'Inactive' }),
      seedSource('vendor:old', {
        category: 'vendor', priority: 2, label: 'Old',
        last_attempted_at: '2026-07-01T00:00:00.000Z',
      }),
      seedSource('vendor:newer', {
        category: 'vendor', priority: 2, label: 'Newer',
        last_attempted_at: '2026-07-15T00:00:00.000Z',
      }),
    ],
    terms: [
      seedTerm('new_model', 'en', 'inactive term', { active: 0, priority: 1 }),
      seedTerm('offer', 'any', 'stale term', {
        priority: 1, last_used_at: '2026-07-01T00:00:00.000Z',
      }),
      seedTerm('offer', 'any', 'fresher term', {
        priority: 1, last_used_at: '2026-07-20T00:00:00.000Z',
      }),
    ],
    windows: [
      seedWindow('24h', 24, 'hour', { active: 0, priority: 0 }),
      seedWindow('30d', 30, 'day', { priority: 1 }),
      seedWindow('72h', 72, 'hour', { active: 0, priority: 0 }),
    ],
  });

  const manifest = lanes.buildLaneManifest(ctx.options);
  const sourcesTask = manifest.tasks.find((task) => task.task_id === 'discovery:sources:1');
  const termsTask = manifest.tasks.find((task) => task.task_id === 'discovery:terms:1');
  assert.ok(sourcesTask && termsTask, 'active rows still form one chunk each');

  // Only active rows appear; inactive sources, terms, and windows are excluded.
  assert.deepEqual(sourcesTask.discovery_sources.map((s) => s.source_key), [
    'vendor:old', 'vendor:newer',
  ]);
  assert.deepEqual(termsTask.search_terms.map((t) => t.term), [
    'stale term', 'fresher term',
  ]);
  assert.deepEqual(termsTask.search_windows.map((w) => w.window_key), ['30d']);

  // Same priority: least recently used (last_used_at / last_attempted_at
  // ascending) runs first; NULL would run before any timestamp.
  assert.deepEqual(sourcesTask.discovery_sources.map((s) => s.label), ['Old', 'Newer']);
});

test('an empty discovery assignment is a valid snapshot with empty arrays', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);

  seedDiscoveryConfig(ctx, {
    sources: [seedSource('only:inactive', { active: 0, priority: 0 })],
    terms: [seedTerm('offer', 'any', 'inactive', { active: 0, priority: 0 })],
    windows: [seedWindow('24h', 24, 'hour', { active: 0, priority: 0 })],
  });

  const manifest = lanes.buildLaneManifest(ctx.options);
  assert.equal(
    manifest.tasks.filter((task) => task.kind === 'discovery').length, 0,
    'an empty assignment emits no discovery chunk tasks'
  );
  assert.equal(manifest.lanes.discovery.assigned, 0);
  assert.equal(manifest.lanes.discovery.assigned_sources, 0);
  assert.equal(manifest.lanes.discovery.assigned_terms, 0);
});

test('buildDiscoveryTasks applies budgets and chunk sizes deterministically (spec 0005)', () => {
  const assignment = {
    sources: Array.from({ length: 7 }, (_, i) => ({ source_key: `vendor:s${i}`, priority: i })),
    terms: Array.from({ length: 5 }, (_, i) => ({ term: `t${i}`, priority: i })),
    windows: [{ window_key: '24h', amount: 24, unit: 'hour', active: 1, priority: 0 }],
  };

  const tasks = lanes.buildDiscoveryTasks(assignment, {
    sourceBudget: 5, termBudget: 5, sourceChunk: 2, termChunk: 3,
  });
  assert.deepEqual(tasks.map((task) => task.task_id), [
    'discovery:sources:1', 'discovery:sources:2', 'discovery:sources:3',
    'discovery:terms:1', 'discovery:terms:2',
  ]);
  assert.deepEqual(tasks.map((task) => task.discovery_sources.length), [2, 2, 1, 0, 0]);
  assert.deepEqual(tasks.map((task) => task.search_terms.length), [0, 0, 0, 3, 2]);
  // Budget cuts the tail of the ordered assignment.
  assert.deepEqual(
    tasks.filter((task) => task.task_id.startsWith('discovery:sources:'))
      .flatMap((task) => task.discovery_sources.map((s) => s.source_key)),
    ['vendor:s0', 'vendor:s1', 'vendor:s2', 'vendor:s3', 'vendor:s4']
  );
  // Every chunk carries the full window list.
  for (const task of tasks) {
    assert.deepEqual(task.search_windows.map((w) => w.window_key), ['24h']);
    assert.equal(task.kind, 'discovery');
    assert.equal(task.output, `artifacts/${task.task_id.replace(/:/g, '-')}.json`);
  }

  assert.deepEqual(
    lanes.buildDiscoveryTasks(assignment, { sourceBudget: 0, termBudget: 0, sourceChunk: 2, termChunk: 2 }),
    [],
    'zero budgets emit no discovery tasks'
  );

  const defaults = lanes.discoveryChunkConfig({});
  assert.deepEqual(defaults, { sourceBudget: 20, termBudget: 12, sourceChunk: 5, termChunk: 4 });
  const overridden = lanes.discoveryChunkConfig({
    DISCOVERY_SOURCE_BUDGET: '3', DISCOVERY_TERM_BUDGET: '0',
    DISCOVERY_SOURCE_CHUNK: '1', DISCOVERY_TERM_CHUNK: 'bogus',
  });
  assert.deepEqual(overridden, { sourceBudget: 3, termBudget: 0, sourceChunk: 1, termChunk: 4 });
});

test('chunked discovery assignments union into source and term bookkeeping (spec 0005)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [offerSeed()]);

  seedDiscoveryConfig(ctx, {
    sources: Array.from({ length: 7 }, (_, i) =>
      seedSource(`vendor:chunk-${i}`, { priority: i, label: `Chunk ${i}` })),
    terms: Array.from({ length: 5 }, (_, i) =>
      seedTerm('new_model', 'en', `term-${i}`, { priority: i })),
    windows: [seedWindow('24h', 24, 'hour', { priority: 0 })],
  });

  const { manifest, reduce } = runCycle(ctx, 'run-chunked', {
    'known:google': knownArtifact({ models: [knownModel('gemini-2.5-pro-free')] }),
    discovery: { task_id: 'discovery', status: 'complete', models: [], errors: [] },
  });

  const discoveryTasks = manifest.tasks.filter((task) => task.kind === 'discovery');
  // 7 sources / chunk 5 = 2 source tasks; 5 terms / chunk 4 = 2 term tasks.
  assert.equal(discoveryTasks.length, 4);
  assert.equal(reduce.coverage.discovery.assigned, 4);
  assert.equal(reduce.coverage.discovery.complete, 4);

  // The union of every chunk's assignment snapshot reaches finalizeRun, so
  // each assigned source and term gets its bookkeeping in the same
  // transaction.
  const database = db.openCollectorDb(ctx.options);
  try {
    const attempted = database.prepare(
      "SELECT COUNT(*) AS c FROM discovery_sources WHERE source_key LIKE 'vendor:chunk-%' AND last_attempted_at IS NOT NULL"
    ).get().c;
    assert.equal(attempted, 7, 'every assigned source is marked attempted');
    const used = database.prepare(
      "SELECT COUNT(*) AS c FROM search_terms WHERE term LIKE 'term-%' AND last_used_at IS NOT NULL"
    ).get().c;
    assert.equal(used, 5, 'every assigned term is marked used');
  } finally {
    database.close();
  }
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
  for (const task of manifest.tasks.filter((tt) => tt.kind === 'discovery')) {
    writeArtifact(ctx, runDir, task.task_id, { task_id: task.task_id, status: 'failed', models: [], errors: ['nothing found'] });
  }

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
  for (const task of manifest.tasks.filter((tt) => tt.kind === 'discovery')) {
    writeArtifact(ctx, runDir2, task.task_id, { task_id: task.task_id, status: 'complete', models: [] });
  }
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
  });

  const row = offerRow(ctx, 'openrouter', 'acme/a:free');
  assert.equal(row.status, 'confirmed_removed');
  assert.equal(row.removal_evidence_json.reason, 'official catalog pricing is no longer free or ultra low');
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
  });
  assert.equal(offerRow(ctx, 'openrouter', 'acme/a:free').status, 'confirmed_removed');

  // Later the price drops back to free: the offer returns to verified.
  runCycle(ctx, 'run-decrease', {
    'catalog:openrouter': catalogArtifact({ models: [catalogModel('acme/a:free', { free: true })] }),
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
        { model_id: 'model-two', source_url: 'https://ai.google.dev/announcement', reason: 'free API ended on 2026-07-30', _evidence_verified: true },
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
      discovery: { task_id: 'discovery', status: 'complete', models: [] },
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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
  });
  assert.equal(offerRow(contradictionCtx, 'google', 'model-two').status, 'stale');
  fs.rmSync(contradictionCtx.root, { recursive: true, force: true });
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

  assert.ok(reduce.coverage.discovery.assigned > 0, 'chunked discovery tasks exist');
  assert.equal(reduce.coverage.discovery.failed, reduce.coverage.discovery.assigned,
    'every chunk failure is counted');
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

  const { manifest, runDir, reduce } = runCycle(ctx, 'run-out', {
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
  const discoveryCount = manifest.tasks.filter((task) => task.kind === 'discovery').length;
  assert.deepEqual(coverage.coverage.discovery, {
    assigned: discoveryCount, complete: discoveryCount, partial: 0, failed: 0,
  });
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
    'known:google': knownArtifact({ models: [knownModel('model-one')] }),
    discovery: {
      task_id: 'discovery', status: 'complete', models: [],
      provider_candidates: [{
        provider_key: 'neonstack',
        label: 'NeonStack AI',
        base_url: 'https://api.neonstack.example/v1',
        docs_url: 'https://docs.neonstack.example/quickstart',
        model_id_pattern: '^neonstack/[a-z0-9-]+$',
        delivery_type: 'official',
      }],
    },
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
    'known:google': knownArtifact({ models: [knownModel('model-one')] }),
    discovery: {
      task_id: 'discovery', status: 'complete', models: [],
      provider_candidates: [
        { provider_key: 'no-label', base_url: 'https://x.example/v1', docs_url: 'https://docs.x.example', model_id_pattern: '^x/' },
        { provider_key: 'Bad Key!', label: 'Bad', base_url: 'https://bad.example/v1', docs_url: 'https://docs.bad.example', model_id_pattern: '^bad/' },
        { provider_key: 'openrouter', label: 'Duplicate', base_url: 'https://openrouter.ai/api/v1', docs_url: 'https://openrouter.ai/docs/quickstart', model_id_pattern: '^openrouter/' },
        { provider_key: 'nobase', label: 'No Base', base_url: 'not-a-url', docs_url: 'https://docs.nobase.example', model_id_pattern: '^nb/' },
      ],
    },
  });

  assert.equal(reduce.providerCandidates.length, 4);
  for (const candidate of reduce.providerCandidates) {
    assert.equal(candidate.accepted, false, `${candidate.provider_key} must be rejected`);
  }
  const registry = JSON.parse(fs.readFileSync(
    path.join(ctx.root, 'build', 'provider-registry.json'), 'utf8'
  ));
  assert.equal(registry.providers.length, 2, 'canonical registry unchanged');
  assert.equal(registry.providers.some((p) => p.key === 'Bad Key!'), false);
});

// ── Discovery source growth (spec 0004 AC-10) ───────────────────

test('a validated discovery source candidate enters SQLite idempotently (AC-10)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'google', exact_model_id: 'model-one' }),
  ]);

  const sourceCandidate = {
    category: 'community',
    label: 'r/NewModelHub',
    source_url: 'https://reddit.com/r/NewModelHub',
    reason: 'found a new model announcement',
  };

  runCycle(ctx, 'run-source-1', {
    'known:google': knownArtifact({ models: [knownModel('model-one')] }),
    discovery: {
      task_id: 'discovery', status: 'complete', models: [],
      source_candidates: [sourceCandidate],
    },
  });

  const database = db.openCollectorDb(ctx.options);
  let row;
  try {
    row = database.prepare(
      "SELECT * FROM discovery_sources WHERE source_key = 'community:r-newmodelhub'"
    ).get();
  } finally {
    database.close();
  }
  assert.ok(row, 'source row was inserted');
  assert.equal(row.label, 'r/NewModelHub');
  assert.equal(row.source_url, 'https://reddit.com/r/NewModelHub');
  assert.equal(row.consecutive_failures, 0);

  // Second run with the same candidate: idempotent, no duplicate.
  runCycle(ctx, 'run-source-2', {
    'known:google': knownArtifact({ models: [knownModel('model-one')] }),
    discovery: {
      task_id: 'discovery', status: 'complete', models: [],
      source_candidates: [sourceCandidate],
    },
  });
  const database2 = db.openCollectorDb(ctx.options);
  try {
    const count = database2.prepare(
      "SELECT COUNT(*) AS c FROM discovery_sources WHERE source_key = 'community:r-newmodelhub'"
    ).get().c;
    assert.equal(count, 1, 'duplicate import is harmless');
  } finally {
    database2.close();
  }
});

test('a malformed source candidate never enters SQLite (AC-10)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seedOffers(ctx, [
    offerSeed({ provider_key: 'google', exact_model_id: 'model-one' }),
  ]);

  const { reduce } = runCycle(ctx, 'run-bad-source', {
    'known:google': knownArtifact({ models: [knownModel('model-one')] }),
    discovery: {
      task_id: 'discovery', status: 'complete', models: [],
      source_candidates: [
        { category: 'community', label: 'No URL' },
        { category: 'community', label: 'Bad URL', source_url: 'not-a-url' },
        { category: 'community', label: '', source_url: 'https://x.example' },
      ],
    },
  });

  assert.equal(reduce.sourceCandidates.length, 0);
  const database = db.openCollectorDb(ctx.options);
  try {
    const count = database.prepare('SELECT COUNT(*) AS c FROM discovery_sources').get().c;
    assert.equal(count, 138, 'only the migration seed rows exist; malformed candidates never enter');
  } finally {
    database.close();
  }
});

// ── Spec 0004 pricing unit normalization and conversion (AC-3, AC-4, AC-8) ──

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
    discovery: { task_id: 'discovery', status: 'complete', models: [] },
  });

  // No offer row is created for a model whose normalized price is over limit.
  const row = offerRow(ctx, 'openrouter', 'moonshotai/kimi-k3');
  assert.equal(row, null);
  assert.equal(reduce.offerChanges.length, 0);
});

test('a source candidate with an unknown category is rejected, never crashes finalize', () => {
  const check = lanes.validateSourceCandidate({
    category: 'official',
    label: 'Official Docs',
    source_url: 'https://example.test/docs',
  });
  assert.equal(check.ok, false);
  assert.match(check.reason, /category/);
});

test('a source candidate category defaults to other and is accepted', () => {
  const check = lanes.validateSourceCandidate({
    label: 'Mystery',
    source_url: 'https://example.test/mystery',
  });
  assert.equal(check.ok, true);
  assert.equal(check.entry.category, 'other');
});
