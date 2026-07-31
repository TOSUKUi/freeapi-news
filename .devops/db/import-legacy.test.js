'use strict';

// One time legacy import tests (spec 0003, build plan step 7). Proves the
// old tracked operational JSON (known_offers.json + benchmarks.json) maps
// into the SQLite offers and benchmarks tables with correct canonical
// identity, and that the import refuses to clobber a non empty store.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const db = require('./collector-db');
const importLegacy = require('./import-legacy');

const REGISTRY = {
  version: 1,
  providers: [
    { key: 'openrouter', label: 'OpenRouter', match: ['openrouter'], base_url: 'https://openrouter.ai/api/v1', delivery_type: 'router' },
    { key: 'google', label: 'Google Gemini', match: ['google', 'gemini'], base_url: 'https://generativelanguage.googleapis.com/v1beta', delivery_type: 'official' },
  ],
};

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'import-legacy-test-'));
  const stateDir = path.join(root, 'state');
  const legacyDir = path.join(root, 'legacy');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'provider-registry.json'), JSON.stringify(REGISTRY, null, 2) + '\n');
  return { root, stateDir, legacyDir, options: { projectRoot: root, stateDir } };
}

function writeLegacy(ctx) {
  fs.writeFileSync(path.join(ctx.legacyDir, 'known_offers.json'), JSON.stringify({
    updated_at: '2026-07-30T18:11:26Z',
    offers: [
      {
        name: 'Kimi K3', provider: 'OpenRouter', model_id: 'moonshotai/kimi-k3',
        ranking_eligible: true, benchmark_tier: 'S', benchmark_score: 88.3,
        base_url: 'https://openrouter.ai/api/v1', last_verified: '2026-07-30T18:02:03Z',
        endpoint_source: 'https://openrouter.ai/moonshotai/kimi-k3',
      },
      {
        name: 'Gemini 2.5 Pro', provider: 'Google Gemini', model_id: 'gemini-2.5-pro',
        ranking_eligible: true, benchmark_tier: 'A', benchmark_score: 59,
        base_url: 'https://generativelanguage.googleapis.com/v1beta', last_verified: '2026-07-30T18:10:46Z',
        endpoint_source: 'https://ai.google.dev/gemini-api/docs/pricing',
      },
      { name: 'No Provider Match', provider: 'Unknown Vendor', model_id: 'x/y' },
    ],
  }, null, 2) + '\n');

  fs.writeFileSync(path.join(ctx.legacyDir, 'benchmarks.json'), JSON.stringify({
    version: 1,
    updated_at: '2026-07-30T18:11:26Z',
    models: [
      {
        // Bare name first, prefixed id second (matches real legacy data): the
        // importer must index the benchmark under BOTH canonical identities so
        // the offer (canonical moonshotai/kimi-k3) still joins to its score.
        canonical_name: 'Kimi K3', model_ids: ['kimi-k3', 'moonshotai/kimi-k3', 'moonshotai/kimi-k3:free'],
        aliases: ['kimi-k3'],
        benchmarks: [
          { name: 'Terminal-Bench 2.1', score: 88.3, source: 'https://x.example/kimi', extraction_method: 'visual_approximate', accessed_at: '2026-07-30T18:02:03Z' },
          { name: 'Terminal Bench 2.1', score: 90, source: 'https://x.example/kimi2', accessed_at: '2026-07-30T18:02:03Z' },
        ],
      },
      {
        canonical_name: 'Gemini 2.5 Pro', model_ids: ['gemini-2.5-pro'],
        benchmarks: [
          { name: 'Terminal-Bench 2.1', score: 59, source: 'https://x.example/gemini', accessed_at: '2026-07-30T18:10:46Z' },
          { name: 'Bad Score', score: 150, source: 'https://x.example/bad' },
          { name: 'No Source', score: 40, source: '' },
        ],
      },
    ],
  }, null, 2) + '\n');
}

describe('importLegacyState', () => {
  let ctx;
  beforeEach(() => { ctx = tmpProject(); });
  afterEach(() => { fs.rmSync(ctx.root, { recursive: true, force: true }); });

  it('imports offers and benchmarks with canonical identity', () => {
    writeLegacy(ctx);
    const summary = importLegacy.importLegacyState({ ...ctx.options, legacyDir: ctx.legacyDir });

    assert.equal(summary.offersImported, 2, 'two offers resolve to registry providers');
    assert.equal(summary.offersSkipped, 1, 'unknown provider offer is skipped');
    // Kimi K3 has two Terminal-Bench 2.1 variants that collapse to one key.
    // Gemini has one valid row; the 150 score and empty source are invalid.
    assert.equal(summary.benchmarksInvalid, 2);

    const database = db.openCollectorDb(ctx.options);
    try {
      const offers = database.prepare('SELECT provider_key, exact_model_id, canonical_model_id, status FROM offers ORDER BY exact_model_id').all();
      assert.deepEqual(offers.map((o) => o.exact_model_id), ['gemini-2.5-pro', 'moonshotai/kimi-k3']);
      assert.equal(offers[1].provider_key, 'openrouter');
      assert.equal(offers[1].canonical_model_id, 'moonshotai/kimi-k3');
      assert.equal(offers.every((o) => o.status === 'verified'), true);

      const benches = database.prepare('SELECT canonical_model_id, benchmark_key, score FROM benchmarks ORDER BY canonical_model_id').all();
      // The benchmark is indexed under the offer's canonical id (the join key
      // buildCandidateView uses), even though the bare name led model_ids.
      const kimi = benches.filter((b) => b.canonical_model_id === 'moonshotai/kimi-k3');
      assert.equal(kimi.length, 1, 'two display variants collapse to one terminal_bench_2_1 row');
      assert.equal(kimi[0].benchmark_key, 'terminal_bench_2_1');
      assert.equal(kimi[0].score, 88.3, 'first seen score wins (insert only)');
      // Also indexed under the bare canonical name.
      assert.ok(benches.some((b) => b.canonical_model_id === 'kimi-k3' && b.benchmark_key === 'terminal_bench_2_1'));
    } finally {
      database.close();
    }
  });

  it('refuses to run against a non empty offers table without force', () => {
    writeLegacy(ctx);
    importLegacy.importLegacyState({ ...ctx.options, legacyDir: ctx.legacyDir });
    assert.throws(
      () => importLegacy.importLegacyState({ ...ctx.options, legacyDir: ctx.legacyDir }),
      /non empty offers table/
    );
    // force merges without throwing.
    const again = importLegacy.importLegacyState({ ...ctx.options, legacyDir: ctx.legacyDir, force: true });
    assert.equal(again.offersImported, 2);
  });

  it('throws when no legacy state exists', () => {
    assert.throws(
      () => importLegacy.importLegacyState({ ...ctx.options, legacyDir: ctx.legacyDir }),
      /no legacy state found/
    );
  });
});
