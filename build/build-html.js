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

// ── Paths ─────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(ROOT, 'report.json');
const INPUT_FALLBACK = path.join(ROOT, '.agents', 'skills', 'llm-deals-intelligence-skill', 'state', 'known_offers.json');
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
  G_FREE_LIKE:            { label: 'G. 無料っぽい',    cls: 'badge-g' },
};

// Performance tier is the admission gate (S, A, B). Raw scores from different
// benchmarks are never compared; the tier is the normalized bucket.
const TIER_RANK = { S: 0, A: 1, B: 2 };
const ADMITTED_TIERS = ['S', 'A', 'B'];

// ── Provider capability registry ──────────────────────────────────
// Providers differ in endpoint path, auth scheme, and OpenAI compatibility.
// `agents` lists the agents with a verified configuration for this provider;
// anything else renders the "このエージェントでは未検証" fallback (AC-6).
const PROVIDER_CAPABILITIES = [
  { match: /nvidia/i,      key: 'nvidia',     label: 'NVIDIA NIM',   openai: true,  env: 'NVIDIA_API_KEY',     agents: ['pi', 'claude_code', 'opencode', 'codex'] },
  { match: /openrouter/i,  key: 'openrouter', label: 'OpenRouter',   openai: true,  env: 'OPENROUTER_API_KEY', agents: ['pi', 'claude_code', 'opencode', 'codex'] },
  { match: /deepseek/i,    key: 'deepseek',   label: 'DeepSeek',     openai: true,  env: 'DEEPSEEK_API_KEY',   agents: ['pi', 'claude_code', 'opencode', 'codex'] },
  { match: /cerebras/i,    key: 'cerebras',   label: 'Cerebras',     openai: true,  env: 'CEREBRAS_API_KEY',   agents: ['pi', 'claude_code', 'opencode', 'codex'] },
  { match: /googleapis|google/i, key: 'google', label: 'Google',     openai: false, env: 'GEMINI_API_KEY',     agents: ['pi', 'opencode'] },
  { match: /together/i,    key: 'together',   label: 'Together.ai',  openai: true,  env: 'TOGETHER_API_KEY',   agents: ['pi', 'claude_code', 'opencode', 'codex'] },
  { match: /anyscale/i,    key: 'anyscale',   label: 'Anyscale',     openai: true,  env: 'ANYSCALE_API_KEY',   agents: ['pi', 'claude_code', 'opencode', 'codex'] },
  { match: /replicate/i,   key: 'replicate',  label: 'Replicate',    openai: true,  env: 'REPLICATE_API_TOKEN', agents: ['pi', 'claude_code', 'opencode', 'codex'] },
  { match: /huggingface/i, key: 'huggingface', label: 'Hugging Face', openai: true, env: 'HF_API_TOKEN',       agents: ['pi', 'claude_code', 'opencode', 'codex'] },
  { match: /groq/i,        key: 'groq',       label: 'Groq',         openai: true,  env: 'GROQ_API_KEY',       agents: ['pi', 'claude_code', 'opencode', 'codex'] },
];
const DEFAULT_CAPABILITY = { key: 'custom', label: 'Custom', openai: true, env: 'API_KEY', agents: ['pi', 'claude_code', 'opencode', 'codex'] };

function getCapability(offer) {
  const hay = `${offer.base_url || ''} ${offer.provider || ''}`;
  for (const cap of PROVIDER_CAPABILITIES) {
    if (cap.match.test(hay)) return cap;
  }
  return DEFAULT_CAPABILITY;
}

// ── Versioned per agent connection templates (AC-6) ───────────────
// Connection instructions are derived here at build time, never stored in
// report.json. Bump the version when the template shapes change.
const AGENT_TEMPLATE_VERSION = '2026.07.1';
const AGENTS = [
  { id: 'pi',          label: 'pi' },
  { id: 'claude_code', label: 'Claude Code' },
  { id: 'opencode',    label: 'OpenCode' },
  { id: 'codex',       label: 'Codex' },
];

const AGENT_SNIPPETS = {
  pi: (o, cap) => `// .pi/settings.json
{
  "defaultProvider": "${cap.key}",
  "defaultModel": "${o.model_id}"
}

# 環境変数 (または pi 内で /login ${cap.key})
export ${cap.env}=xxxxxxxxxxxxxxxx`,
  claude_code: (o, cap) =>
    `# ~/.claude.json にカスタムプロバイダを追加
{
  "customApiProviders": [
    {
      "name": "${cap.label}",
      "baseURL": "${o.base_url}",
      "apiKeyEnvVar": "${cap.env}"
    }
  ]
}

# 起動
claude --model ${cap.key}/${o.model_id}`,
  opencode: (o, cap) => `// opencode.json
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
# opencode 起動後 → /connect ${cap.key} → キーを貼付`,
  codex: (o, cap) =>
    `# ~/.codex/config.toml
[model_providers.${cap.key}]
name = "${cap.label}"
base_url = "${o.base_url}"
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
  return v === 0 ? '$0' : `$${v}`;
}

function priceDisplay(o) {
  const price = o.effective_price_per_million || o.normal_price_per_million || {};
  const inP = fmtPrice(price.input);
  const outP = fmtPrice(price.output);
  const isFree = price.input === 0 && price.output === 0;
  const text = isFree ? '$0' : `${inP} / ${outP}`;
  return { text, isFree };
}

// ── Ranking (AC-3, AC-4) ──────────────────────────────────────────
// Admission gate: ranked_offers only, ranking_eligible === true, a valid
// benchmark (non null tier and score), tier in S/A/B. Conditional credits
// and offers without a benchmark never appear. No fixed card cap.
// Ordering: tier (S>A>B) → benchmark score DESC → freshness DESC → name.
// Performance is the primary axis; freshness breaks ties within a tier.
function selectRankedOffers(report) {
  const eligible = (report.ranked_offers || []).filter(o =>
    o.ranking_eligible === true &&
    o.benchmark &&
    o.benchmark.tier != null &&
    o.benchmark.score != null &&
    ADMITTED_TIERS.includes(o.benchmark.tier)
  );
  return eligible.sort((a, b) => {
    const at = TIER_RANK[a.benchmark.tier];
    const bt = TIER_RANK[b.benchmark.tier];
    if (at !== bt) return at - bt; // S before A before B
    const as = a.benchmark.score ?? 0;
    const bs = b.benchmark.score ?? 0;
    if (bs !== as) return bs - as; // higher score first
    const av = validTimestamp(a.last_verified) ? Date.parse(a.last_verified) : Number.NEGATIVE_INFINITY;
    const bv = validTimestamp(b.last_verified) ? Date.parse(b.last_verified) : Number.NEGATIVE_INFINITY;
    if (bv !== av) return bv - av; // freshness DESC, missing sorts last
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

// ── Component builders ────────────────────────────────────────────
function classBadge(o) {
  const b = CLASS_BADGE[o.classification] || { label: o.classification || '—', cls: 'badge-g' };
  return `<span class="badge ${b.cls}">${esc(b.label)}</span>`;
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
  return `<div class="stat">
      <div class="stat-label">ベンチマーク</div>
      <div class="stat-value"><span class="bench-tier ${cls}">${esc(tier)}</span><span class="bench-score">${esc(o.benchmark.score)}%</span></div>
      <div class="stat-sub">${esc(o.benchmark.benchmark_name)}</div>
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
    `<div class="bench-row"><span class="bench-name">${esc(b.name)}</span><span class="bench-val">${esc(b.score)}%</span></div>`
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
        <p class="acc-note">テンプレート版本 ${esc(AGENT_TEMPLATE_VERSION)} ・ Base URL と Model ID はこのカードの値から生成。APIキーはプレースホルダーです。</p>
        <div class="agent-grid">${blocks}</div>
      </div>
    </details>`;
}

function offerCard(o, index, generatedAt, tz) {
  const price = priceDisplay(o);
  const pos = String(index + 1).padStart(2, '0');
  return `<article class="offer-card reveal" aria-labelledby="offer-${index}">
    <div class="offer-inner">
      <div class="offer-pos" aria-hidden="true">
        <span class="pos-num">${pos}</span>
        <span class="pos-label">位</span>
      </div>
      <div class="offer-main">
        <div class="offer-badges">
          ${classBadge(o)}
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
          ${o.base_url ? `<div class="id-row"><span class="id-key">Base URL</span><code class="id-val">${esc(o.base_url)}</code></div>` : ''}
          ${o.model_id ? `<div class="id-row"><span class="id-key">Model ID</span><code class="id-val">${esc(o.model_id)}</code></div>` : ''}
          ${o.free_limits ? `<div class="id-row"><span class="id-key">リミット</span><span class="id-val-plain">${esc(o.free_limits)}</span></div>` : ''}
          ${o.end_at ? `<div class="id-row"><span class="id-key">期限</span><span class="id-val-plain train-yes">⏳ ${fmtDate(o.end_at, tz)}まで${o.end_timezone_known ? '' : ' (タイムゾーン不明)'}</span></div>` : ''}
          ${o.rate_limits ? `<div class="id-row"><span class="id-key">レート</span><span class="id-val-plain">${esc(o.rate_limits)}</span></div>` : ''}
          ${o.training_use ? `<div class="id-row"><span class="id-key">データ利用</span><span class="id-val-plain ${/なし|no/i.test(o.training_use) ? 'train-no' : 'train-yes'}">${esc(o.training_use)}</span></div>` : ''}
        </div>

        ${benchmarkDetailsBlock(o)}
        ${connectionAccordion(o)}

        <div class="offer-links">
          ${o.sources && o.sources[0] ? `<a class="btn btn-primary" href="${esc(o.sources[0])}" target="_blank" rel="noopener noreferrer">公式サイト <span aria-hidden="true">↗</span></a>` : ''}
        </div>
      </div>
    </div>
  </article>`;
}

function snapshotStrip(report, offers) {
  const total = offers.length;
  const sCount = offers.filter(o => o.benchmark && o.benchmark.tier === 'S').length;
  const freeCount = offers.filter(o => {
    const p = o.effective_price_per_million || {};
    return p.input === 0 && p.output === 0;
  }).length;
  const limitedCount = offers.filter(o => o.end_at).length;
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
  --badge-g: 0 72% 42%;
  --tier-s: 38 92% 36%;
  --tier-a: 217 91% 40%;
  --tier-b: 142 71% 32%;
}
.dark {
  --background: 240 10% 5%;
  --foreground: 0 0% 96%;
  --card: 240 8% 8%;
  --card-foreground: 0 0% 96%;
  --popover: 240 8% 8%;
  --popover-foreground: 0 0% 96%;
  --primary: 0 0% 96%;
  --primary-foreground: 240 10% 6%;
  --secondary: 240 5% 14%;
  --secondary-foreground: 0 0% 96%;
  --muted: 240 5% 14%;
  --muted-foreground: 240 5% 66%;
  --accent: 240 5% 14%;
  --accent-foreground: 0 0% 96%;
  --destructive: 0 62% 55%;
  --destructive-foreground: 0 0% 98%;
  --success: 142 60% 50%;
  --success-foreground: 240 10% 5%;
  --warning: 35 90% 58%;
  --warning-foreground: 240 10% 5%;
  --border: 240 5% 19%;
  --input: 240 5% 19%;
  --ring: 240 5% 70%;
  --badge-a: 142 71% 38%;
  --badge-b: 217 91% 46%;
  --badge-c: 32 95% 40%;
  --badge-d: 262 83% 52%;
  --badge-e: 25 95% 44%;
  --badge-f: 180 70% 32%;
  --badge-g: 0 72% 48%;
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
.badge-g { background-color: hsl(var(--badge-g)); }

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

/* Offer card. */
.offer-card {
  container: offer-card / inline-size;
  background: hsl(var(--card));
  border: 1px solid hsl(var(--border));
  border-radius: var(--radius);
  transition: border-color .2s ease, box-shadow .2s ease, transform .2s ease;
}
.offer-card:hover {
  border-color: hsl(var(--ring) / 0.45);
  box-shadow: 0 10px 30px hsl(var(--foreground) / 0.07);
  transform: translateY(-2px);
}
.offer-inner { display: flex; gap: 1.1rem; padding: 1.35rem 1.5rem; }
.offer-pos { flex-shrink: 0; text-align: center; min-width: 3.2rem; }
.pos-num {
  display: block; font-family: "Space Grotesk", sans-serif;
  font-size: 2.6rem; font-weight: 700; line-height: 1;
  color: hsl(var(--foreground) / 0.16);
}
.pos-label { font-size: 0.65rem; letter-spacing: 0.14em; color: hsl(var(--muted-foreground)); }
.offer-main { flex: 1; min-width: 0; }
.offer-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 0.45rem; margin-bottom: 0.6rem; }
.offer-name { font-family: "Space Grotesk", "Noto Sans JP", sans-serif; font-size: 1.35rem; font-weight: 700; line-height: 1.25; }
.offer-meta { font-size: 0.85rem; color: hsl(var(--muted-foreground)); margin-top: 0.15rem; }

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

.offer-links { margin-top: 1.1rem; }
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
.snap-num { font-family: "Space Grotesk", sans-serif; font-size: 2rem; font-weight: 700; line-height: 1; }
.snap-num-s { color: hsl(var(--tier-s)); }
.snap-num-free { color: hsl(var(--success)); }
.snap-label { font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; color: hsl(var(--muted-foreground)); }

/* Examples. */
/* Scroll reveal: visible by default (no-JS safe); the .js class, added by the
   early script, opts into the hidden-then-reveal animation as an enhancement. */
.reveal { opacity: 1; transform: none; }
.js .reveal { opacity: 0; transform: translateY(14px); transition: opacity .55s ease, transform .55s ease; }
.js .reveal.visible { opacity: 1; transform: none; }

/* Focus visibility. */
:focus-visible { outline: 2px solid hsl(var(--ring)); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  .js .reveal { opacity: 1 !important; transform: none !important; transition: none !important; }
  *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
}
`;

// ── Main HTML template ────────────────────────────────────────────
function generateHTML(report) {
  const generatedAt = report.generated_at || new Date().toISOString();
  const tz = report.timezone || 'Asia/Tokyo';
  const dateStr = fmtDate(generatedAt, tz);

  const offers = selectRankedOffers(report);
  const cards = offers.map((o, i) => offerCard(o, i, generatedAt, tz)).join('\n');
  const snapshot = snapshotStrip(report, offers);

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="description" content="無料・割引LLM API速報 — 検証済みの無料APIを性能と鮮度でランキング。pi, Claude Code, OpenCode, Codex向け接続方法も掲載。">
  <title>無料LLM API速報</title>
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

  <header class="sticky top-0 z-30 border-b bg-card/85 backdrop-blur">
    <div class="container mx-auto max-w-7xl px-4 py-3.5 flex items-center justify-between gap-4">
      <div class="flex items-center gap-3 min-w-0">
        <div class="w-9 h-9 rounded-lg bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="w-5 h-5"><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>
        </div>
        <div class="min-w-0">
          <h1 class="font-display text-lg sm:text-xl font-bold leading-tight truncate">無料LLM API速報</h1>
          <p class="text-[11px] text-muted-foreground tracking-widest uppercase">Free LLM API Intelligence ・ 毎日11:00 JST</p>
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
      <p class="text-sm text-muted-foreground mb-6">運用確認済み ・ ベンチマーク上位 (S/A/B) のみ掲載。<strong class="text-foreground">性能ティアとスコア</strong>で並び、同率内は情報の鮮度順。</p>
      <div class="grid grid-cols-1 gap-4 items-start lg:grid-cols-2">${cards}</div>
    </section>

    <footer class="border-t pt-8 pb-4 text-center text-sm text-muted-foreground">
      <p class="mb-2"><strong class="text-foreground">無料LLM API速報</strong> ・ 毎日11:00 JST自動更新</p>
      <p class="mb-2">データソース: 公式ブログ ・ 価格ページ ・ GitHub ・ Reddit 他</p>
      <p class="mb-4">
        <a href="https://github.com/free-api-news/free-api-news" target="_blank" rel="noopener noreferrer" class="underline hover:text-foreground transition-colors">GitHub リポジトリ</a>
        <span aria-hidden="true">·</span>
        <a href="https://github.com/free-api-news/free-api-news/issues" target="_blank" rel="noopener noreferrer" class="underline hover:text-foreground transition-colors">フィードバック</a>
      </p>
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
    console.error(`⚠️  入力ファイルが見つかりません: ${inputPath}`);
    console.error(`   フォールバック: ${INPUT_FALLBACK}`);
    try {
      raw = fs.readFileSync(INPUT_FALLBACK, 'utf8');
    } catch (e2) {
      console.error('   フォールバックも失敗しました。ダミーデータで生成します。');
      raw = JSON.stringify({
        generated_at: new Date().toISOString(),
        timezone: 'Asia/Tokyo',
        new_models: [],
        changes: [],
        ranked_offers: [],
        excluded_offers: [],
        sources: [],
      });
    }
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (e) {
    console.error('⚠️  JSONの解析に失敗しました。ダミーデータで生成します。');
    report = {
      generated_at: new Date().toISOString(),
      timezone: 'Asia/Tokyo',
      new_models: [],
      changes: [],
      ranked_offers: [],
      excluded_offers: [],
      sources: [],
    };
  }

  const html = generateHTML(report);
  fs.writeFileSync(outputPath, html, 'utf8');
  const ranked = selectRankedOffers(report);
  console.log(`✅ HTMLを生成しました: ${outputPath}`);
  console.log(`   入力: ${inputPath}`);
  console.log(`   レポート日時: ${report.generated_at || '不明'}`);
  console.log(`   掲載オファー: ${ranked.length} 件 (S/A/B ・ 鮮度順)`);
}

main();
