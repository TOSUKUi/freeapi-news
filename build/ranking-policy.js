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
};
