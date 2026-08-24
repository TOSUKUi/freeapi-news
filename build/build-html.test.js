'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { generateHTML, selectRankedOffers, computeSnapshot, fmtPrice } = require('./build-html');

function cardOffer(overrides = {}) {
  return {
    name: 'Acme Model',
    model_name: 'Acme Model',
    provider: 'OpenRouter',
    provider_key: 'openrouter',
    canonical_model_id: 'acme/model',
    access_kind: 'FREE',
    delivery_type: 'router',
    classification: 'B_PERMANENT_FREE_TIER',
    ranking_eligible: true,
    suspicion_score: 0,
    information_confidence: 'HIGH',
    operational_confidence: 'HIGH',
    last_verified: '2026-07-31T00:00:00.000Z',
    base_url: 'https://openrouter.ai/api/v1',
    model_id: 'acme/model:free',
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

test('a card renders access kind, benchmark version, price date, and escaped model id', () => {
  const html = generateHTML(report(cardOffer()));

  assert.ok(html.includes('>無料</span>'), 'access kind badge renders in plain Japanese');
  assert.ok(html.includes('Terminal-Bench 2.1'), 'benchmark name renders');
  assert.ok(html.includes('価格確認日'), 'price confirmation date row renders');
  assert.ok(html.includes('acme/model:free'), 'exact model id renders');
  assert.ok(!html.includes('free_model_names'), 'free_model_names is gone');
  assert.ok(html.includes('AI による自動収集'), 'footer disclaimer renders');
});

test('ULTRA_LOW offers render an 激安 badge and real prices', () => {
  const html = generateHTML(report(cardOffer({
    access_kind: 'ULTRA_LOW',
    effective_price_per_million: { input: 0.1, output: 0.2 },
  })));
  assert.ok(html.includes('>激安</span>'));
  assert.ok(!html.includes('>ULTRA_LOW</span>'));
  assert.ok(html.includes('$0.1 / $0.2'));
});

test('G_FREE_LIKE is not shown as 無料っぽい over deterministic access badges', () => {
  const freeHtml = generateHTML(report(cardOffer({ classification: 'G_FREE_LIKE' })));
  assert.ok(freeHtml.includes('>無料</span>'));
  assert.ok(!freeHtml.includes('無料っぽい'));

  const cheapHtml = generateHTML(report(cardOffer({
    classification: 'G_FREE_LIKE',
    access_kind: 'ULTRA_LOW',
    effective_price_per_million: { input: 0.1, output: 0.2 },
  })));
  assert.ok(cheapHtml.includes('>激安</span>'));
  assert.ok(!cheapHtml.includes('無料っぽい'));
});

test('fmtPrice renders tiny decimals readably and hides float artifacts', () => {
  // Very small USD per million prices must not degrade to exponential
  // notation or leak IEEE-754 artifacts (spec 0004 AC-14 readability).
  assert.equal(fmtPrice(1e-7), '$0.0000001');
  assert.equal(fmtPrice(6.000000000000001e-7), '$0.0000006');
  assert.equal(fmtPrice(0.0000010000000000000002), '$0.000001');
  assert.equal(fmtPrice(3e-8), '$0.00000003');
  assert.equal(fmtPrice(0.00000125), '$0.00000125');
  assert.equal(fmtPrice(0.1), '$0.1');
  assert.equal(fmtPrice(0), '$0');
  assert.equal(fmtPrice(null), '—');
});

test('cards with tiny catalog prices render readable USD per million', () => {
  const html = generateHTML(report(cardOffer({
    access_kind: 'ULTRA_LOW',
    effective_price_per_million: { input: 1e-7, output: 6.000000000000001e-7 },
  })));
  assert.ok(html.includes('$0.0000001 / $0.0000006'));
  assert.ok(!html.includes('1e-7'), 'exponential price notation is never rendered');
  assert.ok(!html.includes('6.000000000000001'), 'float artifact never reaches the card');
});

test('a discount end date renders when present', () => {
  const html = generateHTML(report(cardOffer({
    discount_end_at: '2026-09-30T00:00:00.000Z',
  })));
  assert.ok(html.includes('割引期限'));
});

// Publication policy (operator 2026-08-24): limited-time campaigns render in
// a separate slot, only when non-empty.
test('campaign offers render in a separate 期間限定キャンペーン slot', () => {
  const campaignOffer = cardOffer({
    name: 'Campaign Model',
    model_id: 'acme/campaign:free',
    canonical_model_id: 'acme/campaign',
    classification: 'C_LIMITED_FREE',
    ranking_eligible: false,
    end_at: '2026-09-15T00:00:00.000Z',
  });
  const r = report(cardOffer({}));
  r.campaign_offers = [campaignOffer];
  const html = generateHTML(r);
  assert.ok(html.includes('期間限定キャンペーン'), 'slot title renders');
  assert.ok(html.includes('Campaign Model'), 'campaign card renders');
  // The campaign must not leak into the standing free slot.
  const freeSlot = html.slice(html.indexOf('slot-free'), html.indexOf('slot-ultra'));
  assert.ok(!freeSlot.includes('Campaign Model'), 'campaign stays out of the free slot');
});

test('the campaign slot stays hidden when there are no campaigns', () => {
  const html = generateHTML(report(cardOffer({})));
  assert.ok(!html.includes('期間限定キャンペーン'), 'no campaign slot when empty');
});

test('selectRankedOffers admits only eligible offers with FREE or ULTRA_LOW', () => {
  const reportWithMixed = report(cardOffer());
  reportWithMixed.ranked_offers.push(cardOffer({
    name: 'No Access',
    access_kind: null,
    effective_price_per_million: { input: 5, output: 5 },
  }));
  const ranked = selectRankedOffers(reportWithMixed);
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].name, 'Acme Model');
});

test('computeSnapshot counts FREE via access_kind and limited via discount', () => {
  const offers = [
    cardOffer({ access_kind: 'FREE' }),
    cardOffer({ access_kind: 'ULTRA_LOW', name: 'Cheap', discount_end_at: '2026-09-30T00:00:00.000Z' }),
  ];
  const snap = computeSnapshot({}, offers);
  assert.deepEqual(snap, { total: 2, sCount: 0, aCount: 2, freeCount: 1, limitedCount: 1 });
});
