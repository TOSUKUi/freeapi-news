'use strict';

// Deterministic catalog tests for spec 0003 child 0002 (AC-6, AC-16):
// decimal price parsing, positive zero free check, catalog shape validation,
// same run retry, unavailable outcomes, and endpoint evidence. No test
// touches the live project state or the public network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const db = require('./collector-db');
const catalog = require('./catalog');

const REGISTRY_ENTRY = {
  key: 'openrouter',
  label: 'OpenRouter',
  base_url: 'https://openrouter.ai/api/v1',
  docs_url: 'https://openrouter.ai/docs/quickstart',
  api_catalog_url: 'https://openrouter.ai/api/v1/models',
};

const TASK = {
  task_id: 'catalog:openrouter',
  kind: 'catalog',
  provider_key: 'openrouter',
  api_catalog_url: REGISTRY_ENTRY.api_catalog_url,
};

function fetchStub(routes) {
  // routes: { [url]: { status, body } | Error | fn(url) }
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const route = typeof routes === 'function' ? routes(url, calls.length) : routes[url];
    if (route instanceof Error) throw route;
    if (!route) throw new Error(`no stub for ${url}`);
    return { status: route.status, body: route.body };
  };
  impl.calls = calls;
  return impl;
}

function catalogBody(entries) {
  return JSON.stringify({ data: entries });
}

test('parseDecimalPrice accepts decimal strings and rejects everything else', () => {
  assert.equal(catalog.parseDecimalPrice('0'), 0);
  assert.equal(catalog.parseDecimalPrice('0.0'), 0);
  assert.equal(catalog.parseDecimalPrice('0.00000000'), 0);
  assert.equal(catalog.parseDecimalPrice('1.5e-3'), 0.0015);
  assert.equal(catalog.parseDecimalPrice('12.34'), 12.34);
  assert.equal(catalog.parseDecimalPrice('-0'), -0);
  assert.equal(catalog.parseDecimalPrice(''), null);
  assert.equal(catalog.parseDecimalPrice('   '), null);
  assert.equal(catalog.parseDecimalPrice('abc'), null);
  assert.equal(catalog.parseDecimalPrice('0x10'), null, 'hex is not a decimal string');
  assert.equal(catalog.parseDecimalPrice('1e400'), null, 'overflow is not finite');
  assert.equal(catalog.parseDecimalPrice(0), null, 'numbers are not decimal strings');
  assert.equal(catalog.parseDecimalPrice(null), null);
  assert.equal(catalog.parseDecimalPrice(undefined), null);
});

test('isPositiveZero treats "0", "0.0", "0.00000000" alike and rejects -0', () => {
  assert.equal(catalog.isPositiveZero(catalog.parseDecimalPrice('0')), true);
  assert.equal(catalog.isPositiveZero(catalog.parseDecimalPrice('0.0')), true);
  assert.equal(catalog.isPositiveZero(catalog.parseDecimalPrice('0.00000000')), true);
  assert.equal(catalog.isPositiveZero(catalog.parseDecimalPrice('-0')), false);
  assert.equal(catalog.isPositiveZero(catalog.parseDecimalPrice('-0.0')), false);
  assert.equal(catalog.isPositiveZero(0.0000001), false);
});

test('pricingHash is canonical over decimal zero spellings', () => {
  const a = db.pricingHash(catalog.parseDecimalPrice('0'), catalog.parseDecimalPrice('0'));
  const b = db.pricingHash(catalog.parseDecimalPrice('0.00000000'), catalog.parseDecimalPrice('0.0'));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
  const nonzero = db.pricingHash(0.5, 1.5);
  assert.notEqual(nonzero, a);
  assert.equal(db.pricingHash(Number.NaN, 0), null);
  assert.equal(db.pricingHash(0, Infinity), null);
});

test('pricingHashFromText normalizes NFKC and collapses whitespace', () => {
  const a = db.pricingHashFromText('＄10 / month　 extra');
  const b = db.pricingHashFromText('$10 / month extra');
  assert.equal(a, b, 'fullwidth forms and ideographic space normalize');
  assert.equal(db.pricingHashFromText('   '), null);
  assert.equal(db.pricingHashFromText(''), null);
  assert.notEqual(db.pricingHashFromText('$10'), db.pricingHashFromText('$11'));
});

test('validateCatalogResponse accepts a mixed price catalog and flags free models', () => {
  const check = catalog.validateCatalogResponse(JSON.parse(catalogBody([
    { id: 'acme/fast:free', name: 'Acme Fast (free)', pricing: { prompt: '0', completion: '0.0' } },
    { id: 'acme/slow:free', name: 'Acme Slow', pricing: { prompt: '0.00000000', completion: '0' } },
    { id: 'acme/paid', name: 'Acme Paid', pricing: { prompt: '0.5', completion: '1.5' } },
    { id: 'acme/negative', name: 'Acme Negative', pricing: { prompt: '-0', completion: '0' } },
  ])));
  assert.equal(check.ok, true);
  assert.equal(check.entries.length, 4);
  const byId = Object.fromEntries(check.entries.map((e) => [e.exact_model_id, e]));
  assert.equal(byId['acme/fast:free'].is_free, true);
  assert.equal(byId['acme/slow:free'].is_free, true, 'zero spelled differently is still free');
  assert.equal(byId['acme/paid'].is_free, false);
  assert.equal(byId['acme/negative'].is_free, false, 'negative zero is not positive zero');
  assert.equal(byId['acme/fast:free'].pricing_hash, byId['acme/slow:free'].pricing_hash);
});

test('validateCatalogResponse rejects malformed shapes', () => {
  const cases = [
    [null, 'not a JSON object'],
    [[], 'not a JSON object'],
    [{}, 'no data array'],
    [{ data: 'nope' }, 'no data array'],
    [{ data: [] }, 'empty'],
    [{ data: [{ id: 'a', pricing: { prompt: '0', completion: '0' } }, { id: 'a', pricing: { prompt: '0', completion: '0' } }] }, 'duplicate'],
    [{ data: [{ id: 42, pricing: { prompt: '0', completion: '0' } }] }, 'id is not a non empty string'],
    [{ data: [{ id: 'a', pricing: { prompt: 0, completion: '0' } }] }, 'prompt price is not a parseable decimal string'],
    [{ data: [{ id: 'a', pricing: { prompt: '0', completion: 'free' } }] }, 'completion price is not a parseable decimal string'],
    [{ data: [{ id: 'a', pricing: { prompt: '0', completion: '0' } }, 'junk'] }, 'not an object'],
  ];
  for (const [payload, needle] of cases) {
    const check = catalog.validateCatalogResponse(payload);
    assert.equal(check.ok, false, `expected invalid: ${needle}`);
    assert.equal(check.entries.length, 0, 'invalid catalogs yield no entries');
    assert.ok(check.errors.some((e) => e.includes(needle)), `errors mention ${needle}: ${check.errors.join('; ')}`);
  }
});

test('fetchCatalogForProvider stages only free models from a valid mixed catalog (AC-6)', async () => {
  const fetchImpl = fetchStub({
    [REGISTRY_ENTRY.api_catalog_url]: {
      status: 200,
      body: catalogBody([
        { id: 'acme/fast:free', name: 'Acme Fast (free)', pricing: { prompt: '0', completion: '0' } },
        { id: 'acme/paid', name: 'Acme Paid', pricing: { prompt: '0.5', completion: '1.5' } },
      ]),
    },
    [REGISTRY_ENTRY.docs_url]: { status: 200, body: 'Use https://openrouter.ai/api/v1 as the base URL.' },
  });

  const artifact = await catalog.fetchCatalogForProvider(TASK, REGISTRY_ENTRY, {
    now: '2026-07-31T00:00:00.000Z', fetchImpl,
  });

  assert.equal(artifact.status, 'complete');
  assert.equal(artifact.available, true);
  assert.equal(artifact.task_id, 'catalog:openrouter');
  assert.equal(artifact.provider_key, 'openrouter');
  assert.equal(artifact.base_url, REGISTRY_ENTRY.base_url, 'registry base_url verbatim');
  assert.equal(artifact.models.length, 2, 'all models staged for removal proof');
  const free = artifact.models.filter((m) => m.is_free);
  assert.equal(free.length, 1);
  assert.equal(free[0].model_id, 'acme/fast:free');
  assert.equal(free[0].model_name, 'Acme Fast', 'display (free) suffix stripped');
  assert.equal(artifact.endpoint_source, REGISTRY_ENTRY.docs_url, 'docs page documents the base URL');
  assert.match(artifact.endpoint_source_hash, /^[0-9a-f]{64}$/);
  assert.match(artifact.content_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(artifact.fetches.map((f) => f.subject_key), ['catalog:openrouter', 'endpoint:openrouter']);
  assert.equal(artifact.fetches[0].http_status, 200);
});

test('fetchCatalogForProvider retries once within the run and recovers (AC-6)', async () => {
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url === REGISTRY_ENTRY.api_catalog_url && calls === 1) {
      throw new Error('ECONNRESET');
    }
    if (url === REGISTRY_ENTRY.api_catalog_url) {
      return { status: 200, body: catalogBody([{ id: 'a:free', name: 'A', pricing: { prompt: '0', completion: '0' } }]) };
    }
    return { status: 200, body: 'docs' };
  };
  const artifact = await catalog.fetchCatalogForProvider(TASK, REGISTRY_ENTRY, { fetchImpl });
  assert.equal(artifact.available, true);
  assert.equal(calls, 3, 'catalog twice (one retry) plus docs once');
});

test('fetchCatalogForProvider marks the catalog unavailable after retries fail (AC-6)', async () => {
  const fetchImpl = fetchStub({
    [REGISTRY_ENTRY.api_catalog_url]: new Error('timeout fetching catalog'),
  });
  const artifact = await catalog.fetchCatalogForProvider(TASK, REGISTRY_ENTRY, { fetchImpl });
  assert.equal(artifact.status, 'failed');
  assert.equal(artifact.available, false);
  assert.deepEqual(artifact.models, []);
  assert.deepEqual(artifact.fetches, [], 'failed fetches are never cached (AC-16)');
  assert.ok(artifact.errors[0].includes('2 attempts'));
});

test('fetchCatalogForProvider treats HTTP errors and malformed payloads as unavailable (AC-6)', async () => {
  const http500 = await catalog.fetchCatalogForProvider(TASK, REGISTRY_ENTRY, {
    fetchImpl: fetchStub({ [REGISTRY_ENTRY.api_catalog_url]: { status: 503, body: 'unavailable' } }),
  });
  assert.equal(http500.available, false);
  assert.equal(http500.status, 'failed');

  const notJson = await catalog.fetchCatalogForProvider(TASK, REGISTRY_ENTRY, {
    fetchImpl: fetchStub({ [REGISTRY_ENTRY.api_catalog_url]: { status: 200, body: '<html>nope</html>' } }),
  });
  assert.equal(notJson.available, false);
  assert.ok(notJson.errors[0].includes('not valid JSON'));

  const emptyData = await catalog.fetchCatalogForProvider(TASK, REGISTRY_ENTRY, {
    fetchImpl: fetchStub({ [REGISTRY_ENTRY.api_catalog_url]: { status: 200, body: '{"data":[]}' } }),
  });
  assert.equal(emptyData.available, false, 'empty data is invalid and cannot confirm removal');

  const badPrice = await catalog.fetchCatalogForProvider(TASK, REGISTRY_ENTRY, {
    fetchImpl: fetchStub({
      [REGISTRY_ENTRY.api_catalog_url]: {
        status: 200,
        body: catalogBody([{ id: 'a', name: 'A', pricing: { prompt: '0', completion: '0' } }, { id: 'b', name: 'B', pricing: { prompt: 'oops', completion: '0' } }]),
      },
    }),
  });
  assert.equal(badPrice.available, false, 'one malformed price invalidates the whole catalog');
  assert.deepEqual(badPrice.models, []);
});

test('a valid catalog with zero free offers is authoritative (AC-5, AC-6)', async () => {
  const fetchImpl = fetchStub({
    [REGISTRY_ENTRY.api_catalog_url]: {
      status: 200,
      body: catalogBody([
        { id: 'acme/paid', name: 'Acme Paid', pricing: { prompt: '0.5', completion: '1.5' } },
        { id: 'acme/pricier', name: 'Acme Pricier', pricing: { prompt: '2', completion: '6' } },
      ]),
    },
    [REGISTRY_ENTRY.docs_url]: { status: 200, body: 'docs' },
  });
  const artifact = await catalog.fetchCatalogForProvider(TASK, REGISTRY_ENTRY, { fetchImpl });
  assert.equal(artifact.status, 'complete');
  assert.equal(artifact.available, true, 'nonempty valid catalog with zero free offers stays authoritative');
  assert.equal(artifact.models.length, 2);
  assert.ok(artifact.models.every((m) => m.is_free === false));
});

test('docs fetch failure does not sink an otherwise valid catalog', async () => {
  const fetchImpl = fetchStub({
    [REGISTRY_ENTRY.api_catalog_url]: {
      status: 200,
      body: catalogBody([{ id: 'a:free', name: 'A', pricing: { prompt: '0', completion: '0' } }]),
    },
    [REGISTRY_ENTRY.docs_url]: { status: 404, body: 'moved' },
  });
  const artifact = await catalog.fetchCatalogForProvider(TASK, REGISTRY_ENTRY, { fetchImpl });
  assert.equal(artifact.available, true);
  assert.equal(artifact.endpoint_source, null, 'no endpoint evidence from a failed docs fetch');
  assert.deepEqual(artifact.fetches.map((f) => f.subject_key), ['catalog:openrouter']);
});

test('fetchCatalogForProvider works against a real local HTTP server', async () => {
  const body = catalogBody([
    { id: 'local/model:free', name: 'Local Model (free)', pricing: { prompt: '0', completion: '0' } },
  ]);
  const server = http.createServer((req, res) => {
    if (req.url === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
    } else if (req.url === '/docs') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('base url docs');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const artifact = await catalog.fetchCatalogForProvider(
      { task_id: 'catalog:local', kind: 'catalog', provider_key: 'local', api_catalog_url: `http://127.0.0.1:${port}/models` },
      { key: 'local', base_url: `http://127.0.0.1:${port}/v1`, docs_url: `http://127.0.0.1:${port}/docs` }
    );
    assert.equal(artifact.available, true);
    assert.equal(artifact.models.length, 1);
    assert.equal(artifact.models[0].is_free, true);
    assert.equal(artifact.endpoint_source, `http://127.0.0.1:${port}/docs`);
  } finally {
    server.close();
  }
});

test('catalog module never spawns an LLM (structural, AC-6)', () => {
  const source = fs.readFileSync(path.join(__dirname, 'catalog.js'), 'utf8');
  assert.ok(!/child_process/.test(source), 'no process spawning');
  assert.ok(!/\bpi\b\s+--/.test(source), 'no pi worker invocation');
});
