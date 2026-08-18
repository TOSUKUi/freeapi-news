#!/usr/bin/env node
'use strict';

// One time Phase 0 helper (spec 0008): fetch-verifies every URL in
// build/research-watchlist.json. Prints a status table; does not modify the
// file. Operator reviews the table and fixes or nulls failing channels.

const https = require('node:https');
const http = require('node:http');

const { loadWatchlist } = require('../../build/research-watchlist');

function fetchUrl(url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; free-api-news-watchlist-verify/1.0)',
        Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
      },
    }, (res) => {
      const status = res.statusCode;
      res.resume();
      if ([301, 302, 307, 308].includes(status) && res.headers.location) {
        resolve({ status, redirect: new URL(res.headers.location, url).toString() });
      } else {
        resolve({ status });
      }
    });
    req.on('error', (err) => resolve({ status: `ERR:${err.code || err.message}` }));
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

async function main() {
  const watchlist = loadWatchlist();
  const rows = [];
  const push = (domain, key, url, status) => rows.push({ domain, key, url, status: String(status) });

  const jobs = [];
  for (const vendor of watchlist.vendors) {
    const c = vendor.channels || {};
    for (const ch of ['blog', 'x', 'changelog', 'pricing', 'model_catalog', 'event_page', 'banner_url']) {
      if (c[ch]) jobs.push(fetchUrl(c[ch]).then((r) => push(`vendor:${vendor.key}`, ch, c[ch], r.status + (r.redirect ? ` -> ${r.redirect}` : ''))));
    }
    if (c.hf_org) jobs.push(fetchUrl(`https://huggingface.co/api/models?author=${c.hf_org}&limit=1`).then((r) => push(`vendor:${vendor.key}`, `hf_org:${c.hf_org}`, '', r.status)));
    for (const org of c.github_orgs || []) jobs.push(fetchUrl(`https://api.github.com/orgs/${org}`).then((r) => push(`vendor:${vendor.key}`, `github_org:${org}`, '', r.status)));
  }
  for (const monitor of watchlist.provider_monitors) {
    for (const [ch, url] of Object.entries(monitor.watch || {})) {
      if (String(url).includes('{')) { push(`monitor:${monitor.provider_key}`, ch, url, 'template (skipped)'); continue; }
      jobs.push(fetchUrl(url).then((r) => push(`monitor:${monitor.provider_key}`, ch, url, r.status + (r.redirect ? ` -> ${r.redirect}` : ''))));
    }
  }
  for (const product of watchlist.coding_products) {
    jobs.push(fetchUrl(product.pricing_url).then((r) => push(`product:${product.key}`, 'pricing', product.pricing_url, r.status + (r.redirect ? ` -> ${r.redirect}` : ''))));
    if (product.changelog_url) jobs.push(fetchUrl(product.changelog_url).then((r) => push(`product:${product.key}`, 'changelog', product.changelog_url, r.status + (r.redirect ? ` -> ${r.redirect}` : ''))));
  }
  for (const program of watchlist.credit_programs) {
    jobs.push(fetchUrl(program.url).then((r) => push(`program:${program.key}`, 'url', program.url, r.status + (r.redirect ? ` -> ${r.redirect}` : ''))));
  }

  // concurrency 8
  let next = 0;
  async function lane() {
    while (next < jobs.length) {
      const i = next;
      next += 1;
      await jobs[i];
    }
  }
  await Promise.all(Array.from({ length: 8 }, lane));

  rows.sort((a, b) => a.domain.localeCompare(b.domain) || a.key.localeCompare(b.key));
  const failures = rows.filter((r) => !/^(2|3)/.test(r.status) && !r.status.startsWith('template'));
  console.log(`total=${rows.length} failures=${failures.length}\n`);
  for (const r of rows) {
    const bad = !/^(2|3)/.test(r.status) && !r.status.startsWith('template') ? '  ❌' : '  ✅';
    console.log(`${bad} ${r.domain}  ${r.key}  ${r.status}  ${r.url}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
