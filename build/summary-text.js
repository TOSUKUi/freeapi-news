'use strict';

const SUMMARY_TIERS = ['S', 'A', 'B'];

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// The public summary is derived only from the report arrays after all
// deterministic assembly and validation changes have been applied.
function buildReportSummary(report = {}) {
  const ranked = asArray(report && report.ranked_offers).filter((offer) =>
    offer && offer.ranking_eligible === true
  );
  const caution = asArray(report && report.caution_offers);
  const excluded = asArray(report && report.excluded_offers);
  const tierCounts = Object.fromEntries(SUMMARY_TIERS.map((tier) => [
    tier,
    ranked.filter((offer) => offer.benchmark && offer.benchmark.tier === tier).length,
  ]));
  const freeCount = ranked.filter((offer) => offer.access_kind === 'FREE').length;
  const ultraLowCount = ranked.filter((offer) => offer.access_kind === 'ULTRA_LOW').length;

  return `無料・激安 LLM API の日次ランキング。今回ランクイン ${ranked.length} 件` +
    `（S ${tierCounts.S}、A ${tierCounts.A}、B ${tierCounts.B}）、` +
    `無料 ${freeCount} 件、激安 ${ultraLowCount} 件、` +
    `注意 ${caution.length} 件、対象外 ${excluded.length} 件。`;
}

module.exports = { buildReportSummary };
