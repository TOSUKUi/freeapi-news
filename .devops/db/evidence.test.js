'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const db = require('./collector-db');
const evidence = require('./evidence');

function ctx() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'free-api-evidence-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'provider-registry.json'), '{"providers":[]}');
  return { root, stateDir, options: { projectRoot: root, stateDir } };
}

function serverFixture() {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/facts' }); res.end(); return;
    }
    if (req.url === '/status') { res.writeHead(503); res.end('offline'); return; }
    if (req.url === '/irrelevant') { res.writeHead(200); res.end('welcome'); return; }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Acme acme/model-v1 price $0 Terminal Bench 2.1 55 https://api.acme.test/v1 acme/model-v1');
  });
  return server;
}

test('bounded HTTP evidence records redirects, status, final URL, and body hash', async (t) => {
  const server = serverFixture();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const ok = await evidence.fetchOfficialEvidence(`${base}/redirect`, { attempts: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.status, 200);
  assert.equal(ok.final_url, `${base}/facts`);
  assert.match(ok.body_hash, /^[0-9a-f]{64}$/);
  const failed = await evidence.fetchOfficialEvidence(`${base}/status`, { attempts: 1 });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 503);
});

test('removal evidence binds the exact model to one normalized semantic region', () => {
  assert.equal(evidence.removalEvidenceRelevant('<tr><td>model-one</td><td>removed</td></tr>', { model_id: 'model-one' }), true);
  assert.equal(evidence.removalEvidenceRelevant('model-one was removed. model-two remains available.', { model_id: 'model-two' }), false);
  assert.equal(evidence.removalEvidenceRelevant('model-two is available; model-one was removed', { model_id: 'model-two' }), false);
  assert.equal(evidence.removalEvidenceRelevant('model-two is supported and live', { model_id: 'model-two' }), false);
  assert.equal(evidence.removalEvidenceRelevant('model-two was not removed', { model_id: 'model-two' }), false);
  assert.equal(evidence.removalEvidenceRelevant('<li>model-two</li><li>was removed</li>', { model_id: 'model-two' }), false);
  assert.equal(evidence.removalEvidenceRelevant('model-two is deprecated', { model_id: 'model-two' }, '2026-08-15T00:00:00Z'), false, 'deprecated alone is not completed removal');
  assert.equal(evidence.removalEvidenceRelevant('model-two will be removed on 2026-08-20', { model_id: 'model-two' }, '2026-08-15T00:00:00Z'), false, 'future removal is not current');
  assert.equal(evidence.removalEvidenceRelevant('model-two scheduled for removal on 2026-08-01', { model_id: 'model-two' }, '2026-08-15T00:00:00Z'), false, 'scheduled removal is not completed');
  assert.equal(evidence.removalEvidenceRelevant('model-two was removed on 2026-08-01', { model_id: 'model-two' }, '2026-08-15T00:00:00Z'), true, 'completed past removal is current');
});

test('removal audit requires assigned official provenance and keeps redirects official', async () => {
  const official = 'https://docs.acme.example/removals';
  const allowedRedirect = 'https://docs.acme.example/old-removals';
  const badRedirect = 'https://docs.acme.example/bad-removals';
  const responses = new Map([
    [official, { status: 200, url: official, body: '<p>acme/model-one was removed from the API.</p>' }],
    [allowedRedirect, { status: 302, headers: new Map([['location', official]]), url: allowedRedirect, body: '' }],
    [badRedirect, { status: 302, headers: new Map([['location', 'https://unofficial.example/removals']]), url: badRedirect, body: '' }],
    ['https://unofficial.example/removals', { status: 200, url: 'https://unofficial.example/removals', body: 'acme/model-one was removed from the API.' }],
  ]);
  const fetchImpl = async (url) => responses.get(url) || { status: 404, url, body: '' };
  const registryProviders = [{ key: 'acme', docs_url: official, base_url: 'https://api.acme.example/v1', api_catalog_url: 'https://api.acme.example/v1/models' }];
  async function audit(sourceUrl) {
    const result = { provider_key: 'acme', models: [], removals: [{ model_id: 'acme/model-one', source_url: sourceUrl, reason: 'official removal' }] };
    return (await evidence.auditRunEvidence([{ kind: 'known_refresh', result_json: result }], {
      attempts: 1, fetchImpl, registryProviders,
    })).tasks[0].result_json.removals;
  }
  assert.equal((await audit(official)).length, 1, 'canonical official domain is accepted');
  assert.equal((await audit(allowedRedirect)).length, 1, 'redirect ending on official domain is accepted');
  assert.equal((await audit(badRedirect)).length, 0, 'redirect ending on arbitrary domain is rejected');
  assert.equal((await audit('https://unofficial.example/removals')).length, 0, 'arbitrary matching domain is rejected');
});

test('completed free to paid transitions pass, but future transitions fail', async () => {
  const source = 'https://docs.acme.example/transition';
  const registryProviders = [{ key: 'acme', docs_url: source, base_url: 'https://api.acme.example/v1' }];
  async function audit(body) {
    const result = {
      provider_key: 'acme', models: [],
      removals: [{ model_id: 'acme/model-one', source_url: source, reason: 'pricing transition' }],
    };
    return (await evidence.auditRunEvidence([{ kind: 'known_refresh', result_json: result }], {
      attempts: 1, now: '2026-08-15T00:00:00Z', registryProviders,
      fetchImpl: async () => ({ status: 200, url: source, body, headers: new Map() }),
    })).tasks[0].result_json.removals;
  }
  assert.equal((await audit('acme/model-one changed from free to paid on 2026-08-01')).length, 1,
    'past free to paid transition confirms removal');
  assert.equal((await audit('acme/model-one switched from free to paid on 2026-09-01')).length, 0,
    'future dated free to paid transition is rejected');
  assert.equal((await audit('acme/model-one will switch from free to paid')).length, 0,
    'future transition language is rejected');
});

test('multi tenant provenance requires the Registry namespace and checks redirect finals', async () => {
  const docs = 'https://huggingface.co/docs/acme/removals';
  const arbitrary = 'https://huggingface.co/arbitrary-user/unofficial-post';
  const allowed = 'https://huggingface.co/docs/acme/removals/archive';
  const crossOrigin = 'https://huggingface.co/docs/acme/redirect';
  const responses = new Map([
    [docs, { status: 200, url: docs, body: 'acme/model-one was removed' }],
    [arbitrary, { status: 200, url: arbitrary, body: 'acme/model-one was removed' }],
    [allowed, { status: 200, url: allowed, body: 'acme/model-one was removed' }],
    [crossOrigin, { status: 302, url: crossOrigin, headers: new Map([['location', 'https://github.com/other-user/post']]), body: '' }],
    ['https://github.com/other-user/post', { status: 200, url: 'https://github.com/other-user/post', body: 'acme/model-one was removed' }],
  ]);
  const fetchImpl = async (url) => responses.get(url) || { status: 404, url, body: '', headers: new Map() };
  const registryProviders = [{ key: 'hf', docs_url: docs, base_url: 'https://api.hf.example/v1' }];
  async function audit(sourceUrl) {
    const result = { provider_key: 'hf', models: [], removals: [{ model_id: 'acme/model-one', source_url: sourceUrl, reason: 'official removal' }] };
    return (await evidence.auditRunEvidence([{ kind: 'known_refresh', result_json: result }], {
      attempts: 1, fetchImpl, registryProviders, now: '2026-08-15T00:00:00Z',
    })).tasks[0].result_json.removals;
  }
  assert.equal((await audit(arbitrary)).length, 0, 'arbitrary user content on the official host is rejected');
  assert.equal((await audit(allowed)).length, 1, 'official Registry descendants are accepted');
  assert.equal((await audit(crossOrigin)).length, 0, 'cross origin redirect final is rejected');
});

test('audit accepts only relevant 2xx source/provider evidence and deduplicates claims', async (t) => {
  const server = serverFixture();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = {
    task_id: 'discovery', status: 'complete', provider_key: '_discovery', models: [{
      provider_key: 'acme', model_id: 'acme/model-v1', pricing_text: '$0',
      benchmark_finds: [{ name: 'Terminal Bench 2.1', score: 55 }],
    }],
    source_candidates: [
      { category: 'community', label: 'Acme Facts', source_url: `${base}/redirect`, provider_key: 'acme', model_id: 'acme/model-v1', fact_text: '$0' },
      { category: 'community', label: 'Acme Facts', source_url: `${base}/irrelevant`, provider_key: 'acme', model_id: 'acme/model-v1', fact_text: '$0' },
    ],
    provider_candidates: [{
      provider_key: 'newacme', label: 'New Acme', base_url: 'https://api.acme.test/v1', docs_url: `${base}/facts`,
      model_id_pattern: '^acme/', model_id_example: 'acme/model-v1',
    }], errors: [],
  };
  const audit = await evidence.auditRunEvidence([{ kind: 'discovery', result_json: result, assigned_json: { discovery_sources: [], search_terms: [] } }], { attempts: 1 });
  const audited = audit.tasks[0].result_json;
  assert.equal(audited.source_candidates.length, 1);
  assert.equal(audited.provider_candidates.length, 1);
  assert.equal(audit.sourceCache.length, 2);
  assert.ok(audit.sourceCache.every((row) => row.http_status >= 200 && row.http_status < 300));
});

test('structured worker prices require fetched relevant price and conversion evidence', async () => {
  const responses = new Map([
    ['https://prices.example/usd', { status: 200, body: 'acme/model-v1 input 0.000001 output 0.000002 USD per token' }],
    ['https://prices.example/eur', { status: 200, body: 'acme/model-v1 input 0.01 output 0.02 EUR per million tokens' }],
    ['https://rates.example/eur-usd', { status: 200, body: '1 EUR = 1.1 USD confirmed 2026-08-01T00:00:00.000Z' }],
    ['https://prices.example/irrelevant', { status: 200, body: 'acme/model-v1 pricing unavailable' }],
  ]);
  const fetchImpl = async (url) => {
    const response = responses.get(url);
    if (!response) return { status: 503, body: 'offline', headers: new Map() };
    return { ...response, headers: new Map(), url };
  };
  const models = [
    { model_id: 'acme/model-v1', source_amount_input: 0.000001, source_amount_output: 0.000002, source_currency: 'USD', source_unit: 'per_token', price_source_url: 'https://prices.example/usd' },
    { model_id: 'acme/model-v1', source_amount_input: 0.01, source_amount_output: 0.02, source_currency: 'EUR', source_unit: 'per_million_tokens', conversion_rate: 1.1, conversion_source: 'https://rates.example/eur-usd', conversion_confirmed_at: '2026-08-01T00:00:00.000Z', price_source_url: 'https://prices.example/eur' },
    { model_id: 'acme/model-v1', source_amount_input: 0.000001, source_amount_output: 0.000002, source_currency: 'USD', source_unit: 'per_token', price_source_url: 'https://prices.example/irrelevant' },
  ];
  const audit = await evidence.auditRunEvidence([{
    kind: 'known_refresh', result_json: { models, source_candidates: [], provider_candidates: [] },
  }], { fetchImpl, attempts: 1 });
  const audited = audit.tasks[0].result_json.models;
  assert.equal(audited[0]._price_evidence_verified, true);
  assert.equal(audited[1]._price_evidence_verified, true);
  assert.equal(audited[2]._price_evidence_verified, undefined);
  assert.equal(audited[2].price_source_url, undefined);
});

test('price unit evidence rejects a per token body for a per million claim', async () => {
  const model = {
    model_id: 'acme/model-v1', source_amount_input: 0.000001,
    source_amount_output: 0.000002, source_currency: 'USD',
    source_unit: 'per_million_tokens', price_source_url: 'https://prices.example/unit',
  };
  const audit = await evidence.auditRunEvidence([{
    kind: 'known_refresh', result_json: {
      models: [model], source_candidates: [], provider_candidates: [],
    },
  }], {
    attempts: 1,
    fetchImpl: async () => ({
      status: 200, headers: new Map(), url: 'https://prices.example/unit',
      body: 'acme/model-v1 input 0.000001 output 0.000002 USD per token',
    }),
  });
  const rejected = audit.tasks[0].result_json.models[0];
  assert.equal(rejected._price_evidence_verified, undefined);
  assert.equal(rejected.source_unit, undefined);
  assert.equal(rejected.price_source_url, undefined);
});

test('omitting discount dates rejects a discounted raw price update and preserves no fresh claims', async () => {
  const model = {
    model_id: 'acme/model-v1',
    normal_source_amount_input: 1,
    normal_source_amount_output: 2,
    effective_source_amount_input: 0.1,
    effective_source_amount_output: 0.2,
    source_currency: 'USD', source_unit: 'per_million_tokens',
    price_source_url: 'https://prices.example/omitted',
  };
  const audit = await evidence.auditRunEvidence([{
    kind: 'known_refresh', result_json: { models: [model], source_candidates: [], provider_candidates: [] },
  }], {
    attempts: 1,
    fetchImpl: async () => ({
      status: 200, headers: new Map(), url: model.price_source_url,
      body: 'acme/model-v1 normal input 1 output 2 promo input 0.1 output 0.2 USD per million tokens',
    }),
  });
  const rejected = audit.tasks[0].result_json.models[0];
  assert.equal(rejected._price_evidence_verified, undefined);
  assert.equal(rejected.normal_source_amount_input, undefined);
  assert.equal(rejected.price_source_url, undefined);
});

test('discount dates require both valid ordered dates confirmed in the fetched body', async () => {
  const model = {
    model_id: 'acme/model-v1',
    normal_source_amount_input: 1, normal_source_amount_output: 2,
    effective_source_amount_input: 0.1, effective_source_amount_output: 0.2,
    source_currency: 'USD', source_unit: 'per_million_tokens',
    price_source_url: 'https://prices.example/discount-dates',
    discount_start_at: '2026-08-01T00:00:00Z',
    discount_end_at: '2026-09-01T00:00:00Z',
  };
  const run = (overrides, body, options = {}) => evidence.auditRunEvidence([{
    kind: 'known_refresh', result_json: { models: [{ ...model, ...overrides }], source_candidates: [], provider_candidates: [] },
  }], {
    attempts: 1,
    now: '2026-08-15T00:00:00.000Z',
    ...options,
    fetchImpl: async () => ({ status: 200, headers: new Map(), url: model.price_source_url, body }),
  });
  const common = 'acme/model-v1 normal input 1 normal output 2 discounted input 0.1 discounted output 0.2 USD per million tokens';
  const missingStart = await run({ discount_start_at: undefined }, `${common} ends 2026-09-01`);
  assert.equal(missingStart.tasks[0].result_json.models[0]._price_evidence_verified, undefined);
  const missingEnd = await run({ discount_end_at: undefined }, `${common} starts 2026-08-01`);
  assert.equal(missingEnd.tasks[0].result_json.models[0]._price_evidence_verified, undefined);
  const reversed = await run({ discount_start_at: model.discount_end_at, discount_end_at: model.discount_start_at }, `${common} starts 2026-09-01 ends 2026-08-01`);
  assert.equal(reversed.tasks[0].result_json.models[0]._price_evidence_verified, undefined);
  const omittedBodyDate = await run({}, `${common} starts 2026-08-01 ends 2026-09-02`);
  assert.equal(omittedBodyDate.tasks[0].result_json.models[0]._price_evidence_verified, undefined);
  const bareDates = await run({}, `${common} 2026-08-01 2026-09-01`);
  assert.equal(bareDates.tasks[0].result_json.models[0]._price_evidence_verified, undefined, 'dates without their semantic labels never confirm a discount period');
  const valid = await run({}, `${common} starts 2026-08-01 ends 2026-09-01`);
  assert.equal(valid.tasks[0].result_json.models[0]._price_evidence_verified, true);

  const markerOnly = {
    model_id: model.model_id, source_amount_input: 0.1, source_amount_output: 0.2,
    source_currency: 'USD', source_unit: 'per_million_tokens', price_source_url: model.price_source_url,
    discount_start_at: model.discount_start_at, discount_end_at: model.discount_end_at,
  };
  const markerAudit = await evidence.auditRunEvidence([{
    kind: 'known_refresh', result_json: { models: [markerOnly], source_candidates: [], provider_candidates: [] },
  }], {
    attempts: 1,
    now: '2026-08-15T00:00:00.000Z',
    fetchImpl: async () => ({ status: 200, headers: new Map(), url: model.price_source_url,
      body: 'acme/model-v1 limited input 0.1 output 0.2 USD per million tokens discount starts 2026-08-01 ends 2026-09-01' }),
  });
  assert.equal(markerAudit.tasks[0].result_json.models[0]._price_evidence_verified, true, 'body marker also requires and accepts both labeled dates');
});

test('discount dates reject expired and future intervals against the deterministic audit time', async () => {
  const model = {
    model_id: 'acme/model-v1',
    normal_source_amount_input: 1, normal_source_amount_output: 2,
    effective_source_amount_input: 0.1, effective_source_amount_output: 0.2,
    source_currency: 'USD', source_unit: 'per_million_tokens',
    price_source_url: 'https://prices.example/discount-active',
    discount_start_at: '2026-07-01T00:00:00Z',
    discount_end_at: '2026-08-01T00:00:00Z',
  };
  const run = (overrides, body) => evidence.auditRunEvidence([{
    kind: 'known_refresh', result_json: { models: [{ ...model, ...overrides }], source_candidates: [], provider_candidates: [] },
  }], {
    attempts: 1,
    now: '2026-08-15T00:00:00.000Z',
    fetchImpl: async () => ({ status: 200, headers: new Map(), url: model.price_source_url, body }),
  });
  const common = 'acme/model-v1 normal input 1 normal output 2 discounted input 0.1 discounted output 0.2 USD per million tokens';
  // Expired: interval ended before the audit time.
  const expired = await run({}, `${common} starts 2026-07-01 ends 2026-08-01`);
  assert.equal(expired.tasks[0].result_json.models[0]._price_evidence_verified, undefined);
  // Future: interval starts after the audit time.
  const future = await run({
    discount_start_at: '2026-09-01T00:00:00Z',
    discount_end_at: '2026-10-01T00:00:00Z',
  }, `${common} starts 2026-09-01 ends 2026-10-01`);
  assert.equal(future.tasks[0].result_json.models[0]._price_evidence_verified, undefined);
});

test('discount dates bind to their labels so swapped labels fail', async () => {
  const model = {
    model_id: 'acme/model-v1',
    normal_source_amount_input: 1, normal_source_amount_output: 2,
    effective_source_amount_input: 0.1, effective_source_amount_output: 0.2,
    source_currency: 'USD', source_unit: 'per_million_tokens',
    price_source_url: 'https://prices.example/discount-swap',
    discount_start_at: '2026-08-01T00:00:00Z',
    discount_end_at: '2026-09-01T00:00:00Z',
  };
  const run = (body) => evidence.auditRunEvidence([{
    kind: 'known_refresh', result_json: { models: [model], source_candidates: [], provider_candidates: [] },
  }], {
    attempts: 1,
    now: '2026-08-15T00:00:00.000Z',
    fetchImpl: async () => ({ status: 200, headers: new Map(), url: model.price_source_url, body }),
  });
  const common = 'acme/model-v1 normal input 1 normal output 2 discounted input 0.1 discounted output 0.2 USD per million tokens';
  // Both claimed dates exist in the body, but under the opposite labels.
  const swapped = await run(`${common} starts 2026-09-01 ends 2026-08-01`);
  assert.equal(swapped.tasks[0].result_json.models[0]._price_evidence_verified, undefined, 'swapped labels must fail');
  // Both dates exist with correct labels in one sentence region; each is
  // bound to its own label and the claim passes.
  const singleSentence = await run(`${common} valid from 2026-08-01 through 2026-09-01`);
  assert.equal(singleSentence.tasks[0].result_json.models[0]._price_evidence_verified, true);
  // The claimed start date appears only under end labels: an end label can
  // never confirm the start claim.
  const endLabelsOnly = await run(`${common} valid through 2026-08-01, ends 2026-09-01`);
  assert.equal(endLabelsOnly.tasks[0].result_json.models[0]._price_evidence_verified, undefined, 'an end label cannot confirm the start claim');
  const correct = await run(`${common} starts 2026-08-01 ends 2026-09-01`);
  assert.equal(correct.tasks[0].result_json.models[0]._price_evidence_verified, true);
});

test('discount interval boundaries use start inclusive and end exclusive', async () => {
  const model = {
    model_id: 'acme/model-v1',
    normal_source_amount_input: 1, normal_source_amount_output: 2,
    effective_source_amount_input: 0.1, effective_source_amount_output: 0.2,
    source_currency: 'USD', source_unit: 'per_million_tokens',
    price_source_url: 'https://prices.example/discount-boundary',
    discount_start_at: '2026-08-01T00:00:00Z',
    discount_end_at: '2026-09-01T00:00:00Z',
  };
  const body = 'acme/model-v1 normal input 1 normal output 2 discounted input 0.1 discounted output 0.2 USD per million tokens starts 2026-08-01 ends 2026-09-01';
  const run = (now) => evidence.auditRunEvidence([{
    kind: 'known_refresh', result_json: { models: [model], source_candidates: [], provider_candidates: [] },
  }], {
    attempts: 1,
    now,
    fetchImpl: async () => ({ status: 200, headers: new Map(), url: model.price_source_url, body }),
  });
  const atStart = await run('2026-08-01T00:00:00.000Z');
  assert.equal(atStart.tasks[0].result_json.models[0]._price_evidence_verified, true, 'audit time exactly at the start is active');
  const atEnd = await run('2026-09-01T00:00:00.000Z');
  assert.equal(atEnd.tasks[0].result_json.models[0]._price_evidence_verified, undefined, 'audit time exactly at the end is expired');
  const inside = await run('2026-08-20T12:00:00.000Z');
  assert.equal(inside.tasks[0].result_json.models[0]._price_evidence_verified, true);
});

test('discount dates require exact fetched price body dates, and cache prices are not applied', async () => {
  const base = {
    model_id: 'acme/model-v1', source_amount_input: 0.000001,
    source_amount_output: 0.000002, source_currency: 'USD', source_unit: 'per_token',
    price_source_url: 'https://prices.example/dates',
    discount_start_at: '2026-08-01T00:00:00.000Z',
    discount_end_at: '2026-09-01T00:00:00.000Z',
    normal_cache_read_price_usd: 0.01,
    normal_cache_write_price_usd: 0.02,
  };
  const fetchImpl = async () => ({
    status: 200, headers: new Map(), url: base.price_source_url,
    body: 'acme/model-v1 input 0.000001 output 0.000002 USD per token discount starts 2026-08-01',
  });
  const audit = await evidence.auditRunEvidence([{
    kind: 'known_refresh', result_json: { models: [base], source_candidates: [], provider_candidates: [] },
  }], { attempts: 1, fetchImpl });
  const verified = audit.tasks[0].result_json.models[0];
  assert.equal(verified._price_evidence_verified, undefined, 'an unverified optional cache or end date rejects the fresh update');
  assert.equal(verified.price_source_url, undefined);
});

test('discovery goal tasks carry a goal assignment and finalize without pool state (spec 0007)', async (t) => {
  const c = ctx();
  t.after(() => fs.rmSync(c.root, { recursive: true, force: true }));
  db.applyMigrations(c.options);
  for (const goal of ['new', 'pricing']) {
    db.startRun(`evidence-goal-${goal}`, [{ task_id: `discovery:${goal}`, kind: 'discovery', assigned_json: { goal } }], c.options);
    db.finalizeRun(`evidence-goal-${goal}`, { runStatus: 'candidate_ready' }, c.options);
  }
  const check = db.openCollectorDb(c.options);
  try {
    const tables = check.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('discovery_sources', 'search_terms', 'search_windows')"
    ).all().map((r) => r.name);
    assert.deepEqual(tables, [], 'spec 0007 drops the discovery pool tables');
  } finally { check.close(); }
});

test('price evidence binds input and output values to their labels', () => {
  const model = { model_id: 'acme/model-v1', source_amount_input: 0.1, source_amount_output: 0.4, source_currency: 'USD', source_unit: 'per_million_tokens' };
  assert.equal(evidence.priceEvidenceRelevant('acme/model-v1 input 0.4 output 0.1 USD per million tokens', model), false);
  assert.equal(evidence.priceEvidenceRelevant('acme/model-v1 input 0.1 output 0.4 USD per million tokens', model), true);
});

test('conversion evidence requires USD per source currency direction', () => {
  const model = { source_currency: 'EUR', conversion_rate: 1.1, conversion_confirmed_at: '2026-08-01T00:00:00.000Z' };
  assert.equal(evidence.conversionEvidenceRelevant('1 USD = 0.9 EUR 2026-08-01T00:00:00.000Z', model), false);
  assert.equal(evidence.conversionEvidenceRelevant('1 EUR = 1.1 USD 2026-08-01T00:00:00.000Z', model), true);
});

test('normal and effective discount labels preserve cache read and write amounts', async () => {
  const model = { model_id: 'acme/model-v1', normal_source_amount_input: 1, normal_source_amount_output: 2, effective_source_amount_input: 0.1, effective_source_amount_output: 0.2, normal_source_amount_cache_read: 0.3, normal_source_amount_cache_write: 0.4, effective_source_amount_cache_read: 0.05, effective_source_amount_cache_write: 0.06, source_currency: 'USD', source_unit: 'per_million_tokens', price_source_url: 'https://prices.example/discount', discount_start_at: '2026-08-01T00:00:00Z', discount_end_at: '2026-09-01T00:00:00Z' };
  const audited = await evidence.auditRunEvidence([{ kind: 'known_refresh', result_json: { models: [model], source_candidates: [], provider_candidates: [] } }], { attempts: 1, now: '2026-08-15T00:00:00.000Z', fetchImpl: async () => ({ status: 200, headers: new Map(), url: model.price_source_url, body: 'acme/model-v1 normal input 1 output 2 effective input 0.1 output 0.2 normal cache read 0.3 cache write 0.4 effective cache read 0.05 cache write 0.06 USD per million tokens discount starts 2026-08-01 ends 2026-09-01' }) });
  assert.equal(audited.tasks[0].result_json.models[0]._price_evidence_verified, true);
});
