'use strict';

// Staged report assembly tests for spec 0003 child 0004 (AC-12, AC-17, and
// the deterministic derivation and ranking rules): the Editor writes prose
// only and deterministic code assembles the report from SQLite state, ranking
// eligibility and ordering, the local model gate, conditional credits, stale
// caution placement, change records, and daily report schema conformance.
// Every test runs in a fresh temp directory and never touches live state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const db = require('./collector-db');
const assemble = require('./assemble');

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
  ],
};

const DAILY_REPORT_SCHEMA = path.join(
  __dirname, '..', '..', '.agents', 'skills', 'llm-deals-intelligence-skill',
  'schemas', 'daily_report.schema.json'
);

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collector-assemble-test-'));
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
    provider_key: 'openrouter',
    exact_model_id: 'acme/a:free',
    canonical_model_id: 'acme/a',
    source_kind: 'catalog',
    status: 'verified',
    consecutive_failures: 0,
    first_seen_at: '2026-07-01T00:00:00.000Z',
    last_attempted_at: '2026-07-30T00:00:00.000Z',
    last_verified_at: '2026-07-30T00:00:00.000Z',
    pricing_hash: null,
    removal_evidence_json: null,
    // Spec 0004 AC-3 typed prices: free by default so ranked offers pass the
    // AC-4 access kind gate.
    effective_input_price_usd: 0,
    effective_output_price_usd: 0,
    normal_input_price_usd: 0,
    normal_output_price_usd: 0,
    source_currency: 'USD',
    source_unit: 'per_million_tokens',
    price_source_url: 'https://openrouter.ai/api/v1/models',
    price_verified_at: '2026-07-30T00:00:00.000Z',
    facts_json: {
      model_name: 'Acme A',
      free_quota_text: 'free tier, 100 requests per day',
      endpoint_source: 'https://openrouter.ai/docs/quickstart',
      catalog_url: 'https://openrouter.ai/api/v1/models',
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

// ── Deterministic derivations ────────────────────────────────────

test('delivery_type comes from the registry, allowance and params from facts', () => {
  const regByKey = { openrouter: { delivery_type: 'router' } };
  assert.equal(assemble.deriveDeliveryType('openrouter', regByKey), 'router');
  assert.equal(assemble.deriveDeliveryType('unknown', regByKey), 'official');

  assert.equal(assemble.deriveAllowance('unlimited requests'), 'AMPLE');
  assert.equal(assemble.deriveAllowance('free tier, 100 requests per day'), 'NORMAL');
  assert.equal(assemble.deriveAllowance('prototype preview, very limited'), 'TINY');
  assert.equal(assemble.deriveAllowance('$10 per month of free credit'), 'AMPLE');
  assert.equal(assemble.deriveAllowance(''), 'NORMAL');

  assert.equal(assemble.deriveParamsB({ params_text: '70B total parameters' }), 70);
  assert.equal(assemble.deriveParamsB({ total_parameters_b: 118 }), 118);
  assert.equal(assemble.deriveParamsB({ params_text: 'a 405B MoE model' }), 405);
  assert.equal(assemble.deriveParamsB({}), null);
});

test('provisional classification keeps conditional and trial offers out of true free', () => {
  assert.equal(
    assemble.deriveClassificationProvisional({ free_quota_text: 'free API tier, always free' }),
    'B_PERMANENT_FREE_TIER'
  );
  assert.equal(
    assemble.deriveClassificationProvisional({ free_quota_text: 'free in exchange for data sharing opt-in' }),
    'F_CONDITIONAL'
  );
  assert.equal(
    assemble.deriveClassificationProvisional({ pricing_text: 'one-time $5 free trial credit' }),
    'D_TRIAL_CREDIT'
  );
  const contributorFacts = {
    model_name: 'Muse Spark 1.2 Contributor (Data Used for Training)',
    description: 'A cheaper opt-in version. Prompts and outputs may be used for training.',
  };
  assert.equal(assemble.deriveClassificationProvisional(contributorFacts), 'F_CONDITIONAL');
  assert.equal(
    assemble.deriveClassificationProvisional({ ...contributorFacts, is_free_signal: false }),
    'F_CONDITIONAL',
    'a paid contributor variant still carries the data use condition'
  );
  assert.match(assemble.deriveTrainingUse(contributorFacts), /学習/);
  assert.deepEqual(assemble.deriveRegistrationConditions(contributorFacts), [
    'データ利用（学習・製品改善）への同意が必要な条件付きモデル',
  ]);
});

// ── Access kind derivation (spec 0004 AC-4) ─────────────────────

test('access kind boundaries: FREE, ULTRA_LOW, and over-limit are derived (AC-4)', () => {
  assert.equal(assemble.deriveAccessKind(0, 0), 'FREE');
  assert.equal(assemble.deriveAccessKind(0.2, 0.4), 'ULTRA_LOW');
  assert.equal(assemble.deriveAccessKind(0.199999, 0.399999), 'ULTRA_LOW');
  assert.equal(assemble.deriveAccessKind(0.200001, 0.4), null, 'input above 0.2 is excluded');
  assert.equal(assemble.deriveAccessKind(0.2, 0.400001), null, 'output above 0.4 is excluded');
  assert.equal(assemble.deriveAccessKind(null, 0), null, 'missing input is unknown');
  assert.equal(assemble.deriveAccessKind(0, undefined), null, 'missing output is unknown');
  assert.equal(assemble.deriveAccessKind(Number.NaN, 0), null);
  assert.equal(assemble.deriveAccessKind(0, -0.1), null, 'negative prices are not free');
});

test('an offer with unknown or over-limit prices is excluded, not ranked (AC-4)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      // ULTRA_LOW boundary: ranked.
      offerSeed({ exact_model_id: 'acme/cheap:free', canonical_model_id: 'acme/cheap',
        effective_input_price_usd: 0.2, effective_output_price_usd: 0.4,
        normal_input_price_usd: 0.2, normal_output_price_usd: 0.4,
        facts_json: { model_name: 'Cheap', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      // Over limit: excluded.
      offerSeed({ exact_model_id: 'acme/pricey:free', canonical_model_id: 'acme/pricey',
        effective_input_price_usd: 0.3, effective_output_price_usd: 0.4,
        normal_input_price_usd: 0.3, normal_output_price_usd: 0.4,
        facts_json: { model_name: 'Pricey', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      // Missing output price: excluded.
      offerSeed({ exact_model_id: 'acme/missing:free', canonical_model_id: 'acme/missing',
        effective_input_price_usd: 0.1, effective_output_price_usd: null,
        normal_input_price_usd: 0.1, normal_output_price_usd: null,
        facts_json: { model_name: 'Missing', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [
      benchRow('acme/cheap', 60),
      benchRow('acme/pricey', 60),
      benchRow('acme/missing', 60),
    ],
  });
  const runDir = runDirFor(ctx, 'run-access');
  const { report } = assemble.assembleReport('run-access', runDir, ctx.options);
  assert.deepEqual(report.ranked_offers.map((o) => o.model_id), ['acme/cheap:free']);
  assert.equal(report.ranked_offers[0].access_kind, 'ULTRA_LOW');
  assert.ok(report.excluded_offers.some((e) => e.name === 'Pricey' && /access/.test(e.reason)));
  assert.ok(report.excluded_offers.some((e) => e.name === 'Missing' && /access/.test(e.reason)));
});

// ── Shared ranking policy in assembler (AC-5) ─────────────────────

test('a Terminal Bench score below 50 is never ranked even as tier B (AC-5)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [offerSeed({
      exact_model_id: 'acme/low:free', canonical_model_id: 'acme/low',
      facts_json: { model_name: 'Low Score', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' },
    })],
    benchmarks: [benchRow('acme/low', 49.999, {
      benchmark_key: 'terminal_bench_2_0', display_name: 'Terminal-Bench 2.0', version: '2.0',
    })],
  });
  const runDir = runDirFor(ctx, 'run-low');
  const { report } = assemble.assembleReport('run-low', runDir, ctx.options);
  assert.equal(report.ranked_offers.length, 0, '49.999 never ranks');
  assert.ok(report.excluded_offers.some((e) => e.name === 'Low Score' && /benchmark/.test(e.reason)));
});

test('the assembler derives access kind from typed prices, never a stale label (AC-4)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [offerSeed({
      exact_model_id: 'acme/cheap:free', canonical_model_id: 'acme/cheap',
      effective_input_price_usd: 0.05, effective_output_price_usd: 0.05,
      normal_input_price_usd: 0.05, normal_output_price_usd: 0.05,
      facts_json: { model_name: 'Cheap', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' },
    })],
    benchmarks: [benchRow('acme/cheap', 60)],
  });
  const runDir = runDirFor(ctx, 'run-cheap');
  const { report } = assemble.assembleReport('run-cheap', runDir, ctx.options);
  assert.equal(report.ranked_offers.length, 1);
  assert.equal(report.ranked_offers[0].access_kind, 'ULTRA_LOW', '0.05 is within the ULTRA_LOW limits');
});

// ── Candidate view ───────────────────────────────────────────────

test('the candidate view carries tier, allowance, and endpoint facts from state (AC-12)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [offerSeed({})],
    benchmarks: [benchRow('acme/a', 70)],
  });
  const view = assemble.buildCandidateView(ctx.options);
  assert.equal(view.candidates.length, 1);
  const c = view.candidates[0];
  assert.equal(c.offer_key, 'openrouter/acme/a:free');
  assert.equal(c.delivery_type, 'router');
  assert.equal(c.tier, 'S');
  assert.equal(c.benchmark.score, 70);
  assert.equal(c.base_url, 'https://openrouter.ai/api/v1');
  assert.equal(c.endpoint_source, 'https://openrouter.ai/docs/quickstart');
  assert.equal(c.free_allowance_rank, 'NORMAL');
  assert.equal(c.benchmark_pending, false);
});

test('confirmed_removed offers are not candidates', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
      offerSeed({ exact_model_id: 'acme/gone:free', canonical_model_id: 'acme/gone', status: 'confirmed_removed' }),
    ],
    benchmarks: [benchRow('acme/a', 70)],
  });
  const view = assemble.buildCandidateView(ctx.options);
  assert.deepEqual(view.candidates.map((c) => c.canonical_model_id), ['acme/a']);
});

test('operator hidden offers are not candidates', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      offerSeed({ exact_model_id: 'acme/visible:free', canonical_model_id: 'acme/visible' }),
      offerSeed({ exact_model_id: 'acme/hidden:free', canonical_model_id: 'acme/hidden' }),
    ],
    benchmarks: [benchRow('acme/visible', 70), benchRow('acme/hidden', 70)],
  });
  db.setOfferHidden('openrouter', 'acme/hidden:free', true, ctx.options);
  const view = assemble.buildCandidateView(ctx.options);
  assert.deepEqual(view.candidates.map((c) => c.canonical_model_id), ['acme/visible']);
});

// ── Ranking eligibility and ordering ─────────────────────────────

test('ranking orders by tier, then access kind, then same key score (AC-7)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      // Tier S, ULTRA_LOW, score 70.
      offerSeed({ exact_model_id: 'acme/s-ultra:free', canonical_model_id: 'acme/s-ultra',
        effective_input_price_usd: 0.1, effective_output_price_usd: 0.2,
        normal_input_price_usd: 0.1, normal_output_price_usd: 0.2,
        facts_json: { model_name: 'S Ultra', free_quota_text: 'free tier', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      // Tier S, FREE, score 65 -> ranks first (FREE before ULTRA_LOW).
      offerSeed({ exact_model_id: 'acme/s-free:free', canonical_model_id: 'acme/s-free',
        facts_json: { model_name: 'S Free', free_quota_text: 'unlimited free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      // Tier A, FREE -> ranks after both S offers.
      offerSeed({ exact_model_id: 'acme/a-free:free', canonical_model_id: 'acme/a-free',
        facts_json: { model_name: 'A Free', free_quota_text: 'unlimited free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [
      benchRow('acme/s-ultra', 70),
      benchRow('acme/s-free', 65),
      benchRow('acme/a-free', 60),
    ],
  });
  const runDir = runDirFor(ctx, 'run-order');
  const { report } = assemble.assembleReport('run-order', runDir, ctx.options);
  assert.deepEqual(
    report.ranked_offers.map((o) => o.model_id),
    ['acme/s-free:free', 'acme/s-ultra:free', 'acme/a-free:free']
  );
  assert.deepEqual(report.ranked_offers.map((o) => o.rank), [1, 2, 3]);
});

test('same key scores compare; different keys fall through to price_verified_at (AC-7)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      // Tier A via Terminal-Bench 2.1 score 90, newer price confirmation.
      offerSeed({ exact_model_id: 'acme/x:free', canonical_model_id: 'acme/x',
        last_verified_at: '2026-07-30T00:00:00.000Z',
        price_verified_at: '2026-07-30T00:00:00.000Z',
        facts_json: { model_name: 'X', free_quota_text: 'unlimited free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      // Tier A via Terminal-Bench 2.0 score 95 (different key), older price
      // confirmation.
      offerSeed({ exact_model_id: 'acme/y:free', canonical_model_id: 'acme/y',
        last_verified_at: '2026-07-01T00:00:00.000Z',
        price_verified_at: '2026-07-01T00:00:00.000Z',
        facts_json: { model_name: 'Y', free_quota_text: 'unlimited free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [
      benchRow('acme/x', 90),
      benchRow('acme/y', 95, { benchmark_key: 'terminal_bench_2_0', display_name: 'Terminal-Bench 2.0', version: '2.0' }),
    ],
  });
  const runDir = runDirFor(ctx, 'run-diffkey');
  const { report } = assemble.assembleReport('run-diffkey', runDir, ctx.options);
  // Different Terminal Bench versions: raw scores are NOT compared; the newer
  // price confirmation date (acme/x) ranks first even though its raw score is
  // lower.
  assert.deepEqual(
    report.ranked_offers.map((o) => o.model_id),
    ['acme/x:free', 'acme/y:free']
  );
});

test('benchmark_pending offers are excluded, not ranked (AC-5)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
      offerSeed({ exact_model_id: 'acme/pending:free', canonical_model_id: 'acme/pending',
        facts_json: { model_name: 'Pending', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [benchRow('acme/a', 70)],
  });
  const runDir = runDirFor(ctx, 'run-pending');
  const { report } = assemble.assembleReport('run-pending', runDir, ctx.options);
  assert.deepEqual(report.ranked_offers.map((o) => o.model_id), ['acme/a:free']);
  assert.ok(report.excluded_offers.some((e) => e.name === 'Pending' && /benchmark-pending/.test(e.reason)));
});

test('non Terminal Bench benchmarks never substitute for admission (AC-5, AC-6)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      offerSeed({ exact_model_id: 'acme/swe:free', canonical_model_id: 'acme/swe',
        facts_json: { model_name: 'SWE Only', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      offerSeed({ exact_model_id: 'acme/tb20:free', canonical_model_id: 'acme/tb20',
        facts_json: { model_name: 'TB 2.0', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [
      benchRow('acme/swe', 95, { benchmark_key: 'swe_bench_verified', display_name: 'SWE-bench Verified', version: '1.0' }),
      benchRow('acme/tb20', 52, { benchmark_key: 'terminal_bench_2_0', display_name: 'Terminal-Bench 2.0', version: '2.0' }),
    ],
  });
  const runDir = runDirFor(ctx, 'run-tb-gate');
  const { report } = assemble.assembleReport('run-tb-gate', runDir, ctx.options);
  assert.deepEqual(report.ranked_offers.map((o) => o.model_id), ['acme/tb20:free']);
  assert.ok(report.excluded_offers.some((e) => e.name === 'SWE Only' && /benchmark-gate/.test(e.reason)));
});

test('router offers are one card per provider and exact model; aggregate routes stay excluded', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      offerSeed({
        exact_model_id: 'alpha/model:free',
        canonical_model_id: 'alpha/model',
        facts_json: {
          model_name: 'Alpha Model',
          endpoint_source: 'https://openrouter.ai/docs/quickstart',
          catalog_url: 'https://openrouter.ai/api/v1/models',
        },
      }),
      offerSeed({
        exact_model_id: 'openrouter/free',
        canonical_model_id: 'openrouter/free',
        facts_json: {
          model_name: 'Free Models Router',
          endpoint_source: 'https://openrouter.ai/docs/quickstart',
          catalog_url: 'https://openrouter.ai/api/v1/models',
        },
      }),
    ],
    benchmarks: [benchRow('alpha/model', 57)],
  });
  const runDir = runDirFor(ctx, 'run-router-list');
  const { report } = assemble.assembleReport('run-router-list', runDir, ctx.options);

  assert.equal(report.ranked_offers.length, 1);
  assert.equal(report.ranked_offers[0].delivery_type, 'router');
  assert.equal(report.ranked_offers[0].model_id, 'alpha/model:free');
  assert.equal(report.ranked_offers[0].provider_key, 'openrouter');
  assert.equal(report.ranked_offers[0].canonical_model_id, 'alpha/model');
  assert.equal('free_model_names' in report.ranked_offers[0], false, 'free_model_names is gone (AC-2)');
  assert.ok(report.excluded_offers.some((entry) =>
    entry.name === 'Free Models Router' && /benchmark-pending/.test(entry.reason)
  ));
});

test('catalog offers need fetched endpoint evidence instead of registry docs fallback', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      offerSeed({
        exact_model_id: 'acme/no-docs:free',
        canonical_model_id: 'acme/no-docs',
        facts_json: {
          model_name: 'No Docs Evidence',
          catalog_url: 'https://openrouter.ai/api/v1/models',
        },
      }),
      offerSeed({
        exact_model_id: 'acme/with-docs:free',
        canonical_model_id: 'acme/with-docs',
        facts_json: {
          model_name: 'Fetched Docs Evidence',
          catalog_url: 'https://openrouter.ai/api/v1/models',
          endpoint_source: 'https://openrouter.ai/docs/quickstart',
        },
      }),
    ],
    benchmarks: [benchRow('acme/no-docs', 57), benchRow('acme/with-docs', 57)],
  });
  const runDir = runDirFor(ctx, 'run-endpoint-evidence');
  const { report } = assemble.assembleReport('run-endpoint-evidence', runDir, ctx.options);

  assert.deepEqual(report.ranked_offers.map((offer) => offer.model_id), ['acme/with-docs:free']);
  assert.equal(report.ranked_offers[0].endpoint_source, 'https://openrouter.ai/docs/quickstart');
  assert.ok(report.excluded_offers.some((entry) =>
    entry.name === 'No Docs Evidence' && /missing endpoint_source/.test(entry.reason)
  ));
});

test('the local model gate excludes sub 30B offers unless tier S or A (AGENTS.md)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      // 20B and tier B -> excluded.
      offerSeed({ exact_model_id: 'acme/small-b:free', canonical_model_id: 'acme/small-b',
        facts_json: { model_name: 'Small B', total_parameters_b: 20, free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      // 20B but tier S -> ranked (competitive small model exception).
      offerSeed({ exact_model_id: 'acme/small-s:free', canonical_model_id: 'acme/small-s',
        facts_json: { model_name: 'Small S', total_parameters_b: 20, free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [
      benchRow('acme/small-b', 49, { benchmark_key: 'terminal_bench_2_0', display_name: 'Terminal-Bench 2.0', version: '2.0' }),
      benchRow('acme/small-s', 70),
    ],
  });
  const runDir = runDirFor(ctx, 'run-small');
  const { report } = assemble.assembleReport('run-small', runDir, ctx.options);
  assert.deepEqual(report.ranked_offers.map((o) => o.model_id), ['acme/small-s:free']);
  // Small B has only a 49 score on Terminal Bench 2.0: below the shared 50
  // gate it is benchmark_pending and excluded on the benchmark gate, not the
  // local-run gate.
  assert.ok(report.excluded_offers.some((e) => e.name === 'Small B' && /benchmark/.test(e.reason)));
});

// ── Conditional credits and caution ──────────────────────────────

test('F_CONDITIONAL offers go to conditional_credits, not the ranking (AGENTS.md)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      offerSeed({ exact_model_id: 'acme/cond:free', canonical_model_id: 'acme/cond',
        facts_json: { model_name: 'Cond', free_quota_text: 'free with data sharing opt-in', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [benchRow('acme/cond', 70)],
  });
  const runDir = runDirFor(ctx, 'run-cond');
  const { report } = assemble.assembleReport('run-cond', runDir, ctx.options);
  assert.equal(report.ranked_offers.length, 0);
  assert.equal(report.conditional_credits.length, 1);
  assert.equal(report.conditional_credits[0].classification, 'F_CONDITIONAL');
});

test('a stale offer at run four moves to caution with prior facts (AC-3)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      offerSeed({ exact_model_id: 'acme/stale:free', canonical_model_id: 'acme/stale',
        status: 'stale', consecutive_failures: 4,
        facts_json: { model_name: 'Stale', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [benchRow('acme/stale', 70)],
  });
  const runDir = runDirFor(ctx, 'run-caution');
  const { report } = assemble.assembleReport('run-caution', runDir, ctx.options);
  assert.equal(report.ranked_offers.length, 0);
  assert.equal(report.caution_offers.length, 1);
  assert.equal(report.caution_offers[0].model_id, 'acme/stale:free');
  assert.equal(report.caution_offers[0].operational_confidence, 'LOW');
});

// ── Editorial boundary (AC-12) ───────────────────────────────────

test('editorial offer prose is combined; summary and data stay deterministic (AC-12)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [offerSeed({})],
    benchmarks: [benchRow('acme/a', 70)],
  });
  const runDir = runDirFor(ctx, 'run-editorial');
  fs.writeFileSync(path.join(runDir, 'candidate', 'editorial.json'), JSON.stringify({
    schema_version: 1,
    summary: '今回は999件がランクインしました（S 9、A 8、B 7）。注意999件、対象外999件。',
    offer_prose: [
      { offer_key: 'openrouter/acme/a:free', summary: 'Acme A は高速な無料モデルです。' },
    ],
  }));
  const { report } = assemble.assembleReport('run-editorial', runDir, ctx.options);
  assert.equal(
    report.summary,
    '無料・激安 LLM API の日次ランキング。今回ランクイン 1 件（S 1、A 0、B 0）、無料 1 件、激安 0 件、注意 0 件、対象外 0 件。'
  );
  assert.equal(report.ranked_offers[0].recent_activity, 'Acme A は高速な無料モデルです。');
  // Deterministic fields are not taken from prose.
  assert.equal(report.ranked_offers[0].benchmark.score, 70);
  assert.equal(report.ranked_offers[0].tier ?? report.ranked_offers[0].benchmark.tier, 'S');
  assert.equal(report.ranked_offers[0].delivery_type, 'router');
});

test('the classifier output overrides the provisional classification (AC-12)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [offerSeed({})],
    benchmarks: [benchRow('acme/a', 70)],
  });
  const runDir = runDirFor(ctx, 'run-classifier');
  fs.mkdirSync(path.join(runDir, 'reduced'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'reduced', 'classifications.json'), JSON.stringify({
    classifications: [{ offer_key: 'openrouter/acme/a:free', classification: 'A_TRUE_FREE', information_confidence: 'HIGH' }],
  }));
  const { report } = assemble.assembleReport('run-classifier', runDir, ctx.options);
  assert.equal(report.ranked_offers[0].classification, 'A_TRUE_FREE');
});

test('classifications stay attached to exact offers when display names collide', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      offerSeed({
        exact_model_id: 'acme/ling',
        canonical_model_id: 'acme/ling',
        effective_input_price_usd: 0.075,
        effective_output_price_usd: 0.22,
        normal_input_price_usd: 0.075,
        normal_output_price_usd: 0.22,
        facts_json: {
          model_name: 'Ling 3.0 Flash',
          endpoint_source: 'https://openrouter.ai/docs/quickstart',
          catalog_url: 'https://openrouter.ai/api/v1/models',
        },
      }),
      offerSeed({
        exact_model_id: 'acme/ling:free',
        canonical_model_id: 'acme/ling',
        facts_json: {
          model_name: 'Ling 3.0 Flash',
          endpoint_source: 'https://openrouter.ai/docs/quickstart',
          catalog_url: 'https://openrouter.ai/api/v1/models',
        },
      }),
    ],
    benchmarks: [benchRow('acme/ling', 57)],
  });
  const runDir = runDirFor(ctx, 'run-classifier-collision');
  fs.mkdirSync(path.join(runDir, 'reduced'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'reduced', 'classifications.json'), JSON.stringify({
    classifications: [
      { offer_key: 'openrouter/acme/ling', classification: 'E_DISCOUNT' },
      { offer_key: 'openrouter/acme/ling:free', classification: 'B_PERMANENT_FREE_TIER' },
    ],
  }));

  const { report } = assemble.assembleReport('run-classifier-collision', runDir, ctx.options);
  const byModelId = new Map(report.ranked_offers.map((offer) => [offer.model_id, offer]));
  assert.equal(byModelId.get('acme/ling').classification, 'E_DISCOUNT');
  assert.equal(byModelId.get('acme/ling:free').classification, 'B_PERMANENT_FREE_TIER');
});

// ── Change records ───────────────────────────────────────────────

test('change records diff against the pre run DB copy (spec value sourcing)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  // Prior state: acme/old exists, acme/kept exists with one pricing hash.
  seed(ctx, {
    runId: 'prior',
    offers: [
      offerSeed({ exact_model_id: 'acme/old:free', canonical_model_id: 'acme/old',
        facts_json: { model_name: 'Old', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      offerSeed({ exact_model_id: 'acme/kept:free', canonical_model_id: 'acme/kept',
        pricing_hash: 'a'.repeat(64),
        facts_json: { model_name: 'Kept', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [benchRow('acme/old', 70), benchRow('acme/kept', 70)],
  });
  const runDir = runDirFor(ctx, 'run-changes');
  // Copy the prior state as the pre run backup.
  db.copyDatabaseForRun('run-changes', ctx.options);
  // Current state: acme/old removed, acme/kept pricing changed, acme/new added.
  seed(ctx, {
    runId: 'current',
    offers: [
      offerSeed({ exact_model_id: 'acme/old:free', canonical_model_id: 'acme/old', status: 'confirmed_removed',
        facts_json: { model_name: 'Old', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      offerSeed({ exact_model_id: 'acme/kept:free', canonical_model_id: 'acme/kept',
        pricing_hash: 'b'.repeat(64),
        facts_json: { model_name: 'Kept', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      offerSeed({ exact_model_id: 'acme/new:free', canonical_model_id: 'acme/new',
        facts_json: { model_name: 'New', free_quota_text: 'free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [benchRow('acme/old', 70), benchRow('acme/kept', 70), benchRow('acme/new', 70)],
  });
  const { report } = assemble.assembleReport('run-changes', runDir, ctx.options);
  const types = Object.fromEntries(report.changes.map((c) => [c.offer_name, c.change_type]));
  assert.equal(types.Old, 'ended');
  assert.equal(types.Kept, 'price_change');
  assert.equal(types.New, 'new');
  // Every change carries a Japanese summary (deterministic fallback).
  for (const change of report.changes) {
    assert.ok(change.summary && change.summary.length > 0);
  }
});

// ── Schema conformance ───────────────────────────────────────────

test('the assembled report conforms to the daily report schema (AC-12)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      offerSeed({ exact_model_id: 'acme/a:free', canonical_model_id: 'acme/a' }),
      offerSeed({ provider_key: 'google', exact_model_id: 'gemini-2.5-pro', canonical_model_id: 'gemini-2.5-pro',
        facts_json: { model_name: 'Gemini 2.5 Pro', free_quota_text: 'unlimited free', endpoint_source: 'https://ai.google.dev/gemini-api/docs' } }),
    ],
    benchmarks: [benchRow('acme/a', 70), benchRow('gemini-2.5-pro', 59)],
  });
  const runDir = runDirFor(ctx, 'run-schema');
  const { report } = assemble.assembleReport('run-schema', runDir, ctx.options);

  const Ajv = require('ajv');
  const addFormats = require('ajv-formats');
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(DAILY_REPORT_SCHEMA, 'utf8'));
  const validate = ajv.compile(schema);
  const valid = validate(report);
  assert.equal(valid, true, JSON.stringify(validate.errors, null, 2));
});

test('crawl facts schema rejects unknown fact type and typed price properties', () => {
  const Ajv = require('ajv');
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.agents/skills/llm-deals-intelligence-skill/schemas/crawl-facts.schema.json'), 'utf8'));
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  const fact = { schema_version: 1, task_id: 'known:x', status: 'complete', crawled_at: '2026-08-01T00:00:00Z', provider_key: 'x', models: [{ model_id: 'x/m', fact_type: 'tier', input_price_usd: 1 }], errors: [] };
  assert.equal(validate(fact), false);
  assert.ok(validate.errors.some((error) => error.keyword === 'additionalProperties'));

  const omittedEnd = {
    schema_version: 1, task_id: 'known:x', status: 'complete', crawled_at: '2026-08-01T00:00:00Z',
    provider_key: 'x', models: [{ model_id: 'x/m', discount_start_at: '2026-08-01T00:00:00Z' }], errors: [],
  };
  assert.equal(validate(omittedEnd), false, 'a supplied discount start requires an end');
});
