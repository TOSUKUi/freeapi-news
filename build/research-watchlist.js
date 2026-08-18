'use strict';

// research-watchlist.js
//
// Shared access to build/research-watchlist.json (spec 0008 D1). The
// watchlist is human managed, git tracked configuration, exactly like
// provider-registry.json. It is NOT operational state, so it never lives in
// SQLite (spec 0007 lesson: pooled config in the DB became its own workload).
//
// The deterministic triage module (.devops/db/watch.js) reads this file every
// run. Operators edit it through the CLI (npm run watch:list/add/remove) so
// changes land as reviewable git diffs; watch:add is also the approval flow
// for new sources the discovery lanes propose.

const fs = require('fs');
const path = require('path');

const WATCHLIST_PATH = path.join(__dirname, 'research-watchlist.json');

const WATCHLIST_VERSION = 1;

const CHANNEL_KEYS = [
  'blog', 'x', 'changelog', 'pricing', 'model_catalog',
  'hf_org', 'github_orgs', 'event_page', 'banner_url',
];

const DOMAIN_KEYS = [
  'frontier_vendors', 'vendors', 'provider_monitors',
  'community', 'coding_products', 'credit_programs',
];

const VENDOR_TIERS = [1, 2, 3];
const COMMUNITY_KINDS = ['reddit', 'hn', 'github'];
const PROGRAM_KEYS = ['max_credit', 'currency', 'eligibility', 'deadline', 'usable_services', 'prepaid_conditions', 'terms_text'];

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//.test(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIdentifier(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value);
}

// Validates one channel object. All channel values are null or http(s)
// pointers; hf_org is a bare Hugging Face org name; github_orgs is a list of
// bare GitHub org names. Workers search and open these; the deterministic
// triage fetches the JSON API forms derived from them.
function validateChannels(channels, label, errors) {
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    errors.push(`${label}.channels must be an object`);
    return;
  }
  for (const key of Object.keys(channels)) {
    if (!CHANNEL_KEYS.includes(key)) {
      errors.push(`${label}.channels has unknown key "${key}" (allowed: ${CHANNEL_KEYS.join(', ')})`);
    }
  }
  for (const key of ['blog', 'x', 'changelog', 'pricing', 'model_catalog', 'event_page', 'banner_url']) {
    const value = channels[key];
    if (value !== null && value !== undefined && !isHttpUrl(value)) {
      errors.push(`${label}.channels.${key} must be null or an http(s) url`);
    }
  }
  const hfOrg = channels.hf_org;
  if (hfOrg !== null && hfOrg !== undefined) {
    if (!isNonEmptyString(hfOrg) || /[/\s]/.test(hfOrg)) {
      errors.push(`${label}.channels.hf_org must be null or a bare hugging face org name`);
    }
  }
  const orgs = channels.github_orgs;
  if (orgs !== null && orgs !== undefined) {
    if (!Array.isArray(orgs) || orgs.some((o) => !isNonEmptyString(o) || /[/\s]/.test(o))) {
      errors.push(`${label}.channels.github_orgs must be null or an array of bare github org names`);
    }
  }
}

// Validates the whole watchlist document. Returns { ok, errors }.
function validateWatchlist(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: ['watchlist is not a JSON object'] };
  }
  if (data.version !== WATCHLIST_VERSION) {
    errors.push(`watchlist version must be ${WATCHLIST_VERSION}, got ${JSON.stringify(data.version)}`);
  }

  const windows = data.windows;
  if (!windows || typeof windows !== 'object') {
    errors.push('windows must be an object');
  } else {
    for (const key of ['hot_days', 'warm_days', 'catchup_days']) {
      const value = windows[key];
      if (!Number.isInteger(value) || value < 1 || value > 365) {
        errors.push(`windows.${key} must be an integer from 1 to 365`);
      }
    }
  }

  const frontier = data.frontier_vendors;
  if (!Array.isArray(frontier) || frontier.some((v) => !isIdentifier(v))) {
    errors.push('frontier_vendors must be an array of lowercase identifier keys');
  }

  const vendorKeys = new Set();
  if (!Array.isArray(data.vendors) || data.vendors.length === 0) {
    errors.push('vendors must be a non empty array');
  } else {
    for (const [i, vendor] of data.vendors.entries()) {
      const label = `vendors[${i}]`;
      if (!vendor || typeof vendor !== 'object') {
        errors.push(`${label} must be an object`);
        continue;
      }
      if (!isIdentifier(vendor.key)) {
        errors.push(`${label}.key must be a lowercase identifier`);
      } else if (vendorKeys.has(vendor.key)) {
        errors.push(`${label}.key "${vendor.key}" is duplicated`);
      } else {
        vendorKeys.add(vendor.key);
      }
      if (!isNonEmptyString(vendor.label)) {
        errors.push(`${label}.label must be a non empty string`);
      }
      if (!VENDOR_TIERS.includes(vendor.tier)) {
        errors.push(`${label}.tier must be one of ${VENDOR_TIERS.join(', ')}`);
      }
      validateChannels(vendor.channels, label, errors);
    }
  }

  if (Array.isArray(frontier)) {
    for (const key of frontier) {
      if (!vendorKeys.has(key)) {
        errors.push(`frontier_vendors key "${key}" has no matching vendors entry`);
      }
    }
  }

  if (!Array.isArray(data.provider_monitors)) {
    errors.push('provider_monitors must be an array');
  } else {
    const monitorKeys = new Set();
    for (const [i, monitor] of data.provider_monitors.entries()) {
      const label = `provider_monitors[${i}]`;
      if (!monitor || typeof monitor !== 'object') {
        errors.push(`${label} must be an object`);
        continue;
      }
      if (!isIdentifier(monitor.provider_key)) {
        errors.push(`${label}.provider_key must be a lowercase identifier`);
      } else if (monitorKeys.has(monitor.provider_key)) {
        errors.push(`${label}.provider_key "${monitor.provider_key}" is duplicated`);
      } else {
        monitorKeys.add(monitor.provider_key);
      }
      const watch = monitor.watch;
      if (!watch || typeof watch !== 'object' || Object.keys(watch).length === 0) {
        errors.push(`${label}.watch must be a non empty object of url keys`);
      } else {
        for (const [key, value] of Object.entries(watch)) {
          if (!isHttpUrl(value)) {
            errors.push(`${label}.watch.${key} must be an http(s) url`);
          }
        }
      }
    }
  }

  if (!Array.isArray(data.community)) {
    errors.push('community must be an array');
  } else {
    for (const [i, entry] of data.community.entries()) {
      const label = `community[${i}]`;
      if (!entry || typeof entry !== 'object') {
        errors.push(`${label} must be an object`);
        continue;
      }
      if (!COMMUNITY_KINDS.includes(entry.kind)) {
        errors.push(`${label}.kind must be one of ${COMMUNITY_KINDS.join(', ')}`);
      }
      if (entry.kind === 'reddit' && (!Array.isArray(entry.subreddits) || entry.subreddits.length === 0)) {
        errors.push(`${label}.subreddits must be a non empty array`);
      }
      if (entry.kind === 'hn' && (!Array.isArray(entry.queries) || entry.queries.length === 0)) {
        errors.push(`${label}.queries must be a non empty array`);
      }
      if (entry.kind === 'github') {
        if (!Array.isArray(entry.repos) || !Array.isArray(entry.orgs)) {
          errors.push(`${label} requires repos[] and orgs[] arrays`);
        }
      }
      if (entry.keywords !== undefined && !Array.isArray(entry.keywords)) {
        errors.push(`${label}.keywords must be an array`);
      }
    }
  }

  for (const domain of ['coding_products', 'credit_programs']) {
    if (!Array.isArray(data[domain])) {
      errors.push(`${domain} must be an array`);
      continue;
    }
    for (const [i, entry] of data[domain].entries()) {
      const label = `${domain}[${i}]`;
      if (!entry || typeof entry !== 'object') {
        errors.push(`${label} must be an object`);
        continue;
      }
      if (!isIdentifier(entry.key)) {
        errors.push(`${label}.key must be a lowercase identifier`);
      }
      if (!isNonEmptyString(entry.label)) {
        errors.push(`${label}.label must be a non empty string`);
      }
      if (domain === 'coding_products') {
        if (!isHttpUrl(entry.pricing_url)) {
          errors.push(`${label}.pricing_url must be an http(s) url`);
        }
        if (entry.changelog_url !== undefined && entry.changelog_url !== null && !isHttpUrl(entry.changelog_url)) {
          errors.push(`${label}.changelog_url must be null or an http(s) url`);
        }
      } else {
        if (!isHttpUrl(entry.url)) {
          errors.push(`${label}.url must be an http(s) url`);
        }
        for (const key of PROGRAM_KEYS) {
          if (entry[key] !== undefined && entry[key] !== null && !isNonEmptyString(entry[key])) {
            errors.push(`${label}.${key} must be null or a non empty string`);
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// Loads and validates the watchlist from disk. Throws on any validation
// error so a broken config fails the run loudly instead of silently
// shrinking the watch.
function loadWatchlist(watchlistPath = WATCHLIST_PATH) {
  const raw = fs.readFileSync(watchlistPath, 'utf8');
  const data = JSON.parse(raw);
  const check = validateWatchlist(data);
  if (!check.ok) {
    throw new Error(`invalid research watchlist at ${watchlistPath}:\n  ${check.errors.join('\n  ')}`);
  }
  return data;
}

// Adds or replaces one entry in a domain list. The whole document is
// revalidated before anything is written, so a bad add can never corrupt the
// file. Returns the new document.
function addEntry(data, domain, entry) {
  if (!DOMAIN_KEYS.includes(domain) || domain === 'frontier_vendors' || domain === 'windows') {
    throw new Error(`watch:add domain must be one of vendors, provider_monitors, community, coding_products, credit_programs`);
  }
  if (!Array.isArray(data[domain])) {
    throw new Error(`domain ${domain} is not a list in this watchlist`);
  }
  const keyOf = (item) => (item && item.key) || (item && item.provider_key) || (item && item.kind);
  const key = keyOf(entry);
  if (!isIdentifier(key)) {
    throw new Error('entry requires a lowercase identifier key (or provider_key / kind)');
  }
  const next = {
    ...data,
    [domain]: data[domain].map((item) => (keyOf(item) === key ? entry : item)),
  };
  if (!data[domain].some((item) => keyOf(item) === key)) {
    next[domain] = [...data[domain], entry];
  }
  const check = validateWatchlist(next);
  if (!check.ok) {
    throw new Error(`watchlist invalid after add:\n  ${check.errors.join('\n  ')}`);
  }
  return next;
}

// Removes one entry from a domain list by key. Returns the new document.
function removeEntry(data, domain, key) {
  if (!DOMAIN_KEYS.includes(domain) || domain === 'frontier_vendors' || domain === 'windows') {
    throw new Error(`watch:remove domain must be one of vendors, provider_monitors, community, coding_products, credit_programs`);
  }
  const list = data[domain];
  if (!Array.isArray(list)) {
    throw new Error(`domain ${domain} is not a list in this watchlist`);
  }
  const keyOf = (item) => (item && item.key) || (item && item.provider_key) || (item && item.kind);
  const before = list.length;
  const next = { ...data, [domain]: list.filter((item) => keyOf(item) !== key) };
  if (next[domain].length === before) {
    throw new Error(`no entry with key "${key}" in ${domain}`);
  }
  if (domain === 'vendors' && Array.isArray(data.frontier_vendors) && data.frontier_vendors.includes(key)) {
    throw new Error(`vendor "${key}" is listed in frontier_vendors; remove it there first`);
  }
  const check = validateWatchlist(next);
  if (!check.ok) {
    throw new Error(`watchlist invalid after remove:\n  ${check.errors.join('\n  ')}`);
  }
  return next;
}

// Atomic write: temp file in the same directory plus rename.
function writeWatchlist(data, watchlistPath = WATCHLIST_PATH) {
  const check = validateWatchlist(data);
  if (!check.ok) {
    throw new Error(`refusing to write invalid watchlist:\n  ${check.errors.join('\n  ')}`);
  }
  const temp = `${watchlistPath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(temp, watchlistPath);
}

module.exports = {
  WATCHLIST_PATH,
  WATCHLIST_VERSION,
  CHANNEL_KEYS,
  DOMAIN_KEYS,
  validateWatchlist,
  loadWatchlist,
  addEntry,
  removeEntry,
  writeWatchlist,
};
