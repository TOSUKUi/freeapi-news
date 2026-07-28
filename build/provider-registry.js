/**
 * provider-registry.js
 *
 * Shared access to build/provider-registry.json — the single source of
 * truth for provider endpoints. Used by:
 *   - validate-report.js  (hard-fail on base_url that contradicts the registry)
 *   - build-html.js       (connection snippet generation)
 *
 * The collection skill also reads the JSON directly before writing any
 * base_url/model_id into report.json.
 */

const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, 'provider-registry.json');

function loadRegistry() {
  const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  return raw.providers || [];
}

/**
 * Match an offer against the registry.
 *
 * Returns { entry, byUrl }:
 *   - byUrl=true  : the offer's base_url matches the entry's official pattern
 *   - byUrl=false : matched only via provider/name substrings (base_url may
 *                   still be wrong — callers decide whether that is an error)
 *   - null        : no registry entry matches at all
 */
function matchProvider(offer, providers) {
  const baseUrl = offer.base_url || '';
  if (baseUrl) {
    for (const entry of providers) {
      try {
        if (new RegExp(entry.base_url_pattern).test(baseUrl)) {
          return { entry, byUrl: true };
        }
      } catch {
        // Invalid pattern in the registry: skip URL matching for this entry.
      }
    }
  }
  const hay = `${baseUrl} ${offer.provider || ''} ${offer.name || ''}`.toLowerCase();
  for (const entry of providers) {
    if ((entry.match || []).some((m) => hay.includes(String(m).toLowerCase()))) {
      return { entry, byUrl: false };
    }
  }
  return null;
}

module.exports = { REGISTRY_PATH, loadRegistry, matchProvider };
