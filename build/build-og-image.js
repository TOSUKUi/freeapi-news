#!/usr/bin/env node
/* build/build-og-image.js
 *
 * Generates the Open Graph / Twitter Card preview image (og-image.png) from
 * report.json so the share card is *data-driven*: it carries today's date,
 * the live snapshot counts, and the current #1 offer. A stale-looking card
 * kills click-through on a "daily intel" site, so the image is rebuilt every
 * batch alongside index.html.
 *
 * Pipeline:
 *   1. Read report.json + reuse the site's design tokens (TOKEN_CSS) and the
 *      ranking/snapshot helpers from build-html.js — tokens stay the single
 *      source of truth (AGENTS.md: 色はトークンを唯一の真実源).
 *   2. Emit a self-contained 1200x630 HTML page (og-image.html, dark palette).
 *   3. Render it to og-image.png with headless Chrome at 2x for retina cards.
 *
 * The intermediate og-image.html is gitignored; only og-image.png is served.
 * If no Chrome binary is found the render is skipped with a warning (exit 0)
 * so `npm run build` still succeeds on machines without a browser — the last
 * committed og-image.png keeps serving. A real Chrome failure exits non-zero.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const {
  selectRankedOffers,
  computeSnapshot,
  dayKeyInTz,
  TOKEN_CSS,
} = require('./build-html.js');

const ROOT = path.resolve(__dirname, '..');
const SITE_URL = 'https://freeapi-news.tosukui.xyz/';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The brand glyph (broadcast / radio waves) — same mark as the site header.
const BRAND_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="2.2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>`;

function statCell(num, label, colorVar) {
  const color = colorVar ? `hsl(var(${colorVar}))` : 'hsl(var(--foreground))';
  return `<div class="stat">
      <span class="stat-num" style="color:${color}">${esc(num)}</span>
      <span class="stat-label">${esc(label)}</span>
    </div>`;
}

function buildOgHTML(report) {
  const tz = report.timezone || 'Asia/Tokyo';
  const offers = selectRankedOffers(report);
  const snap = computeSnapshot(report, offers);
  const dateKey = dayKeyInTz(report.generated_at, tz); // YYYY-MM-DD in JST
  const top = offers[0];
  const topName = top ? top.name : null;
  const topTier = top && top.benchmark ? top.benchmark.tier : null;

  const rankLine = topName
    ? `<div class="rankline">
        <span class="rank-badge"${topTier ? ` data-tier="${esc(topTier)}"` : ''}>1</span>
        <span class="rank-text">本日の1位&nbsp;&nbsp;<strong>${esc(topName)}</strong></span>
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="ja" class="dark">
<head>
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Noto+Sans+JP:wght@500;700&family=JetBrains+Mono:wght@500&display=swap" rel="stylesheet">
<style>
${TOKEN_CSS}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { width: 1200px; height: 630px; overflow: hidden; }
body {
  font-family: "Noto Sans JP", system-ui, sans-serif;
  color: hsl(var(--foreground));
  background-color: hsl(var(--background));
  position: relative;
}
/* Layered ambient field — same language as the site's .bg-texture, plus a
   warm gold bloom so the card reads as "live signal" on a feed. */
.bg {
  position: absolute; inset: 0;
  background:
    radial-gradient(circle at 86% 12%, hsl(var(--tier-s) / 0.18), transparent 42%),
    radial-gradient(circle at 8% 96%, hsl(var(--tier-a) / 0.12), transparent 46%),
    radial-gradient(ellipse 92% 60% at 50% -14%, hsl(var(--ring) / 0.12), transparent 64%),
    radial-gradient(hsl(var(--foreground) / 0.05) 1px, transparent 1px);
  background-size: auto, auto, auto, 22px 22px;
}
/* Oversized brand glyph, barely there, anchors the right side. */
.watermark {
  position: absolute; right: -54px; bottom: -64px;
  width: 360px; height: 360px; color: hsl(var(--foreground));
  opacity: 0.045;
}
.frame {
  position: absolute; inset: 0;
  padding: 50px 64px 46px;
  display: flex; flex-direction: column; justify-content: space-between;
}
/* ── top lockup ─────────────────────────────────────────── */
.top { display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.brand { display: flex; align-items: center; gap: 14px; }
.brand-mark {
  width: 46px; height: 46px; border-radius: 13px; flex: none;
  display: flex; align-items: center; justify-content: center;
  color: hsl(240 10% 5%);
  background: linear-gradient(140deg, hsl(var(--tier-s)), hsl(28 95% 50%));
  box-shadow: 0 6px 22px hsl(var(--tier-s) / 0.32);
}
.brand-mark svg { width: 25px; height: 25px; }
.brand-url {
  font-family: "JetBrains Mono", monospace; font-size: 15px; font-weight: 500;
  letter-spacing: 0.02em; color: hsl(var(--muted-foreground));
}
.date-chip {
  display: inline-flex; align-items: center; gap: 10px;
  padding: 9px 16px; border-radius: 999px;
  background: hsl(var(--card) / 0.7);
  border: 1px solid hsl(var(--border));
  font-size: 14px; color: hsl(var(--muted-foreground));
  white-space: nowrap;
}
.date-chip .dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: hsl(var(--success));
  box-shadow: 0 0 0 4px hsl(var(--success) / 0.18);
}
.date-chip strong { color: hsl(var(--foreground)); font-weight: 700; }
.date-chip .sep { opacity: 0.5; }
/* ── hero ───────────────────────────────────────────────── */
.hero { padding: 4px 0; }
.eyebrow {
  font-family: "Space Grotesk", sans-serif; font-weight: 600;
  font-size: 16px; letter-spacing: 0.34em; text-transform: uppercase;
  color: hsl(var(--tier-s)); margin-bottom: 16px;
}
.title {
  font-weight: 700; font-size: 90px; line-height: 1.02;
  letter-spacing: -0.01em; color: hsl(var(--foreground));
}
.sub {
  margin-top: 18px; font-size: 25px; font-weight: 500; line-height: 1.4;
  color: hsl(var(--muted-foreground));
}
.sub b { color: hsl(var(--foreground)); font-weight: 700; }
.rankline { display: flex; align-items: center; gap: 12px; margin-top: 22px; }
.rank-badge {
  width: 30px; height: 30px; border-radius: 9px; flex: none;
  display: flex; align-items: center; justify-content: center;
  font-family: "Space Grotesk", sans-serif; font-weight: 700; font-size: 16px;
  color: hsl(240 10% 5%); background: hsl(var(--foreground));
}
.rank-badge[data-tier="S"] { background: hsl(var(--tier-s)); }
.rank-badge[data-tier="A"] { background: hsl(var(--tier-a)); color: #fff; }
.rank-badge[data-tier="B"] { background: hsl(var(--tier-b)); color: #fff; }
.rank-text { font-size: 18px; color: hsl(var(--muted-foreground)); }
.rank-text strong { color: hsl(var(--foreground)); font-weight: 700; }
/* ── bottom snapshot strip (mirrors the site's snapshot) ── */
.strip {
  display: grid; grid-template-columns: repeat(4, 1fr);
  border-top: 1px solid hsl(var(--border)); padding-top: 22px;
}
.stat { padding: 0 4px 0 26px; border-left: 1px solid hsl(var(--border)); display: flex; flex-direction: column; gap: 4px; }
.stat:first-child { border-left: none; padding-left: 0; }
.stat-num { font-family: "Space Grotesk", sans-serif; font-weight: 700; font-size: 46px; line-height: 1; }
.stat-label { font-size: 14px; letter-spacing: 0.04em; color: hsl(var(--muted-foreground)); }
</style>
</head>
<body>
  <div class="bg"></div>
  <div class="watermark" aria-hidden="true">${BRAND_SVG}</div>
  <div class="frame">
    <div class="top">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true">${BRAND_SVG}</span>
        <span class="brand-url">freeapi-news.tosukui.xyz</span>
      </div>
      <div class="date-chip">
        <span class="dot" aria-hidden="true"></span>
        <strong>${esc(dateKey)}</strong>&nbsp;更新
        <span class="sep">・</span>毎日 11:00 JST
      </div>
    </div>

    <div class="hero">
      <div class="eyebrow">Free LLM API Intelligence</div>
      <h1 class="title">無料LLM API速報</h1>
      <p class="sub">検証済み無料APIを <b>性能 × 鮮度</b> でランキング</p>
      ${rankLine}
    </div>

    <div class="strip">
      ${statCell(snap.total, '掲載オファー', null)}
      ${statCell(snap.sCount, 'S ティア', '--tier-s')}
      ${statCell(snap.freeCount, '完全無料', '--success')}
      ${statCell(snap.limitedCount, '期限付き', null)}
    </div>
  </div>
</body>
</html>`;
}

function findChrome() {
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
    const r = spawnSync('command', ['-v', bin], { shell: true, encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  return null;
}

function render(htmlPath, pngPath) {
  if (!path.isAbsolute(htmlPath)) {
    console.error('❌ OGP レンダラの htmlPath は絶対パスである必要があります:', htmlPath);
    process.exit(1);
  }
  const chrome = findChrome();
  if (!chrome) {
    console.warn('⚠️  Chrome が見つからないため OGP 画像のレンダリングをスキップします。');
    console.warn('    既存の og-image.png があればそのまま配信されます。');
    return false;
  }
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--force-device-scale-factor=2', '--window-size=1200,630',
    '--default-background-color=00000000',
    '--run-all-compositor-stages-before-draw',
    '--virtual-time-budget=10000',
    `--screenshot=${pngPath}`,
    `file://${htmlPath}`,
  ];
  const r = spawnSync(chrome, args, { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(pngPath)) {
    console.error('❌ OGP 画像のレンダリングに失敗しました。');
    if (r.stderr) console.error(r.stderr.trim());
    process.exit(1);
  }
  return true;
}

function main() {
  let inputPath = process.argv[2] || path.join(ROOT, 'report.json');
  let htmlPath = process.argv[3] || path.join(ROOT, 'og-image.html');
  let pngPath = process.argv[4] || path.join(ROOT, 'og-image.png');

  // Resolve every path against the project root so the file:// URL is always
  // absolute. A relative path (e.g. when called via `npm run build`) yields an
  // invalid `file://og-image.html` URL and Chrome screenshots its error page.
  inputPath = path.resolve(ROOT, inputPath);
  htmlPath = path.resolve(ROOT, htmlPath);
  pngPath = path.resolve(ROOT, pngPath);

  const raw = fs.readFileSync(inputPath, 'utf8');
  const report = JSON.parse(raw);

  const html = buildOgHTML(report);
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html, 'utf8');

  const ok = render(htmlPath, pngPath);
  const offers = selectRankedOffers(report);
  const snap = computeSnapshot(report, offers);
  console.log(`✅ OGP HTMLを生成しました: ${path.relative(ROOT, htmlPath)}`);
  if (ok) {
    const kb = (fs.statSync(pngPath).size / 1024).toFixed(1);
    console.log(`✅ OGP 画像を生成しました: ${path.relative(ROOT, pngPath)} (2400x1260, ${kb} KB)`);
  }
  console.log(`   更新日: ${dayKeyInTz(report.generated_at, report.timezone || 'Asia/Tokyo')} ・ 掲載 ${snap.total} / S ${snap.sCount} / 無料 ${snap.freeCount}`);
}

if (require.main === module) main();

module.exports = { buildOgHTML };
