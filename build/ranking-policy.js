'use strict';

// Shared ranking admission policy (spec 0004 AC-4, AC-5, AC-7; AGENTS.md).
//
// This module is the single source of truth for the performance admission
// gate and the access-kind derivation. Assembler, validator, builder, and
// the catalog price admission in lanes.js all import the same constants and
// functions so the policy can never drift between stages.
//
// Invariants:
//   * A model ranks only with a verified Terminal Bench 2.0 or 2.1 score at
//     or above RANKING_MIN_SCORE (50). Scores below 50 never become a
//     rankable tier B.
//   * access_kind derives only from typed effective USD-per-million input
//     and output prices: FREE when both are positive zero, ULTRA_LOW when
//     input <= 0.2 and output <= 0.4. Unknown (null / non finite / negative)
//     prices never rank.
//   * Raw scores from different benchmark versions are never compared.

const RANKING_BENCHMARK_KEYS = ['terminal_bench_2_0', 'terminal_bench_2_1'];
const RANKING_MIN_SCORE = 50;
const ULTRA_LOW_MAX_INPUT_USD = 0.2;
const ULTRA_LOW_MAX_OUTPUT_USD = 0.4;
// Spec 0008 §4.11: frontier models are Terminal-Bench 2.0/2.1 at or above
// 80 (separate from the 50 ranking admission gate) or a watchlist
// frontier vendor. The vendor list itself is operator data in the watchlist.
const FRONTIER_MIN_SCORE = 80;
// Spec 0008 §4.7: suspicion 4-5 never ranks; an unregistered provider is
// never better than suspicion 2 (deterministic floor).
const SUSPICION_RANKING_MAX = 3;
const SUSPICION_UNREGISTERED_FLOOR = 2;

// ---------------------------------------------------------------------------
// Publication policy by offer kind (operator decision 2026-08-24).
// The main free slots (完全無料 / 超激安) are for standing access only:
//   * free tiers that renew (per day / per month)        -> published
//   * permanently offered free models, clear rate limits  -> published
//   * free operation via ads etc.                         -> published
// Everything else is routed deterministically by classification:
//   * C_LIMITED_FREE  -> campaign_offers (separate slot, never the main slots)
//   * D_TRIAL_CREDIT  -> never published (one-time credits, trial / preview /
//                        prototype access programs)
//   * NVIDIA NIM free endpoints are never published in principle, except
//     NVIDIA first-party models (nvidia/ namespace), which are standing
//     offerings.
// ---------------------------------------------------------------------------

// Classifications that always go to the separate campaign slot.
const CAMPAIGN_CLASSES = ['C_LIMITED_FREE'];
// Classifications that are never published anywhere (excluded with a reason).
const NON_PUBLISHABLE_CLASSES = ['D_TRIAL_CREDIT'];

// A NIM model id in the first-party nvidia/ namespace (nemotron, llama
// nemotron, etc.) is a standing NVIDIA offering; every other namespace on
// integrate.api.nvidia.com is a hosted third-party free endpoint.
function isNvidiaFirstPartyModelId(modelId) {
  return typeof modelId === 'string' && /^nvidia\//i.test(modelId);
}

// NIM free-endpoint publication rule (operator 2026-08-24): a free or
// ultra-low offer on provider 'nvidia' whose model id is NOT in the
// first-party nvidia/ namespace is excluded in principle. Returns a
// deterministic exclusion reason, or null when the offer may be published.
function nimFreeEndpointExclusion({ providerKey, accessKind, modelId } = {}) {
  if (providerKey !== 'nvidia') return null;
  if (accessKind !== 'FREE' && accessKind !== 'ULTRA_LOW') return null;
  if (isNvidiaFirstPartyModelId(modelId)) return null;
  return '[nim] NIM free endpoints are excluded in principle; only standing NVIDIA first-party (nvidia/*) models are published';
}

// Catalog and publication stages must share the same access thresholds.
function isPriceEligible(input, output) {
  return deriveAccessKind(input, output) !== null;
}

// Positive zero only: Object.is style check via 1/n so "-0" is not free.
function isPositiveZero(n) {
  return n === 0 && 1 / n === Infinity;
}

// Access kind (AC-4): FREE when effective input and output are both positive
// zero; ULTRA_LOW when both are finite non-negative and within the per
// million limits; otherwise null (unknown or over limit, never ranked).
// -0 is not a genuine zero and never admits (isPositiveZero rejects it).
function deriveAccessKind(effectiveInputUsd, effectiveOutputUsd) {
  const input = effectiveInputUsd;
  const output = effectiveOutputUsd;
  if (typeof input !== 'number' || !Number.isFinite(input) ||
      typeof output !== 'number' || !Number.isFinite(output) ||
      input < 0 || output < 0) {
    return null;
  }
  // -0 is not a genuine zero: reject it so it never passes as FREE or
  // ULTRA_LOW (isPositiveZero returns false for -0).
  if (input === 0 && !isPositiveZero(input)) return null;
  if (output === 0 && !isPositiveZero(output)) return null;
  if (isPositiveZero(input) && isPositiveZero(output)) return 'FREE';
  if (input <= ULTRA_LOW_MAX_INPUT_USD && output <= ULTRA_LOW_MAX_OUTPUT_USD) return 'ULTRA_LOW';
  return null;
}

// access_kind matches when the effective prices are known and derive exactly
// to the given kind (AC-4). A null price object never matches.
function accessKindMatches(accessKind, effectiveInputUsd, effectiveOutputUsd) {
  return deriveAccessKind(effectiveInputUsd, effectiveOutputUsd) === accessKind;
}

// A benchmark key is a ranking admission key (AC-5).
function isRankingBenchmarkKey(key) {
  return RANKING_BENCHMARK_KEYS.includes(key);
}

// A verified Terminal Bench 2.0/2.1 score qualifies when it is at or above
// the admission gate (AC-5). Returns true only for known ranking keys and a
// finite score >= 50. Other benchmark keys and unknown versions never admit.
function qualifiesTerminalBench(benchmarkKey, score) {
  if (!isRankingBenchmarkKey(benchmarkKey)) return false;
  if (typeof score !== 'number' || !Number.isFinite(score)) return false;
  return score >= RANKING_MIN_SCORE;
}

// Effective prices are rankable when both input and output are finite,
// non-negative numbers (a derived access kind exists).
function hasRankableEffectivePrices(input, output) {
  return deriveAccessKind(input, output) !== null;
}

// ---------------------------------------------------------------------------
// Spec 0008 §4.11: DISCOUNTED admission (Gate 2 extension) and frontier
// qualification. A discounted frontier model shows at any absolute price.
// ---------------------------------------------------------------------------

// Deterministic price check for a discount: normal and effective are both
// known (at least one direction each) and normal strictly exceeds effective
// in at least one direction. No inference from missing sides.
function isDiscountPrice(normalInput, normalOutput, effectiveInput, effectiveOutput) {
  const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!finite(normalInput) || !finite(normalOutput) ||
      !finite(effectiveInput) || !finite(effectiveOutput)) {
    return false;
  }
  return normalInput > effectiveInput || normalOutput > effectiveOutput;
}

// Discount rate per direction in percent (null when the direction has no
// positive normal price). The report shows both rates; admission only needs
// isDiscountPrice.
function discountRates(normalInput, normalOutput, effectiveInput, effectiveOutput) {
  const rate = (normal, effective) => {
    if (typeof normal !== 'number' || typeof effective !== 'number' ||
        !Number.isFinite(normal) || !Number.isFinite(effective) || normal <= 0) {
      return null;
    }
    return Math.round(((normal - effective) / normal) * 1000) / 10;
  };
  return {
    input: rate(normalInput, effectiveInput),
    output: rate(normalOutput, effectiveOutput),
  };
}

// A benchmark key qualifies for frontier at the 80 line (same keys as
// ranking; the threshold is the only difference).
function qualifiesFrontierBenchmark(benchmarkKey, score) {
  if (!isRankingBenchmarkKey(benchmarkKey)) return false;
  if (typeof score !== 'number' || !Number.isFinite(score)) return false;
  return score >= FRONTIER_MIN_SCORE;
}

// ---------------------------------------------------------------------------
// Spec 0008 §4.7: Gate 3 deterministic operational confidence.
// Returns 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE'. NONE is a deterministic
// ranking exclusion (e.g. a $0 router model with zero providers: listed but
// not operable). The LLM's confidence is advisory only and never drives this.
// ---------------------------------------------------------------------------

function deriveOperationalConfidence({
  providerKey = null,
  accessKind = null,
  verified = false,
  staleMild = false,
  providerCount = null,
  uptimePercent = null,
  freeEndpointStatus = null,
  apiCalls30d = null,
} = {}) {
  const isRouter = providerKey === 'openrouter';
  const isNvidia = providerKey === 'nvidia';
  const count = Number.isInteger(providerCount) ? providerCount : null;
  const uptime = typeof uptimePercent === 'number' && Number.isFinite(uptimePercent)
    ? uptimePercent : null;
  const calls = Number.isInteger(apiCalls30d) ? apiCalls30d : null;

  if (isNvidia && (accessKind === 'FREE' || accessKind === 'ULTRA_LOW')) {
    // NIM: the individual free endpoint page is the operational evidence.
    if (freeEndpointStatus === 'deprecated') return 'NONE';
    if (freeEndpointStatus === 'available') {
      return (calls !== null && calls > 0) ? 'HIGH' : 'MEDIUM';
    }
    return 'LOW'; // unknown: the page was not verified this run
  }

  if (isRouter) {
    // A measured zero provider set at $0 / ultra-low is not operable:
    // deterministic exclusion, not merely low confidence (spec: listed but
    // no provider). An unobserved model (count null) is not an observed
    // zero: carried-over evidence stays rankable at MEDIUM (fail-safe).
    if (count === 0 && accessKind && accessKind !== 'DISCOUNTED') return 'NONE';
    if ((count !== null && count > 0) && uptime !== null) return 'HIGH';
    if ((count !== null && count > 0) || uptime !== null) return 'MEDIUM';
    if (verified || staleMild) return 'MEDIUM';
    return 'LOW';
  }

  // Official providers: this run's docs / pricing fetch success is HIGH.
  // A mild stale carryover (failures below the caution threshold) keeps the
  // last verified evidence rankable at MEDIUM; deeper staleness is LOW.
  if (verified) return 'HIGH';
  return staleMild ? 'MEDIUM' : 'LOW';
}

module.exports = {
  RANKING_BENCHMARK_KEYS,
  RANKING_BENCHMARK_KEY: 'terminal_bench_2_1',
  RANKING_MIN_SCORE,
  ULTRA_LOW_MAX_INPUT_USD,
  ULTRA_LOW_MAX_OUTPUT_USD,
  isPositiveZero,
  deriveAccessKind,
  isPriceEligible,
  accessKindMatches,
  isRankingBenchmarkKey,
  qualifiesTerminalBench,
  hasRankableEffectivePrices,
  // spec 0008
  FRONTIER_MIN_SCORE,
  SUSPICION_RANKING_MAX,
  SUSPICION_UNREGISTERED_FLOOR,
  isDiscountPrice,
  discountRates,
  qualifiesFrontierBenchmark,
  deriveOperationalConfidence,
  // publication policy by kind (operator 2026-08-24)
  CAMPAIGN_CLASSES,
  NON_PUBLISHABLE_CLASSES,
  isNvidiaFirstPartyModelId,
  nimFreeEndpointExclusion,
};
