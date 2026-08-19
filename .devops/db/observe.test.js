'use strict';

// Spec 0008 Phase 2 acceptance tests: operational evidence (Gate 3), the
// router endpoints observer, NIM verification, contradictions, the diff
// engine's discount campaign records, and the DISCOUNTED frontier section.
// Every test runs in a fresh temp directory and never touches live state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('./collector-db');
const assemble = require('./assemble');
const observe = require('./observe');

const FIXTURE_REGISTRY = {
  version: 1,
  providers: [
    {
      key: 'openrouter',
      label: 'OpenRouter',
      match: ['openrouter'],
      base_url: 'https://openrouter.ai/api/v1',
      docs_url: 'https://openrouter.ai/docs/quickstart',
      delivery_type: 'router',
      api_catalog_url: 'https://openrouter.ai/api/v1/models',
    },
    {
      key: 'google',
      label: 'Google Gemini',
      match: ['google', 'gemini'],
      base_url: 'https://generativelanguage.googleapis.com/v1beta',
      docs_url: 'https://ai.google.dev/gemini-api/docs',
      delivery_type: 'official',
    },
    {
      key: 'nvidia',
      label: 'NVIDIA NIM',
      match: ['nvidia', 'nim'],
      base_url: 'https://integrate.api.nvidia.com/v1',
      docs_url: 'https://docs.nvidia.com/nim/large-language-models/latest/quick-start.html',
      delivery_type: 'official',
      api_catalog_url: 'https://integrate.api.nvidia.com/v1/models',
    },
  ],
};

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-observe-test-'));
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

function seed(ctx, { offers = [], benchmarks = [], runId = 'seed' }) {
  db.startRun(runId, [], ctx.options);
  db.finalizeRun(runId, { offers, benchmarks, runStatus: 'promoted' }, ctx.options);
}

function offerSeed(overrides = {}) {
  return {
    provider_key: 'google',
    exact_model_id: 'frontier-x',
    canonical_model_id: 'acme/frontier-x',
    source_kind: 'official_page',
    status: 'verified',
    consecutive_failures: 0,
    first_seen_at: '2026-07-01T00:00:00.000Z',
    last_attempted_at: '2026-08-18T00:00:00.000Z',
    last_verified_at: '2026-08-18T00:00:00.000Z',
    pricing_hash: null,
    removal_evidence_json: null,
    normal_input_price_usd: 15,
    normal_output_price_usd: 30,
    effective_input_price_usd: 7.5,
    effective_output_price_usd: 15,
    source_currency: 'USD',
    source_unit: 'per_million_tokens',
    price_source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
    price_verified_at: '2026-08-18T00:00:00.000Z',
    facts_json: {
      model_name: 'Frontier X',
      pricing_text: 'Launch pricing: $7.50 per million input tokens (normally $15.00)',
      endpoint_source: 'https://ai.google.dev/gemini-api/docs',
    },
    ...overrides,
  };
}

function benchRow(canonical, score, overrides = {}) {
  return {
    canonical_model_id: canonical,
    benchmark_key: 'terminal_bench_2_1',
    display_name: 'Terminal-Bench 2.1',
    version: '2.1',
    score,
    source_url: 'https://leaderboard.example/terminal-bench',
    source_hash: 'h'.repeat(64),
    verified_at: '2026-07-30T00:00:00.000Z',
    facts_json: { origin: 'test' },
    ...overrides,
  };
}

function runDirFor(ctx, runId) {
  const dir = path.join(ctx.stateDir, 'crawl', runId);
  fs.mkdirSync(path.join(dir, 'candidate'), { recursive: true });
  return dir;
}

// A models row flagged frontier (as rederiveFrontier would write it).
function frontierModel(ctx, canonical, overrides = {}) {
  db.upsertModel(canonical, {
    display_name: canonical,
    frontier: 1,
    ...overrides,
  }, ctx.options);
}

// ── DISCOUNTED admission (§4.11) ────────────────────────────────────────

test('an expensive frontier model at a discount lands in discount_offers, never ranked', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  frontierModel(ctx, 'acme/frontier-x');
  seed(ctx, {
    offers: [offerSeed({
      discount_start_at: '2026-08-01',
      discount_end_at: '2026-08-31',
    })],
  });
  const runDir = runDirFor(ctx, 'run-discount');
  const { report } = assemble.assembleReport('run-discount', runDir, ctx.options);

  assert.equal(report.discount_offers.length, 1, 'one discount offer');
  const discount = report.discount_offers[0];
  assert.equal(discount.name, 'Frontier X');
  assert.equal(discount.access_kind, 'DISCOUNTED');
  assert.equal(discount.ranking_eligible, false);
  assert.deepEqual(discount.discount_rates, { input: 50, output: 50 });
  assert.equal(discount.normal_price_per_million.input, 15);
  assert.equal(discount.effective_price_per_million.input, 7.5);
  assert.equal(discount.discount_start_at, '2026-08-01');
  assert.equal(discount.discount_end_at, '2026-08-31');
  // Never in the free ranking.
  assert.deepEqual(report.ranked_offers, [], 'discounted offers are not ranked');
});

test('a non-frontier discounted model is not DISCOUNTED', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  // models row without the frontier flag.
  db.upsertModel('acme/frontier-x', { display_name: 'Frontier X' }, ctx.options);
  seed(ctx, {
    offers: [offerSeed({
      discount_start_at: '2026-08-01',
      discount_end_at: '2026-08-31',
    })],
  });
  const runDir = runDirFor(ctx, 'run-nodiscount');
  const { report } = assemble.assembleReport('run-nodiscount', runDir, ctx.options);
  assert.deepEqual(report.discount_offers, [], 'no frontier flag, no discount section entry');
  const excludedNames = report.excluded_offers.map((e) => e.name);
  assert.ok(excludedNames.includes('Frontier X'), 'the offer is excluded, not ranked');
});

test('a discount without window or normal price citation is not admitted', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  frontierModel(ctx, 'acme/frontier-x');
  seed(ctx, {
    offers: [offerSeed({
      facts_json: { model_name: 'Frontier X', endpoint_source: 'https://ai.google.dev/gemini-api/docs' },
      discount_start_at: null,
      discount_end_at: null,
    })],
  });
  const runDir = runDirFor(ctx, 'run-noevidence');
  const { report } = assemble.assembleReport('run-noevidence', runDir, ctx.options);
  assert.deepEqual(report.discount_offers, [], 'no discount evidence, no admission');
});

// ── Discount campaign change records (§4.11) ────────────────────────────

test('a discount rate change (65% to 77%) emits a before/after change record', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  frontierModel(ctx, 'acme/frontier-x');
  // Prior run: 65% off (15 -> 5.25 / 30 -> 10.5).
  seed(ctx, {
    runId: 'prior',
    offers: [offerSeed({
      effective_input_price_usd: 5.25,
      effective_output_price_usd: 10.5,
      discount_start_at: '2026-08-01',
      discount_end_at: '2026-08-31',
    })],
  });
  const runDir = runDirFor(ctx, 'run-rate');
  db.copyDatabaseForRun('run-rate', ctx.options);
  // Current run: 77% off (15 -> 3.45 / 30 -> 6.9).
  seed(ctx, {
    runId: 'current',
    offers: [offerSeed({
      effective_input_price_usd: 3.45,
      effective_output_price_usd: 6.9,
      discount_start_at: '2026-08-01',
      discount_end_at: '2026-08-31',
    })],
  });
  const { report } = assemble.assembleReport('run-rate', runDir, ctx.options);
  const change = report.changes.find((c) => c.offer_name === 'Frontier X');
  assert.ok(change, 'a change record exists for Frontier X');
  assert.equal(change.change_type, 'discount_rate_change');
  assert.equal(change.discount_before, 65);
  assert.equal(change.discount_after, 77);
  assert.deepEqual(change.before, { input: 5.25, output: 10.5 });
  assert.deepEqual(change.after, { input: 3.45, output: 6.9 });
});

test('a price returned to normal ends the campaign (campaign_ended)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  frontierModel(ctx, 'acme/frontier-x');
  // Prior run: the discount was live.
  seed(ctx, {
    runId: 'prior',
    offers: [offerSeed({
      discount_start_at: '2026-08-01',
      discount_end_at: '2026-08-31',
    })],
  });
  const runDir = runDirFor(ctx, 'run-ended');
  db.copyDatabaseForRun('run-ended', ctx.options);
  // Current run: the observe phase set the price back to normal and marked
  // the offer confirmed_removed (campaign liveness).
  seed(ctx, {
    runId: 'current',
    offers: [offerSeed({
      effective_input_price_usd: 15,
      effective_output_price_usd: 30,
      status: 'confirmed_removed',
      removal_evidence_json: { reason: 'discount ended', source_url: 'https://ai.google.dev/gemini-api/docs/pricing' },
      discount_start_at: '2026-08-01',
      discount_end_at: '2026-08-31',
    })],
  });
  const { report } = assemble.assembleReport('run-ended', runDir, ctx.options);
  const change = report.changes.find((c) => c.offer_name === 'Frontier X');
  assert.ok(change, 'a change record exists for Frontier X');
  assert.equal(change.change_type, 'campaign_ended');
  assert.deepEqual(report.discount_offers, [], 'the ended discount is not displayed');
});

// ── Gate 3 operational evidence (§4.7) ──────────────────────────────────

test('a $0 router model with a measured zero provider set is excluded', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      // Observed zero providers: listed but not operable.
      offerSeed({
        provider_key: 'openrouter',
        exact_model_id: 'acme/dead:free',
        canonical_model_id: 'acme/dead',
        effective_input_price_usd: 0,
        effective_output_price_usd: 0,
        normal_input_price_usd: 0,
        normal_output_price_usd: 0,
        facts_json: { model_name: 'Dead', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' },
      }),
      // Observed providers + uptime: operable, ranks.
      offerSeed({
        provider_key: 'openrouter',
        exact_model_id: 'acme/live:free',
        canonical_model_id: 'acme/live',
        effective_input_price_usd: 0,
        effective_output_price_usd: 0,
        normal_input_price_usd: 0,
        normal_output_price_usd: 0,
        facts_json: { model_name: 'Live', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' },
      }),
    ],
    benchmarks: [benchRow('acme/dead', 70), benchRow('acme/live', 70)],
  });
  // Operational evidence is observer owned (written by the endpoints
  // observer, not by lane upserts).
  db.setOfferOperationalEvidence('openrouter', 'acme/dead:free',
    { provider_count: 0, uptime_percent: null, activity_evidence: 'router: 0 provider(s)' }, ctx.options);
  db.setOfferOperationalEvidence('openrouter', 'acme/live:free',
    { provider_count: 3, uptime_percent: 99.1, activity_evidence: 'router: 3 provider(s), 1d uptime 99.1%' }, ctx.options);
  const runDir = runDirFor(ctx, 'run-gate3');
  const { report } = assemble.assembleReport('run-gate3', runDir, ctx.options);

  const rankedNames = report.ranked_offers.map((o) => o.name);
  assert.ok(rankedNames.includes('Live'), 'the operable router offer ranks');
  assert.ok(!rankedNames.includes('Dead'), 'the zero provider offer does not rank');
  const deadExclusion = report.excluded_offers.find((e) => e.name === 'Dead');
  assert.ok(deadExclusion, 'Dead is recorded as excluded');
  assert.match(deadExclusion.reason, /gate3/);
  const live = report.ranked_offers.find((o) => o.name === 'Live');
  assert.equal(live.operational_confidence, 'HIGH');
  assert.equal(live.provider_count, 3);
  assert.match(live.operational_evidence, /3 provider/);
});

test('a deprecated NIM free endpoint is removed and never ranked; an available one ranks', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      // The observe phase already applied the NIM verdict: removed.
      offerSeed({
        provider_key: 'nvidia',
        exact_model_id: 'nvidia/dead-nim',
        canonical_model_id: 'nvidia/dead-nim',
        effective_input_price_usd: 0,
        effective_output_price_usd: 0,
        normal_input_price_usd: 0,
        normal_output_price_usd: 0,
        status: 'confirmed_removed',
        facts_json: { model_name: 'Dead NIM', free_quota_text: 'free', endpoint_source: 'https://docs.nvidia.com/nim/large-language-models/latest/quick-start.html' },
      }),
      // Available free endpoint with activity: HIGH.
      offerSeed({
        provider_key: 'nvidia',
        exact_model_id: 'nvidia/live-nim',
        canonical_model_id: 'nvidia/live-nim',
        effective_input_price_usd: 0,
        effective_output_price_usd: 0,
        normal_input_price_usd: 0,
        normal_output_price_usd: 0,
        facts_json: { model_name: 'Live NIM', free_quota_text: 'free', endpoint_source: 'https://docs.nvidia.com/nim/large-language-models/latest/quick-start.html' },
      }),
    ],
    benchmarks: [benchRow('nvidia/dead-nim', 70), benchRow('nvidia/live-nim', 70)],
  });
  db.setOfferOperationalEvidence('nvidia', 'nvidia/dead-nim',
    { free_endpoint_status: 'deprecated', api_calls_30d: 0, activity_evidence: 'NIM free endpoint deprecated on the individual model page' }, ctx.options);
  db.setOfferOperationalEvidence('nvidia', 'nvidia/live-nim',
    { free_endpoint_status: 'available', api_calls_30d: 1234, activity_evidence: 'NIM free endpoint available (API calls last 30 days: 1234)' }, ctx.options);
  const runDir = runDirFor(ctx, 'run-nim');
  const { report } = assemble.assembleReport('run-nim', runDir, ctx.options);

  const rankedNames = report.ranked_offers.map((o) => o.name);
  assert.ok(rankedNames.includes('Live NIM'), 'the available NIM free offer ranks');
  assert.ok(!rankedNames.includes('Dead NIM'), 'the deprecated NIM offer never ranks');
  const live = report.ranked_offers.find((o) => o.name === 'Live NIM');
  assert.equal(live.operational_confidence, 'HIGH');
  assert.equal(live.free_endpoint_status, 'available');
  assert.match(live.operational_evidence, /API calls last 30 days: 1234/);
});

test('an unobserved router offer stays rankable at MEDIUM (fail-safe carryover)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [offerSeed({
      provider_key: 'openrouter',
      exact_model_id: 'acme/unobserved:free',
      canonical_model_id: 'acme/unobserved',
      effective_input_price_usd: 0,
      effective_output_price_usd: 0,
      normal_input_price_usd: 0,
      normal_output_price_usd: 0,
      provider_count: null,
      uptime_percent: null,
      facts_json: { model_name: 'Unobserved', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' },
    })],
    benchmarks: [benchRow('acme/unobserved', 70)],
  });
  const runDir = runDirFor(ctx, 'run-unobserved');
  const { report } = assemble.assembleReport('run-unobserved', runDir, ctx.options);
  const ranked = report.ranked_offers.find((o) => o.name === 'Unobserved');
  assert.ok(ranked, 'an unobserved but verified router offer still ranks');
  assert.equal(ranked.operational_confidence, 'MEDIUM');
});

// ── Contradictions (§4.5) ───────────────────────────────────────────────

test('a listing free vs individual deprecated contradiction adopts the individual page', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  // A nvidia offer the catalog listing still reports as free.
  seed(ctx, {
    offers: [offerSeed({
      provider_key: 'nvidia',
      exact_model_id: 'nvidia/flip',
      canonical_model_id: 'nvidia/flip',
      effective_input_price_usd: 0,
      effective_output_price_usd: 0,
      normal_input_price_usd: 0,
      normal_output_price_usd: 0,
      price_source_url: 'https://integrate.api.nvidia.com/v1/models',
      facts_json: { model_name: 'Flip', free_quota_text: 'free', endpoint_source: 'https://docs.nvidia.com/nim/large-language-models/latest/quick-start.html' },
    })],
  });
  db.startRun('run-obs', [], ctx.options);
  const result = observe.detectContradictions('run-obs', ctx.options, {
    nimArtifact: {
      models: [{
        model_id: 'nvidia/flip',
        free_endpoint_status: 'deprecated',
        evidence_url: 'https://build.nvidia.com/models/nvidia/flip/overview',
      }],
    },
    catalogArtifacts: [],
    now: '2026-08-19T00:00:00.000Z',
  });
  assert.equal(result.findings, 1);
  assert.equal(result.added, 1);
  const open = db.listContradictions({ openOnly: true }, ctx.options);
  assert.equal(open.length, 1);
  assert.equal(open[0].fact, 'free_status');
  assert.equal(open[0].resolved_value, 'deprecated');
  assert.equal(open[0].resolution_rule, 'lowest_source_tier');

  // A later run reaching the same adoption closes the contradiction.
  db.startRun('run-obs-2', [], ctx.options);
  const second = observe.detectContradictions('run-obs-2', ctx.options, {
    nimArtifact: {
      models: [{
        model_id: 'nvidia/flip',
        free_endpoint_status: 'deprecated',
        evidence_url: 'https://build.nvidia.com/models/nvidia/flip/overview',
      }],
    },
    catalogArtifacts: [],
    now: '2026-08-20T00:00:00.000Z',
  });
  assert.equal(second.closed, 1);
  assert.equal(db.listContradictions({ openOnly: true }, ctx.options).length, 0);
});

// ── NIM verification application ────────────────────────────────────────

test('nim_verify results are applied to offers and deprecated endpoints are removed', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [offerSeed({
      provider_key: 'nvidia',
      exact_model_id: 'nvidia/check',
      canonical_model_id: 'nvidia/check',
      effective_input_price_usd: 0,
      effective_output_price_usd: 0,
      normal_input_price_usd: 0,
      normal_output_price_usd: 0,
      facts_json: { model_name: 'Check', free_quota_text: 'free', endpoint_source: 'https://docs.nvidia.com/nim/large-language-models/latest/quick-start.html' },
    })],
  });
  db.startRun('run-nim-verify', [], ctx.options);
  db.addRunTasks('run-nim-verify', [{
    task_id: 'nim_verify',
    kind: 'nim_verify',
    provider_key: 'nvidia',
    assigned_model_ids: ['nvidia/check'],
  }], ctx.options);
  db.recordTaskResult('run-nim-verify', 'nim_verify', {
    status: 'complete',
    result: {
      schema_version: 1,
      task_id: 'nim_verify',
      status: 'complete',
      crawled_at: '2026-08-19T00:00:00.000Z',
      models: [{
        model_id: 'nvidia/check',
        free_endpoint_status: 'deprecated',
        api_calls_30d: 0,
        activity_text: 'API calls (last 30 days): 0',
        evidence_url: 'https://build.nvidia.com/models/nvidia/check/overview',
      }],
      errors: [],
    },
  }, ctx.options);

  const summary = observe.applyNimVerification('run-nim-verify', ctx.options);
  assert.equal(summary.applied, 1);
  assert.equal(summary.removed, 1);
  const offer = db.getOffer('nvidia', 'nvidia/check', ctx.options);
  assert.equal(offer.status, 'confirmed_removed');
  assert.equal(offer.free_endpoint_status, 'deprecated');
  assert.equal(offer.api_calls_30d, 0);
});

// ── Router endpoints observer application ───────────────────────────────

test('router endpoint observations are stored as offer operational evidence', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [offerSeed({
      provider_key: 'openrouter',
      exact_model_id: 'acme/routed:free',
      canonical_model_id: 'acme/routed',
      effective_input_price_usd: 0,
      effective_output_price_usd: 0,
      normal_input_price_usd: 0,
      normal_output_price_usd: 0,
      facts_json: { model_name: 'Routed', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' },
    })],
  });
  const runDir = path.join(ctx.stateDir, 'crawl', 'run-or-obs');
  fs.mkdirSync(path.join(runDir, 'reduced'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'reduced', 'or-endpoints.json'), JSON.stringify({
    run_id: 'run-or-obs',
    models: 1,
    fetched: 1,
    cached: 0,
    failed: 0,
    observations: [{
      model_id: 'acme/routed:free',
      provider_count: 4,
      providers: ['provider-a', 'provider-b', 'provider-c', 'provider-d'],
      top_provider: 'provider-a',
      uptime_percent: 98.7,
      context_length: 200000,
      source: 'fetched',
      error: null,
    }],
  }));
  const summary = observe.applyOrEndpointObservations(runDir, ctx.options);
  assert.equal(summary.applied, 1);
  const offer = db.getOffer('openrouter', 'acme/routed:free', ctx.options);
  assert.equal(offer.provider_count, 4);
  assert.equal(offer.uptime_percent, 98.7);
  assert.match(offer.activity_evidence, /provider-a/);
});

// ── Catalog discount signals ────────────────────────────────────────────

test('catalog discount signals fire only for known normal price drops', () => {
  const catalogArtifacts = [{
    provider_key: 'openrouter',
    status: 'available',
    catalog_url: 'https://openrouter.ai/api/v1/models',
    models: [
      // Known normal 15/30, catalog now 7.5/15: a drop.
      { model_id: 'acme/frontier-x', is_free: false, prompt_price: 0.0000075, completion_price: 0.000015 },
      // No known normal price: no signal.
      { model_id: 'acme/unknown', is_free: false, prompt_price: 0.000001, completion_price: 0.000002 },
      // Free models are never discount candidates.
      { model_id: 'acme/free', is_free: true, prompt_price: 0, completion_price: 0 },
    ],
  }];
  const knownNormals = new Map([['acme/frontier-x', { input: 15, output: 30 }]]);
  const signals = observe.catalogDiscountSignals(catalogArtifacts, knownNormals);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].provider_key, 'openrouter');
  assert.equal(signals[0].model_id, 'acme/frontier-x');
  assert.deepEqual(signals[0].now, { input: 7.5, output: 15 });
  assert.deepEqual(signals[0].previous_normal, { input: 15, output: 30 });
});

// ── DISCOUNTED admission from discovery candidates (observe phase) ─────

test('a verified discounted frontier discovery candidate is admitted as an offer', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  frontierModel(ctx, 'acme/frontier-x');
  const runDir = path.join(ctx.stateDir, 'crawl', 'run-admit');
  fs.mkdirSync(path.join(runDir, 'reduced'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'reduced', 'discovery-candidates.json'), JSON.stringify({
    run_id: 'run-admit',
    candidates: [{
      provider_key: 'google',
      model_name: 'Frontier X',
      canonical_model_id: 'acme/frontier-x',
      exact_model_id: 'frontier-x',
      facts: {
        _price_evidence_verified: true,
        source_unit: 'per_million_tokens',
        source_currency: 'USD',
        normal_source_amount_input: 15,
        normal_source_amount_output: 30,
        effective_source_amount_input: 7.5,
        effective_source_amount_output: 15,
        pricing_text: 'Launch pricing: $7.50/M input (normally $15.00)',
        price_source_url: 'https://ai.google.dev/gemini-api/docs/pricing',
        endpoint_source: 'https://ai.google.dev/gemini-api/docs',
        base_url: 'https://generativelanguage.googleapis.com/v1beta',
        discount_start_at: '2026-08-01',
        discount_end_at: '2026-08-31',
      },
    }],
  }));
  const summary = observe.applyDiscountedOffers('run-admit', runDir, ctx.options, { watchlist: null });
  assert.equal(summary.admitted, 1);
  assert.equal(summary.ended, 0);
  const offer = db.getOffer('google', 'frontier-x', ctx.options);
  assert.ok(offer, 'the discounted offer was admitted');
  assert.equal(offer.status, 'verified');
  assert.equal(offer.normal_input_price_usd, 15);
  assert.equal(offer.effective_input_price_usd, 7.5);
  assert.equal(offer.discount_start_at, '2026-08-01');
});

test('a discount price returning to normal ends the campaign via the pre run backup', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  frontierModel(ctx, 'acme/frontier-x');
  // Prior day: the discount is live.
  seed(ctx, {
    runId: 'prior',
    offers: [offerSeed({
      discount_start_at: '2026-08-01',
      discount_end_at: '2026-08-31',
    })],
  });
  const runDir = runDirFor(ctx, 'run-liveness');
  db.copyDatabaseForRun('run-liveness', ctx.options);
  // This run: the catalog lane re-verified the price at the normal value.
  const database = db.openCollectorDb(ctx.options);
  try {
    database.prepare(
      'UPDATE offers SET effective_input_price_usd = ?, effective_output_price_usd = ? '
      + 'WHERE provider_key = ? AND exact_model_id = ?'
    ).run(15, 30, 'google', 'frontier-x');
  } finally {
    database.close();
  }
  fs.mkdirSync(path.join(runDir, 'reduced'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'reduced', 'discovery-candidates.json'),
    JSON.stringify({ run_id: 'run-liveness', candidates: [] }));
  const summary = observe.applyDiscountedOffers('run-liveness', runDir, ctx.options, { watchlist: null });
  assert.equal(summary.ended, 1, 'returning to the normal price ends the campaign');
  const after = db.getOffer('google', 'frontier-x', ctx.options);
  assert.equal(after.status, 'confirmed_removed');

  // A still-discounted offer is untouched.
  seed(ctx, {
    runId: 'prior2',
    offers: [offerSeed({
      exact_model_id: 'frontier-y',
      canonical_model_id: 'acme/frontier-y',
      discount_start_at: '2026-08-01',
      discount_end_at: '2026-08-31',
    })],
  });
  const runDir2 = runDirFor(ctx, 'run-liveness-2');
  db.copyDatabaseForRun('run-liveness-2', ctx.options);
  fs.mkdirSync(path.join(runDir2, 'reduced'), { recursive: true });
  fs.writeFileSync(path.join(runDir2, 'reduced', 'discovery-candidates.json'),
    JSON.stringify({ run_id: 'run-liveness-2', candidates: [] }));
  const second = observe.applyDiscountedOffers('run-liveness-2', runDir2, ctx.options, { watchlist: null });
  assert.equal(second.ended, 0, 'a live discount is not ended');
  assert.equal(db.getOffer('google', 'frontier-y', ctx.options).status, 'verified');
});
