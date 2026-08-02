'use strict';

// One time legacy state import at cutover (spec 0003, build plan step 7:
// "Import the current tracked operational JSON once"). Reads the old tracked
// operational JSON (known_offers.json and benchmarks.json) and populates the
// SQLite offers and benchmarks tables, preserving curated state across the
// direct replacement. Run once; the JSON files are removed afterwards.
//
// source_cache is deliberately NOT imported: AC-16 records only URLs this
// system actually fetched with a real content hash, and the cache rebuilds
// itself on the next run. Importing stale entries with fabricated hashes
// would violate that provenance rule.

const fs = require('node:fs');
const path = require('node:path');

const db = require('./collector-db');

function nowIso() {
  return new Date().toISOString();
}

function importLegacyState(options = {}) {
  const paths = db.resolvePaths(options);
  const legacyDir = options.legacyDir
    ? path.resolve(options.legacyDir)
    : paths.stateDir;
  const knownPath = path.join(legacyDir, 'known_offers.json');
  const benchPath = path.join(legacyDir, 'benchmarks.json');

  if (!fs.existsSync(knownPath) && !fs.existsSync(benchPath)) {
    throw new Error(
      `no legacy state found in ${legacyDir} `
      + '(expected known_offers.json and/or benchmarks.json)'
    );
  }

  db.applyMigrations(options);
  const providers = db.loadProviderRegistry(paths.registryPath);

  const summary = {
    legacyDir,
    offersImported: 0,
    offersSkipped: 0,
    benchmarksImported: 0,
    benchmarksExisting: 0,
    benchmarksInvalid: 0,
  };

  const fallbackTime = nowIso();
  const database = db.openDatabaseFile(paths.dbPath);
  try {
    const existing = database.prepare('SELECT COUNT(*) AS c FROM offers').get();
    if (existing.c > 0 && !options.force) {
      throw new Error(
        'import-legacy refuses to run against a non empty offers table '
        + `(found ${existing.c} offers). This is a one time cutover import. `
        + 'Pass force to merge legacy rows anyway.'
      );
    }

    const upsertOffer = database.prepare(db.buildOfferUpsertSql(
      ', ' +
      '  canonical_model_id = excluded.canonical_model_id,' +
      '  source_kind = excluded.source_kind,' +
      '  last_seen_run_id = excluded.last_seen_run_id,' +
      '  pricing_hash = excluded.pricing_hash,' +
      '  removal_evidence_json = excluded.removal_evidence_json'
    ));
    const insertBenchmark = database.prepare(
      'INSERT INTO benchmarks ('
      + '  canonical_model_id, benchmark_key, display_name, version, score,'
      + '  source_url, source_hash, verified_at, facts_json'
      + ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(canonical_model_id, benchmark_key) DO NOTHING'
    );

    database.exec('BEGIN IMMEDIATE');
    try {
      if (fs.existsSync(knownPath)) {
        const known = JSON.parse(fs.readFileSync(knownPath, 'utf8'));
        for (const offer of known.offers || []) {
          const providerKey = db.resolveProviderKey(providers, offer.provider);
          const exactModelId = typeof offer.model_id === 'string' && offer.model_id
            ? offer.model_id
            : null;
          if (!providerKey || !exactModelId) {
            summary.offersSkipped += 1;
            continue;
          }
          const verifiedAt = offer.last_verified || fallbackTime;
          upsertOffer.run(...db.offerUpsertParams({
            provider_key: providerKey,
            exact_model_id: exactModelId,
            canonical_model_id: db.canonicalModelId(exactModelId),
            source_kind: 'legacy',
            status: 'verified',
            consecutive_failures: 0,
            first_seen_at: verifiedAt,
            last_attempted_at: verifiedAt,
            last_verified_at: verifiedAt,
            pricing_hash: null,
            removal_evidence_json: null,
            facts_json: offer,
            ...db.extractOfferPriceColumns(offer),
          }, verifiedAt, null));
          summary.offersImported += 1;
        }
      }

      if (fs.existsSync(benchPath)) {
        const bench = JSON.parse(fs.readFileSync(benchPath, 'utf8'));
        for (const model of bench.models || []) {
          // A legacy model carries several ids and aliases. The assembler
          // joins benchmarks to offers by canonical_model_id, so insert each
          // fact under EVERY canonical identity the model is known by; the
          // offer's canonical (canonicalModelId of its exact id) then matches.
          const identities = new Set();
          for (const id of model.model_ids || []) {
            if (id) identities.add(db.canonicalModelId(id));
          }
          for (const alias of model.aliases || []) {
            if (alias) identities.add(db.canonicalModelId(alias));
          }
          if (identities.size === 0 && model.canonical_name) {
            identities.add(db.canonicalModelId(String(model.canonical_name).trim()));
          }
          identities.delete('');
          if (identities.size === 0) continue;
          for (const item of model.benchmarks || []) {
            const score = Number(item.score);
            const sourceUrl = typeof item.source === 'string' ? item.source : '';
            const name = typeof item.name === 'string' ? item.name : '';
            if (!name || !Number.isFinite(score) || score < 0 || score > 100 || !/^https?:\/\//.test(sourceUrl)) {
              summary.benchmarksInvalid += 1;
              continue;
            }
            const key = db.benchmarkKey(name);
            const version = db.benchmarkVersion(name);
            const verifiedAt = item.accessed_at || bench.updated_at || fallbackTime;
            const facts = JSON.stringify({
              origin: 'legacy-import',
              canonical_name: model.canonical_name || null,
              extraction_method: item.extraction_method || null,
            });
            for (const canonical of identities) {
              const info = insertBenchmark.run(
                canonical, key, name, version, score,
                sourceUrl, 'legacy-import', verifiedAt, facts
              );
              if (info.changes > 0) summary.benchmarksImported += 1;
              else summary.benchmarksExisting += 1;
            }
          }
        }
      }

      database.exec('COMMIT');
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch { /* connection state already reset */ }
      throw err;
    }
    return summary;
  } finally {
    database.close();
  }
}

module.exports = { importLegacyState };
