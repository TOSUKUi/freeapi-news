'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('./ranking-policy');

test('deriveAccessKind boundary: positive zero both is FREE', () => {
  assert.equal(policy.deriveAccessKind(0, 0), 'FREE');
  assert.equal(policy.deriveAccessKind(0.0, -0), null, '-0 is not positive zero');
});

test('deriveAccessKind boundary: 0.2/0.4 is ULTRA_LOW, above is null', () => {
  assert.equal(policy.deriveAccessKind(0.2, 0.4), 'ULTRA_LOW');
  assert.equal(policy.deriveAccessKind(0.199999, 0.399999), 'ULTRA_LOW');
  assert.equal(policy.deriveAccessKind(0.200001, 0.4), null);
  assert.equal(policy.deriveAccessKind(0.2, 0.400001), null);
});

test('deriveAccessKind rejects unknown and negative prices', () => {
  assert.equal(policy.deriveAccessKind(null, 0), null);
  assert.equal(policy.deriveAccessKind(undefined, 0), null);
  assert.equal(policy.deriveAccessKind(NaN, 0), null);
  assert.equal(policy.deriveAccessKind(Infinity, 0), null);
  assert.equal(policy.deriveAccessKind(-0.1, 0), null);
});

test('qualifiesTerminalBench admits only 2.0/2.1 at or above 50', () => {
  assert.equal(policy.qualifiesTerminalBench('terminal_bench_2_1', 50), true);
  assert.equal(policy.qualifiesTerminalBench('terminal_bench_2_1', 49.999), false);
  assert.equal(policy.qualifiesTerminalBench('terminal_bench_2_0', 50), true);
  assert.equal(policy.qualifiesTerminalBench('terminal_bench_2_0', 49.999), false);
  assert.equal(policy.qualifiesTerminalBench('terminal_bench_2_2', 90), false, 'future versions stay pending');
  assert.equal(policy.qualifiesTerminalBench('swe_bench_verified', 90), false, 'other benchmarks never admit');
  assert.equal(policy.qualifiesTerminalBench('terminal_bench_2_1', null), false);
  assert.equal(policy.qualifiesTerminalBench('terminal_bench_2_1', '57'), false, 'string scores never admit');
});

test('accessKindMatches requires exact derivation', () => {
  assert.equal(policy.accessKindMatches('FREE', 0, 0), true);
  assert.equal(policy.accessKindMatches('FREE', 0.05, 0.05), false, 'non-zero FREE is a mismatch');
  assert.equal(policy.accessKindMatches('ULTRA_LOW', 0.2, 0.4), true);
  assert.equal(policy.accessKindMatches('ULTRA_LOW', 0.2, 0.400001), false);
  assert.equal(policy.accessKindMatches('FREE', null, 0), false);
  assert.equal(policy.accessKindMatches('ULTRA_LOW', null, null), false);
});
