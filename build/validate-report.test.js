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
