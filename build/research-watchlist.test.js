'use strict';

// Tests for build/research-watchlist.js (spec 0008 D1). The watchlist is git
// tracked human managed configuration; the validator is the approval gate for
// watch:add. Every test that writes uses a temp file path; the seed file
// itself is only read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wl = require('./research-watchlist');

// A minimal valid document for mutation tests.
function seed() {
  return {
    version: 1,
    windows: { hot_days: 1, warm_days: 3, catchup_days: 30 },
    frontier_vendors: ['openai'],
    vendors: [
      {
        key: 'openai',
        label: 'OpenAI',
        tier: 1,
        channels: {
          blog: 'https://openai.com/news/',
          x: 'https://x.com/OpenAI',
          changelog: null,
          pricing: 'https://openai.com/api/pricing/',
          model_catalog: 'https://platform.openai.com/docs/models',
          hf_org: 'openai',
          github_orgs: [],
          event_page: null,
          banner_url: null,
        },
      },
    ],
    provider_monitors: [
      {
        provider_key: 'groq',
        watch: { new_models: 'https://groq.com/pricing' },
      },
    ],
    community: [
      {
        kind: 'reddit',
        subreddits: ['LocalLLaMA'],
        keywords: ['free'],
      },
      { kind: 'hn', queries: ['free LLM API'] },
      { kind: 'github', repos: ['openai/openai-python'], orgs: ['deepseek-ai'] },
    ],
    coding_products: [
      {
        key: 'claude_code',
        label: 'Claude Code',
        pricing_url: 'https://www.anthropic.com/pricing',
        changelog_url: 'https://docs.anthropic.com/en/release-notes',
      },
    ],
    credit_programs: [
      { key: 'google_for_startups', label: 'Google for Startups', url: 'https://cloud.google.com/startup' },
    ],
  };
}

function tmpWatchlist(data) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watchlist-test-')), 'research-watchlist.json');
  if (data) fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return file;
}

test('the committed seed watchlist validates and loads', () => {
  const data = wl.loadWatchlist(wl.WATCHLIST_PATH);
  assert.equal(data.version, 1);
  assert.ok(data.vendors.length >= 19, 'seed has the 19 spec vendors');
  assert.equal(data.frontier_vendors.length, 13);
  assert.ok(data.provider_monitors.length >= 25);
  assert.ok(data.coding_products.length >= 13);
  assert.ok(data.credit_programs.length >= 10);
});

test('validateWatchlist accepts a minimal valid document', () => {
  const check = wl.validateWatchlist(seed());
  assert.deepEqual(check.errors, []);
});

test('validateWatchlist rejects structural problems', () => {
  const cases = {
    'wrong version': () => { const d = seed(); d.version = 2; return d; },
    'bad windows': () => { const d = seed(); d.windows.hot_days = 0; return d; },
    'frontier key without vendor': () => { const d = seed(); d.frontier_vendors = ['openai', 'nosuch']; return d; },
    'duplicate vendor key': () => {
      const d = seed();
      d.vendors.push({ ...d.vendors[0] });
      return d;
    },
    'non http channel url': () => {
      const d = seed();
      d.vendors[0].channels.blog = 'not-a-url';
      return d;
    },
    'unknown channel key': () => {
      const d = seed();
      d.vendors[0].channels.foo = 'https://example.com';
      return d;
    },
    'hf org with slash': () => {
      const d = seed();
      d.vendors[0].channels.hf_org = 'openai/extra';
      return d;
    },
    'github orgs not a list of bare names': () => {
      const d = seed();
      d.vendors[0].channels.github_orgs = ['deepseek-ai/repo'];
      return d;
    },
    'empty provider monitor watch': () => {
      const d = seed();
      d.provider_monitors[0].watch = {};
      return d;
    },
    'non http provider monitor url': () => {
      const d = seed();
      d.provider_monitors[0].watch = { new_models: 'ftp://nope' };
      return d;
    },
    'duplicate provider monitor key': () => {
      const d = seed();
      d.provider_monitors.push({ ...d.provider_monitors[0] });
      return d;
    },
    'bad community kind': () => {
      const d = seed();
      d.community[0].kind = 'mastodon';
      return d;
    },
    'reddit without subreddits': () => {
      const d = seed();
      delete d.community[0].subreddits;
      return d;
    },
    'hn without queries': () => {
      const d = seed();
      delete d.community[1].queries;
      return d;
    },
    'github without repos and orgs': () => {
      const d = seed();
      d.community[2] = { kind: 'github' };
      return d;
    },
    'coding product without pricing url': () => {
      const d = seed();
      d.coding_products[0].pricing_url = null;
      return d;
    },
    'credit program without url': () => {
      const d = seed();
      d.credit_programs[0].url = null;
      return d;
    },
    'empty vendors': () => { const d = seed(); d.vendors = []; return d; },
  };
  for (const [name, make] of Object.entries(cases)) {
    const check = wl.validateWatchlist(make());
    assert.equal(check.ok, false, `${name} should fail`);
    assert.ok(check.errors.length > 0, `${name} reports an error`);
  }
});

test('addEntry appends a new entry and replaces an existing one by key', () => {
  const data = seed();
  const added = wl.addEntry(data, 'credit_programs', {
    key: 'aws_activate',
    label: 'AWS Activate',
    url: 'https://aws.amazon.com/startups/',
  });
  assert.equal(added.credit_programs.length, 2);

  const replaced = wl.addEntry(data, 'provider_monitors', {
    provider_key: 'groq',
    watch: { new_models: 'https://groq.com/pricing', changelog: 'https://groq.com/blog' },
  });
  assert.equal(replaced.provider_monitors.length, 1);
  assert.deepEqual(replaced.provider_monitors[0].watch, {
    new_models: 'https://groq.com/pricing',
    changelog: 'https://groq.com/blog',
  });

  // vendor entries use key; community entries use kind
  const vendor = wl.addEntry(data, 'vendors', {
    key: 'xai',
    label: 'xAI',
    tier: 1,
    channels: { blog: 'https://x.ai/news' },
  });
  assert.equal(vendor.vendors.length, 2);
  // the original document is not mutated
  assert.equal(data.credit_programs.length, 1);
  assert.equal(data.vendors.length, 1);
});

test('addEntry rejects invalid results without mutating the input', () => {
  const data = seed();
  assert.throws(
    () => wl.addEntry(data, 'vendors', { key: 'bad', label: 'Bad', tier: 1, channels: { blog: 'nope' } }),
    /invalid after add/
  );
  assert.equal(data.vendors.length, 1);
  assert.throws(() => wl.addEntry(data, 'windows', { hot_days: 1 }), /domain/);
  assert.throws(() => wl.addEntry(data, 'frontier_vendors', { key: 'x' }), /domain/);
});

test('removeEntry removes by key and guards frontier listed vendors', () => {
  const data = seed();
  const removed = wl.removeEntry(data, 'credit_programs', 'google_for_startups');
  assert.equal(removed.credit_programs.length, 0);

  assert.throws(() => wl.removeEntry(data, 'credit_programs', 'nosuch'), /no entry/);
  assert.throws(
    () => wl.removeEntry(data, 'vendors', 'openai'),
    /frontier_vendors/
  );
});

test('writeWatchlist writes atomically and validates on write', () => {
  const file = tmpWatchlist();
  wl.writeWatchlist(seed(), file);
  const loaded = wl.loadWatchlist(file);
  assert.equal(loaded.version, 1);
  assert.throws(() => wl.writeWatchlist({ version: 99 }, file), /invalid watchlist/);
  // the bad write left the good file intact
  assert.equal(wl.loadWatchlist(file).version, 1);
  const litter = fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(litter, [], 'no temp litter');
});

test('loadWatchlist throws with all validation errors on a broken file', () => {
  const file = tmpWatchlist({ version: 1 });
  assert.throws(() => wl.loadWatchlist(file), /invalid research watchlist/);
});
