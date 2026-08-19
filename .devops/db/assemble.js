'use strict';

// Staged report assembly and publication (assembly half). Spec 0003 fail safe
// collection pipeline, child 0004 (AC-12, AC-17).
//
// The Editor writes Japanese prose only (editorial.json). The Classifier
// writes classification only (classifications.json). This module is the
// deterministic finalizer: it owns offer and model identity, endpoint and
// provider facts, free limits and pricing, liveness and freshness, benchmark
// facts and tier, ranking eligibility and ordering, and the final daily
// report schema assembly. It combines SQLite current state with the staged
// prose into one complete candidate generation under
// <run_dir>/candidate/report.json. LLMs never write offer state, benchmark
// state, the provider registry, the cache, or the production report (AC-12).
//
// Deterministic derivations follow the spec's value sourcing table:
// delivery_type from the registry, free_allowance_rank from the quota parser,
// total_parameters_b from official facts (MoE uses total), tier from an
// accepted Terminal Bench 2.0 or 2.1 row (AC-10), the local model gate
// (sub 30B needs S or A),
// and the ranking order (tier, access kind, same key score,
// price_verified_at, name).

const fs = require('node:fs');
const path = require('node:path');

const db = require('./collector-db');
const benchmarks = require('./benchmarks');
const rankingPolicy = require('../../build/ranking-policy');
const { buildReportSummary } = require('../../build/summary-text');

// Ranking order (AGENTS.md): tier S>A>B, then access kind FREE>ULTRA_LOW,
// same key benchmark score descending, then price confirmation date descending,
// then name. Free allowance is display only.
const TIER_ORDER = { S: 0, A: 1, B: 2 };

// Local model gate (AGENTS.md): total parameters below 30B are local run
// territory and are not ranked unless the model proves tier S or A
// competitiveness. MoE uses total, not active.
const LOCAL_MODEL_GATE_B = 30;

// Stale disclosure (AC-3): runs one through three stay ranked with a note,
// run four moves the offer to the caution section. Mirrors lanes.js.
const CAUTION_FAILURES = 4;

const CHANGE_TYPES = [
  'new', 'ended', 'revived', 'price_change', 'discount_rate_change',
  'provider_count_change', 'free_status_change', 'availability_change',
  'context_change', 'model_id_change', 'rate_limit_change',
  'data_policy_change', 'capability_change', 'campaign_started',
  'campaign_ended', 'campaign_date_change', 'limit_change', 'provider_change',
  'end_date_change',
];

// Report priority (§4.6): ranked price drops / free-ups > new free offers
// > ended / removed > everything else. Within a class the order is
// deterministic (offer key).
const CHANGE_PRIORITY = {
  price_drop: 0, new_free: 1, ended: 2, other: 3,
};

function nowIso() {
  return new Date().toISOString();
}

function loadRegistryProviders(registryPath) {
  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const providers = Array.isArray(raw) ? raw : raw.providers;
  if (!Array.isArray(providers)) {
    throw new Error(`provider registry has no providers array: ${registryPath}`);
  }
  return providers;
}

// Stable offer key the Editor references in editorial.json.
function offerKey(providerKey, exactModelId) {
  return `${providerKey}/${exactModelId}`;
}

// ---------------------------------------------------------------------------
// Deterministic derivations (carried forward from the legacy merger)
// ---------------------------------------------------------------------------

// delivery_type comes straight from the registry. Workers never write it.
function deriveDeliveryType(providerKey, regByKey) {
  const entry = regByKey[providerKey];
  return (entry && entry.delivery_type) || 'official';
}

// free_allowance_rank from verbatim quota text. Keyword first, then a rough
// recurring USD value, else NORMAL. Unlimited or no quota is AMPLE; explicit
// limited or prototype wording caps at TIGHT or TINY (spec value sourcing).
function deriveAllowance(text) {
  const t = String(text || '').toLowerCase();
  if (!t.trim()) return 'NORMAL';
  if (/unlimited|no limit|no quota|制限なし|無制限/.test(t)) return 'AMPLE';
  if (/prototype|preview|early access|beta|very limited|tiny/.test(t)) return 'TINY';
  const usd = t.match(/\$?\s*(\d+(?:\.\d+)?)\s*(?:\/|per\s*)?(?:month|mo\b)/);
  if (usd) {
    const v = parseFloat(usd[1]);
    if (v >= 5) return 'AMPLE';
    if (v >= 1) return 'NORMAL';
    if (v >= 0.1) return 'TIGHT';
    return 'TINY';
  }
  if (/generous|ample|large|high limit/.test(t)) return 'AMPLE';
  if (/tight|limited|small|low limit|only \d/.test(t)) return 'TIGHT';
  return 'NORMAL';
}

// total_parameters_b from official facts. MoE uses total, not active. Accepts
// an explicit numeric field or verbatim params text.
function deriveParamsB(facts) {
  if (facts && typeof facts.total_parameters_b === 'number' && Number.isFinite(facts.total_parameters_b)) {
    return facts.total_parameters_b;
  }
  const t = String((facts && (facts.params_text || facts.parameters_text)) || '');
  if (!t) return null;
  const totalExplicit = t.match(/(\d+(?:\.\d+)?)\s*B\s*total/i);
  if (totalExplicit) return parseFloat(totalExplicit[1]);
  const total = t.match(/(\d+(?:\.\d+)?)\s*B\b/i);
  if (total) return parseFloat(total[1]);
  return null;
}

// Provisional classification from facts text. The Classifier makes the final
// call (classifications.json overrides this); the keyword pass only keeps
// obviously conditional or trial offers out of the true free bucket so the
// report is sane even when the Classifier did not run.
function deriveClassificationProvisional(facts) {
  const f = facts || {};
  const text = [
    f.name, f.model_name, f.description, f.free_quota_text, f.pricing_text,
    f.params_text, f.free_limits, f.training_use,
    ...(Array.isArray(f.registration_conditions) ? f.registration_conditions : []),
  ].filter((value) => value !== undefined && value !== null).join(' ').toLowerCase();
  // A data contribution or training opt in is a material access condition,
  // even when the worker correctly says the underlying API is paid.
  // Match both explicit data-sharing wording and catalog descriptions such as
  // "opt-in version" whose condition is stated later in the sentence.
  if (/data[\s-]?sharing|share.*data|opt[\s-]?in.*(?:data|training)|(?:data|prompt|output|conversation).*training|data used for training|training.*consent/.test(text)) {
    return 'F_CONDITIONAL';
  }
  if (f.is_free_signal === false) return 'G_FREE_LIKE';
  const recurrent = /per (?:month|day|mo\b)|monthly|daily|every (?:month|day)|毎月|毎日/.test(text);
  if (recurrent && /free|credit|quota|tier/.test(text)) return 'B_PERMANENT_FREE_TIER';
  if (/trial|launch credit|one[\s-]?time|\$?\d+\s*free credit/.test(text)) return 'D_TRIAL_CREDIT';
  if (/discount|\d+\s*% off|limited[\s-]?time.*off/.test(text)) return 'E_DISCOUNT';
  if (/free (?:api|tier|quota|access)|永久.*無料|always[\s-]?free/.test(text)) return 'B_PERMANENT_FREE_TIER';
  return 'G_FREE_LIKE';
}

// These facts are derived from the fetched official catalog description when
// a provider exposes a data contribution or training condition. Keeping the
// condition in typed candidate fields prevents it from disappearing when the
// model is not a free tier and gives the classifier/editor the exact context.
function deriveTrainingUse(facts) {
  const f = facts || {};
  if (typeof f.training_use === 'string' && f.training_use.trim()) return f.training_use.trim();
  const text = [f.name, f.model_name, f.description].filter(Boolean).join(' ');
  if (!/data[\s-]?sharing|opt[\s-]?in.*(?:data|training)|data used for training|(?:prompt|output|conversation).*training/i.test(text)) return null;
  return 'あり。プロンプトまたは出力が提供元の学習・製品改善に利用される可能性があります。';
}

function deriveRegistrationConditions(facts) {
  const f = facts || {};
  if (Array.isArray(f.registration_conditions)) {
    return f.registration_conditions.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim());
  }
  return deriveTrainingUse(facts)
    ? ['データ利用（学習・製品改善）への同意が必要な条件付きモデル']
    : [];
}

function deriveCapability(facts, key) {
  const capabilities = facts && facts.capabilities;
  return capabilities && typeof capabilities === 'object' && typeof capabilities[key] === 'boolean'
    ? capabilities[key]
    : null;
}

// Access kind (spec 0004 AC-4): FREE when effective input and output are both
// positive zero; ULTRA_LOW when effective input is at most 0.2 USD and output
// at most 0.4 USD per million tokens. When either effective price is unknown
// (null/undefined/non finite), access kind is null and the offer cannot rank.
// Shared with the validator and the builder via build/ranking-policy.js.
function deriveAccessKind(effectiveInputUsd, effectiveOutputUsd) {
  return rankingPolicy.deriveAccessKind(effectiveInputUsd, effectiveOutputUsd);
}

// Information confidence (spec deterministic derivations): HIGH for fetched
// official text or an accepted official image, otherwise MEDIUM.
function deriveInformationConfidence(candidate) {
  if (candidate.endpoint_source) return 'HIGH';
  return 'MEDIUM';
}

// Operational confidence is deterministic Gate 3 evidence (spec 0008 §4.7),
// derived from the stored observation columns, never from the LLM:
//   * NIM free offers need the individual endpoint page (available /
//     deprecated + API call count);
//   * router offers need the endpoints observer (provider count / uptime;
//     a measured zero provider set at $0 is NONE = not operable);
//   * official providers need this run's docs / pricing fetch success.
// Ranking admits HIGH and MEDIUM only; NONE and LOW are deterministic
// ranking exclusions.
function deriveOperationalConfidence(candidate) {
  return rankingPolicy.deriveOperationalConfidence({
    providerKey: candidate.provider_key,
    accessKind: candidate.access_kind,
    verified: candidate.status === 'verified',
    // Mild staleness (below the caution threshold) keeps the carried-over
    // evidence rankable at MEDIUM; the fail-safe convention is preserved.
    staleMild: candidate.status === 'stale' &&
      (candidate.consecutive_failures || 0) < CAUTION_FAILURES,
    providerCount: candidate.provider_count ?? null,
    uptimePercent: candidate.uptime_percent ?? null,
    freeEndpointStatus: candidate.free_endpoint_status ?? null,
    apiCalls30d: candidate.api_calls_30d ?? null,
  });
}

// Human readable Gate 3 evidence line for the report card.
function gate3Evidence(candidate) {
  if (candidate.provider_key === 'nvidia') {
    if (candidate.free_endpoint_status === 'deprecated') return 'NIM free endpoint deprecated on the individual model page';
    if (candidate.free_endpoint_status === 'available') {
      return candidate.api_calls_30d !== null && candidate.api_calls_30d !== undefined
        ? `NIM free endpoint available (API calls last 30 days: ${candidate.api_calls_30d})`
        : 'NIM free endpoint available (call count not visible)';
    }
    return candidate.activity_evidence || null;
  }
  if (candidate.provider_key === 'openrouter') {
    if (typeof candidate.provider_count === 'number') {
      return candidate.uptime_percent !== null && candidate.uptime_percent !== undefined
        ? `router: ${candidate.provider_count} provider(s), 1d uptime ${candidate.uptime_percent}%`
        : `router: ${candidate.provider_count} provider(s)`;
    }
    return candidate.activity_evidence || null;
  }
  return candidate.status === 'verified' ? 'official docs / pricing fetch verified this run' : null;
}

// ---------------------------------------------------------------------------
// Candidate view (deterministic facts for the Editor and the assembler)
// ---------------------------------------------------------------------------

// Builds one candidate record per current offer (verified or stale) from
// SQLite current state plus the registry. confirmed_removed offers are not
// candidates (they surface as change records and excluded offers).
function buildCandidateView(options = {}) {
  const paths = db.resolvePaths(options);
  const providers = loadRegistryProviders(paths.registryPath);
  const regByKey = Object.fromEntries(providers.map((p) => [p.key, p]));

  const database = db.openCollectorDb(options);
  let offers;
  let frontierRows = [];
  try {
    offers = database.prepare(
      'SELECT * FROM offers ORDER BY provider_key, exact_model_id'
    ).all().map((row) => db.parseRow('offers', row));
    // Frontier models (spec 0008 §4.11): re-derived this run into
    // models.frontier (Terminal-Bench 80+ or watchlist frontier vendor).
    // Discount tracking matches canonical id and aliases, slash insensitive.
    frontierRows = database.prepare(
      'SELECT canonical_model_id, aliases_json FROM models WHERE frontier = 1'
    ).all();
  } catch { /* models table absent in very old fixtures: no frontier */ }
  finally {
    database.close();
  }
  const { byModel } = benchmarks.loadCurrentBenchmarks(options);
  const normId = (v) => String(v || '').replace(/\//g, '').toLowerCase();
  const frontierIds = new Set();
  for (const row of frontierRows) {
    frontierIds.add(normId(row.canonical_model_id));
    let aliases = [];
    try { aliases = JSON.parse(row.aliases_json || '[]'); } catch { aliases = []; }
    for (const alias of aliases) frontierIds.add(normId(alias));
  }

  const candidates = [];
  for (const offer of offers) {
    if (offer.status === 'confirmed_removed') continue;
    // Hidden is an operator controlled publication override. Keep the offer
    // in SQLite for audit and explicit unhide, but never build it into a
    // candidate report.
    if (offer.hidden === 1) continue;
    const reg = regByKey[offer.provider_key] || {};
    const facts = offer.facts_json && typeof offer.facts_json === 'object' && !Array.isArray(offer.facts_json)
      ? offer.facts_json
      : {};
    const benchmarkRows = byModel.get(offer.canonical_model_id) || [];
    const tier = benchmarks.deriveTier(benchmarkRows);
    const name = facts.name || facts.model_name || offer.canonical_model_id;
    const modelVendor = facts.model_vendor ||
      (offer.canonical_model_id.includes('/') ? offer.canonical_model_id.split('/')[0] : null);
    const deliveryType = deriveDeliveryType(offer.provider_key, regByKey);
    // Catalog pricing/liveness evidence is not endpoint evidence. A catalog
    // task that could not fetch the provider docs leaves endpoint_source null;
    // do not manufacture it from the registry docs URL. Legacy, bootstrap
    // report, and official-page rows may still use the registry fallback
    // during the transition.
    const canUseRegistryDocsFallback = ['official_page', 'legacy', 'report']
      .includes(offer.source_kind);
    const endpointSource = facts.endpoint_source ||
      (canUseRegistryDocsFallback ? reg.docs_url : null);
    const catalogSource = typeof facts.catalog_url === 'string' ? facts.catalog_url : null;
    const modelPageSource = reg.delivery_type === 'router' &&
      typeof reg.model_page_template === 'string' && reg.model_page_template.includes('{model_id}')
      ? reg.model_page_template.replace('{model_id}', offer.exact_model_id)
      : null;
    const freeLimits = facts.free_quota_text || facts.free_limits || null;
    const trainingUse = deriveTrainingUse(facts);
    const registrationConditions = deriveRegistrationConditions(facts);
    const inCaution = offer.status === 'stale' && (offer.consecutive_failures || 0) >= CAUTION_FAILURES;

    // Spec 0004 AC-3: core prices live in typed columns. Price evidence is
    // carried forward when a fresh fetch fails (AC-8: the last verified price
    // and date stay). Access kind derives only from the effective prices
    // (AC-4).
    const normalPrice = priceObject(
      offer.normal_input_price_usd, offer.normal_output_price_usd,
      offer.normal_cache_read_price_usd, offer.normal_cache_write_price_usd
    );
    const effectivePrice = priceObject(
      offer.effective_input_price_usd, offer.effective_output_price_usd,
      offer.effective_cache_read_price_usd, offer.effective_cache_write_price_usd
    );
    const derivedAccessKind = deriveAccessKind(
      offer.effective_input_price_usd, offer.effective_output_price_usd
    );
    const frontierModel = Boolean(offer.canonical_model_id) &&
      (frontierIds.has(normId(offer.canonical_model_id)) ||
        frontierIds.has(normId(offer.exact_model_id)));
    const isDiscount = rankingPolicy.isDiscountPrice(
      offer.normal_input_price_usd, offer.normal_output_price_usd,
      offer.effective_input_price_usd, offer.effective_output_price_usd
    );
    // A frontier model at a verified discount is DISCOUNTED (discount
    // section, never ranked), even when the discounted price would also
    // qualify as ULTRA_LOW (spec 0008 §4.11, operator decision 2026-08-19).
    const accessKind = (isDiscount && frontierModel)
      ? 'DISCOUNTED'
      : derivedAccessKind;

    // Deterministic suspicion floor: an unregistered provider never scores
    // better than 2 (spec 0008 §4.7); the classifier value (Phase 3) can
    // raise it, nothing raises it above 5.
    const registered = Boolean(regByKey[offer.provider_key]);
    const suspicion = Math.max(
      Number.isInteger(offer.suspicion_score) ? offer.suspicion_score : 0,
      registered ? 0 : rankingPolicy.SUSPICION_UNREGISTERED_FLOOR
    );

    candidates.push({
      offer_key: offerKey(offer.provider_key, offer.exact_model_id),
      provider_key: offer.provider_key,
      exact_model_id: offer.exact_model_id,
      canonical_model_id: offer.canonical_model_id,
      provider: reg.label || offer.provider_key,
      model_vendor: modelVendor,
      name,
      model_name: facts.model_name || name,
      description: typeof facts.description === 'string' ? facts.description : null,
      delivery_type: deliveryType,
      base_url: reg.base_url || null,
      endpoint_source: endpointSource,
      free_limits: freeLimits,
      rate_limits: facts.rate_limits || null,
      registration_conditions: registrationConditions,
      training_use: trainingUse,
      free_allowance_rank: deriveAllowance(freeLimits),
      context_tokens: Number.isInteger(facts.context_tokens) ? facts.context_tokens : null,
      max_output_tokens: Number.isInteger(facts.max_output_tokens) ? facts.max_output_tokens : null,
      tool_calling: deriveCapability(facts, 'tool_calling'),
      structured_output: deriveCapability(facts, 'structured_output'),
      image_input: deriveCapability(facts, 'vision') ?? deriveCapability(facts, 'image_input'),
      total_parameters_b: deriveParamsB(facts),
      active_parameters_b: typeof facts.active_parameters_b === 'number' ? facts.active_parameters_b : null,
      classification: deriveClassificationProvisional(facts),
      benchmarks: benchmarkRows.map((row) => ({
        name: row.display_name, score: row.score, version: row.version,
        source_url: row.source_url, verified_at: row.verified_at,
      })),
      benchmark: tier.benchmark_pending
        ? null
        : { score: tier.score, benchmark_name: tier.benchmark_name, version: tier.version, tier: tier.tier },
      benchmark_key: tier.benchmark_key,
      tier: tier.tier,
      benchmark_pending: tier.benchmark_pending,
      normal_price_per_million: normalPrice,
      effective_price_per_million: effectivePrice,
      access_kind: accessKind,
      price_source: offer.price_source_url || null,
      price_verified_at: offer.price_verified_at || null,
      discount_start_at: offer.discount_start_at || null,
      discount_end_at: offer.discount_end_at || null,
      status: offer.status,
      consecutive_failures: offer.consecutive_failures || 0,
      in_caution: inCaution,
      last_verified: offer.last_verified_at || null,
      pricing_hash: offer.pricing_hash || null,
      suspicion_score: suspicion,
      // Spec 0008 Phase 2: Gate 3 operational evidence columns.
      provider_count: Number.isInteger(offer.provider_count) ? offer.provider_count : null,
      uptime_percent: typeof offer.uptime_percent === 'number' ? offer.uptime_percent : null,
      activity_evidence: offer.activity_evidence || null,
      free_endpoint_status: offer.free_endpoint_status || null,
      api_calls_30d: Number.isInteger(offer.api_calls_30d) ? offer.api_calls_30d : null,
      frontier: frontierModel,
      data_policy: offerDataPolicy(offer),
      data_policy_source: offerDataPolicySource(offer),
      // For router cards the exact model page is the primary citation. It is
      // generated from the registry template, while only fetched URLs enter
      // source_cache and endpoint evidence.
      sources: [modelPageSource, endpointSource, catalogSource, ...benchmarkRows.map((row) => row.source_url)]
        .filter((url) => typeof url === 'string' && /^https?:\/\//.test(url)),
      facts,
    });
  }
  return { generatedAt: nowIso(), candidates };
}

// Data policy text from the stored condition facts (Phase 3 wires the
// refresh; the column may already carry a verified value).
function offerDataPolicy(offer) {
  if (!offer.data_policy_json) return null;
  try {
    const parsed = typeof offer.data_policy_json === 'string'
      ? JSON.parse(offer.data_policy_json)
      : offer.data_policy_json;
    if (parsed && typeof parsed === 'object') {
      return typeof parsed.text === 'string' ? parsed.text
        : (typeof parsed.value === 'string' ? parsed.value : null);
    }
    return typeof parsed === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

// The verified data policy page (data_policy_json.url), when stored.
function offerDataPolicySource(offer) {
  if (!offer.data_policy_json) return null;
  try {
    const parsed = typeof offer.data_policy_json === 'string'
      ? JSON.parse(offer.data_policy_json)
      : offer.data_policy_json;
    if (parsed && typeof parsed === 'object' && typeof parsed.url === 'string' &&
        /^https?:\/\//.test(parsed.url)) {
      return parsed.url;
    }
    return null;
  } catch {
    return null;
  }
}

// Builds the price object from typed USD columns. Only finite numbers are
// emitted; cache prices may be absent (null) while input and output are kept.
function priceObject(input, output, cacheRead, cacheWrite) {
  const out = {};
  const put = (key, value) => {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  };
  put('input', input);
  put('output', output);
  put('cache_read', cacheRead);
  put('cache_write', cacheWrite);
  return out;
}

// ---------------------------------------------------------------------------
// Ranking eligibility and ordering (spec 0004 AC-4, AC-5, AC-7, AGENTS.md)
// ---------------------------------------------------------------------------

// Decides ranking eligibility deterministically. Returns { eligible, reason }.
// An offer ranks only when it has a verified accepted Terminal Bench (2.0 or
// 2.1) score at or above 50 (spec 0004 AC-5, AC-6), a derived access kind
// (FREE or ULTRA_LOW) from typed effective prices, a price source and
// confirmation date, passes the local model gate, and carries the endpoint
// evidence the validator will re-check.
function decideEligibility(candidate) {
  // Spec 0008 §4.11: DISCOUNTED frontier offers are never ranked; they are
  // evaluated for the discount_offers section instead.
  if (candidate.access_kind === 'DISCOUNTED') {
    return { eligible: false, reason: '[discounted] frontier discount offers belong to discount_offers, never ranked (spec 0008 §4.11)' };
  }
  // Gate 3 (spec 0008 §4.7): deterministic operational evidence. NONE is a
  // hard exclusion (e.g. a $0 router model with a measured zero provider
  // set: listed but not operable); LOW means no fresh evidence this run and
  // does not rank.
  const operationalConfidence = deriveOperationalConfidence(candidate);
  if (operationalConfidence === 'NONE') {
    return { eligible: false, reason: '[gate3] no operational evidence: the offer is not currently operable (provider_count 0 at $0, deprecated endpoint, or unverified)' };
  }
  if (operationalConfidence === 'LOW') {
    return { eligible: false, reason: '[gate3] operational confidence LOW: no fresh operational evidence this run' };
  }
  // Suspicion 4-5 never ranks (classifier value + deterministic floor).
  if (candidate.suspicion_score > rankingPolicy.SUSPICION_RANKING_MAX) {
    return { eligible: false, reason: `[suspicion] suspicion ${candidate.suspicion_score} >= 4 never ranks (spec 0008 §4.7)` };
  }
  if (candidate.benchmark_pending || !candidate.tier) {
    return { eligible: false, reason: '[benchmark-pending] no verified accepted Terminal Bench at or above 50 on record; not ranked (AC-5)' };
  }
  // Shared ranking policy gate: only verified Terminal Bench 2.0/2.1 at or
  // above 50 admits. A score below 50 is never rankable (not even tier B).
  if (!rankingPolicy.qualifiesTerminalBench(candidate.benchmark_key, candidate.benchmark && candidate.benchmark.score)) {
    return { eligible: false, reason: '[benchmark-gate] only verified Terminal Bench 2.0/2.1 at or above 50 admits; other benchmarks and lower scores do not substitute (AC-5, AC-6)' };
  }
  if (!TIER_ORDER.hasOwnProperty(candidate.tier)) {
    return { eligible: false, reason: `[tier] tier ${candidate.tier} is not rankable` };
  }
  if (!candidate.access_kind) {
    return { eligible: false, reason: '[access] effective input and output must both be known and free or ultra low (AC-4)' };
  }
  // Ranked effective prices must be a non null finite non-negative input /
  // output object matching the derived access kind (AC-4, AC-14).
  const eff = candidate.effective_price_per_million || {};
  if (!rankingPolicy.accessKindMatches(
    candidate.access_kind, eff.input, eff.output
  )) {
    return { eligible: false, reason: `[access] effective prices ${JSON.stringify(eff)} do not match access_kind ${candidate.access_kind} (AC-4)` };
  }
  if (!candidate.price_source) {
    return { eligible: false, reason: '[price-source] no fetched price source on record' };
  }
  if (!candidate.price_verified_at) {
    return { eligible: false, reason: '[price-date] no price confirmation date on record' };
  }
  if (typeof candidate.total_parameters_b === 'number' &&
      candidate.total_parameters_b < LOCAL_MODEL_GATE_B &&
      candidate.tier !== 'S' && candidate.tier !== 'A') {
    return { eligible: false, reason: `[local-run] total ${candidate.total_parameters_b}B < ${LOCAL_MODEL_GATE_B}B and tier ${candidate.tier} is not S/A competitive` };
  }
  if (!candidate.base_url) {
    return { eligible: false, reason: '[endpoint] missing base_url; provider not in registry' };
  }
  if (!candidate.endpoint_source) {
    return { eligible: false, reason: '[endpoint] missing endpoint_source; no fetched official doc states the base URL' };
  }
  return { eligible: true, reason: null };
}

// Spec 0008 §4.11: DISCOUNTED admission for the discount_offers section.
// Gate 1 (endpoint evidence) and Gate 3 (operational evidence) apply as
// usual; on top of them the discount-specific deterministic conditions:
// frontier status, both prices known with normal > effective, and discount
// evidence (a stated window or a quoted normal price). No inference.
function decideDiscountEligibility(candidate) {
  if (candidate.in_caution) {
    return { eligible: false, reason: `[stale] ${candidate.consecutive_failures} consecutive failed verifications; moved to caution (AC-3)` };
  }
  if (!candidate.frontier) {
    return { eligible: false, reason: '[frontier] not a frontier model (no Terminal-Bench 80+ and no frontier vendor); discount tracking is frontier-only (§4.11)' };
  }
  if (!candidate.price_source) {
    return { eligible: false, reason: '[price-source] no fetched price source on record' };
  }
  if (!candidate.price_verified_at) {
    return { eligible: false, reason: '[price-date] no price confirmation date on record' };
  }
  const normal = candidate.normal_price_per_million || {};
  const effective = candidate.effective_price_per_million || {};
  if (typeof normal.input !== 'number' || typeof normal.output !== 'number' ||
      typeof effective.input !== 'number' || typeof effective.output !== 'number') {
    return { eligible: false, reason: '[discount] normal and effective prices must both be fully known (no inference)' };
  }
  if (!rankingPolicy.isDiscountPrice(normal.input, normal.output, effective.input, effective.output)) {
    return { eligible: false, reason: '[discount] normal price does not strictly exceed the effective price' };
  }
  const hasWindow = Boolean(candidate.discount_start_at && candidate.discount_end_at);
  const hasNormalQuote = candidate.facts &&
    typeof candidate.facts.pricing_text === 'string' && candidate.facts.pricing_text.trim().length > 0;
  if (!hasWindow && !hasNormalQuote) {
    return { eligible: false, reason: '[discount] no discount window or normal price citation on record (no inference)' };
  }
  const operationalConfidence = deriveOperationalConfidence(candidate);
  if (operationalConfidence === 'NONE') {
    return { eligible: false, reason: '[gate3] no operational evidence: the offer is not currently operable' };
  }
  if (operationalConfidence === 'LOW') {
    return { eligible: false, reason: '[gate3] operational confidence LOW: no fresh operational evidence this run' };
  }
  if (candidate.suspicion_score > rankingPolicy.SUSPICION_RANKING_MAX) {
    return { eligible: false, reason: `[suspicion] suspicion ${candidate.suspicion_score} >= 4 never ranks (spec 0008 §4.7)` };
  }
  if (!candidate.base_url) {
    return { eligible: false, reason: '[endpoint] missing base_url; provider not in registry' };
  }
  if (!candidate.endpoint_source) {
    return { eligible: false, reason: '[endpoint] missing endpoint_source' };
  }
  if (typeof candidate.total_parameters_b === 'number' && candidate.total_parameters_b > 0 &&
      candidate.total_parameters_b < 30) {
    return { eligible: false, reason: '[local-run] under 30B models stay out of discount tracking (quality gate)' };
  }
  return { eligible: true, reason: null };
}

// Ranking comparator (spec 0004 AC-7). Tier first (S>A>B), then access kind
// (FREE before ULTRA_LOW), then the same Terminal Bench version score
// descending only when the representative benchmark key matches, then price
// confirmation date descending, then name ascending. Different benchmark keys
// skip the score step. Free allowance is displayed but is not an ordering axis.
const ACCESS_ORDER = { FREE: 0, ULTRA_LOW: 1 };

function compareRanked(a, b) {
  const tierDiff = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
  if (tierDiff !== 0) return tierDiff;
  const accessDiff = (ACCESS_ORDER[a.access_kind] ?? 99) - (ACCESS_ORDER[b.access_kind] ?? 99);
  if (accessDiff !== 0) return accessDiff;
  if (a.benchmark_key && a.benchmark_key === b.benchmark_key &&
      typeof a.benchmark.score === 'number' && typeof b.benchmark.score === 'number') {
    const scoreDiff = b.benchmark.score - a.benchmark.score;
    if (scoreDiff !== 0) return scoreDiff;
  }
  const aTime = a.price_verified_at || a.last_verified || '';
  const bTime = b.price_verified_at || b.last_verified || '';
  if (aTime !== bTime) return aTime < bTime ? 1 : -1;
  return String(a.name).localeCompare(String(b.name));
}

// ---------------------------------------------------------------------------
// Change records (diff against the last promoted DB state)
// ---------------------------------------------------------------------------

// Loads current offers from an arbitrary SQLite file (the pre run backup) for
// diffing. Returns [] when the file is absent or unreadable.
function loadOffersFromBackup(runDir) {
  if (!runDir) return [];
  const backupPath = path.join(runDir, 'backup', 'collector.sqlite');
  if (!fs.existsSync(backupPath)) return [];
  let database;
  try {
    database = db.openDatabaseFile(backupPath, { readOnly: true });
    return database.prepare('SELECT * FROM offers ORDER BY provider_key, exact_model_id')
      .all().map((row) => db.parseRow('offers', row));
  } catch {
    return [];
  } finally {
    if (database) {
      try { database.close(); } catch { /* already closed */ }
    }
  }
}

// Deterministic change records with structured before / after (spec 0008
// §4.6). Exact identity, pricing, quota, endpoint, benchmark, liveness,
// discount campaign, provider count, context, model id alias join, data
// policy. The Editor supplies the Japanese summary from the structured
// values; the assembler keeps a deterministic fallback so changes never
// depend on prose. Returns one record per (offer, type) so a single offer
// can produce both a price_change and a campaign_date_change.
function computeChanges(currentOffers, priorOffers) {
  const priorByKey = new Map(priorOffers.map((o) => [offerKey(o.provider_key, o.exact_model_id), o]));
  const currentByKey = new Map(currentOffers.map((o) => [offerKey(o.provider_key, o.exact_model_id), o]));
  const changes = [];

  const nameOf = (offer) => {
    const facts = offer.facts_json && typeof offer.facts_json === 'object' ? offer.facts_json : {};
    return facts.name || facts.model_name || offer.canonical_model_id;
  };
  const pricePair = (o) => ({
    input: o.effective_input_price_usd === undefined ? null : o.effective_input_price_usd,
    output: o.effective_output_price_usd === undefined ? null : o.effective_output_price_usd,
  });
  const isFreePair = (p) => p.input === 0 && p.output === 0;
  const discPct = (normalIn, normalOut, effIn, effOut) => {
    const rate = (n, e) => (typeof n === 'number' && typeof e === 'number' && n > 0 && Number.isFinite(n) && Number.isFinite(e))
      ? Math.round(((n - e) / n) * 1000) / 10 : null;
    const a = rate(normalIn, effIn);
    const b = rate(normalOut, effOut);
    return a === null ? b : (b === null ? a : Math.max(a, b));
  };
  const factsOf = (o) => (o.facts_json && typeof o.facts_json === 'object' ? o.facts_json : {});
  const quotaText = (o) => {
    const f = factsOf(o);
    return String(f.free_quota_text || f.free_limits || '') + '|' + JSON.stringify(f.rate_limits || o.facts_json?.rate_limits || null);
  };

  // model_id_change: the old exact id disappeared but the same canonical
  // model reappeared under a new id (alias join). Those two offers are not
  // "ended + new"; they are one rename (spec §4.6).
  const priorByCanonical = new Map();
  for (const o of priorOffers) {
    if (!o.canonical_model_id || o.status === 'confirmed_removed') continue;
    priorByCanonical.set(`${o.provider_key}\u0000${o.canonical_model_id}`, o);
  }
  const renamedCurrent = new Set();
  const renamedPrior = new Set();
  for (const [key, current] of currentByKey) {
    if (!current.canonical_model_id || priorByKey.has(key)) continue;
    const prior = priorByCanonical.get(`${current.provider_key}\u0000${current.canonical_model_id}`);
    if (prior && prior.exact_model_id !== current.exact_model_id && !priorByKey.has(offerKey(current.provider_key, prior.exact_model_id))) {
      renamedCurrent.add(key);
      renamedPrior.add(offerKey(current.provider_key, prior.exact_model_id));
      changes.push({
        offer_key: key, offer_name: nameOf(current), change_type: 'model_id_change',
        field: 'model_id', before: prior.exact_model_id, after: current.exact_model_id,
      });
    }
  }

  for (const [key, current] of currentByKey) {
    const prior = priorByKey.get(key);
    const name = nameOf(current);
    if (!prior) {
      if (current.status !== 'confirmed_removed' && !renamedCurrent.has(key)) {
        const p = pricePair(current);
        const newFree = isFreePair(p) ||
          (p.input !== null && p.input <= 0.2 && p.output !== null && p.output <= 0.4);
        changes.push({
          offer_key: key, offer_name: name, change_type: 'new',
          field: null, before: null, after: newFree ? { free: true } : null,
        });
      }
      continue;
    }

    const curFacts = factsOf(current);
    const priorFacts = factsOf(prior);
    const priorPair = pricePair(prior);
    const curPair = pricePair(current);
    const priorDates = { start: prior.discount_start_at ?? null, end: prior.discount_end_at ?? null };
    const curDates = { start: current.discount_start_at ?? null, end: current.discount_end_at ?? null };
    const priorDiscounted = (prior.normal_input_price_usd !== null || prior.normal_output_price_usd !== null) &&
      priorPair.input !== null && priorPair.output !== null &&
      ((prior.normal_input_price_usd ?? 0) > priorPair.input || (prior.normal_output_price_usd ?? 0) > priorPair.output);
    const curDiscounted = (current.normal_input_price_usd !== null || current.normal_output_price_usd !== null) &&
      curPair.input !== null && curPair.output !== null &&
      ((current.normal_input_price_usd ?? 0) > curPair.input || (current.normal_output_price_usd ?? 0) > curPair.output);

    // Liveness transitions first: they can redefine the whole record.
    if (prior.status === 'confirmed_removed' && current.status !== 'confirmed_removed') {
      changes.push({ offer_key: key, offer_name: name, change_type: 'revived', field: 'liveness', before: prior.status, after: current.status });
      continue;
    }
    if (prior.status !== 'confirmed_removed' && current.status === 'confirmed_removed') {
      // A discounted offer whose price returned to normal is a campaign end,
      // not a plain removal (§4.11 liveness).
      const type = priorDiscounted || priorDates.start || priorDates.end ? 'campaign_ended' : 'ended';
      changes.push({ offer_key: key, offer_name: name, change_type: type, field: 'liveness', before: prior.status, after: current.status });
      continue;
    }

    // free_status_change: $0 <-> paid flip (spec §4.6).
    if (priorPair.input !== null && priorPair.output !== null && curPair.input !== null && curPair.output !== null) {
      const wasFree = isFreePair(priorPair);
      const isFreeNow = isFreePair(curPair);
      if (wasFree !== isFreeNow) {
        changes.push({
          offer_key: key, offer_name: name, change_type: 'free_status_change',
          field: 'effective_price_per_million', before: priorPair, after: curPair,
        });
      }
    }

    // Discount rate change takes the specific slot; it carries the price
    // before / after too (AC: 65% -> 77% with structured values).
    const priorRate = discPct(prior.normal_input_price_usd, prior.normal_output_price_usd, priorPair.input, priorPair.output);
    const curRate = discPct(current.normal_input_price_usd, current.normal_output_price_usd, curPair.input, curPair.output);
    const priceMoved = priorPair.input !== curPair.input || priorPair.output !== curPair.output;
    if (priceMoved) {      if (priorRate !== null || curRate !== null) {
        changes.push({
          offer_key: key, offer_name: name, change_type: 'discount_rate_change',
          field: 'effective_price_per_million', before: priorPair, after: curPair,
          discount_before: priorRate, discount_after: curRate,
        });
      } else {
        changes.push({
          offer_key: key, offer_name: name, change_type: 'price_change',
          field: 'effective_price_per_million', before: priorPair, after: curPair,
        });
      }
    } else if (priorRate !== null && curRate !== null && Math.abs(priorRate - curRate) > 0.05) {
      changes.push({
        offer_key: key, offer_name: name, change_type: 'discount_rate_change',
        field: 'discount_rate', before: { percent: priorRate }, after: { percent: curRate },
        discount_before: priorRate, discount_after: curRate,
      });
    }

    // Hash fallback: the effective pair did not move (e.g. both $0) but the
    // raw pricing evidence changed, so the price terms changed (legacy
    // pricing_hash semantics kept for free offers).
    if (!priceMoved && priorRate === null && curRate === null &&
        prior.pricing_hash && current.pricing_hash && prior.pricing_hash !== current.pricing_hash) {
      changes.push({
        offer_key: key, offer_name: name, change_type: 'price_change',
        field: 'pricing_hash', before: prior.pricing_hash, after: current.pricing_hash,
      });
    }

    // Campaign window transitions (dates present / absent / changed).
    const hadDates = Boolean(priorDates.start || priorDates.end);
    const hasDates = Boolean(curDates.start || curDates.end);
    if (curDiscounted && !hadDates && hasDates) {
      changes.push({ offer_key: key, offer_name: name, change_type: 'campaign_started', field: 'discount_window', before: null, after: { start: curDates.start, end: curDates.end } });
    } else if (hadDates && !hasDates && curDiscounted) {
      changes.push({ offer_key: key, offer_name: name, change_type: 'campaign_date_change', field: 'discount_window', before: { start: priorDates.start, end: priorDates.end }, after: null });
    } else if (hadDates && hasDates && (priorDates.start !== curDates.start || priorDates.end !== curDates.end)) {
      changes.push({ offer_key: key, offer_name: name, change_type: 'campaign_date_change', field: 'discount_window', before: { start: priorDates.start, end: priorDates.end }, after: { start: curDates.start, end: curDates.end } });
    }

    // Router market observation.
    if (Number.isInteger(prior.provider_count) && Number.isInteger(current.provider_count) &&
        prior.provider_count !== current.provider_count) {
      changes.push({ offer_key: key, offer_name: name, change_type: 'provider_count_change', field: 'provider_count', before: prior.provider_count, after: current.provider_count });
    }

    // Context window.
    const priorCtx = typeof priorFacts.context_tokens === 'number' ? priorFacts.context_tokens : null;
    const curCtx = typeof curFacts.context_tokens === 'number' ? curFacts.context_tokens : null;
    if (priorCtx !== null && curCtx !== null && priorCtx !== curCtx) {
      changes.push({ offer_key: key, offer_name: name, change_type: 'context_change', field: 'context_tokens', before: priorCtx, after: curCtx });
    }

    // Rate limit / quota text.
    const priorQuota = quotaText(prior);
    const curQuota = quotaText(current);
    if (priorQuota && curQuota && priorQuota !== curQuota) {
      changes.push({ offer_key: key, offer_name: name, change_type: 'rate_limit_change', field: 'free_quota', before: priorFacts.free_quota_text || priorFacts.free_limits || null, after: curFacts.free_quota_text || curFacts.free_limits || null });
    }

    // Data policy hash. before / after carry the verbatim text excerpt so
    // the report can show what the policy said before and after (spec §4.6).
    if ((prior.data_policy_hash || null) !== (current.data_policy_hash || null) &&
        (prior.data_policy_hash || current.data_policy_hash)) {
      const policyTextOf = (o) => {
        const p = o.data_policy_json;
        return p && typeof p === 'object' && typeof p.text === 'string' ? p.text : null;
      };
      const excerpt = (text) => (text === null ? null : text.slice(0, 160) + (text.length > 160 ? '…' : ''));
      changes.push({
        offer_key: key, offer_name: name, change_type: 'data_policy_change', field: 'data_policy',
        before: { hash: prior.data_policy_hash || null, text: excerpt(policyTextOf(prior)) },
        after: { hash: current.data_policy_hash || null, text: excerpt(policyTextOf(current)) },
      });
    }

    // Capability (tool calling / structured output) turns on or off.
    const priorCap = [Boolean(priorFacts.tool_calling), Boolean(priorFacts.structured_output)];
    const curCap = [Boolean(curFacts.tool_calling), Boolean(curFacts.structured_output)];
    if (priorCap.some((v, i) => v !== curCap[i])) {
      changes.push({ offer_key: key, offer_name: name, change_type: 'capability_change', field: 'capabilities', before: { tool_calling: priorCap[0], structured_output: priorCap[1] }, after: { tool_calling: curCap[0], structured_output: curCap[1] } });
    }

    // Endpoint / provider move.
    if (priorFacts.endpoint_source && curFacts.endpoint_source &&
        priorFacts.endpoint_source !== curFacts.endpoint_source) {
      changes.push({ offer_key: key, offer_name: name, change_type: 'provider_change', field: 'endpoint_source', before: priorFacts.endpoint_source, after: curFacts.endpoint_source });
    }

    // Anything left over that changed liveness-ish state.
    if (prior.status !== current.status) {
      changes.push({ offer_key: key, offer_name: name, change_type: 'availability_change', field: 'liveness', before: prior.status, after: current.status });
    }
  }

  // Ended offers that no longer exist at all (row removed from the current
  // candidate view is impossible: confirmed_removed rows persist). The
  // renamed old ids are not "ended".
  for (const [key, prior] of priorByKey) {
    if (currentByKey.has(key) || renamedPrior.has(key)) continue;
    if (prior.status === 'confirmed_removed') continue;
    const type = prior.discount_start_at || prior.discount_end_at ? 'campaign_ended' : 'ended';
    changes.push({ offer_key: key, offer_name: nameOf(prior), change_type: type, field: 'liveness', before: prior.status, after: 'confirmed_removed' });
  }

  // Deterministic report ordering by priority class.
  const classOf = (change) => {
    if (change.change_type === 'new' && change.after && change.after.free) return CHANGE_PRIORITY.new_free;
    if (change.change_type === 'ended' || change.change_type === 'campaign_ended') return CHANGE_PRIORITY.ended;
    if (change.change_type === 'price_change' || change.change_type === 'discount_rate_change' ||
        change.change_type === 'free_status_change') {
      const before = change.before || {};
      const after = change.after || {};
      const beforeSum = (before.input || 0) + (before.output || 0);
      const afterSum = (after.input || 0) + (after.output || 0);
      return afterSum < beforeSum ? CHANGE_PRIORITY.price_drop : CHANGE_PRIORITY.other;
    }
    return CHANGE_PRIORITY.other;
  };
  changes.forEach((change, index) => { change._order = classOf(change) * 100000 + index; });
  changes.sort((a, b) => a._order - b._order);
  for (const change of changes) delete change._order;
  return changes;
}

const CHANGE_FALLBACK_JA = {
  new: (n) => `${n} が新たにランキング対象になりました。`,
  ended: (n) => `${n} の無料提供が終了しました。`,
  revived: (n) => `${n} の無料提供が再開しました。`,
  price_change: (n) => `${n} の無料枠・価格条件が変わりました。`,
  discount_rate_change: (n) => `${n} の割引率が変更になりました。`,
  provider_count_change: (n) => `${n} の提供プロバイダ数が変わりました。`,
  free_status_change: (n) => `${n} の無料 / 有料状況が反転しました。`,
  limit_change: (n) => `${n} の無料枠の条件が変わりました。`,
  provider_change: (n) => `${n} の提供元・エンドポイントが変わりました。`,
  availability_change: (n) => `${n} の提供状況が変わりました。`,
  context_change: (n) => `${n} のコンテキスト長が変わりました。`,
  model_id_change: (n) => `${n} のモデル ID が変更になりました。`,
  rate_limit_change: (n) => `${n} のレート制限・無料枠条件が変わりました。`,
  data_policy_change: (n) => `${n} のデータ利用条件が変わりました。`,
  capability_change: (n) => `${n} の機能（ツール呼び出し等）が変わりました。`,
  campaign_started: (n) => `${n} のキャンペーン（割引期間）が始まりました。`,
  campaign_ended: (n) => `${n} の割引キャンペーンが終了しました。`,
  campaign_date_change: (n) => `${n} のキャンペーン期間が変わりました。`,
  end_date_change: (n) => `${n} の提供期限が変わりました。`,
};

// ---------------------------------------------------------------------------
// Report assembly (AC-12: deterministic code combines prose and state)
// ---------------------------------------------------------------------------

function readJsonIfPresent(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Builds one public offer object (daily_report schema offer def) from a
// candidate, its classification, and its editorial prose.
function toPublicOffer(candidate, classification, prose, rank) {
  const offer = {
    rank: rank || null,
    name: candidate.name,
    model_name: candidate.model_name,
    provider: candidate.provider,
    model_vendor: candidate.model_vendor,
    delivery_type: candidate.delivery_type,
    classification: classification || candidate.classification,
    start_at: null,
    end_at: candidate.facts.end_at || null,
    end_timezone_known: false,
    regions: [],
    registration_conditions: Array.isArray(candidate.registration_conditions)
      ? candidate.registration_conditions
      : [],
    card_required: null,
    minimum_deposit: null,
    kyc_required: null,
    auto_renewal: null,
    refund_policy: null,
    free_limits: candidate.free_limits,
    rate_limits: candidate.rate_limits,
    context_tokens: candidate.context_tokens ?? (typeof candidate.facts.context_tokens === 'number' ? candidate.facts.context_tokens : null),
    max_output_tokens: candidate.max_output_tokens ?? (typeof candidate.facts.max_output_tokens === 'number' ? candidate.facts.max_output_tokens : null),
    tool_calling: candidate.tool_calling ?? null,
    structured_output: candidate.structured_output ?? null,
    image_input: candidate.image_input ?? null,
    base_url: candidate.base_url,
    model_id: candidate.exact_model_id,
    provider_count: candidate.provider_count ?? null,
    recent_activity: (prose && prose.summary) || candidate.description || null,
    normal_price_per_million: candidate.normal_price_per_million || null,
    effective_price_per_million: candidate.effective_price_per_million || null,
    effective_discount_percent: null,
    discount_rates: null,
    data_retention: null,
    data_policy: candidate.data_policy || null,
    data_policy_source: candidate.data_policy_source || null,
    free_endpoint_status: candidate.free_endpoint_status || null,
    operational_evidence: gate3Evidence(candidate),
    activity: candidate.activity_evidence || null,
    training_use: candidate.training_use || null,
    suspicion_score: candidate.suspicion_score,
    suspicion_reasons: Array.isArray(candidate.suspicion_reasons) ? candidate.suspicion_reasons : [],
    information_confidence: deriveInformationConfidence(candidate),
    operational_confidence: deriveOperationalConfidence(candidate),
    ranking_eligible: false,
    exclusion_reason: null,
    last_verified: candidate.last_verified,
    endpoint_source: candidate.endpoint_source,
    provider_key: candidate.provider_key,
    canonical_model_id: candidate.canonical_model_id,
    access_kind: candidate.access_kind,
    price_source: candidate.price_source || null,
    price_verified_at: candidate.price_verified_at || null,
    discount_start_at: candidate.discount_start_at || null,
    discount_end_at: candidate.discount_end_at || null,
    free_allowance_rank: candidate.free_allowance_rank,
    total_parameters_b: candidate.total_parameters_b,
    active_parameters_b: candidate.active_parameters_b,
    sources: candidate.sources,
    benchmark: candidate.benchmark,
    benchmarks: candidate.benchmarks,
    benchmark_key: candidate.benchmark_key,
  };
  return offer;
}

// Loads the current offer state and the pre run backup state for the
// deterministic diff. The candidate view step uses this to write the
// changes preview the editor reads; assembleReport uses it for the final
// change records. Same inputs, same deterministic output.
function loadOfferDiffInputs(runDir, options = {}) {
  const priorOffers = loadOffersFromBackup(runDir);
  const database = db.openCollectorDb(options);
  let currentOffers;
  try {
    currentOffers = database.prepare('SELECT * FROM offers ORDER BY provider_key, exact_model_id')
      .all().map((row) => db.parseRow('offers', row));
  } finally {
    database.close();
  }
  return { currentOffers, priorOffers };
}

// Assembles the full staged daily report from SQLite current state, the
// staged editorial prose, and the classifier output. Writes
// <run_dir>/candidate/report.json and <run_dir>/candidate/provider-registry.json.
// Returns { report, counts, candidateDir }.
function assembleReport(runId, runDir, options = {}) {
  const paths = db.resolvePaths(options);
  const now = options.now || nowIso();
  const providers = loadRegistryProviders(paths.registryPath);

  const view = buildCandidateView(options);
  const candidatesByKey = new Map(view.candidates.map((c) => [c.offer_key, c]));

  // Staged LLM outputs (prose and classification only).
  const editorial = readJsonIfPresent(options.editorialPath || (runDir && path.join(runDir, 'candidate', 'editorial.json')));
  const classifications = readJsonIfPresent(options.classificationsPath || (runDir && path.join(runDir, 'reduced', 'classifications.json')));

  const proseByKey = new Map();
  if (editorial && Array.isArray(editorial.offer_prose)) {
    for (const prose of editorial.offer_prose) {
      if (prose && typeof prose.offer_key === 'string') proseByKey.set(prose.offer_key, prose);
    }
  }
  // Classification is attached to the exact provider and model transport
  // identity. Display names are not unique: a router can expose both
  // `model` and `model:free` with the same name but different prices.
  const classificationByKey = new Map();
  const legacyClassificationsByName = new Map();
  const classifierEntryByKey = new Map();
  if (classifications && Array.isArray(classifications.classifications)) {
    for (const entry of classifications.classifications) {
      if (!entry || typeof entry.classification !== 'string') continue;
      if (typeof entry.offer_key === 'string' && entry.offer_key.length > 0) {
        classificationByKey.set(entry.offer_key, entry.classification);
        classifierEntryByKey.set(entry.offer_key, entry);
      }
      // Read old artifacts without allowing an ambiguous display name to
      // classify multiple exact offers. New schema output never uses this
      // fallback, but it keeps recovery of an old run fail safe.
      if (typeof entry.name === 'string' && entry.name.length > 0) {
        const values = legacyClassificationsByName.get(entry.name) || [];
        values.push(entry.classification);
        legacyClassificationsByName.set(entry.name, values);
      }
    }
  }

  // Classify each candidate: the classifier overrides the provisional call.
  // Phase 3 wiring (spec §12): the classifier's suspicion_score and
  // reasoning are adopted by the assembler. The classifier value can only
  // raise the deterministic base (offer column + unregistered floor), it is
  // clamped to the 0..5 scale, and 4-5 never ranks (decideEligibility).
  const adoptClassifierSuspicion = (candidate) => {
    const entry = classifierEntryByKey.get(candidate.offer_key);
    if (!entry) return;
    const raw = Number(entry.suspicion_score);
    if (Number.isFinite(raw)) {
      const clamped = Math.max(0, Math.min(5, Math.round(raw)));
      if (clamped > candidate.suspicion_score) candidate.suspicion_score = clamped;
    }
    if (typeof entry.reasoning === 'string' && entry.reasoning.trim()) {
      candidate.suspicion_reasons = [entry.reasoning.trim()];
    }
  };
  const ranked = [];
  const conditional = [];
  const caution = [];
  const excluded = [];

  for (const candidate of view.candidates) {
    const prose = proseByKey.get(candidate.offer_key) || null;
    adoptClassifierSuspicion(candidate);
    const legacyValues = legacyClassificationsByName.get(candidate.name);
    const legacyClassification = legacyValues && legacyValues.length === 1
      ? legacyValues[0]
      : null;
    const classification = classificationByKey.get(candidate.offer_key) ||
      legacyClassification || candidate.classification;

    // Stale run four discloses staleness in caution before any eligibility
    // gate (the fail-safe convention: carried-over facts stay visible).
    if (candidate.in_caution) {
      const cautionOffer = toPublicOffer(candidate, classification, prose, null);
      cautionOffer.ranking_eligible = false;
      cautionOffer.exclusion_reason = `[stale] ${candidate.consecutive_failures} consecutive failed verifications; moved to caution (AC-3)`;
      caution.push(cautionOffer);
      continue;
    }

    // DISCOUNTED frontier offers are evaluated in the discount section
    // below; they never enter the ranked loop or the exclusion list here
    // (spec 0008 §4.11).
    if (candidate.access_kind === 'DISCOUNTED') continue;

    const eligibility = decideEligibility(candidate);

    if (!eligibility.eligible) {
      const offer = toPublicOffer(candidate, classification, prose, null);
      offer.ranking_eligible = false;
      offer.exclusion_reason = eligibility.reason;
      excluded.push({ name: candidate.name, reason: eligibility.reason, last_known_status: candidate.status });
      // Keep the full offer out of ranked; record only the exclusion entry.
      continue;
    }

    const offer = toPublicOffer(candidate, classification, prose, null);
    offer.ranking_eligible = true;

    if (classification === 'F_CONDITIONAL') {
      // Data sharing opt in free tiers are conditional credits (AGENTS.md).
      offer.ranking_eligible = false;
      offer.exclusion_reason = '[conditional] free tier requires data sharing opt in (F_CONDITIONAL)';
      conditional.push(offer);
      continue;
    }

    ranked.push({ offer, candidate });
  }

  ranked.sort((a, b) => compareRanked(a.candidate, b.candidate));
  const rankedOffers = ranked.map((entry, index) => {
    entry.offer.rank = index + 1;
    return entry.offer;
  });

  // Spec 0008 §4.11: DISCOUNTED frontier offers. They are evaluated here,
  // never in the ranked loop: a discounted frontier model shows at any
  // absolute price, with normal price, current price, discount rate, and
  // window always displayed (deterministic computation).
  const discountOffers = [];
  for (const candidate of view.candidates) {
    if (candidate.access_kind !== 'DISCOUNTED') continue;
    const eligibility = decideDiscountEligibility(candidate);
    if (!eligibility.eligible) {
      excluded.push({ name: candidate.name, reason: eligibility.reason, last_known_status: candidate.status });
      continue;
    }
    const prose = proseByKey.get(candidate.offer_key) || null;
    const classification = classificationByKey.get(candidate.offer_key) || candidate.classification;
    const offer = toPublicOffer(candidate, classification, prose, null);
    offer.ranking_eligible = false;
    offer.access_kind = 'DISCOUNTED';
    const normal = candidate.normal_price_per_million || {};
    const effective = candidate.effective_price_per_million || {};
    offer.discount_rates = rankingPolicy.discountRates(
      normal.input, normal.output, effective.input, effective.output
    );
    discountOffers.push(offer);
  }

  // Open contradictions (spec 0008 §4.5): within-run disagreements between
  // fetch evidences of different source tiers, resolved by the lowest tier.
  let contradictions = [];
  try {
    const open = db.listContradictions({ openOnly: true }, options);
    contradictions = open.map((entry) => {
      const offerKey = typeof entry.change_key === 'string' && entry.change_key.startsWith('offer:')
        ? entry.change_key.slice('offer:'.length)
        : entry.change_key;
      const candidate = candidatesByKey.get(offerKey);
      return {
        offer_name: candidate ? candidate.name : offerKey,
        fact: entry.fact,
        values: (entry.values_json || []).map((v) => ({
          source: v.source_url || null,
          value: v.value,
        })),
        adopted_value: entry.resolved_value ?? null,
        note: entry.resolution_rule || 'lowest_source_tier',
      };
    });
  } catch { /* table absent in very old fixtures: no contradictions */ }

  // Change records: deterministic diff plus editorial Japanese summaries.
  const { currentOffers, priorOffers } = loadOfferDiffInputs(runDir, options);
  const rawChanges = computeChanges(currentOffers, priorOffers);
  // Persist the structured diff to the changes table (per-run append; the
  // durable audit trail behind the report's change section, spec §4.6).
  for (const change of rawChanges) {
    try {
      db.recordChange(runId, {
        change_key: `offer:${change.offer_key}`,
        change_type: change.change_type,
        field: change.field ?? null,
        before: change.before ?? null,
        after: change.after ?? null,
        detected_at: now,
      }, options);
    } catch { /* persistence is best effort; the report still carries them */ }
  }
  const changeProseByKey = new Map();
  if (editorial && Array.isArray(editorial.change_prose)) {
    for (const entry of editorial.change_prose) {
      if (entry && typeof entry.offer_name === 'string' && typeof entry.change_type === 'string') {
        changeProseByKey.set(`${entry.offer_name}\u0000${entry.change_type}`, entry.summary);
      }
    }
  }
  const changes = rawChanges
    .filter((change) => CHANGE_TYPES.includes(change.change_type))
    .slice(0, 10)
    .map((change) => {
      const fallback = CHANGE_FALLBACK_JA[change.change_type] || ((n) => `${n} の状況が変わりました。`);
      const summary = changeProseByKey.get(`${change.offer_name}\u0000${change.change_type}`) ||
        fallback(change.offer_name);
      const record = { offer_name: change.offer_name, change_type: change.change_type, summary };
      if (change.field !== undefined) record.field = change.field;
      if (change.before !== undefined) record.before = change.before;
      if (change.after !== undefined) record.after = change.after;
      if (change.discount_before !== undefined) record.discount_before = change.discount_before;
      if (change.discount_after !== undefined) record.discount_after = change.discount_after;
      return record;
    });

  // New models from the discovery candidate set (best effort, deterministic).
  const newModels = buildNewModels(runDir);

  // Spec 0008 Phase 3: product / program monitor sections. The observe
  // phase already applied the worker artifacts (watchlist-key filtered);
  // an empty entries array is the legitimate "no change" day and the site
  // renders the explicit no-change line for it.
  const productUpdatesPayload = readJsonIfPresent(runDir && path.join(runDir, 'reduced', 'product-updates.json'));
  const startupCreditsPayload = readJsonIfPresent(runDir && path.join(runDir, 'reduced', 'startup-credits.json'));
  const productUpdates = Array.isArray(productUpdatesPayload && productUpdatesPayload.entries)
    ? productUpdatesPayload.entries
    : [];
  const startupCredits = Array.isArray(startupCreditsPayload && startupCreditsPayload.entries)
    ? startupCreditsPayload.entries
    : [];

  // Top level sources: union of offer sources and benchmark sources.
  const sourceSet = new Map();
  for (const candidate of view.candidates) {
    for (const url of candidate.sources) {
      if (!sourceSet.has(url)) {
        sourceSet.set(url, { url, source_type: 'official', accessed_at: candidate.last_verified || now });
      }
    }
  }

  // Accepted provider registration candidates (spec 0004 AC-11) become part
  // of the candidate Registry (validated by publication before promotion) and
  // are reported as new seed candidates. Rejected candidates are not
  // Registry changes; they surface in the reduced provider-candidates.json
  // for the operator.
  const providerCandidateEntries = [];
  const seedCandidates = [];
  const providerCandidates = readJsonIfPresent(runDir && path.join(runDir, 'reduced', 'provider-candidates.json'));
  if (providerCandidates && Array.isArray(providerCandidates.candidates)) {
    for (const candidate of providerCandidates.candidates) {
      if (candidate && candidate.accepted === true && candidate.entry && candidate.entry.key) {
        providerCandidateEntries.push(candidate.entry);
        seedCandidates.push({
          name: candidate.entry.label,
          type: 'provider',
          recommend_add: true,
          reason: `registered from ${candidate.entry.added_from}`,
        });
      }
    }
  }

  // Summary counts are code-owned; staged editorial.summary is intentionally
  // ignored so LLM-authored counts cannot reach the public report.
  const summary = buildReportSummary({
    ranked_offers: rankedOffers,
    caution_offers: caution,
    excluded_offers: excluded,
  });

  const report = {
    generated_at: now,
    timezone: options.timezone || 'Asia/Tokyo',
    summary,
    new_models: newModels,
    changes,
    ranked_offers: rankedOffers,
    discount_offers: discountOffers,
    product_updates: productUpdates,
    startup_credits: startupCredits,
    conditional_credits: conditional,
    caution_offers: caution,
    excluded_offers: excluded,
    new_seed_candidates: seedCandidates,
    contradictions,
    sources: [...sourceSet.values()],
  };

  // Write the staged generation under the candidate directory (AC-13 layout;
  // validation and promotion are slice 4 and operate only on these files).
  const candidateDir = path.join(runDir, 'candidate');
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.writeFileSync(path.join(candidateDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const candidateProviders = providers.concat(providerCandidateEntries);
  fs.writeFileSync(
    path.join(candidateDir, 'provider-registry.json'),
    `${JSON.stringify({ version: 'candidate', providers: candidateProviders }, null, 2)}\n`
  );

  return {
    report,
    candidateDir,
    counts: {
      ranked: rankedOffers.length,
      discounted: discountOffers.length,
      conditional: conditional.length,
      caution: caution.length,
      excluded: excluded.length,
      changes: changes.length,
      newModels: newModels.length,
      contradictions: contradictions.length,
    },
  };
}

// Builds new_models entries. Spec 0008 Phase 1: entries now come from both
// the discovery candidate set and the deterministic model lane (verified
// announcements of this run), and each entry carries a recency window tag
// (hot 24h / warm 72h / catchup 30d / undated) plus a distribution_note
// summarizing the model fan out route verdicts. No route ever reads as more
// confirmed than the notes say: no verdict is an explicit "unconfirmed" note.
function buildNewModels(runDir, now = new Date().toISOString()) {
  const models = [];
  const noteKeys = new Map();
  const seen = new Set();
  const push = (entry, extraKeys = []) => {
    if (!entry || !entry.canonical_name || seen.has(entry.canonical_name)) return;
    seen.add(entry.canonical_name);
    models.push({ ...entry });
    noteKeys.set(entry.canonical_name, extraKeys);
  };

  // 1. Verified announcements from this run's model lane.
  const updates = readJsonIfPresent(runDir && path.join(runDir, 'reduced', 'model-updates.json'));
  if (updates && Array.isArray(updates.announcements)) {
    for (const ann of updates.announcements) {
      push({
        canonical_name: ann.model_name,
        aliases: Array.isArray(ann.aliases) ? ann.aliases : [],
        vendor: ann.vendor_key || 'unknown',
        status: 'announced',
        release_date: ann.release_date || null,
        official_source: ann.source_url,
        api_available: null,
        open_weight: null,
        known_providers: [],
      }, [ann.canonical_model_id, ...(Array.isArray(ann.aliases) ? ann.aliases : [])]);
    }
  }

  // 2. Discovery candidates (legacy path: discovery lane model facts).
  const data = readJsonIfPresent(runDir && path.join(runDir, 'reduced', 'discovery-candidates.json'));
  if (data && Array.isArray(data.candidates)) {
    for (const candidate of data.candidates) {
      if (candidate.reappearance) continue;
      const facts = candidate.facts && typeof candidate.facts === 'object' ? candidate.facts : {};
      const canonicalName = candidate.model_name || candidate.canonical_model_id;
      const officialSource = facts.endpoint_source || facts.docs_url || facts.official_source || null;
      if (!canonicalName || !officialSource || !/^https?:\/\//.test(officialSource)) continue;
      push({
        canonical_name: canonicalName,
        aliases: [],
        vendor: facts.model_vendor || (candidate.canonical_model_id.includes('/')
          ? candidate.canonical_model_id.split('/')[0]
          : candidate.provider_key) || 'unknown',
        status: 'announced',
        release_date: typeof facts.release_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(facts.release_date.trim())
          ? facts.release_date.trim()
          : null,
        official_source: officialSource,
        api_available: true,
        open_weight: null,
        known_providers: candidate.provider_key ? [candidate.provider_key] : [],
      }, [candidate.canonical_model_id]);
    }
  }

  // 3. Window tag + distribution note. Notes are keyed by model id, so each
  // entry looks up by display name, canonical id, and all known aliases.
  const notes = readJsonIfPresent(runDir && path.join(runDir, 'reduced', 'distribution-notes.json'));
  const noteByModel = new Map();
  const addNoteKey = (key, note) => {
    const k = key.replace(/\//g, '').toLowerCase();
    if (!k) return;
    if (!noteByModel.has(k)) noteByModel.set(k, []);
    noteByModel.get(k).push(note);
  };
  if (notes && Array.isArray(notes.notes)) {
    for (const note of notes.notes) {
      if (!note || typeof note.model_id !== 'string') continue;
      addNoteKey(note.model_id, note);
    }
  }
  for (const entry of models) {
    entry.window = modelWindowTag(entry.release_date, now);
    const noteGroups = [];
    const seenNotes = new Set();
    const collect = (name) => {
      if (typeof name !== 'string' || !name) return;
      for (const note of noteByModel.get(name.replace(/\//g, '').toLowerCase()) || []) {
        if (seenNotes.has(note)) continue;
        seenNotes.add(note);
        noteGroups.push(note);
      }
    };
    collect(entry.canonical_name);
    for (const alias of entry.aliases || []) collect(alias);
    for (const key of noteKeys.get(entry.canonical_name) || []) collect(key);
    entry.distribution_note = noteGroups.length > 0
      ? noteGroups.map((n) => `${n.status}: ${n.provider_key || 'unknown'}`).join('; ')
      : 'unconfirmed (no route verification this run)';
  }
  return models;
}

// hot = 24h, warm = 72h, catchup = 30d, undated when no release date.
function modelWindowTag(releaseDate, now) {
  if (typeof releaseDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return 'undated';
  const t = Date.parse(`${releaseDate}T00:00:00Z`);
  if (Number.isNaN(t)) return 'undated';
  const ageMs = Date.parse(now) - t;
  if (ageMs <= 86400000) return 'hot';
  if (ageMs <= 3 * 86400000) return 'warm';
  if (ageMs <= 30 * 86400000) return 'catchup';
  return 'catchup';
}

module.exports = {
  TIER_ORDER,
  ACCESS_ORDER,
  LOCAL_MODEL_GATE_B,
  CAUTION_FAILURES,
  offerKey,
  deriveDeliveryType,
  deriveAllowance,
  deriveParamsB,
  deriveTrainingUse,
  deriveRegistrationConditions,
  deriveCapability,
  deriveAccessKind,
  priceObject,
  deriveClassificationProvisional,
  deriveInformationConfidence,
  deriveOperationalConfidence,
  buildCandidateView,
  decideEligibility,
  compareRanked,
  loadOffersFromBackup,
  loadOfferDiffInputs,
  computeChanges,
  toPublicOffer,
  assembleReport,
  buildNewModels,
};
