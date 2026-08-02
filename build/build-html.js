#!/usr/bin/env node
/**
 * build-html.js
 *
 * Reads the LLM Deals Intelligence Skill JSON report (report.json)
 * and generates a single self-contained index.html page for GitHub Pages.
 *
 * Spec 0002: shadcn/ui design tokens, working dark mode, freshness ranked
 * list, per model connection accordions, OpenRouter free model names.
 *
 * Usage:
 *   node build/build-html.js [input.json] [output.html]
 *
 * Defaults:
 *   input  -> report.json (in project root)
 *   output -> index.html (in project root)
 */

const fs = require('fs');
const path = require('path');
const rankingPolicy = require('./ranking-policy');

// ── Paths ─────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(ROOT, 'report.json');
const DEFAULT_OUTPUT = path.join(ROOT, 'index.html');

// Pinned Tailwind build (spec 0002 AC-2: fixed version, not the floating CDN script).
const TAILWIND_CDN = 'https://cdn.tailwindcss.com/3.4.1';

// ── Classification badges (seven colors, token backed) ────────────
const CLASS_BADGE = {
  A_TRUE_FREE:            { label: 'A. 完全無料',      cls: 'badge-a' },
  B_PERMANENT_FREE_TIER:  { label: 'B. 恒久無料枠',    cls: 'badge-b' },
  C_LIMITED_FREE:         { label: 'C. 期間限定無料',  cls: 'badge-c' },
  D_TRIAL_CREDIT:         { label: 'D. 試用クレジット', cls: 'badge-d' },
  E_DISCOUNT:             { label: 'E. 割引',          cls: 'badge-e' },
  F_CONDITIONAL:          { label: 'F. 条件付き',      cls: 'badge-f' },
};

// Performance tier is the admission gate (S, A, B). Raw scores from different
// benchmarks are never compared; the tier is the normalized bucket.
const TIER_RANK = { S: 0, A: 1, B: 2 };
const ADMITTED_TIERS = ['S', 'A', 'B'];

// ── Provider capability registry ──────────────────────────────────
// Loaded from build/provider-registry.json — the single source of truth
// shared with validate-report.js (endpoint gate) and the collection skill.
// Providers differ in endpoint path, auth scheme, and OpenAI compatibility.
// `agents` lists the agents with a verified configuration for this provider;
// anything else renders the "このエージェントでは未検証" fallback (AC-6).
// Offers that match NO registry entry render a fully unverified accordion —
// the build never fabricates a generic connection snippet.
const { loadRegistry, matchProvider } = require('./provider-registry');
const PROVIDER_CAPABILITIES = loadRegistry();

function getCapability(offer) {
  const hit = matchProvider(offer, PROVIDER_CAPABILITIES);
  return hit ? hit.entry : null;
}

// ── Versioned per agent connection templates (AC-6) ───────────────
// Connection instructions are derived here at build time, never stored in
// report.json. Bump the version when the template shapes change.
const AGENT_TEMPLATE_VERSION = '2026.07.2';
const AGENTS = [
  { id: 'pi',          label: 'pi' },
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'opencode',    label: 'OpenCode' },
  { id: 'codex',       label: 'Codex' },
];

// Base URL used for OpenAI-style clients: providers whose canonical URL is a
// native endpoint (e.g. Gemini's /v1beta) expose a separate OpenAI-compatible
// path, recorded as openai_base_url in the registry.
function openaiBaseUrl(o, cap) {
  return cap.openai_base_url || o.base_url;
}

const AGENT_SNIPPETS = {
  // pi: custom providers are registered in ~/.pi/agent/models.json; settings.json
  // only selects an already-registered provider (pi docs: models.md).
  pi: (o, cap) => `// ~/.pi/agent/models.json にプロバイダを登録
{
  "providers": {
    "${cap.key}": {
      "baseUrl": "${o.base_url}",
      "api": "${cap.api_type}",
      "apiKey": "$${cap.env}",
      "models": [
        { "id": "${o.model_id}", "reasoning": false }
      ]
    }
  }
}

export ${cap.env}=xxxxxxxxxxxxxxxx

# 起動 (または .pi/settings.json の defaultProvider/defaultModel)
pi --model ${cap.key}/${o.model_id}`,
  // Claude Code: no native OpenAI-compatible provider support. The documented
  // routes are an Anthropic-protocol gateway/proxy, or Vertex AI for Gemini.
  claude_code: (o, cap) =>
    cap.openai
      ? `# Claude Code は OpenAI 互換 API に直接接続できません。
# Anthropic 規約に変換するプロキシ (LiteLLM, claude-code-router 等) 経由で接続します。
# プロキシの上流を ${o.base_url} ・ モデル ${o.model_id} に設定してから:
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_AUTH_TOKEN=xxxxxxxxxxxxxxxx

claude --model ${o.model_id}`
      : `# Claude Code は Gemini を Google Vertex AI 経由で利用できます。
export CLAUDE_CODE_USE_VERTEX=1
export CLOUD_ML_REGION=global
export ANTHROPIC_VERTEX_PROJECT_ID=<GCPプロジェクトID>

claude --model ${o.model_id}`,
  opencode: (o, cap) =>
    cap.openai
      ? `// opencode.json
{
  "provider": {
    "${cap.key}": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "${o.base_url}" },
      "models": { "${o.model_id}": {} }
    }
  }
}

# APIキー登録 (無料キーで可)
# opencode 起動後 → /connect ${cap.key} → キーを貼付`
      : `// opencode.json
{
  "provider": {
    "${cap.key}": {
      "npm": "@ai-sdk/google",
      "models": { "${o.model_id}": {} }
    }
  }
}

export ${cap.env}=xxxxxxxxxxxxxxxx
# または opencode 起動後 → /connect ${cap.key}`,
  codex: (o, cap) =>
    `# ~/.codex/config.toml
[model_providers.${cap.key}]
name = "${cap.label}"
base_url = "${openaiBaseUrl(o, cap)}"
env_key = "${cap.env}"
wire_api = "chat"

[profiles.${cap.key}]
provider = "${cap.key}"
model = "${o.model_id}"

# 起動
codex --profile ${cap.key}`,
};

// ── Helpers ───────────────────────────────────────────────────────
function esc(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(dt, tz) {
  if (!dt) return '不明';
  try {
    return new Date(dt).toLocaleDateString('ja-JP', {
      year: 'numeric', month: 'long', day: 'numeric',
      timeZone: tz || 'Asia/Tokyo',
    });
  } catch { return esc(dt); }
}

function validTimestamp(v) {
  return typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
}

// Calendar day key (YYYY-MM-DD) of a timestamp in a given IANA timezone.
function dayKeyInTz(iso, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date(iso));
}

// Freshness label: a Japanese calendar day relative label against
// report.generated_at in report.timezone (AC-4). Missing/invalid -> 未検証.
function freshnessLabel(lastVerified, generatedAt, tz) {
  if (!validTimestamp(lastVerified)) return { text: '未検証', verified: false };
  try {
    const genDay = Date.parse(dayKeyInTz(generatedAt, tz));
    const verDay = Date.parse(dayKeyInTz(lastVerified, tz));
    const days = Math.round((genDay - verDay) / 86400000);
    if (days <= 0) return { text: '今日', verified: true };
    if (days === 1) return { text: '昨日', verified: true };
    return { text: `${days}日前`, verified: true };
  } catch {
    return { text: '未検証', verified: false };
  }
}

function fmtPrice(v) {
  if (v == null) return '—';
  if (v === 0) return '$0';
  // Spec 0004 AC-14: prices are USD per million tokens and must be readable.
  // Tiny catalog prices arrive as small decimals with occasional float
  // artifacts (e.g. OpenRouter returns 0.0000006000000000000001, parsed as
  // 6.000000000000001e-7). Plain `${v}` would render '1e-7' or
  // '6.000000000000001e-7'. Format with up to 12 significant digits and no
  // grouping so real values stay exact and artifacts round to the readable
  // intended decimal ($0.0000006).
  const s = new Intl.NumberFormat('en-US', {
    useGrouping: false,
    maximumSignificantDigits: 12,
  }).format(v);
  return `$${s}`;
}

function priceDisplay(o) {
  const price = o.effective_price_per_million || o.normal_price_per_million || {};
  const inP = fmtPrice(price.input);
  const outP = fmtPrice(price.output);
  const isFree = o.access_kind === 'FREE' || (price.input === 0 && price.output === 0);
  const text = isFree ? '$0' : `${inP} / ${outP}`;
  return { text, isFree };
}

// ── Ranking (spec 0004 AC-4, AC-5, AC-7) ─────────────────────────
// Admission gate: ranked_offers only, ranking_eligible === true, a
// qualifying shared-policy Terminal Bench 2.0/2.1 at or above 50, tier in
// S/A/B, and a derived access kind of FREE or ULTRA_LOW whose effective
// prices match. No fixed card cap.
// Ordering mirrors assemble.js compareRanked: tier (S>A>B) → access kind
// (FREE before ULTRA_LOW) → same Terminal Bench version score DESC → price
// confirmation date DESC → name. Raw scores from different benchmark
// versions are never compared.
const ACCESS_RANK = { FREE: 0, ULTRA_LOW: 1 };

function selectRankedOffers(report) {
  const eligible = (report.ranked_offers || []).filter(o =>
    o.ranking_eligible === true &&
    rankingPolicy.qualifiesTerminalBench(
      o.benchmark_key,
      o.benchmark && o.benchmark.score
    ) &&
    o.benchmark &&
    o.benchmark.tier != null &&
    ADMITTED_TIERS.includes(o.benchmark.tier) &&
    (o.access_kind === 'FREE' || o.access_kind === 'ULTRA_LOW') &&
    rankingPolicy.accessKindMatches(
      o.access_kind,
      o.effective_price_per_million && o.effective_price_per_million.input,
      o.effective_price_per_million && o.effective_price_per_million.output
    )
  );
  return eligible.sort((a, b) => {
    const at = TIER_RANK[a.benchmark.tier];
    const bt = TIER_RANK[b.benchmark.tier];
    if (at !== bt) return at - bt; // S before A before B
    const aa = ACCESS_RANK[a.access_kind] ?? ACCESS_RANK.ULTRA_LOW;
    const ba = ACCESS_RANK[b.access_kind] ?? ACCESS_RANK.ULTRA_LOW;
    if (aa !== ba) return aa - ba; // FREE before ULTRA_LOW
    if (a.benchmark.version && b.benchmark.version && a.benchmark.version === b.benchmark.version) {
      const as = a.benchmark.score ?? 0;
      const bs = b.benchmark.score ?? 0;
      if (bs !== as) return bs - as; // higher same-version score first
    }
    const av = validTimestamp(a.price_verified_at) ? Date.parse(a.price_verified_at) : Number.NEGATIVE_INFINITY;
    const bv = validTimestamp(b.price_verified_at) ? Date.parse(b.price_verified_at) : Number.NEGATIVE_INFINITY;
    if (bv !== av) return bv - av; // price confirmation date DESC, missing sorts last
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

// ── Component builders ────────────────────────────────────────────
function classBadge(o) {
  // G_FREE_LIKE is the classifier's fallback when no more specific offer
  // mechanism is proven. It adds no useful information beside the
  // deterministic FREE / ULTRA_LOW access badge, so do not present it as if
  // it described the current price.
  if (o.classification === 'G_FREE_LIKE') return '<!-- no offer-mechanism badge -->';
  const b = CLASS_BADGE[o.classification];
  if (!b) return '<!-- no offer-mechanism badge -->';
  return `<span class="badge ${b.cls}">${esc(b.label)}</span>`;
}

// Access kind badge (spec 0004 AC-14): deterministic, token backed, and
// displayed in plain Japanese rather than exposing the internal enum.
function accessBadge(o) {
  if (o.access_kind === 'FREE') {
    return `<span class="badge badge-a" title="実効入力・出力価格が 0ドル / 百万トークン">無料</span>`;
  }
  if (o.access_kind === 'ULTRA_LOW') {
    return `<span class="badge badge-c" title="入力 0.2ドル以下 ・ 出力 0.4ドル以下 / 百万トークン">激安</span>`;
  }
  return '';
}

function tierBadge(tier) {
  const cls = tier === 'S' ? 'tier-s' : tier === 'A' ? 'tier-a' : 'tier-b';
  return `<span class="tier ${cls}" title="性能ティア"><span class="tier-letter">${esc(tier)}</span></span>`;
}

function freshnessBadge(o, generatedAt, tz) {
  const f = freshnessLabel(o.last_verified, generatedAt, tz);
  const cls = f.verified ? 'fresh' : 'fresh-unverified';
  const icon = f.verified
    ? '<svg class="fresh-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>'
    : '<svg class="fresh-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/></svg>';
  return `<span class="freshness ${cls}">${icon}${esc(f.text)}${f.verified ? ' 確認' : ''}</span>`;
}

function benchmarkBlock(o) {
  if (!o.benchmark) return '';
  const tier = o.benchmark.tier;
  const cls = tier === 'S' ? 'tier-s' : tier === 'A' ? 'tier-a' : 'tier-b';
  const version = o.benchmark.version ? ` (${esc(o.benchmark.version)})` : '';
  return `<div class="stat">
      <div class="stat-label">ベンチマーク</div>
      <div class="stat-value"><span class="bench-tier ${cls}">${esc(tier)}</span><span class="bench-score">${esc(o.benchmark.score)}%</span></div>
      <div class="stat-sub">${esc(o.benchmark.benchmark_name)}${version}</div>
    </div>`;
}

function confidenceBlock(o) {
  const conf = o.operational_confidence || '—';
  const cls = conf === 'HIGH' ? 'conf-high' : conf === 'MEDIUM' ? 'conf-med' : 'conf-low';
  return `<div class="stat">
      <div class="stat-label">運用信頼度</div>
      <div class="stat-value"><span class="conf ${cls}">${esc(conf)}</span></div>
      <div class="stat-sub">${esc(o.recent_activity || '')}</div>
    </div>`;
}

// Expandable benchmark details: representative score shown on the card,
// full benchmark list revealed on demand.
function benchmarkDetailsBlock(o) {
  const list = Array.isArray(o.benchmarks) ? o.benchmarks : [];
  if (list.length === 0) return '';
  const rows = list.map(b =>
    `<div class="bench-row"><span class="bench-name">${esc(b.name)}${b.version ? ` (${esc(b.version)})` : ''}</span><span class="bench-val">${esc(b.score)}%</span></div>`
  ).join('');
  return `<details class="bench-details">
      <summary class="bench-summary">
        <span class="bench-summary-label">ベンチマーク詳細</span>
        <span class="bench-summary-count">${list.length}件</span>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </summary>
      <div class="bench-list">${rows}</div>
    </details>`;
}

// Per model connection accordion (AC-6): one details/summary per card with
// four agent subsections from the versioned template registry.
function connectionAccordion(o) {
  const cap = getCapability(o);
  if (!cap) {
    // Unknown provider: never fabricate a snippet. The registry gates
    // validation; this notice tells the reader the config is unverified.
    return `<details class="acc">
      <summary class="acc-summary" aria-label="接続方法を表示">
        <span class="acc-title">
          <svg class="acc-plug" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 2v6m6-6v6M5 8h14l-1 7a5 5 0 0 1-5 4h-2a5 5 0 0 1-5-4L5 8Zm3 12v2"/></svg>
          接続方法
        </span>
        <span class="acc-agents">未検証</span>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </summary>
      <div class="acc-body">
        <p class="agent-unsupported">このプロバイダーの接続例はまだ検証されていません。カード内の Base URL と Model ID を元に、公式ドキュメントで各エージェントの設定方法を確認してください。</p>
      </div>
    </details>`;
  }
  const blocks = AGENTS.map(agent => {
    const supported = cap.agents.includes(agent.id);
    if (!supported) {
      return `<div class="agent-block">
          <div class="agent-head"><span class="agent-name">${esc(agent.label)}</span><span class="agent-tag agent-tag-unverified">未検証</span></div>
          <p class="agent-unsupported">このエージェントでは未検証</p>
        </div>`;
    }
    const snippet = AGENT_SNIPPETS[agent.id](o, cap);
    return `<div class="agent-block">
        <div class="agent-head"><span class="agent-name">${esc(agent.label)}</span><span class="agent-tag agent-tag-ok">設定例</span></div>
        <pre class="agent-code"><code>${esc(snippet)}</code></pre>
      </div>`;
  }).join('');
  return `<details class="acc">
      <summary class="acc-summary" aria-label="接続方法を表示">
        <span class="acc-title">
          <svg class="acc-plug" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 2v6m6-6v6M5 8h14l-1 7a5 5 0 0 1-5 4h-2a5 5 0 0 1-5-4L5 8Zm3 12v2"/></svg>
          接続方法
        </span>
        <span class="acc-agents">pi · Claude Code · OpenCode · Codex</span>
        <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </summary>
      <div class="acc-body">
        <p class="acc-note">テンプレート版本 ${esc(AGENT_TEMPLATE_VERSION)} ・ エンドポイントは provider-registry.json (公式ドキュメント由来) で検証済み。Base URL と Model ID はこのカードの値から生成。APIキーはプレースホルダーです。</p>
        <div class="agent-grid">${blocks}</div>
      </div>
    </details>`;
}

// Identity rows for one card (spec 0004 AC-14). Rows render only when the
// value exists; absent rows emit nothing so the generated HTML has no
// whitespace only lines.
function offerIdRows(o, tz) {
  const rows = [
    ['Base URL', o.base_url ? `<code class="id-val">${esc(o.base_url)}</code>` : null],
    ['Model ID', o.model_id ? `<code class="id-val">${esc(o.model_id)}</code>` : null],
    ['価格確認日', o.price_verified_at ? `<span class="id-val-plain">${fmtDate(o.price_verified_at, tz)}</span>` : null],
    ['割引期限', o.discount_end_at ? `<span class="id-val-plain train-yes">⏳ ${fmtDate(o.discount_end_at, tz)}まで</span>` : null],
    ['リミット', o.free_limits ? `<span class="id-val-plain">${esc(o.free_limits)}</span>` : null],
    ['期限', o.end_at ? `<span class="id-val-plain train-yes">⏳ ${fmtDate(o.end_at, tz)}まで${o.end_timezone_known ? '' : ' (タイムゾーン不明)'}</span>` : null],
    ['レート', o.rate_limits ? `<span class="id-val-plain">${esc(o.rate_limits)}</span>` : null],
    ['データ利用', o.training_use ? `<span class="id-val-plain ${/なし|no/i.test(o.training_use) ? 'train-no' : 'train-yes'}">${esc(o.training_use)}</span>` : null],
  ];
  return rows
    .filter((row) => row[1] !== null)
    .map((row) => `<div class="id-row"><span class="id-key">${row[0]}</span>${row[1]}</div>`)
    .join('\n          ');
}

function offerCard(o, index, generatedAt, tz) {
  const price = priceDisplay(o);
  const pos = String(index + 1).padStart(2, '0');
  const tierCls = o.benchmark ? ` tier-accent-${o.benchmark.tier.toLowerCase()}` : '';
  const cardDetails = [benchmarkDetailsBlock(o), connectionAccordion(o)]
    .filter(Boolean)
    .join('\n        ');
  return `<article class="offer-card reveal${tierCls}" aria-labelledby="offer-${index}">
    <div class="card-accent" aria-hidden="true"></div>
    <span class="rank-watermark" aria-hidden="true">${pos}</span>
    <div class="offer-inner">
      <div class="offer-main">
        <div class="offer-badges">
          ${classBadge(o)}
          ${accessBadge(o)}
          ${o.benchmark ? tierBadge(o.benchmark.tier) : ''}
          ${freshnessBadge(o, generatedAt, tz)}
        </div>
        <h3 id="offer-${index}" class="offer-name">${esc(o.name)}</h3>
        <p class="offer-meta">${o.provider ? `by <strong>${esc(o.provider)}</strong>` : ''}${o.model_name ? ` ・ ${esc(o.model_name)}` : ''}</p>

        <div class="offer-stats">
          ${benchmarkBlock(o)}
          <div class="stat">
            <div class="stat-label">実効価格 <span class="stat-unit">/ 1M tokens</span></div>
            <div class="stat-value"><span class="price ${price.isFree ? 'price-free' : ''}">${esc(price.text)}</span></div>
            <div class="stat-sub">入力 / 出力</div>
          </div>
          ${confidenceBlock(o)}
        </div>

        <div class="offer-ids">
          ${offerIdRows(o, tz)}
        </div>

        ${cardDetails}

        <div class="offer-links">
          ${(() => {
            // Router offers link to the model page (registry template), not a
            // generic docs page — the reader wants the exact model's page.
            const cap = getCapability(o);
            const modelPage = cap && cap.model_page_template && o.model_id
              ? cap.model_page_template.replace('{model_id}', o.model_id)
              : null;
            const href = modelPage || (o.sources && o.sources[0]);
            const label = modelPage ? 'モデルページ' : '公式サイト';
            return href ? `<a class="btn btn-primary" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${label} <span aria-hidden="true">↗</span></a>` : '';
          })()}
        </div>
      </div>
    </div>
  </article>`;
}

// Raw summary counts for the snapshot strip AND the OGP image, so the two
// never disagree. Single source of truth for "what's in today's report".
function computeSnapshot(report, offers) {
  const total = offers.length;
  const sCount = offers.filter(o => o.benchmark && o.benchmark.tier === 'S').length;
  const aCount = offers.filter(o => o.benchmark && o.benchmark.tier === 'A').length;
  const freeCount = offers.filter(o => o.access_kind === 'FREE' ||
    (!o.access_kind && o.effective_price_per_million && o.effective_price_per_million.input === 0 && o.effective_price_per_million.output === 0)).length;
  const limitedCount = offers.filter(o => o.end_at || o.discount_end_at).length;
  return { total, sCount, aCount, freeCount, limitedCount };
}

function snapshotStrip(report, offers) {
  const { total, sCount, freeCount, limitedCount } = computeSnapshot(report, offers);
  return `<div class="snapshot reveal" role="group" aria-label="今回のサマリー">
    <div class="snap-cell">
      <span class="snap-num">${total}</span>
      <span class="snap-label">掲載オファー</span>
    </div>
    <div class="snap-cell">
      <span class="snap-num snap-num-s">${sCount}</span>
      <span class="snap-label">Sティア</span>
    </div>
    <div class="snap-cell">
      <span class="snap-num snap-num-free">${freeCount}</span>
      <span class="snap-label">完全無料</span>
    </div>
    <div class="snap-cell">
      <span class="snap-num">${limitedCount}</span>
      <span class="snap-label">期限付き</span>
    </div>
  </div>`;
}

// ── Theme tokens (spec 0002 AC-1, AC-2) ───────────────────────────
// One source of truth: CSS variables in :root and .dark, with the Tailwind
// config mapped onto them. No duplicated color systems.
const TOKEN_CSS = `
:root {
  --background: 0 0% 99%;
  --foreground: 240 10% 6%;
  --card: 0 0% 100%;
  --card-foreground: 240 10% 6%;
  --popover: 0 0% 100%;
  --popover-foreground: 240 10% 6%;
  --primary: 240 8% 12%;
  --primary-foreground: 0 0% 98%;
  --secondary: 240 5% 96%;
  --secondary-foreground: 240 8% 12%;
  --muted: 240 5% 96%;
  --muted-foreground: 240 4% 45%;
  --accent: 240 5% 96%;
  --accent-foreground: 240 8% 12%;
  --destructive: 0 72% 51%;
  --destructive-foreground: 0 0% 98%;
  --success: 142 71% 34%;
  --success-foreground: 0 0% 98%;
  --warning: 32 95% 38%;
  --warning-foreground: 0 0% 98%;
  --border: 240 6% 89%;
  --input: 240 6% 89%;
  --ring: 240 8% 12%;
  --radius: 0.5rem;
  --badge-a: 142 71% 32%;
  --badge-b: 217 91% 40%;
  --badge-c: 30 95% 34%;
  --badge-d: 262 83% 44%;
  --badge-e: 24 95% 38%;
  --badge-f: 180 70% 26%;
  --tier-s: 38 92% 36%;
  --tier-a: 217 91% 40%;
  --tier-b: 142 71% 32%;
}
.dark {
  --background: 240 7% 10%;
  --foreground: 0 0% 96%;
  --card: 240 6% 13%;
  --card-foreground: 0 0% 96%;
  --popover: 240 6% 13%;
  --popover-foreground: 0 0% 96%;
  --primary: 0 0% 96%;
  --primary-foreground: 240 7% 10%;
  --secondary: 240 5% 16%;
  --secondary-foreground: 0 0% 96%;
  --muted: 240 5% 16%;
  --muted-foreground: 240 5% 68%;
  --accent: 240 5% 16%;
  --accent-foreground: 0 0% 96%;
  --destructive: 0 62% 55%;
  --destructive-foreground: 0 0% 98%;
  --success: 142 60% 50%;
  --success-foreground: 240 7% 10%;
  --warning: 35 90% 58%;
  --warning-foreground: 240 7% 10%;
  --border: 240 6% 22%;
  --input: 240 6% 22%;
  --ring: 240 5% 70%;
  --badge-a: 142 71% 38%;
  --badge-b: 217 91% 46%;
  --badge-c: 32 95% 40%;
  --badge-d: 262 83% 52%;
  --badge-e: 25 95% 44%;
  --badge-f: 180 70% 32%;
  --tier-s: 43 96% 62%;
  --tier-a: 217 91% 66%;
  --tier-b: 142 71% 56%;
}
`;

// Component CSS. Every color references a token; no hardcoded hex.
const COMPONENT_CSS = `
* { border-color: hsl(var(--border)); }
html { scroll-behavior: smooth; }
body {
  background-color: hsl(var(--background));
  color: hsl(var(--foreground));
  font-family: "Noto Sans JP", system-ui, sans-serif;
}
.font-display { font-family: "Space Grotesk", "Noto Sans JP", sans-serif; }

/* Header gradient accent: tier colors as a thin underline, tying the
   chrome to the content's color system. */
header::after {
  content: ''; position: absolute; bottom: 0; left: 0; right: 0; height: 2px;
  background: linear-gradient(90deg,
    hsl(var(--tier-s) / 0.5) 0%, hsl(var(--tier-a) / 0.4) 50%, hsl(var(--tier-b) / 0.5) 100%);
  pointer-events: none;
}

/* Live pulse dot: conveys the daily feed is current. */
.live-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: hsl(var(--success));
  animation: live-pulse 2.4s ease-in-out infinite;
}
@keyframes live-pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 0 0 hsl(var(--success) / 0.5); }
  50% { opacity: 0.6; box-shadow: 0 0 0 4px hsl(var(--success) / 0); }
}

/* Layered ambient background: a soft top wash over a faint dot grid. */
.bg-texture {
  position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background-image:
    radial-gradient(ellipse 90% 55% at 50% -12%, hsl(var(--ring) / 0.07), transparent 62%),
    radial-gradient(hsl(var(--foreground) / 0.045) 1px, transparent 1px);
  background-size: 100% 100%, 22px 22px;
}

/* Classification badges: filled pill, white text. */
.badge {
  display: inline-flex; align-items: center;
  padding: 0.2rem 0.6rem; border-radius: calc(var(--radius) - 2px);
  font-size: 0.72rem; font-weight: 700; letter-spacing: 0.02em;
  color: #fff; white-space: nowrap;
}
.badge-a { background-color: hsl(var(--badge-a)); }
.badge-b { background-color: hsl(var(--badge-b)); }
.badge-c { background-color: hsl(var(--badge-c)); }
.badge-d { background-color: hsl(var(--badge-d)); }
.badge-e { background-color: hsl(var(--badge-e)); }
.badge-f { background-color: hsl(var(--badge-f)); }

/* Performance tier: soft square badge, colored letter. */
.tier {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1.7rem; height: 1.7rem; border-radius: calc(var(--radius) - 2px);
  font-family: "Space Grotesk", sans-serif; font-weight: 700; font-size: 0.9rem;
}
.tier-s { background: hsl(var(--tier-s) / 0.14); color: hsl(var(--tier-s)); box-shadow: inset 0 0 0 1px hsl(var(--tier-s) / 0.4); }
.tier-a { background: hsl(var(--tier-a) / 0.12); color: hsl(var(--tier-a)); box-shadow: inset 0 0 0 1px hsl(var(--tier-a) / 0.35); }
.tier-b { background: hsl(var(--tier-b) / 0.12); color: hsl(var(--tier-b)); box-shadow: inset 0 0 0 1px hsl(var(--tier-b) / 0.35); }

/* Freshness label. */
.freshness {
  display: inline-flex; align-items: center; gap: 0.3rem;
  padding: 0.2rem 0.55rem; border-radius: 999px;
  font-size: 0.72rem; font-weight: 600;
}
.fresh { background: hsl(var(--success) / 0.12); color: hsl(var(--success)); }
.fresh-unverified { background: hsl(var(--warning) / 0.14); color: hsl(var(--warning)); }
.fresh-icon { width: 0.8rem; height: 0.8rem; }

/* Offer card: flex column so same row cards stretch to equal height.
   position: relative anchors the rank watermark and accent bar. */
.offer-card {
  container: offer-card / inline-size;
  position: relative; overflow: hidden;
  display: flex; flex-direction: column;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  transition: border-color .2s ease, box-shadow .2s ease, transform .2s ease;
}
/* Tier accent bar: a 3px gradient at the very top of the card.
   Encodes performance tier structurally, visible in a grid scan. */
.card-accent {
  position: absolute; top: 0; left: 0; right: 0; height: 3px;
  background: hsl(var(--border));
  transition: height .2s ease;
}
.tier-accent-s .card-accent { background: linear-gradient(90deg, hsl(var(--tier-s)), hsl(var(--tier-s) / 0.3)); }
.tier-accent-a .card-accent { background: linear-gradient(90deg, hsl(var(--tier-a)), hsl(var(--tier-a) / 0.3)); }
.tier-accent-b .card-accent { background: linear-gradient(90deg, hsl(var(--tier-b)), hsl(var(--tier-b) / 0.3)); }
.offer-card:hover .card-accent { height: 4px; }

/* Rank watermark: the signature element. A large ghosted numeral
   positioned in the top right, tier tinted, never competing with content. */
.rank-watermark {
  position: absolute; top: -0.3rem; right: 0.6rem;
  font-family: "Space Grotesk", sans-serif;
  font-size: 5.5rem; font-weight: 700; line-height: 1;
  color: hsl(var(--foreground) / 0.04);
  pointer-events: none; user-select: none;
  transition: color .2s ease;
}
.tier-accent-s .rank-watermark { color: hsl(var(--tier-s) / 0.07); }
.tier-accent-a .rank-watermark { color: hsl(var(--tier-a) / 0.06); }
.tier-accent-b .rank-watermark { color: hsl(var(--tier-b) / 0.06); }
.offer-card:hover .rank-watermark { color: hsl(var(--foreground) / 0.07); }
.tier-accent-s:hover .rank-watermark { color: hsl(var(--tier-s) / 0.12); }
.tier-accent-a:hover .rank-watermark { color: hsl(var(--tier-a) / 0.10); }
.tier-accent-b:hover .rank-watermark { color: hsl(var(--tier-b) / 0.10); }

.offer-card:hover {
  border-color: hsl(var(--ring) / 0.45);
  box-shadow: 0 8px 24px hsl(var(--foreground) / 0.08);
  transform: translateY(-2px);
}
.offer-card.tier-accent-s:hover { box-shadow: 0 8px 28px hsl(var(--tier-s) / 0.13); }
.offer-card.tier-accent-a:hover { box-shadow: 0 8px 28px hsl(var(--tier-a) / 0.13); }
.offer-card.tier-accent-b:hover { box-shadow: 0 8px 28px hsl(var(--tier-b) / 0.13); }
.offer-inner { flex: 1; display: flex; padding: 1.35rem 1.5rem; padding-top: 1.5rem; }
.offer-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.offer-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; margin-bottom: 0.5rem; }
.offer-name {
  font-family: "Space Grotesk", "Noto Sans JP", sans-serif;
  font-size: 1.5rem; font-weight: 700; line-height: 1.2;
  letter-spacing: -0.02em;
}
.offer-meta { font-size: 0.82rem; color: hsl(var(--muted-foreground)); margin-top: 0.2rem; }

.offer-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); gap: 0.75rem; margin-top: 1rem; }
.stat { background: hsl(var(--muted) / 0.55); border-radius: calc(var(--radius) - 2px); padding: 0.65rem 0.8rem; }
.stat-label { font-size: 0.68rem; letter-spacing: 0.08em; color: hsl(var(--muted-foreground)); text-transform: uppercase; }
.stat-unit { text-transform: none; letter-spacing: 0; }
.stat-value { margin-top: 0.25rem; display: flex; align-items: baseline; gap: 0.4rem; }
.stat-sub { font-size: 0.72rem; color: hsl(var(--muted-foreground)); margin-top: 0.15rem; }
.bench-tier { font-family: "Space Grotesk", sans-serif; font-weight: 700; font-size: 1.3rem; }
.bench-tier.tier-s { color: hsl(var(--tier-s)); }
.bench-tier.tier-a { color: hsl(var(--tier-a)); }
.bench-tier.tier-b { color: hsl(var(--tier-b)); }
.bench-score { font-family: "Space Grotesk", sans-serif; font-weight: 600; font-size: 1.05rem; }
.price { font-family: "Space Grotesk", sans-serif; font-weight: 700; font-size: 1.25rem; }
.price-free { color: hsl(var(--success)); }
.conf { font-weight: 700; font-size: 1rem; }
.conf-high { color: hsl(var(--success)); }
.conf-med { color: hsl(var(--warning)); }
.conf-low { color: hsl(var(--destructive)); }

.offer-ids { margin-top: 1rem; display: grid; gap: 0.4rem; }
.id-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; font-size: 0.8rem; }
.id-key { color: hsl(var(--muted-foreground)); min-width: 5rem; font-weight: 600; }
.id-val { background: hsl(var(--muted)); padding: 0.15rem 0.5rem; border-radius: calc(var(--radius) - 4px); font-size: 0.75rem; word-break: break-all; }
.id-val-plain { font-size: 0.8rem; }
.train-no { color: hsl(var(--success)); font-weight: 600; }
.train-yes { color: hsl(var(--warning)); font-weight: 600; }

/* Expandable benchmark details. */
.bench-details { margin-top: 1.15rem; border-top: 1px solid hsl(var(--border)); padding-top: 0.9rem; }
.bench-summary {
  display: flex; align-items: center; gap: 0.7rem; cursor: pointer;
  list-style: none; user-select: none;
  padding: 0.45rem 0.6rem; margin: 0 -0.6rem; border-radius: calc(var(--radius) - 2px);
  transition: background-color .15s ease;
}
.bench-summary::-webkit-details-marker { display: none; }
.bench-summary:hover { background: hsl(var(--accent)); }
.bench-summary-label { font-weight: 700; font-size: 0.9rem; }
.bench-summary-count {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 1.4rem; height: 1.4rem; padding: 0 0.35rem;
  border-radius: 999px; background: hsl(var(--primary)); color: hsl(var(--primary-foreground));
  font-family: "Space Grotesk", sans-serif; font-size: 0.68rem; font-weight: 700;
}
.bench-list { padding: 0.9rem 0.2rem 0.2rem; display: grid; gap: 0.35rem; }
.bench-row {
  display: flex; align-items: center; justify-content: space-between; gap: 1rem;
  padding: 0.45rem 0.7rem; border-radius: calc(var(--radius) - 4px);
  background: hsl(var(--muted) / 0.5); font-size: 0.8rem;
}
.bench-name { color: hsl(var(--muted-foreground)); font-weight: 500; }
.bench-val { font-family: "Space Grotesk", sans-serif; font-weight: 700; font-size: 0.85rem; color: hsl(var(--foreground)); }

/* Connection accordion (details/summary styled after shadcn/ui Accordion). */
.acc { margin-top: 1.15rem; border-top: 1px solid hsl(var(--border)); padding-top: 0.9rem; }
.acc-summary {
  display: flex; align-items: center; gap: 0.7rem; cursor: pointer;
  list-style: none; user-select: none;
  padding: 0.45rem 0.6rem; margin: 0 -0.6rem; border-radius: calc(var(--radius) - 2px);
  transition: background-color .15s ease;
}
.acc-summary::-webkit-details-marker { display: none; }
.acc-summary:hover { background: hsl(var(--accent)); }
.acc-title { display: inline-flex; align-items: center; gap: 0.45rem; font-weight: 700; font-size: 0.9rem; }
.acc-plug { width: 1rem; height: 1rem; color: hsl(var(--muted-foreground)); }
.acc-agents { font-size: 0.75rem; color: hsl(var(--muted-foreground)); }
.chev { width: 1.1rem; height: 1.1rem; margin-left: auto; color: hsl(var(--muted-foreground)); transition: transform .2s ease; flex-shrink: 0; }
details.acc[open] .chev { transform: rotate(180deg); }
.acc-body { padding: 0.9rem 0.2rem 0.2rem; }
.acc-note { font-size: 0.75rem; color: hsl(var(--muted-foreground)); margin-bottom: 0.8rem; }
.agent-grid { display: grid; grid-template-columns: 1fr; gap: 0.9rem; }
/* Card is a container: agent snippets sit side by side only when the card
   itself is wide enough, regardless of the page's column count. */
@container offer-card (min-width: 40rem) { .agent-grid { grid-template-columns: 1fr 1fr; } }
/* Compact mode: when the card is narrow (2 col layout), tighten spacing
   and scale down the rank numeral to preserve content density. */
@container offer-card (max-width: 36rem) {
  .offer-inner { padding: 1.1rem 1.2rem; padding-top: 1.25rem; }
  .rank-watermark { font-size: 4rem; top: -0.2rem; right: 0.4rem; }
  .offer-name { font-size: 1.2rem; }
}
.agent-block { min-width: 0; }
.agent-head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.4rem; }
.agent-name { font-weight: 700; font-size: 0.85rem; }
.agent-tag { font-size: 0.62rem; font-weight: 700; padding: 0.1rem 0.45rem; border-radius: 999px; }
.agent-tag-ok { background: hsl(var(--success) / 0.12); color: hsl(var(--success)); }
.agent-tag-unverified { background: hsl(var(--warning) / 0.14); color: hsl(var(--warning)); }
.agent-code {
  background: hsl(var(--muted)); border: 1px solid hsl(var(--border));
  border-radius: calc(var(--radius) - 2px); padding: 0.8rem;
  font-family: "JetBrains Mono", monospace; font-size: 0.72rem; line-height: 1.55;
  overflow-x: auto; white-space: pre;
}
.agent-unsupported {
  background: hsl(var(--warning) / 0.08); border: 1px dashed hsl(var(--warning) / 0.5);
  border-radius: calc(var(--radius) - 2px); padding: 0.8rem;
  color: hsl(var(--warning)); font-size: 0.8rem; font-weight: 600;
}

.offer-links { margin-top: auto; padding-top: 1.1rem; }
.btn {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.5rem 1rem; border-radius: calc(var(--radius) - 2px);
  font-size: 0.82rem; font-weight: 700; min-height: 2.4rem;
  transition: opacity .15s ease, background-color .15s ease;
}
.btn-primary { background: hsl(var(--primary)); color: hsl(var(--primary-foreground)); }
.btn-primary:hover { opacity: 0.85; }

/* Snapshot strip. */
.snapshot {
  display: grid; grid-template-columns: repeat(2, 1fr);
  border: 1px solid hsl(var(--border)); border-radius: var(--radius);
  background: hsl(var(--card)); overflow: hidden;
}
@media (min-width: 768px) { .snapshot { grid-template-columns: repeat(4, 1fr); } }
.snap-cell {
  padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: 0.15rem;
  border-right: 1px solid hsl(var(--border)); border-bottom: 1px solid hsl(var(--border));
}
.snap-cell:last-child { border-right: 0; }
@media (max-width: 767px) { .snap-cell:nth-child(2n) { border-right: 0; } }
@media (min-width: 768px) { .snap-cell { border-bottom: 0; } }
.snap-num { font-family: "Space Grotesk", sans-serif; font-size: 2.4rem; font-weight: 700; line-height: 1; letter-spacing: -0.03em; }
.snap-num-s { color: hsl(var(--tier-s)); }
.snap-num-free { color: hsl(var(--success)); }
.snap-label { font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; color: hsl(var(--muted-foreground)); }
/* Each snapshot cell gets a thin top accent matching its metric semantics. */
.snap-cell:nth-child(1) { border-top: 2px solid hsl(var(--primary) / 0.5); }
.snap-cell:nth-child(2) { border-top: 2px solid hsl(var(--tier-s) / 0.6); }
.snap-cell:nth-child(3) { border-top: 2px solid hsl(var(--success) / 0.6); }
.snap-cell:nth-child(4) { border-top: 2px solid hsl(var(--warning) / 0.6); }

/* Examples. */
/* Scroll reveal: visible by default (no-JS safe); the .js class, added by the
   early script, opts into the hidden-then-reveal animation as an enhancement. */
.reveal { opacity: 1; transform: none; }
.js .reveal { opacity: 0; transform: translateY(14px); transition: opacity .55s ease, transform .55s ease; }
.js .reveal.visible { opacity: 1; transform: none; }
/* Staggered reveal: right column cards enter slightly after left column,
   creating a subtle cascade across each row. */
.js .offer-card:nth-child(2n) { transition-delay: 0.07s; }

/* Focus visibility. */
:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .js .reveal { opacity: 1 !important; transform: none !important; transition: none !important; }
  .live-dot { animation: none; }
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;

// ── Main HTML template ────────────────────────────────────────────
function generateHTML(report) {
  const generatedAt = report.generated_at || new Date().toISOString();
  const tz = report.timezone || 'Asia/Tokyo';
  const dateStr = fmtDate(generatedAt, tz);
  // Calendar day in JST — used as the OGP image cache-buster so the share
  // card (and its embedded date) refreshes every daily batch. Twitter/X keys
  // its image cache on the full URL incl. query string (~7d TTL otherwise).
  const dateKey = dayKeyInTz(generatedAt, tz);
  const ogImage = `https://freeapi-news.tosukui.xyz/og-image.png?v=${dateKey.replace(/-/g, '')}`;
  const ogDesc = '検証済みの無料・割引LLM APIを、性能と鮮度で毎日ランキング。pi / Claude Code / OpenCode / Codex 向けの接続例も掲載。';
  const ogImageAlt = '無料LLM API速報 — 検証済み無料APIを性能×鮮度でランキング（毎日11:00 JST更新）';

  const offers = selectRankedOffers(report);
  const cards = offers.map((o, i) => offerCard(o, i, generatedAt, tz)).join('\n');
  const snapshot = snapshotStrip(report, offers);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="${esc(ogDesc)}">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" content="#fcfcfc" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#17181c" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%23f5a623'/><g fill='none' stroke='%23101014' stroke-width='2.4' stroke-linecap='round'><circle cx='16' cy='16' r='2.4'/><path d='M20.5 11.5a6 6 0 0 1 0 9M11.5 20.5a6 6 0 0 1 0-9M23.5 8.5a10 10 0 0 1 0 15M8.5 23.5a10 10 0 0 1 0-15'/></g></svg>">
  <title>無料LLM API速報</title>
  <link rel="canonical" href="https://freeapi-news.tosukui.xyz/">
  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="無料LLM API速報">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:title" content="無料LLM API速報">
  <meta property="og:description" content="${esc(ogDesc)}">
  <meta property="og:url" content="https://freeapi-news.tosukui.xyz/">
  <meta property="og:image" content="${esc(ogImage)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="${esc(ogImageAlt)}">
  <!-- Twitter / X Card (summary_large_image) -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="無料LLM API速報">
  <meta name="twitter:description" content="${esc(ogDesc)}">
  <meta name="twitter:image" content="${esc(ogImage)}">
  <meta name="twitter:image:alt" content="${esc(ogImageAlt)}">
  <script>
    // Apply the theme before first paint (spec 0002 AC-1): read the stored
    // choice, fall back to the system preference, never flash the wrong theme.
    (function () {
      var root = document.documentElement;
      root.classList.add('js'); // opt into scroll-reveal; no-JS keeps content visible
      var dark = false;
      try {
        var stored = localStorage.getItem('theme');
        if (stored === 'dark' || stored === 'light') {
          dark = stored === 'dark';
        } else {
          dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        }
      } catch (e) {
        try { dark = window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e2) {}
      }
      root.classList.toggle('dark', dark);
    })();
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Noto+Sans+JP:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <script src="${TAILWIND_CDN}"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            border: 'hsl(var(--border))',
            input: 'hsl(var(--input))',
            ring: 'hsl(var(--ring))',
            background: 'hsl(var(--background))',
            foreground: 'hsl(var(--foreground))',
            primary: { DEFAULT: 'hsl(var(--primary))', foreground: 'hsl(var(--primary-foreground))' },
            secondary: { DEFAULT: 'hsl(var(--secondary))', foreground: 'hsl(var(--secondary-foreground))' },
            destructive: { DEFAULT: 'hsl(var(--destructive))', foreground: 'hsl(var(--destructive-foreground))' },
            success: { DEFAULT: 'hsl(var(--success))', foreground: 'hsl(var(--success-foreground))' },
            warning: { DEFAULT: 'hsl(var(--warning))', foreground: 'hsl(var(--warning-foreground))' },
            muted: { DEFAULT: 'hsl(var(--muted))', foreground: 'hsl(var(--muted-foreground))' },
            accent: { DEFAULT: 'hsl(var(--accent))', foreground: 'hsl(var(--accent-foreground))' },
            popover: { DEFAULT: 'hsl(var(--popover))', foreground: 'hsl(var(--popover-foreground))' },
            card: { DEFAULT: 'hsl(var(--card))', foreground: 'hsl(var(--card-foreground))' },
          },
          borderRadius: {
            lg: 'var(--radius)',
            md: 'calc(var(--radius) - 2px)',
            sm: 'calc(var(--radius) - 4px)',
          },
          fontFamily: {
            sans: ['"Noto Sans JP"', 'system-ui', 'sans-serif'],
            display: ['"Space Grotesk"', '"Noto Sans JP"', 'sans-serif'],
            mono: ['"JetBrains Mono"', '"Fira Code"', 'monospace'],
          },
        },
      },
    };
  </script>
  <style>${TOKEN_CSS}${COMPONENT_CSS}</style>
</head>
<body class="bg-background text-foreground font-sans antialiased">
  <div class="bg-texture" aria-hidden="true"></div>
  <a href="#main-content" class="sr-only focus:not-sr-only">本文へ移動</a>

  <header class="sticky top-0 z-30 bg-card/85 backdrop-blur">
    <div class="container mx-auto max-w-7xl px-4 py-3.5 flex items-center justify-between gap-4">
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-9 h-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-5 h-5"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>
        </div>
        <div class="min-w-0">
          <h1 class="font-display text-lg sm:text-xl font-bold leading-tight truncate">無料LLM API速報</h1>
          <p class="text-[11px] text-muted-foreground tracking-widest uppercase flex items-center gap-1.5"><span class="live-dot" aria-hidden="true"></span>Free LLM API Intelligence ・ 毎日11:00 JST</p>
        </div>
      </div>
      <button id="theme-toggle" type="button" class="p-2.5 rounded-md border bg-card hover:bg-accent transition-colors flex-shrink-0" aria-label="ダークモード切替" aria-pressed="false">
        <svg id="icon-sun" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 3v1m0 16v1m-9-9H2m20 0h-1M5.6 5.6l.7.7m12.1-.7-.7.7M5.6 18.4l.7-.7m12.1.7-.7-.7M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/></svg>
        <svg id="icon-moon" xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="display:none" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
    </div>
  </header>

  <main id="main-content" class="container mx-auto max-w-7xl px-4 py-8">

    <div class="mb-5 text-sm text-muted-foreground flex items-center gap-2">
      <span>最終更新</span>
      <time datetime="${esc(generatedAt)}" class="font-medium text-foreground">${esc(dateStr)}</time>
      <span aria-hidden="true">·</span>
      <span>${esc(tz)}</span>
    </div>

    ${snapshot}

    <section id="ranked" class="mt-10 mb-14" aria-labelledby="ranked-h">
      <div class="flex items-end justify-between gap-4 mb-1">
        <h2 id="ranked-h" class="font-display text-2xl sm:text-3xl font-bold">無料・激安APIランキング</h2>
        <span class="font-display text-sm text-muted-foreground whitespace-nowrap">${offers.length} 件</span>
      </div>
      <p class="text-sm text-muted-foreground mb-6">運用確認済み ・ ベンチマーク上位 (S/A/B) のみ掲載。<strong class="text-foreground">ティア</strong> → アクセス区分 (FREE/ULTRA_LOW) → 同じ Terminal Bench 版のスコア → 価格確認日 → 名前の順。無料枠の余裕度は表示のみです。</p>
      <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">${cards}</div>
    </section>

    <footer class="border-t pt-8 pb-4 text-center text-sm text-muted-foreground">
      <p class="mb-2"><strong class="text-foreground">無料LLM API速報</strong> ・ 毎日11:00 JST自動更新</p>
      <p class="mb-2">データソース: 公式ブログ ・ 価格ページ ・ GitHub ・ Reddit 他</p>
      <p class="mb-4">
        <a href="https://github.com/TOSUKUi/freeapi-news" target="_blank" rel="noopener noreferrer" class="underline hover:text-foreground transition-colors">GitHub リポジトリ</a>
        <span aria-hidden="true">·</span>
        <a href="https://github.com/TOSUKUi/freeapi-news/issues" target="_blank" rel="noopener noreferrer" class="underline hover:text-foreground transition-colors">フィードバック</a>
      </p>
      <p class="mb-2 text-xs">このサイトの情報は AI による自動収集に基づきます。誤りや遅延が含まれる可能性があります。利用前に必ず公式情報で確認してください。掲載内容の正確性や結果についての保証はありません。最終的な判断はご自身で行ってください。免責表示があっても、未検証の値は掲載しません。</p>
      <p class="text-xs">© 2026 free-api-news. このサイトの情報は参考用途にお使いください。リンク先の利用規約に従ってください。</p>
    </footer>

  </main>

  <script>
    // Theme toggle: flip the dark class on the document element and persist
    // the choice to localStorage["theme"] (spec 0002 AC-1).
    (function () {
      var root = document.documentElement;
      var btn = document.getElementById('theme-toggle');
      var sun = document.getElementById('icon-sun');
      var moon = document.getElementById('icon-moon');
      function paint() {
        var dark = root.classList.contains('dark');
        sun.style.display = dark ? 'none' : 'block';
        moon.style.display = dark ? 'block' : 'none';
        btn.setAttribute('aria-pressed', String(dark));
      }
      paint();
      btn.addEventListener('click', function () {
        var dark = root.classList.toggle('dark');
        try { localStorage.setItem('theme', dark ? 'dark' : 'light'); } catch (e) {}
        paint();
      });
    })();

    // Scroll reveal (respects prefers-reduced-motion via the CSS override).
    (function () {
      var items = document.querySelectorAll('.reveal');
      if (!('IntersectionObserver' in window)) {
        items.forEach(function (el) { el.classList.add('visible'); });
        return;
      }
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { en.target.classList.add('visible'); io.unobserve(en.target); }
        });
      }, { threshold: 0.08 });
      items.forEach(function (el) { io.observe(el); });
    })();
  </script>
</body>
</html>`;
}

// ── Entry point ───────────────────────────────────────────────────
function main() {
  const inputPath = process.argv[2] || DEFAULT_INPUT;
  const outputPath = process.argv[3] || DEFAULT_OUTPUT;

  let raw;
  try {
    raw = fs.readFileSync(inputPath, 'utf8');
  } catch (e) {
    // Spec 0004 / AGENTS.md: missing or invalid report input must fail
    // instead of generating dummy public HTML. There is no legacy
    // known_offers.json fallback and no dummy generation.
    console.error(`❌ 入力ファイルが見つかりません: ${inputPath}`);
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (e) {
    console.error(`❌ JSONの解析に失敗しました: ${inputPath}: ${e.message}`);
    process.exit(1);
  }

  const html = generateHTML(report);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');
  const ranked = selectRankedOffers(report);
  console.log(`✅ HTMLを生成しました: ${outputPath}`);
  console.log(`   入力: ${inputPath}`);
  console.log(`   レポート日時: ${report.generated_at || '不明'}`);
  console.log(`   掲載オファー: ${ranked.length} 件 (ティア→アクセス区分→同じTerminal Bench版のスコア→価格確認日→名前)`);
}

// Only auto-run when executed directly (`node build-html.js`), so other build
// scripts (e.g. build-og-image.js) can require the tokens/helpers safely.
if (require.main === module) main();

module.exports = {
  generateHTML,
  selectRankedOffers,
  computeSnapshot,
  dayKeyInTz,
  fmtDate,
  fmtPrice,
  TOKEN_CSS,
};
