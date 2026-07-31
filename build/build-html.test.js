'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateHTML } = require('./build-html');

function routerOffer(freeModelNames) {
  return {
    name: 'Router model',
    model_name: 'Router model',
    provider: 'OpenRouter',
    delivery_type: 'router',
    classification: 'B_PERMANENT_FREE_TIER',
    ranking_eligible: true,
    suspicion_score: 0,
    information_confidence: 'HIGH',
    operational_confidence: 'HIGH',
    last_verified: '2026-07-31T00:00:00.000Z',
    base_url: 'https://openrouter.ai/api/v1',
    model_id: 'alpha/model:free',
    endpoint_source: 'https://openrouter.ai/docs/quickstart',
    free_allowance_rank: 'NORMAL',
    free_model_names: freeModelNames,
    benchmark: {
      score: 57,
      benchmark_name: 'Terminal-Bench 2.1',
      tier: 'A',
    },
    benchmarks: [],
    effective_price_per_million: { input: 0, output: 0 },
    sources: ['https://openrouter.ai/api/v1/models'],
  };
}

function report(offer) {
  return {
    generated_at: '2026-07-31T00:00:00.000Z',
    timezone: 'Asia/Tokyo',
    new_models: [],
    changes: [],
    ranked_offers: [offer],
    excluded_offers: [],
    sources: [],
  };
}

test('router HTML renders the sorted unique escaped catalog list', () => {
  const html = generateHTML(report(routerOffer([
    'zeta/model:free',
    '<alpha&model:free',
    'zeta/model:free',
  ])));

  assert.ok(html.indexOf('&lt;alpha&amp;model:free') < html.indexOf('zeta/model:free'));
  assert.equal((html.match(/class="model-chip"/g) || []).length, 2);
  assert.ok(!html.includes('<alpha&model:free'));
  assert.ok(html.includes('無料モデル一覧'));
});

test('router HTML shows an explicit unavailable fallback for an empty list', () => {
  const html = generateHTML(report(routerOffer([])));
  assert.ok(html.includes('モデル一覧未取得'));
  assert.equal((html.match(/class="model-chip"/g) || []).length, 0);
});
