'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseFreeLlmModels,
  parseBaseUrlTable,
  fetchAggregatedIndex,
  FREELLM_MODELS_URL,
  FREELLM_BASE_URLS_URL,
} = require('./aggregated-index');

// A minimal but format-faithful freellm.net models table row set. The real
// page is Astro SSG with <tr class="model-row" data-...> rows.
function makeModelsHtml(rows) {
  return rows.map((r) => {
    const attrs = Object.entries(r)
      .map(([k, v]) => `data-${k}="${v}"`)
      .join(' ');
    return `<tr class="model-row" ${attrs}>` +
      `<td><a href="/models/" class="model-link">${r.name}</a></td></tr>`;
  }).join('\n');
}

test('parseFreeLlmModels extracts data-* attributes from model rows', () => {
  const html = makeModelsHtml([
    {
      'name': 'z.ai: glm 5.2 (free)', 'provider': 'OpenRouter',
      'provider-slug': 'openrouter', 'modality': 'text',
      'free': '1', 'nocard': '1', 'nophone': '1',
      'verified': '1', 'tier-type': 'permanent',
      'context': '256000', 'score': '57', 'released': '0',
      'description': 'z.ai: glm 5.2 (free) is a free model', 'bestfor': 'chat',
      'tag': 'unmapped',
    },
    {
      'name': 'kimi-k3', 'provider': 'Ollama Cloud',
      'provider-slug': 'ollama-cloud', 'modality': 'text,image',
      'free': '0', 'nocard': '1', 'nophone': '1',
      'verified': '0', 'tier-type': 'permanent',
      'context': '128000', 'score': '97', 'released': '1784160000000',
      'description': 'multimodal kimi', 'bestfor': 'chat',
      'tag': 'kimi-k3',
    },
    { 'name': 'broken' }, // no provider: skipped
  ]);
  const rows = parseFreeLlmModels(html);
  assert.strictEqual(rows.length, 2);
  const glm = rows[0];
  assert.strictEqual(glm.name, 'z.ai: glm 5.2 (free)');
  assert.strictEqual(glm.provider, 'OpenRouter');
  assert.strictEqual(glm.free, true);
  assert.strictEqual(glm.verified, true);
  assert.strictEqual(glm.no_card, true);
  assert.strictEqual(glm.tier_type, 'permanent');
  assert.strictEqual(glm.context_tokens, 256000);
  assert.strictEqual(glm.released_ms, 0);
  const kimi = rows[1];
  assert.strictEqual(kimi.free, false);
  assert.strictEqual(kimi.verified, false);
  assert.strictEqual(kimi.context_tokens, 128000);
  assert.strictEqual(kimi.released_ms, 1784160000000);
});

test('parseFreeLlmModels decodes HTML entities in attributes', () => {
  const html = makeModelsHtml([
    {
      'name': 'a &amp; b &lt;c&gt;', 'provider': 'A &amp; B',
      'provider-slug': 'a-b', 'modality': 'text',
      'free': '1', 'tier-type': 'permanent',
    },
  ]);
  const rows = parseFreeLlmModels(html);
  assert.strictEqual(rows[0].name, 'a & b <c>');
  assert.strictEqual(rows[0].provider, 'A & B');
});

test('parseFreeLlmModels handles missing optional attributes as null', () => {
  const html = makeModelsHtml([
    { 'name': 'm', 'provider': 'P', 'free': '1' },
  ]);
  const rows = parseFreeLlmModels(html);
  assert.strictEqual(rows[0].context_tokens, null);
  assert.strictEqual(rows[0].score, null);
  assert.strictEqual(rows[0].released_ms, null);
  assert.strictEqual(rows[0].tier_type, null);
});

test('parseBaseUrlTable extracts provider base URLs from BEGIN_QUICK_REF section', () => {
  const readme = [
    '## Some Other Section',
    '| Provider | Base URL | Get API Key | Credit Card? |',
    '| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | <a>key</a> | Phone |',
    '<!-- BEGIN_QUICK_REF -->',
    '| Provider | Base URL | Get API Key | Credit Card? |',
    '| OpenRouter | `https://openrouter.ai/api/v1` | <a href="#">key</a> | Registration |',
    '| Google Gemini | `https://generativelanguage.googleapis.com/v1beta` | <a href="#">key</a> | No |',
    '| Groq | `https://api.groq.com/openai/v1` | <a href="#">key</a> | No |',
    '<!-- END_QUICK_REF -->',
    '## Best Free Models',
    '| Provider | Best Free Model | Model ID |',
    '| OpenRouter | z.ai glm | z-ai/glm-5.2 |',
  ].join('\n');
  const urls = parseBaseUrlTable(readme);
  assert.deepStrictEqual(urls, {
    OpenRouter: 'https://openrouter.ai/api/v1',
    'Google Gemini': 'https://generativelanguage.googleapis.com/v1beta',
    Groq: 'https://api.groq.com/openai/v1',
  });
});

test('parseBaseUrlTable falls back to whole document when markers are missing', () => {
  const readme = [
    '| Provider | Base URL | Get API Key |',
    '| Mistral AI | `https://api.mistral.ai/v1` | <a>key</a> |',
    '| Cohere | `https://api.cohere.com/v2` | <a>key</a> |',
  ].join('\n');
  const urls = parseBaseUrlTable(readme);
  assert.strictEqual(urls['Mistral AI'], 'https://api.mistral.ai/v1');
  assert.strictEqual(urls.Cohere, 'https://api.cohere.com/v2');
});

test('fetchAggregatedIndex fetches both sources and projects crawl-facts models', async () => {
  const modelsHtml = makeModelsHtml([
    {
      'name': 'z.ai: glm 5.2 (free)', 'provider': 'OpenRouter',
      'provider-slug': 'openrouter', 'modality': 'text',
      'free': '1', 'nocard': '1', 'nophone': '1',
      'verified': '1', 'tier-type': 'permanent',
      'context': '256000', 'score': '57', 'released': '0',
      'description': 'z.ai: glm 5.2 (free) is a free model', 'bestfor': 'chat',
      'tag': 'unmapped',
    },
  ]);
  const readme = [
    '<!-- BEGIN_QUICK_REF -->',
    '| Provider | Base URL | Get API Key |',
    '| OpenRouter | `https://openrouter.ai/api/v1` | <a>key</a> |',
    '<!-- END_QUICK_REF -->',
  ].join('\n');
  const fetchHtml = async (url) => {
    if (url === FREELLM_MODELS_URL) return modelsHtml;
    if (url === FREELLM_BASE_URLS_URL) return readme;
    throw new Error(`unexpected url ${url}`);
  };
  const art = await fetchAggregatedIndex(fetchHtml);
  assert.strictEqual(art.status, 'complete');
  assert.strictEqual(art.models.length, 1);
  assert.strictEqual(art.base_urls.OpenRouter, 'https://openrouter.ai/api/v1');

  const m = art.models[0];
  assert.strictEqual(m.provider_key, 'openrouter');
  assert.strictEqual(m.provider_label, 'OpenRouter');
  assert.strictEqual(m.is_free_signal, true);
  assert.strictEqual(m.verified_free, true);
  assert.strictEqual(m.free_tier_type, 'permanent');
  assert.strictEqual(m.context_tokens, 256000);
  assert.strictEqual(m.base_url, 'https://openrouter.ai/api/v1');
  assert.strictEqual(m.endpoint_source, FREELLM_MODELS_URL);
  assert.strictEqual(m.model_id, 'openrouter:z-ai-glm-5-2-free');
});

test('fetchAggregatedIndex survives one source failing', async () => {
  const modelsHtml = makeModelsHtml([
    { 'name': 'm', 'provider': 'P', 'provider-slug': 'p', 'free': '1' },
  ]);
  const fetchHtml = async (url) => {
    if (url === FREELLM_MODELS_URL) return modelsHtml;
    throw new Error('network down');
  };
  const art = await fetchAggregatedIndex(fetchHtml);
  // Models parsed; base URLs unavailable; artifact remains usable (partial).
  assert.strictEqual(art.models.length, 1);
  assert.strictEqual(art.errors.length, 1);
  assert.ok(art.errors[0].includes('freellm_base_urls fetch failed'));
});

test('fetchAggregatedIndex marks unavailable when the models source fails', async () => {
  const fetchHtml = async () => { throw new Error('down'); };
  const art = await fetchAggregatedIndex(fetchHtml);
  assert.strictEqual(art.status, 'failed');
  assert.strictEqual(art.available, false);
  assert.strictEqual(art.models.length, 0);
  assert.ok(art.errors.length >= 2);
});
// The collect orchestrator passes an options object, like every other
// deterministic lane. A `{}` argument used to land in the fetchHtml parameter
// and throw "fetchHtml is not a function", so the lane failed every run while
// the fail-safe hid it. The fetcher shape is therefore part of the contract.
const FIXTURE_README = [
  '<!-- BEGIN_QUICK_REF -->',
  '| Provider | Base URL | Get API Key |',
  '| OpenRouter | `https://openrouter.ai/api/v1` | <a>key</a> |',
  '<!-- END_QUICK_REF -->',
].join('\n');

const FIXTURE_MODELS = makeModelsHtml([
  {
    'name': 'z.ai: glm 5.2 (free)', 'provider': 'OpenRouter',
    'provider-slug': 'openrouter', 'modality': 'text',
    'free': '1', 'nocard': '1', 'nophone': '1',
    'verified': '1', 'tier-type': 'permanent',
    'context': '256000', 'score': '57', 'released': '0',
    'description': 'z.ai: glm 5.2 (free) is a free model', 'bestfor': 'chat',
    'tag': 'unmapped',
  },
]);

test('fetchAggregatedIndex takes an options object, matching the other lanes', async () => {
  const art = await fetchAggregatedIndex({
    fetchHtml: async (url) => (url === FREELLM_MODELS_URL ? FIXTURE_MODELS : FIXTURE_README),
  });
  assert.strictEqual(art.status, 'complete');
  assert.strictEqual(art.available, true);
  assert.strictEqual(art.models.length, 1);
  assert.strictEqual(art.base_urls.OpenRouter, 'https://openrouter.ai/api/v1');
});

test('an empty options object falls back to the real fetcher, not to a throw', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const body = String(url) === FREELLM_MODELS_URL ? FIXTURE_MODELS : FIXTURE_README;
    return { ok: true, text: async () => body };
  };
  try {
    // Exactly the call shape collect.js uses.
    const art = await fetchAggregatedIndex({});
    assert.equal(urls.length, 2, 'both sources were fetched');
    assert.strictEqual(art.status, 'complete');
    assert.strictEqual(art.available, true);
    assert.strictEqual(art.errors.length, 0);
    assert.strictEqual(art.models.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
