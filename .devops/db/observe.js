'use strict';

// Spec 0008 Phase 2 — deterministic observation application.
//
// Runs after reduceLanes + applyModelFacts, against the finalized candidate
// DB, and before the candidate view / classifier. Every decision here is
// deterministic code: the LLM artifacts (nim_verify, provider_monitor,
// discovery candidates, catalog artifacts) are inputs only. The LLM never
// writes offers, the models table, the registry, or the cache.
//
// Responsibilities:
//   1. OR endpoints observer results  -> offers Gate 3 columns (provider
//      count, uptime, activity evidence).
//   2. NIM verification results       -> free_endpoint_status / api_calls_30d;
//      a deprecated free endpoint is deterministic removal evidence
//      (confirmed_removed with the NIM page URL).
//   3. Within-run contradiction detection + lowest-source-tier resolution
//      (contradictions table, §4.5).
//   4. Frontier re-derivation (models.frontier, §4.11).
//   5. DISCOUNTED admission (Gate 2 extension) + liveness: a discount that
//      returned to the normal price is a campaign end, not a new offer.

const fs = require('node:fs');
const path = require('node:path');
const db = require('./collector-db');
const lanes = require('./lanes');
const rp = require('../../build/ranking-policy');

function readJsonIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// ── 0. Catalog discount signals (§4.11) ───────────────────────────────────

// Deterministic hint for the provider monitors: a catalog model that is
// not free, whose known normal price exists, and whose today's catalog
// price is strictly lower in at least one direction. Verification on the
// official page is the monitor's job; admission happens later in
// applyDiscountedOffers. Accepts the known-normal map keyed by canonical
// model id (matched with slash-insensitive ids).
// Catalog API prices are per-token; the report scale is per million.
// Round to three decimals so half-dollar rates (7.5) survive.
const perM = (p) => Math.round(p * 1000000000) / 1000;

function catalogDiscountSignals(catalogArtifacts = [], knownNormals = new Map()) {
  const signals = [];
  const norm = (v) => String(v || '').replace(/\//g, '').toLowerCase();
  const normalFor = (modelId) => {
    const direct = knownNormals.get(modelId);
    if (direct) return direct;
    const needle = norm(modelId);
    for (const [key, value] of knownNormals) {
      if (norm(key) === needle) return value;
    }
    return null;
  };
  for (const artifact of catalogArtifacts) {
    if (!artifact || artifact.status !== 'available' || !Array.isArray(artifact.models)) continue;
    const providerKey = artifact.provider_key;
    if (!providerKey) continue;
    for (const m of artifact.models) {
      if (!m || m.is_free) continue;
      const inPrice = m.prompt_price === null || m.prompt_price === undefined ? null : perM(m.prompt_price);
      const outPrice = m.completion_price === null || m.completion_price === undefined ? null : perM(m.completion_price);
      if (inPrice === null || outPrice === null) continue;
      const known = normalFor(m.model_id);
      if (!known) continue;
      if ((known.input !== null && inPrice < known.input - 0.001)
          || (known.output !== null && outPrice < known.output - 0.001)) {
        signals.push({
          provider_key: providerKey,
          model_id: m.model_id,
          now: { input: inPrice, output: outPrice },
          previous_normal: { input: known.input, output: known.output },
        });
      }
    }
  }
  return signals;
}

// ── 1. Router endpoints observer ─────────────────────────────────────────

// Applies the reduced OR endpoints observations to the offers that exist.
// A model observed with zero providers is a Gate 3 exclusion signal, stored
// as data (provider_count = 0) so the deterministic gate can act on it.
function applyOrEndpointObservations(runDir, baseOpts = {}) {
  const data = readJsonIfPresent(path.join(runDir, 'reduced', 'or-endpoints.json'));
  if (!data || !Array.isArray(data.observations)) return { applied: 0 };
  let applied = 0;
  for (const obs of data.observations) {
    if (!obs || typeof obs.provider_count !== 'number' || !Number.isInteger(obs.provider_count)) continue;
    const modelId = obs.model_id;
    if (typeof modelId !== 'string' || !modelId) continue;
    const evidence = {
      provider_count: obs.provider_count,
      uptime_percent: typeof obs.uptime_percent === 'number' ? obs.uptime_percent : null,
      activity_evidence: obs.top_provider
        ? `top provider ${obs.top_provider}` +
          (typeof obs.uptime_percent === 'number' ? `, 1d uptime ${obs.uptime_percent}%` : '')
        : null,
    };
    const result = db.setOfferOperationalEvidence('openrouter', modelId, evidence, baseOpts);
    if (result.updated) applied += 1;
  }
  return { applied };
}

// ── 2. NIM verification ──────────────────────────────────────────────────

// Applies the nim_verify artifact (crawl-facts shaped, one models[] entry
// per checked model) to the nvidia offers. A deprecated free endpoint is
// immediate confirmed_removed with the NIM page as removal evidence (Gate 3,
// §4.3-4). A served endpoint with API calls raises operational confidence
// (derived later from the stored columns).
function applyNimVerification(runId, baseOpts = {}) {
  const { tasks } = db.loadRunCandidate(runId, baseOpts);
  const task = tasks.find((t) => t.task_id === 'nim_verify');
  const artifact = task && task.result_json;
  if (!artifact || task.status === 'failed' || !Array.isArray(artifact.models)) {
    return { applied: 0, removed: 0, artifact: null };
  }
  let applied = 0;
  let removed = 0;
  for (const model of artifact.models) {
    if (!model || typeof model.model_id !== 'string' || !model.model_id) continue;
    const modelId = model.model_id;
    const evidence = {};
    if (['available', 'deprecated'].includes(model.free_endpoint_status)) {
      evidence.free_endpoint_status = model.free_endpoint_status;
    }
    if (Number.isInteger(model.api_calls_30d)) evidence.api_calls_30d = model.api_calls_30d;
    if (typeof model.activity_text === 'string' && model.activity_text.trim()) {
      evidence.activity_evidence = model.activity_text;
    }
    if (Object.keys(evidence).length > 0) {
      const result = db.setOfferOperationalEvidence('nvidia', modelId, evidence, baseOpts);
      if (result.updated) applied += 1;
    }
    if (model.free_endpoint_status === 'deprecated') {
      const offer = db.getOffer('nvidia', modelId, baseOpts);
      if (offer && offer.status !== 'confirmed_removed') {
        db.setOfferStatus('nvidia', modelId, 'confirmed_removed', {
          reason: 'NIM free endpoint deprecated on the individual model page (Gate 3)',
          source_url: typeof model.evidence_url === 'string' && model.evidence_url
            ? model.evidence_url
            : null,
          task_id: 'nim_verify',
          run_id: runId,
          observed_at: new Date().toISOString(),
        }, baseOpts);
        removed += 1;
      }
    }
  }
  return { applied, removed, artifact };
}

// ── 3. Contradictions (§4.5) ─────────────────────────────────────────────

// Within-run disagreements on one (offer, fact) between two or more fetch
// evidences of different source tiers. The lowest tier number (strongest)
// wins; the adoption is recorded with its rule. A later run reaching the
// same adoption closes the contradiction; a new disagreement keeps it open.
// Time series value changes across runs are NOT contradictions: those are
// change records (assemble.js diff engine).
function detectContradictions(runId, baseOpts = {}, inputs = {}) {
  const { nimArtifact = null, catalogArtifacts = [], now } = inputs;
  const findings = [];

  // (a) free_status: the NIM individual page (tier 1) says the free endpoint
  // is deprecated while the catalog listing (aggregator tier) still lists
  // the model free. The individual page wins.
  if (nimArtifact && Array.isArray(nimArtifact.models)) {
    for (const model of nimArtifact.models) {
      if (!model || model.free_endpoint_status !== 'deprecated') continue;
      const modelId = model.model_id;
      if (typeof modelId !== 'string') continue;
      const offer = db.getOffer('nvidia', modelId, baseOpts);
      if (!offer) continue;
      const isFree = offer.effective_input_price_usd === 0 && offer.effective_output_price_usd === 0;
      if (!isFree) continue; // a paid nvidia offer is not a free_status claim
      const listingUrl = offer.price_source_url || 'https://integrate.api.nvidia.com/v1/models';
      const individualUrl = typeof model.evidence_url === 'string' && model.evidence_url
        ? model.evidence_url
        : null;
      findings.push({
        change_key: `offer:nvidia/${modelId}`,
        fact: 'free_status',
        values: [
          // The NIM API model list is a machine listing (aggregator tier);
          // the individual availability page is the strongest evidence (1).
          { source_url: listingUrl, source_tier: 8, value: 'free' },
          { source_url: individualUrl, source_tier: 1, value: 'deprecated' },
        ],
        resolved_value: 'deprecated',
        resolution_rule: 'lowest_source_tier',
        detected_at: now,
      });
    }
  }

  // (b) price: this run's catalog price for a model disagrees with a fresh
  // verified worker pricing claim (same provider + model) of a different
  // source tier. Worker artifacts are compared directly (the offer table
  // already reflects whichever lane wrote last and cannot show the
  // within-run disagreement). Lowest tier wins.
  const { tasks } = db.loadRunCandidate(runId, baseOpts);
  const workerClaims = new Map(); // `${provider}\u0000${model_id}` -> {value, url, tier}
  for (const task of tasks) {
    if (!['known_refresh', 'discovery', 'news_scan', 'vendor_deep_dive', 'provider_monitor', 'model_fanout'].includes(task.kind)) continue;
    const artifact = task.result_json;
    if (!artifact || !Array.isArray(artifact.models)) continue;
    for (const model of artifact.models) {
      if (!model || typeof model.model_id !== 'string' || model._price_evidence_verified !== true) continue;
      const providerKey = (typeof model.provider_key === 'string' && model.provider_key)
        || task.provider_key || null;
      if (!providerKey) continue;
      const prices = deriveDiscountPrices(model);
      const legacyIn = typeof model.source_amount_input === 'number' ? model.source_amount_input : null;
      const legacyOut = typeof model.source_amount_output === 'number' ? model.source_amount_output : null;
      let value = null;
      if (prices) {
        value = { input: prices.effectiveInput, output: prices.effectiveOutput };
      } else if (legacyIn !== null && legacyOut !== null) {
        const derived = lanes.deriveUsdPerMillion({
          sourceAmountInput: legacyIn, sourceAmountOutput: legacyOut,
          sourceUnit: typeof model.source_unit === 'string' ? model.source_unit : null,
          sourceCurrency: typeof model.source_currency === 'string' ? model.source_currency : null,
          conversionRate: typeof model.conversion_rate === 'number' ? model.conversion_rate : null,
          conversionSource: typeof model.conversion_source === 'string' ? model.conversion_source : null,
          conversionConfirmedAt: typeof model.conversion_confirmed_at === 'string' ? model.conversion_confirmed_at : null,
        });
        if (derived) value = { input: derived.inputPerM, output: derived.outputPerM };
      }
      if (!value || typeof model.price_source_url !== 'string') continue;
      const key = `${providerKey}\u0000${model.model_id}`;
      if (!workerClaims.has(key)) {
        workerClaims.set(key, { value, url: model.price_source_url, tier: db.sourceTierFromUrl(model.price_source_url) });
      }
    }
  }
  for (const artifact of catalogArtifacts) {
    if (!artifact || artifact.status !== 'available' || !Array.isArray(artifact.models)) continue;
    const providerKey = artifact.provider_key;
    if (!providerKey) continue;
    const catalogUrl = typeof artifact.catalog_url === 'string' ? artifact.catalog_url : null;
    const catalogTier = catalogUrl ? db.sourceTierFromUrl(catalogUrl) : 8;
    for (const catalogModel of artifact.models) {
      const modelId = catalogModel.model_id;
      if (typeof modelId !== 'string') continue;
      const claim = workerClaims.get(`${providerKey}\u0000${modelId}`);
      if (!claim || claim.tier === catalogTier) continue;
      const catalogIn = catalogModel.prompt_price === null ? null : perM(catalogModel.prompt_price);
      const catalogOut = catalogModel.completion_price === null ? null : perM(catalogModel.completion_price);
      if (catalogIn === null || catalogOut === null) continue;
      const differs = Math.abs(catalogIn - claim.value.input) > 0.001
        || Math.abs(catalogOut - claim.value.output) > 0.001;
      if (!differs) continue;
      const lower = Math.min(catalogTier, claim.tier);
      const adopted = catalogTier <= claimTier(claim, catalogTier, catalogIn, catalogOut);
      findings.push({
        change_key: `offer:${providerKey}/${modelId}`,
        fact: 'price',
        values: [
          { source_url: catalogUrl, source_tier: catalogTier, value: { input: catalogIn, output: catalogOut } },
          { source_url: claim.url, source_tier: claim.tier, value: claim.value },
        ],
        resolved_value: adopted,
        resolution_rule: `lowest_source_tier (${lower})`,
        detected_at: now,
      });
    }
  }

  let added = 0;
  let closed = 0;
  for (const finding of findings) {
    const result = db.reconcileContradiction(runId, finding, baseOpts);
    if (result.closed !== undefined) closed += 1; else added += 1;
  }
  return { findings: findings.length, added, closed };
}

// ── 4. Frontier re-derivation (§4.11) ────────────────────────────────────

function rederiveFrontier(watchlist, baseOpts = {}) {
  const vendors = new Set((watchlist && watchlist.frontier_vendors) || []);
  return db.rederiveFrontier([...vendors], baseOpts);
}

// ── 5. DISCOUNTED admission + liveness (§4.11) ───────────────────────────

// Derives USD-per-million normal/effective pairs from crawl-facts shaped
// source amounts using the shared deterministic conversion (lanes.js).
function deriveDiscountPrices(facts) {
  if (!facts || typeof facts !== 'object') return null;
  const sourceUnit = typeof facts.source_unit === 'string' ? facts.source_unit : null;
  const sourceCurrency = typeof facts.source_currency === 'string' ? facts.source_currency : null;
  const conversionRate = typeof facts.conversion_rate === 'number' ? facts.conversion_rate : null;
  const conversionSource = typeof facts.conversion_source === 'string' ? facts.conversion_source : null;
  const conversionConfirmedAt = typeof facts.conversion_confirmed_at === 'string' ? facts.conversion_confirmed_at : null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const normalIn = num(facts.normal_source_amount_input);
  const normalOut = num(facts.normal_source_amount_output);
  const effIn = num(facts.effective_source_amount_input);
  const effOut = num(facts.effective_source_amount_output);
  if (normalIn === null || normalOut === null || effIn === null || effOut === null) return null;
  const derive = (input, output) => lanes.deriveUsdPerMillion({
    sourceAmountInput: input, sourceAmountOutput: output,
    sourceUnit, sourceCurrency, conversionRate, conversionSource, conversionConfirmedAt,
  });
  const normal = derive(normalIn, normalOut);
  const effective = derive(effIn, effOut);
  if (!normal || !effective) return null;
  return {
    normalInput: normal.inputPerM,
    normalOutput: normal.outputPerM,
    effectiveInput: effective.inputPerM,
    effectiveOutput: effective.outputPerM,
  };
}

// A discovery candidate is DISCOUNTED-admissible when (Gate 2 extension):
//   * both normal and effective prices are fetch-verified (evidence marked),
//   * normal > effective in at least one direction,
//   * the model is frontier (models table flag, re-derived this run),
//   * discount evidence: a stated window (start AND end) or a stated normal
//     price quote (normal_source_amount + pricing_text). No inference.
function isDiscountedAdmissible(candidate, prices, modelRow) {
  if (!prices) return null;
  if (!rp.isDiscountPrice(prices.normalInput, prices.normalOutput, prices.effectiveInput, prices.effectiveOutput)) {
    return 'not_a_discount';
  }
  if (!modelRow || modelRow.frontier !== 1) return 'not_frontier';
  const facts = candidate.facts || {};
  if (facts._price_evidence_verified !== true) return 'price_evidence_missing';
  const hasWindow = typeof facts.discount_start_at === 'string' &&
    typeof facts.discount_end_at === 'string' &&
    facts.discount_start_at && facts.discount_end_at;
  const hasNormalQuote = typeof facts.pricing_text === 'string' && facts.pricing_text.trim().length > 0;
  if (!hasWindow && !hasNormalQuote) return 'discount_evidence_missing';
  // 30B and below stay out of discount tracking (quality gate parity).
  if (typeof modelRow.total_parameters_b === 'number' && modelRow.total_parameters_b > 0 &&
      modelRow.total_parameters_b < 30) {
    return 'below_30b';
  }
  return null;
}

// Admits DISCOUNTED offers from this run's discovery candidates and applies
// DISCOUNTED liveness to existing discounted offers:
//   * price returned to normal (effective == normal) -> confirmed_removed
//     with the current price as evidence; the diff engine records
//     campaign_ended and the ended section shows "discount ended".
// Returns { admitted, ended, skipped }.
function applyDiscountedOffers(runId, runDir, baseOpts = {}, inputs = {}) {
  const { watchlist = null } = inputs;
  const candidatesDoc = readJsonIfPresent(path.join(runDir, 'reduced', 'discovery-candidates.json'));
  const candidates = (candidatesDoc && Array.isArray(candidatesDoc.candidates)) ? candidatesDoc.candidates : [];
  let admitted = 0;
  const skipped = [];
  const now = new Date().toISOString();

  for (const candidate of candidates) {
    if (!candidate || typeof candidate.exact_model_id !== 'string') continue;
    const providerKey = candidate.provider_key;
    if (!providerKey) continue;
    // Free / ultra-low candidates belong to the normal admission lane.
    const prices = deriveDiscountPrices(candidate.facts || {});
    if (!prices) continue;
    if (prices.effectiveInput === 0 && prices.effectiveOutput === 0) continue;
    const modelRow = db.findModelsByIds([candidate.canonical_model_id], baseOpts)[0] || null;
    const verdict = isDiscountedAdmissible(candidate, prices, modelRow);
    if (verdict !== null) {
      skipped.push({ provider_key: providerKey, model_id: candidate.exact_model_id, reason: verdict });
      continue;
    }
    const facts = candidate.facts || {};
    const upsert = db.buildOfferUpsertSql();
    const offer = {
      provider_key: providerKey,
      exact_model_id: candidate.exact_model_id,
      canonical_model_id: candidate.canonical_model_id,
      source_kind: 'official_page',
      status: 'verified',
      consecutive_failures: 0,
      first_seen_at: now,
      last_attempted_at: now,
      last_verified_at: now,
      last_seen_run_id: runId,
      pricing_hash: null,
      removal_evidence_json: null,
      facts_json: {
        model_name: candidate.model_name || candidate.exact_model_id,
        discount_kind: 'frontier_discount',
        pricing_text: typeof facts.pricing_text === 'string' ? facts.pricing_text : null,
        endpoint_source: typeof facts.endpoint_source === 'string' ? facts.endpoint_source : null,
        docs_url: typeof facts.docs_url === 'string' ? facts.docs_url : null,
        base_url: typeof facts.base_url === 'string' ? facts.base_url : null,
      },
      normal_input_price_usd: prices.normalInput,
      normal_output_price_usd: prices.normalOutput,
      effective_input_price_usd: prices.effectiveInput,
      effective_output_price_usd: prices.effectiveOutput,
      source_currency: typeof facts.source_currency === 'string' ? facts.source_currency : 'USD',
      source_unit: typeof facts.source_unit === 'string' ? facts.source_unit : 'per_million_tokens',
      conversion_rate: typeof facts.conversion_rate === 'number' ? facts.conversion_rate : null,
      conversion_source: typeof facts.conversion_source === 'string' ? facts.conversion_source : null,
      conversion_confirmed_at: typeof facts.conversion_confirmed_at === 'string' ? facts.conversion_confirmed_at : null,
      price_source_url: typeof facts.price_source_url === 'string' ? facts.price_source_url : null,
      price_verified_at: now,
      discount_start_at: typeof facts.discount_start_at === 'string' ? facts.discount_start_at : null,
      discount_end_at: typeof facts.discount_end_at === 'string' ? facts.discount_end_at : null,
    };
    // Only the typed price columns exist on the upsert surface; build the
    // full parameter list via the shared helper.
    const params = db.offerUpsertParams(offer, now, runId);
    const database = db.openCollectorDb(baseOpts);
    try {
      const stmt = database.prepare(upsert);
      stmt.run(...params);
    } finally {
      database.close();
    }
    admitted += 1;
  }

  // Liveness (§4.11): the offer survives while the DISCOUNT is live. A
  // campaign ends when the pre run state carried a discount (normal strictly
  // above effective) and the current row shows the effective price back at
  // the normal price (both directions fully known). The comparison uses the
  // pre run backup copy, taken before any lane mutated the state.
  let ended = 0;
  const priorOffers = readBackupOffers(runDir);
  const currentBy = new Map();
  const database2 = db.openCollectorDb(baseOpts);
  let currentRows;
  try {
    currentRows = database2.prepare(
      "SELECT provider_key, exact_model_id, status, "
      + 'normal_input_price_usd, normal_output_price_usd, '
      + 'effective_input_price_usd, effective_output_price_usd, price_source_url '
      + 'FROM offers'
    ).all();
  } finally {
    database2.close();
  }
  for (const row of currentRows) {
    currentBy.set(`${row.provider_key}\u0000${row.exact_model_id}`, row);
  }
  for (const prior of priorOffers) {
    if (!prior || prior.status === 'confirmed_removed') continue;
    if (!rp.isDiscountPrice(
      prior.normal_input_price_usd, prior.normal_output_price_usd,
      prior.effective_input_price_usd, prior.effective_output_price_usd)) {
      continue;
    }
    const current = currentBy.get(`${prior.provider_key}\u0000${prior.exact_model_id}`);
    if (!current || current.status === 'confirmed_removed') continue;
    const { normal_input_price_usd: ni, normal_output_price_usd: no,
      effective_input_price_usd: ei, effective_output_price_usd: eo } = current;
    if ([ni, no, ei, eo].some((v) => v === null || v === undefined)) continue;
    if (Math.abs(ni - ei) > 0.001 || Math.abs(no - eo) > 0.001) continue; // still discounted
    const evidence = {
      reason: 'discount ended: effective price returned to normal price (campaign_ended)',
      source_url: current.price_source_url || null,
      task_id: 'discounted_liveness',
      run_id: runId,
      observed_at: now,
    };
    if (db.setOfferStatus(prior.provider_key, prior.exact_model_id, 'confirmed_removed', evidence, baseOpts).updated) {
      ended += 1;
    }
  }

  if (runDir) {
    const reducedDir = path.join(runDir, 'reduced');
    fs.mkdirSync(reducedDir, { recursive: true });
    fs.writeFileSync(
      path.join(reducedDir, 'discounted-offers.json'),
      `${JSON.stringify({ run_id: runId, generated_at: now, admitted, ended, skipped }, null, 2)}\n`
    );
  }
  return { admitted, ended, skipped };
}

// Reads the pre run backup copy (<run_dir>/backup/collector.sqlite) as the
// prior offers state. Returns [] when the backup is absent (first run) or
// unreadable; liveness then simply has no prior state to compare.
function readBackupOffers(runDir) {
  if (!runDir) return [];
  const backupPath = path.join(runDir, 'backup', 'collector.sqlite');
  if (!fs.existsSync(backupPath)) return [];
  let database;
  try {
    database = db.openDatabaseFile(backupPath, { readOnly: true });
    return database.prepare('SELECT * FROM offers').all();
  } catch {
    return [];
  } finally {
    if (database) { try { database.close(); } catch { /* already closed */ } }
  }
}

// ── Phase driver ─────────────────────────────────────────────────────────

function runObservationPhase(runId, runDir, baseOpts = {}, inputs = {}) {
  const { watchlist = null, now, catalogArtifacts = [], log = () => {} } = inputs;
  const stampedNow = now || new Date().toISOString();
  const summary = { run_id: runId, generated_at: stampedNow };

  summary.or_endpoints = applyOrEndpointObservations(runDir, baseOpts);
  log(`  observe or_endpoints: ${summary.or_endpoints.applied} offer(s) updated`);

  summary.nim = applyNimVerification(runId, baseOpts);
  log(`  observe nim: ${summary.nim.applied} offer(s) updated, ${summary.nim.removed} removed`);

  summary.contradictions = detectContradictions(runId, baseOpts, {
    nimArtifact: summary.nim.artifact,
    catalogArtifacts,
    now: stampedNow,
  });
  log(`  observe contradictions: ${summary.contradictions.findings} finding(s) `
    + `(${summary.contradictions.added} new, ${summary.contradictions.closed} closed)`);

  summary.frontier = rederiveFrontier(watchlist, baseOpts);
  log(`  observe frontier: ${summary.frontier.updated} model(s) re-derived`);

  summary.discounted = applyDiscountedOffers(runId, runDir, baseOpts, { watchlist });
  log(`  observe discounted: ${summary.discounted.admitted} admitted, ${summary.discounted.ended} campaign ended`);

  if (runDir) {
    const reducedDir = path.join(runDir, 'reduced');
    fs.mkdirSync(reducedDir, { recursive: true });
    fs.writeFileSync(path.join(reducedDir, 'observations.json'),
      `${JSON.stringify(summary, null, 2)}\n`);
  }
  return summary;
}

module.exports = {
  readJsonIfPresent,
  readBackupOffers,
  catalogDiscountSignals,
  applyOrEndpointObservations,
  applyNimVerification,
  detectContradictions,
  rederiveFrontier,
  deriveDiscountPrices,
  isDiscountedAdmissible,
  applyDiscountedOffers,
  runObservationPhase,
};
