'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseQuotesFromPage,
  selectCandidates,
  fetchPriceIndex,
  pageUrlFor,
} = require('./price-index');

// A minimal but format-faithful Next.js RSC payload: the quote array is
// embedded across several self.__next_f.push([1, "…"]) chunks, JSON-escaped
// exactly like the production pages.
function makePageHtml(quotes) {
  const inner = JSON.stringify(quotes);
  // Split the payload into a few chunks to exercise reassembly.
  const parts = [];
  const step = Math.max(1, Math.floor(inner.length / 3));
  for (let i = 0; i < inner.length; i += step) {
    parts.push(inner.slice(i, i + step));
  }
  return parts
    .map((p) => `self.__next_f.push([1,${JSON.stringify(p)}])`)
    .join('\n');
}

test('parseQuotesFromPage extracts the per-provider quote array from RSC chunks', () => {
  const html = makePageHtml([
    { provider: 'openai', modelId: 'gpt-5.6-sol', input: 5, output: 30, cacheRead: 0.5, official: true, context: 1050000 },
    { provider: 'vercel', modelId: 'openai/gpt-5.6-sol', input: 2.5, output: 15, cacheRead: 0.25, official: false, context: 1050000 },
    { provider: 'nano-gpt', modelId: 'openai/gpt-5.6-sol', input: 2.5, output: 15, cacheRead: 0.25, official: false, context: 1050000 },
    { provider: 'other', modelId: 'gpt-5.6-sol', input: null, output: null, cacheRead: null, official: false },
  ]);
  const quotes = parseQuotesFromPage(html);
  assert.strictEqual(quotes.length, 4);
  const vercel = quotes.find((q) => q.provider === 'vercel');
  assert.deepStrictEqual(
    { input: vercel.input, output: vercel.output, official: vercel.official },
    { input: 2.5, output: 15, official: false },
  );
  const official = quotes.find((q) => q.official);
  assert.strictEqual(official.provider, 'openai');
  assert.strictEqual(official.input, 5);
  // Null prices stay null, never 0.
  const other = quotes.find((q) => q.provider === 'other');
  assert.strictEqual(other.input, null);
});

test('parseQuotesFromPage tolerates malformed payloads', () => {
  const good = JSON.stringify(JSON.stringify(
    { provider: 'a', modelId: 'm', input: 1, output: 2, official: false }
  ));
  const broken = JSON.stringify('not-json{broken"unterminated');
  const html = `self.__next_f.push([1,${broken}])\nself.__next_f.push([1,${good}])`;
  const quotes = parseQuotesFromPage(html);
  assert.strictEqual(quotes.length, 1);
  assert.strictEqual(quotes[0].provider, 'a');
});

test('selectCandidates rechecks previously discounted models first, then active discounted models', () => {
  const models = [
    { id: 'openai/gpt-5.6-sol', usage: { rank: 10 }, reference: { input: 5, output: 30, official: true }, cheapest: { input: 2.5, output: 15, official: false }, blendedMin: 2.5 },
    { id: 'lab/model-b', usage: { rank: 2 }, reference: { input: 10, output: 40, official: true }, cheapest: { input: 4, output: 16, official: false }, blendedMin: 4 },
    // Full price: no discount, never a candidate.
    { id: 'lab/model-c', usage: { rank: 1 }, reference: { input: 1, output: 2, official: true }, cheapest: { input: 1, output: 2, official: false } },
    // A 1% saving is rounding, not a discount.
    { id: 'lab/model-d', usage: { rank: 3 }, reference: { input: 10, output: 40, official: true }, cheapest: { input: 9.95, output: 39.8, official: false } },
  ];
  const picked = selectCandidates(models, new Set(['old/model-x']));
  assert.strictEqual(picked[0], 'old/model-x');
  assert.strictEqual(picked[1], 'lab/model-b'); // active rank 2 beats rank 10
  assert.strictEqual(picked[2], 'openai/gpt-5.6-sol');
  assert.ok(!picked.includes('lab/model-c'));
  assert.ok(!picked.includes('lab/model-d'));
});

test('fetchPriceIndex builds the lane artifact from injected fetches', async () => {
  const index = {
    meta: { syncedAt: '2026-08-20T02:00:00Z', license: 'CC-BY-4.0' },
    models: [
      {
        id: 'openai/gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        lab: 'openai',
        usage: { rank: 5 },
        reference: { provider: 'openai', input: 5, output: 30, official: true },
        cheapest: { provider: 'vercel', input: 2.5, output: 15, official: false },
        blendedMin: 2.5,
      },
    ],
  };
  const page = makePageHtml([
    { provider: 'openai', modelId: 'gpt-5.6-sol', input: 5, output: 30, cacheRead: 0.5, official: true, context: 1050000 },
    { provider: 'vercel', modelId: 'openai/gpt-5.6-sol', input: 2.5, output: 15, cacheRead: 0.25, official: false, context: 1050000 },
  ]);
  const fetchImpl = async (url) => {
    if (url === 'https://llmpricing.dev/api/models.json') return { status: 200, body: JSON.stringify(index) };
    if (url === pageUrlFor('openai/gpt-5.6-sol')) return { status: 200, body: page };
    throw new Error(`unexpected url ${url}`);
  };
  const artifact = await fetchPriceIndex({ fetchImpl, recheckIds: [] });
  assert.strictEqual(artifact.status, 'complete');
  assert.strictEqual(artifact.available, true);
  assert.strictEqual(artifact.models.length, 1);
  const model = artifact.models[0];
  assert.strictEqual(model.model_id, 'openai/gpt-5.6-sol');
  assert.deepStrictEqual(model.reference, { provider: 'openai', input: 5, output: 30 });
  assert.strictEqual(model.quotes.length, 2);
  assert.strictEqual(artifact.fetches.length, 2);
  assert.ok(artifact.fetches.every((f) => typeof f.content_hash === 'string'));
});

test('fetchPriceIndex fails cleanly when the index is unreachable', async () => {
  const artifact = await fetchPriceIndex({
    fetchImpl: async () => { throw new Error('offline'); },
  });
  assert.strictEqual(artifact.status, 'failed');
  assert.strictEqual(artifact.available, false);
  assert.strictEqual(artifact.models.length, 0);
  assert.ok(artifact.errors.length > 0);
});

test('lane wiring: manifest carries the price_index task with the artifact path', () => {
  const db = require('./collector-db');
  const lanes = require('./lanes');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'price-index-manifest-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'provider-registry.json'), JSON.stringify({
    version: 1,
    providers: [],
  }));
  const options = { projectRoot: root, stateDir };
  try {
    db.applyMigrations(options);
    const manifest = lanes.buildLaneManifest(options);
    const task = manifest.tasks.find((t) => t.kind === 'price_index');
    assert.ok(task, 'manifest must carry a price_index task');
    assert.strictEqual(task.task_id, 'price_index:llmpricing');
    assert.strictEqual(task.output, 'artifacts/price_index.json');
    const runDir = path.join(stateDir, 'crawl', 'manifest-run');
    fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
    assert.strictEqual(
      db.artifactPathFor(runDir, task.task_id),
      path.join(runDir, 'artifacts', `${db.sanitizeTaskId(task.task_id)}.json`),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
