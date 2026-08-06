'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { excludeNoAccessKind, excludeNoTerminalBench, excludeMismatchedPrices, rankingPolicy } = require('./validate-report');

const SCHEMA_PATH = path.join(
  __dirname, '..', '.agents', 'skills', 'llm-deals-intelligence-skill',
  'schemas', 'daily_report.schema.json'
);

function reportWithOffers(rankedOffers) {
  return {
    generated_at: '2026-07-31T00:00:00.000Z',
    timezone: 'Asia/Tokyo',
    summary: '事前検証の誤った件数',
    new_models: [],
    changes: [],
    ranked_offers: rankedOffers,
    excluded_offers: [],
    sources: [],
  };
}

function routerOffer(overrides = {}) {
  return {
    name: 'OpenRouter free route',
    model_name: 'OpenRouter free route',
    provider: 'OpenRouter',
    provider_key: 'openrouter',
    canonical_model_id: 'openrouter/free',
    access_kind: 'FREE',
    delivery_type: 'router',
    classification: 'B_PERMANENT_FREE_TIER',
    suspicion_score: 0,
    information_confidence: 'HIGH',
    operational_confidence: 'HIGH',
    ranking_eligible: true,
    last_verified: '2026-07-31T00:00:00.000Z',
    base_url: 'https://openrouter.ai/api/v1',
    model_id: 'openrouter/free',
    endpoint_source: 'https://openrouter.ai/docs/quickstart',
    price_source: 'https://openrouter.ai/api/v1/models',
    price_verified_at: '2026-07-31T00:00:00.000Z',
    effective_price_per_million: { input: 0, output: 0 },
    free_allowance_rank: 'NORMAL',
    benchmark: {
      score: 57,
      benchmark_name: 'Terminal-Bench 2.1',
      version: '2.1',
      tier: 'A',
    },
    benchmark_key: 'terminal_bench_2_1',
    benchmarks: [{ name: 'Terminal-Bench 2.1', version: '2.1', score: 57 }],
    sources: ['https://openrouter.ai/api/v1/models'],
    ...overrides,
  };
}

function officialOffer(name, overrides = {}) {
  return {
    name,
    model_name: name,
    provider: 'Google Gemini',
    provider_key: 'google',
    canonical_model_id: `test/${name.toLowerCase().replace(/\s+/g, '-')}`,
    access_kind: 'FREE',
    delivery_type: 'official',
    classification: 'B_PERMANENT_FREE_TIER',
    suspicion_score: 0,
    information_confidence: 'HIGH',
    operational_confidence: 'HIGH',
    ranking_eligible: true,
    last_verified: '2026-07-31T00:00:00.000Z',
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    model_id: `test/${name.toLowerCase().replace(/\s+/g, '-')}`,
    endpoint_source: 'https://ai.google.dev/gemini-api/docs',
    price_source: 'https://ai.google.dev/gemini-api/docs/pricing',
    price_verified_at: '2026-07-31T00:00:00.000Z',
    effective_price_per_million: { input: 0, output: 0 },
    free_allowance_rank: 'NORMAL',
    benchmark: {
      score: 60,
      benchmark_name: 'Terminal-Bench 2.1',
      version: '2.1',
      tier: 'A',
    },
    benchmark_key: 'terminal_bench_2_1',
    benchmarks: [{ name: 'Terminal-Bench 2.1', version: '2.1', score: 60 }],
    sources: ['https://ai.google.dev/gemini-api/docs'],
    ...overrides,
  };
}

function runValidator(report) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-report-test-'));
  const reportPath = path.join(root, 'report.json');
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const result = spawnSync(process.execPath, [
    path.join(__dirname, 'validate-report.js'), reportPath, SCHEMA_PATH,
  ], {
    env: { ...process.env, SKIP_CITATION_CHECK: '1' },
    encoding: 'utf8',
  });
  const output = fs.readFileSync(reportPath, 'utf8');
  fs.rmSync(root, { recursive: true, force: true });
  return { result, output };
}

test('a ranked offer with all new contract fields validates cleanly', () => {
  const report = reportWithOffers([routerOffer()]);
  const before = `${JSON.stringify(report, null, 2)}\n`;
  const { result, output } = runValidator(report);

  assert.equal(result.status, 0);
  const validated = JSON.parse(output);
  assert.equal(validated.ranked_offers.length, 1);
  assert.equal(validated.ranked_offers[0].provider_key, 'openrouter');
  assert.equal(validated.ranked_offers[0].access_kind, 'FREE');
  assert.equal('free_model_names' in validated.ranked_offers[0], false);
});

test('a paid ULTRA_LOW offer cannot retain a free classification', () => {
  const report = reportWithOffers([routerOffer({
    name: 'Ling 3.0 Flash',
    model_id: 'inclusionai/ling-3.0-flash',
    canonical_model_id: 'inclusionai/ling-3.0-flash',
    access_kind: 'ULTRA_LOW',
    classification: 'B_PERMANENT_FREE_TIER',
    effective_price_per_million: { input: 0.075, output: 0.22 },
  })]);
  const { result, output } = runValidator(report);
  const validated = JSON.parse(output);

  assert.equal(result.status, 0);
  assert.equal(validated.ranked_offers[0].classification, 'E_DISCOUNT');
});

test('ordinary offer-level schema errors retain auto-exclude behavior', () => {
  const report = reportWithOffers([{
    delivery_type: 'official',
    classification: 'B_PERMANENT_FREE_TIER',
    suspicion_score: 0,
    information_confidence: 'HIGH',
    operational_confidence: 'HIGH',
    ranking_eligible: true,
  }]);
  const { result, output } = runValidator(report);
  const validated = JSON.parse(output);

  assert.equal(result.status, 0);
  assert.ok(validated.excluded_offers.some((entry) => /\[schema\]/.test(entry.reason)));
});

test('validator refreshes summary after an exclusion changes ranked and excluded counts', () => {
  const report = reportWithOffers([
    officialOffer('Kept A'),
    officialOffer('No Terminal Bench', {
      model_id: 'test/no-terminal-bench',
      canonical_model_id: 'test/no-terminal-bench',
      benchmark: {
        score: 80,
        benchmark_name: 'LiveCodeBench v6',
        version: '6',
        tier: 'B',
      },
      benchmark_key: 'livecodebench_v6',
      benchmarks: [{ name: 'LiveCodeBench v6', version: '6', score: 80 }],
    }),
  ]);
  const { result, output } = runValidator(report);
  const validated = JSON.parse(output);

  assert.equal(result.status, 0);
  assert.equal(validated.ranked_offers.length, 1);
  assert.equal(validated.excluded_offers.length, 1);
  assert.equal(
    validated.summary,
    '無料・激安 LLM API の日次ランキング。今回ランクイン 1 件（S 0、A 1、B 0）、無料 1 件、激安 0 件、注意 0 件、対象外 1 件。'
  );
});

test('validator excludes a Terminal Bench score below 50 instead of downgrading to B', () => {
  const report = reportWithOffers([officialOffer('Near Terminal Gate', {
    model_id: 'test/near-terminal-gate',
    canonical_model_id: 'test/near-terminal-gate',
    benchmark: {
      score: 49,
      benchmark_name: 'Terminal-Bench 2.1',
      version: '2.1',
      tier: 'A',
    },
    benchmark_key: 'terminal_bench_2_1',
    benchmarks: [{ name: 'Terminal-Bench 2.1', version: '2.1', score: 49 }],
  })]);
  const { result, output } = runValidator(report);
  const validated = JSON.parse(output);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /no-terminal-bench/);
  assert.equal(validated.ranked_offers.length, 0);
  assert.ok(validated.excluded_offers.some((entry) => /no-terminal-bench/.test(entry.reason)));
});

test('a ranked offer without a derived access kind is excluded (AC-4)', () => {
  const report = reportWithOffers([officialOffer('Unknown Price', {
    access_kind: null,
    effective_price_per_million: { input: 5, output: 10 },
  })]);
  const { result, output } = runValidator(report);
  const validated = JSON.parse(output);

  assert.equal(result.status, 0);
  assert.equal(validated.ranked_offers[0].ranking_eligible, false);
  assert.ok(validated.excluded_offers.some((entry) => /access_kind|access-prices/.test(entry.reason)));
});

test('an ULTRA_LOW offer passes when effective prices are within limits (AC-4)', () => {
  const report = reportWithOffers([officialOffer('Cheap Model', {
    access_kind: 'ULTRA_LOW',
    effective_price_per_million: { input: 0.2, output: 0.4 },
  })]);
  const { result, output } = runValidator(report);
  const validated = JSON.parse(output);
  assert.equal(result.status, 0);
  assert.equal(validated.ranked_offers.length, 1);
  assert.equal(validated.ranked_offers[0].access_kind, 'ULTRA_LOW');
});

test('validator excludes a FREE offer whose effective prices are non-zero (AC-4 mismatch)', () => {
  const report = reportWithOffers([officialOffer('Bad Free', {
    access_kind: 'FREE',
    effective_price_per_million: { input: 0.05, output: 0.05 },
  })]);
  const { result, output } = runValidator(report);
  const validated = JSON.parse(output);
  assert.equal(result.status, 0);
  assert.equal(validated.ranked_offers.length, 0);
  assert.ok(validated.excluded_offers.some((entry) => /access-prices/.test(entry.reason)));
});

test('only ranked offers require an access kind; non ranked offers pass through', () => {
  const report = reportWithOffers([{
    delivery_type: 'official',
    ranking_eligible: false,
    access_kind: null,
  }]);
  const { result } = runValidator(report);
  assert.equal(result.status, 0);
});
