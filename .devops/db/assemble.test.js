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
    facts_json: {
      model_name: 'Acme A',
      free_quota_text: 'free tier, 100 requests per day',
      endpoint_source: 'https://openrouter.ai/docs/quickstart',
      catalog_url: 'https://openrouter.ai/api/v1/models',
      free_model_names: ['acme/a:free'],
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

// ── Ranking eligibility and ordering ─────────────────────────────

test('ranking orders by tier, then allowance, then same key score (AGENTS.md)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      // Tier S, NORMAL allowance, score 70.
      offerSeed({ exact_model_id: 'acme/s-norm:free', canonical_model_id: 'acme/s-norm',
        facts_json: { model_name: 'S Norm', free_quota_text: 'free tier', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      // Tier S, AMPLE allowance, score 65 -> ranks first (AMPLE beats NORMAL).
      offerSeed({ exact_model_id: 'acme/s-ample:free', canonical_model_id: 'acme/s-ample',
        facts_json: { model_name: 'S Ample', free_quota_text: 'unlimited free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      // Tier A, AMPLE allowance -> ranks after both S offers.
      offerSeed({ exact_model_id: 'acme/a-ample:free', canonical_model_id: 'acme/a-ample',
        facts_json: { model_name: 'A Ample', free_quota_text: 'unlimited free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [
      benchRow('acme/s-norm', 70),
      benchRow('acme/s-ample', 65),
      benchRow('acme/a-ample', 60),
    ],
  });
  const runDir = runDirFor(ctx, 'run-order');
  const { report } = assemble.assembleReport('run-order', runDir, ctx.options);
  assert.deepEqual(
    report.ranked_offers.map((o) => o.canonical_model_id || o.model_id),
    ['acme/s-ample:free', 'acme/s-norm:free', 'acme/a-ample:free']
  );
  assert.deepEqual(report.ranked_offers.map((o) => o.rank), [1, 2, 3]);
});

test('same key scores compare; different keys fall through to last_verified (AGENTS.md)', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  seed(ctx, {
    offers: [
      // Tier B via SWE-bench score 90, newer verification.
      offerSeed({ exact_model_id: 'acme/x:free', canonical_model_id: 'acme/x',
        last_verified_at: '2026-07-30T00:00:00.000Z',
        facts_json: { model_name: 'X', free_quota_text: 'unlimited free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
      // Tier B via GPQA score 95 (different key), older verification.
      offerSeed({ exact_model_id: 'acme/y:free', canonical_model_id: 'acme/y',
        last_verified_at: '2026-07-01T00:00:00.000Z',
        facts_json: { model_name: 'Y', free_quota_text: 'unlimited free', endpoint_source: 'https://openrouter.ai/docs/quickstart' } }),
    ],
    benchmarks: [
      benchRow('acme/x', 90, { benchmark_key: 'swe_bench_verified', display_name: 'SWE-bench Verified', version: '1.0' }),
      benchRow('acme/y', 95, { benchmark_key: 'gpqa_diamond', display_name: 'GPQA Diamond', version: '1.0' }),
    ],
  });
  const runDir = runDirFor(ctx, 'run-diffkey');
  const { report } = assemble.assembleReport('run-diffkey', runDir, ctx.options);
  // Different benchmark keys: scores are NOT compared; the newer last_verified
  // (acme/x) ranks first even though its raw score is lower.
  assert.deepEqual(
    report.ranked_offers.map((o) => o.model_id),
    ['acme/x:free', 'acme/y:free']
  );
});

test('benchmark_pending offers are excluded, not ranked (AC-10)', (t) => {
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

test('router assembly emits the complete catalog list while benchmark-pending aggregate routes stay excluded', (t) => {
  const ctx = tmpProject();
  t.after(() => fs.rmSync(ctx.root, { recursive: true, force: true }));
  setup(ctx);
  const catalogNames = ['zeta/model:free', 'alpha/model:free', 'openrouter/free', 'alpha/model:free'];
  seed(ctx, {
    offers: [
      offerSeed({
        exact_model_id: 'alpha/model:free',
        canonical_model_id: 'alpha/model',
        facts_json: {
          model_name: 'Alpha Model',
          endpoint_source: 'https://openrouter.ai/docs/quickstart',
          catalog_url: 'https://openrouter.ai/api/v1/models',
          free_model_names: catalogNames,
        },
      }),
      offerSeed({
        exact_model_id: 'openrouter/free',
        canonical_model_id: 'openrouter/free',
        facts_json: {
          model_name: 'Free Models Router',
          endpoint_source: 'https://openrouter.ai/docs/quickstart',
          catalog_url: 'https://openrouter.ai/api/v1/models',
          free_model_names: catalogNames,
        },
      }),
    ],
    benchmarks: [benchRow('alpha/model', 57)],
  });
  const runDir = runDirFor(ctx, 'run-router-list');
  const { report } = assemble.assembleReport('run-router-list', runDir, ctx.options);

  assert.equal(report.ranked_offers.length, 1);
  assert.equal(report.ranked_offers[0].delivery_type, 'router');
  assert.deepEqual(report.ranked_offers[0].free_model_names, [
    'alpha/model:free', 'openrouter/free', 'zeta/model:free',
  ]);
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
          free_model_names: ['acme/no-docs:free'],
        },
      }),
      offerSeed({
        exact_model_id: 'acme/with-docs:free',
        canonical_model_id: 'acme/with-docs',
        facts_json: {
          model_name: 'Fetched Docs Evidence',
          catalog_url: 'https://openrouter.ai/api/v1/models',
          endpoint_source: 'https://openrouter.ai/docs/quickstart',
          free_model_names: ['acme/with-docs:free'],
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
      benchRow('acme/small-b', 90, { benchmark_key: 'swe_bench_verified', display_name: 'SWE-bench Verified', version: '1.0' }),
      benchRow('acme/small-s', 70),
    ],
  });
  const runDir = runDirFor(ctx, 'run-small');
  const { report } = assemble.assembleReport('run-small', runDir, ctx.options);
  assert.deepEqual(report.ranked_offers.map((o) => o.model_id), ['acme/small-s:free']);
  assert.ok(report.excluded_offers.some((e) => e.name === 'Small B' && /local-run/.test(e.reason)));
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
    '無料・割引 LLM API の日次ランキング。今回ランクイン 1 件（S 1、A 0、B 0）、注意 0 件、対象外 0 件。'
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
    classifications: [{ name: 'Acme A', classification: 'A_TRUE_FREE', information_confidence: 'HIGH' }],
  }));
  const { report } = assemble.assembleReport('run-classifier', runDir, ctx.options);
  assert.equal(report.ranked_offers[0].classification, 'A_TRUE_FREE');
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
