'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { findEmptyRouterCatalogOffers } = require('./validate-report');

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
    free_allowance_rank: 'NORMAL',
    free_model_names: [],
    benchmark: {
      score: 57,
      benchmark_name: 'Terminal-Bench 2.1',
      tier: 'A',
    },
    benchmarks: [{ name: 'Terminal-Bench 2.1', score: 57 }],
    sources: ['https://openrouter.ai/api/v1/models'],
    ...overrides,
  };
}

function officialOffer(name, overrides = {}) {
  return {
    name,
    model_name: name,
    provider: 'Google Gemini',
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
    free_allowance_rank: 'NORMAL',
    benchmark: {
      score: 60,
      benchmark_name: 'Terminal-Bench 2.1',
      tier: 'A',
    },
    benchmarks: [{ name: 'Terminal-Bench 2.1', score: 60 }],
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

test('an empty router catalog hard-fails validation and preserves the candidate file', () => {
  const report = reportWithOffers([routerOffer()]);
  const before = `${JSON.stringify(report, null, 2)}\n`;
  const { result, output } = runValidator(report);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Router catalog validation error/);
  assert.equal(output, before, 'hard failure must not rewrite the candidate');
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
      benchmark: {
        score: 80,
        benchmark_name: 'LiveCodeBench v6',
        tier: 'B',
      },
      benchmarks: [{ name: 'LiveCodeBench v6', score: 80 }],
    }),
  ]);
  const { result, output } = runValidator(report);
  const validated = JSON.parse(output);

  assert.equal(result.status, 0);
  assert.equal(validated.ranked_offers.length, 1);
  assert.equal(validated.excluded_offers.length, 1);
  assert.equal(
    validated.summary,
    '無料・割引 LLM API の日次ランキング。今回ランクイン 1 件（S 0、A 1、B 0）、注意 0 件、対象外 1 件。'
  );
});

test('validator refreshes tier counts after auto-fixing A to B', () => {
  const report = reportWithOffers([officialOffer('Near Terminal Gate', {
    model_id: 'test/near-terminal-gate',
    benchmark: {
      score: 49,
      benchmark_name: 'Terminal-Bench 2.1',
      tier: 'A',
    },
    benchmarks: [{ name: 'Terminal-Bench 2.1', score: 49 }],
  })]);
  const { result, output } = runValidator(report);
  const validated = JSON.parse(output);

  assert.equal(result.status, 0);
  assert.match(result.stderr, /tier A → B/);
  assert.equal(validated.ranked_offers[0].benchmark.tier, 'B');
  assert.equal(
    validated.summary,
    '無料・割引 LLM API の日次ランキング。今回ランクイン 1 件（S 0、A 0、B 1）、注意 0 件、対象外 0 件。'
  );
});

test('only router offers require a non-empty catalog inventory', () => {
  assert.deepEqual(findEmptyRouterCatalogOffers(reportWithOffers([{
    delivery_type: 'official',
    free_model_names: [],
  }])), []);
  assert.equal(findEmptyRouterCatalogOffers(reportWithOffers([routerOffer({
    free_model_names: ['alpha/model:free'],
  })])).length, 0);
});

test('router inventory rejects blank and non-string entries', () => {
  for (const inventory of [[''], ['   '], [null], [42], ['valid/model:free', '  ']]) {
    const errors = findEmptyRouterCatalogOffers(reportWithOffers([routerOffer({
      free_model_names: inventory,
    })]));
    assert.equal(errors.length, 1, `inventory ${JSON.stringify(inventory)} must hard-fail`);
  }
});
