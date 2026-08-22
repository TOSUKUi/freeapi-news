'use strict';

// Deterministic aggregated-index lane (operator direction 2026-08-22: prefer
// pre-aggregated data sources over LLM re-browsing).
//
// Two public, pre-aggregated sources provide the bulk of the "which model is
// free / permanent / verified" signal and the official base URLs, without any
// LLM session browsing provider pages:
//
//   1. freellm.net/models/  a static HTML table (Astro SSG) that lists every
//      model the freellm hub tracks, with per-row data-* attributes:
//        data-free        "1" permanent free tier, "0" trial / quota
//        data-tier-type   "permanent" | "quota"
//        data-verified    "1" independently verified endpoint
//        data-context     context window in tokens
//        data-nocard      "1" no credit card required
//        data-nophone     "1" no phone verification
//        data-released    epoch ms
//        data-score       hub's free-tier quality score
//   2. open-free-llm-api/awesome-freellm-apis README  a markdown table whose
//      "Quick Reference Base URLs" section lists official base URLs for 30+
//      providers (BEGIN_QUICK_REF / END_QUICK_REF markers).
//
// This lane fetches both, parses them, and writes one artifact the lanes
// reducer ingests. It never invents anything: every model claim carries the
// source URL of the row it came from, and the base URL map is keyed by the
// provider name exactly as the table spells it. Nothing here calls an LLM.

const fs = require('node:fs');
const path = require('node:path');
const db = require('./collector-db');

const FREELLM_MODELS_URL = 'https://freellm.net/models/';
const FREELLM_BASE_URLS_URL =
  'https://raw.githubusercontent.com/open-free-llm-api/awesome-freellm-apis/main/README.md';

// Simulation file for tests and offline dry runs (fixtures/ under this dir).
function fixturePath(name) {
  return path.join(__dirname, 'fixtures', name);
}

// ---------------------------------------------------------------------------
// freellm.net models table
// ---------------------------------------------------------------------------

// Parses the <tr class="model-row" data-...> rows. Attribute values are
// HTML-entity decoded; missing integer fields become null, missing strings
// become null. Rows that lack data-name are ignored.
function parseFreeLlmModels(html) {
  const rows = [];
  const re = /<tr class="model-row"([^>]*)>/g;
  let match;
  while ((match = re.exec(html)) !== null) {
    const attrs = {};
    const attrRe = /(data-[a-z0-9-]+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(match[1])) !== null) {
      attrs[am[1]] = decodeEntities(am[2]);
    }
    const name = attrs['data-name'];
    const provider = attrs['data-provider'];
    if (!name || !provider) continue;
    rows.push({
      name,
      provider,
      provider_slug: attrs['data-provider-slug'] || null,
      modality: attrs['data-modality'] || null,
      free: attrs['data-free'] === '1',
      no_card: attrs['data-nocard'] === '1',
      no_phone: attrs['data-nophone'] === '1',
      verified: attrs['data-verified'] === '1',
      tier_type: attrs['data-tier-type'] || null,
      context_tokens: intOrNull(attrs['data-context']),
      score: intOrNull(attrs['data-score']),
      released_ms: intOrNull(attrs['data-released']),
      description: attrs['data-description'] || null,
      best_for: attrs['data-bestfor'] || null,
      tag: attrs['data-tag'] || null,
    });
  }
  return rows;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function intOrNull(v) {
  if (v === '' || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// open-free-llm-api README base URL table
// ---------------------------------------------------------------------------

// Pulls the Quick Reference base URL table out of the README. The section is
// wrapped in BEGIN_QUICK_REF / END_QUICK_REF comments; each row is
// | Provider | Base URL | ... |
// Returns { provider: baseUrl } with provider name exactly as spelled.
function parseBaseUrlTable(readme) {
  const out = {};
  const begin = readme.indexOf('<!-- BEGIN_QUICK_REF -->');
  const end = readme.indexOf('<!-- END_QUICK_REF -->');
  const section = begin >= 0 && end > begin
    ? readme.slice(begin, end)
    : readme;
  const rowRe = /^\s*\|[^|]*\|\s*`([^`]*)`\s*\|/gm;
  const cellsRe = /^\s*\|([^|]*)\|\s*`([^`]*)`/;
  let m;
  const lines = section.split('\n');
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = cellsRe.exec(line);
    if (!cells) continue;
    const provider = cells[1].trim();
    const baseUrl = cells[2].trim();
    if (!provider || !baseUrl) continue;
    out[provider] = baseUrl;
  }
  return out;
}

// ---------------------------------------------------------------------------
// High level fetch + artifact
// ---------------------------------------------------------------------------

// Fetches both sources (with a shared timeout) and returns the artifact the
// reducer ingests. `fetchHtml` is injectable for tests.
async function fetchAggregatedIndex(fetchHtml = defaultFetchHtml) {
  const sources = [
    { key: 'freellm_models', url: FREELLM_MODELS_URL, label: 'freellm.net models' },
    { key: 'freellm_base_urls', url: FREELLM_BASE_URLS_URL, label: 'open-free-llm-api README' },
  ];
  const fetches = [];
  const bodies = {};
  for (const s of sources) {
    try {
      const html = await fetchHtml(s.url);
      fetches.push({ source: s.key, url: s.url, http_status: 200, bytes: html.length });
      bodies[s.key] = html;
    } catch (err) {
      fetches.push({
        source: s.key, url: s.url, http_status: null,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  const models = [];
  let baseUrls = {};
  let errors = [];
  if (bodies.freellm_base_urls) {
    try {
      baseUrls = parseBaseUrlTable(bodies.freellm_base_urls);
    } catch (err) {
      errors.push(`freellm_base_urls parse: ${err.message}`);
    }
  } else {
    errors.push('freellm_base_urls fetch failed');
  }
  if (bodies.freellm_models) {
    try {
      const rows = parseFreeLlmModels(bodies.freellm_models);
      for (const r of rows) {
        // Project the hub row onto the crawl-facts models[] shape so the
        // discovery lane reduces it identically to news_scan / vendor dives.
        // model_id is the hub's tag when mapped (91 of 401 rows), else a
        // normalized provider:name handle; either way it is stable and
        // unique for dedupe. The exact canonical id for ranking comes from
        // the provider's own catalog lane; this lane is the free-tier
        // discovery signal.
        const baseUrl = baseUrls[r.provider] || null;
        const modelId = r.tag && r.tag !== 'unmapped'
          ? r.tag
          : `${slugify(r.provider)}:${slugify(r.name)}`;
        models.push({
          model_id: modelId,
          provider_key: r.provider_slug || slugify(r.provider) || r.provider,
          provider_label: r.provider,
          model_name: r.name,
          description: r.description,
          context_tokens: r.context_tokens,
          release_date: r.released_ms ? new Date(r.released_ms).toISOString().slice(0, 10) : null,
          is_free_signal: r.free,
          free_tier_type: r.tier_type,
          verified_free: r.verified,
          no_card_required: r.no_card,
          no_phone_required: r.no_phone,
          free_quota_text: r.free ? `${r.provider} permanent free tier (${r.tier_type || 'unknown'})` : null,
          endpoint_source: FREELLM_MODELS_URL,
          base_url: baseUrl,
          docs_url: null,
          source_amount_input: null,
          source_amount_output: null,
          source_currency: null,
          source_unit: '',
          evidence_url: FREELLM_MODELS_URL,
        });
      }
    } catch (err) {
      errors.push(`freellm_models parse: ${err.message}`);
    }
  } else {
    errors.push('freellm_models fetch failed');
  }

  const available = Boolean(bodies.freellm_models && bodies.freellm_base_urls);
  return {
    schema_version: 1,
    kind: 'aggregated_index',
    provider_key: null,
    crawled_at: new Date().toISOString(),
    status: available ? 'complete' : 'failed',
    available,
    source_urls: {
      freellm_models: FREELLM_MODELS_URL,
      freellm_base_urls: FREELLM_BASE_URLS_URL,
    },
    models,
    base_urls: baseUrls,
    fetches,
    errors,
  };
}

async function defaultFetchHtml(url, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  FREELLM_MODELS_URL,
  FREELLM_BASE_URLS_URL,
  fixturePath,
  parseFreeLlmModels,
  parseBaseUrlTable,
  fetchAggregatedIndex,
  defaultFetchHtml,
};