'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildReportSummary } = require('./summary-text');

const EMPTY_SUMMARY =
  '無料・割引 LLM API の日次ランキング。今回ランクイン 0 件（S 0、A 0、B 0）、注意 0 件、対象外 0 件。';

test('summary helper treats missing and empty arrays as zero counts', () => {
  assert.equal(buildReportSummary(), EMPTY_SUMMARY);
  assert.equal(buildReportSummary({
    ranked_offers: [],
    caution_offers: [],
    excluded_offers: [],
  }), EMPTY_SUMMARY);
});

test('summary helper counts only eligible offers and their final S/A/B tiers', () => {
  assert.equal(buildReportSummary({
    ranked_offers: [
      { ranking_eligible: true, benchmark: { tier: 'S' } },
      { ranking_eligible: true, benchmark: { tier: 'A' } },
      { ranking_eligible: true, benchmark: { tier: 'B' } },
      { ranking_eligible: false, benchmark: { tier: 'S' } },
    ],
    caution_offers: [{}],
    excluded_offers: [{}, {}],
  }), '無料・割引 LLM API の日次ランキング。今回ランクイン 3 件（S 1、A 1、B 1）、注意 1 件、対象外 2 件。');
});
