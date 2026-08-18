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
  'new', 'price_change', 'limit_change', 'provider_change',
  'end_date_change', 'ended', 'revived', 'availability_change',
];

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

// Operational confidence: HIGH when verified this run, MEDIUM while stale
// runs one through three, LOW in caution or removed state.
function deriveOperationalConfidence(offer) {
  if (offer.status === 'confirmed_removed') return 'LOW';
  if (offer.status === 'stale') {
    return (offer.consecutive_failures || 0) >= CAUTION_FAILURES ? 'LOW' : 'MEDIUM';
  }
  return 'HIGH';
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
  try {
    offers = database.prepare(
      'SELECT * FROM offers ORDER BY provider_key, exact_model_id'
    ).all().map((row) => db.parseRow('offers', row));
  } finally {
    database.close();
  }
  const { byModel } = benchmarks.loadCurrentBenchmarks(options);

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
    const accessKind = deriveAccessKind(
      offer.effective_input_price_usd, offer.effective_output_price_usd
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
      suspicion_score: 0,
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

// Deterministic change records: exact identity, pricing hash, quota facts,
// endpoint, benchmark key, and liveness diffs from the last promoted state
// (spec value sourcing). The Editor supplies the Japanese summary; the
// assembler provides a deterministic fallback so changes never depend on prose.
function computeChanges(currentOffers, priorOffers) {
  const priorByKey = new Map(priorOffers.map((o) => [offerKey(o.provider_key, o.exact_model_id), o]));
  const currentByKey = new Map(currentOffers.map((o) => [offerKey(o.provider_key, o.exact_model_id), o]));
  const changes = [];

  const nameOf = (offer) => {
    const facts = offer.facts_json && typeof offer.facts_json === 'object' ? offer.facts_json : {};
    return facts.name || facts.model_name || offer.canonical_model_id;
  };

  for (const [key, current] of currentByKey) {
    const prior = priorByKey.get(key);
    const name = nameOf(current);
    if (!prior) {
      if (current.status !== 'confirmed_removed') {
        changes.push({ offer_key: key, offer_name: name, change_type: 'new', diffs: ['first seen this run'] });
      }
      continue;
    }
    const diffs = [];
    let changeType = null;
    if (prior.status === 'confirmed_removed' && current.status !== 'confirmed_removed') {
      changeType = 'revived';
      diffs.push(`liveness: ${prior.status} -> ${current.status}`);
    } else if (prior.status !== 'confirmed_removed' && current.status === 'confirmed_removed') {
      changeType = 'ended';
      diffs.push(`liveness: ${prior.status} -> confirmed_removed`);
    }
    if (prior.pricing_hash && current.pricing_hash && prior.pricing_hash !== current.pricing_hash) {
      diffs.push('pricing_hash changed');
      if (!changeType) changeType = 'price_change';
    }
    // Typed effective price change detection (spec 0004 AC-3). A change in
    // either effective price is a price change regardless of the hash.
    const priorEffIn = prior.effective_input_price_usd;
    const curEffIn = current.effective_input_price_usd;
    const priorEffOut = prior.effective_output_price_usd;
    const curEffOut = current.effective_output_price_usd;
    if ((priorEffIn !== undefined && curEffIn !== undefined && priorEffIn !== curEffIn) ||
        (priorEffOut !== undefined && curEffOut !== undefined && priorEffOut !== curEffOut)) {
      diffs.push(`effective price: ${priorEffIn}/${priorEffOut} -> ${curEffIn}/${curEffOut}`);
      if (!changeType) changeType = 'price_change';
    }
    const priorFacts = prior.facts_json && typeof prior.facts_json === 'object' ? prior.facts_json : {};
    const curFacts = current.facts_json && typeof current.facts_json === 'object' ? current.facts_json : {};
    const priorQuota = String(priorFacts.free_quota_text || priorFacts.free_limits || '');
    const curQuota = String(curFacts.free_quota_text || curFacts.free_limits || '');
    if (priorQuota && curQuota && priorQuota !== curQuota) {
      diffs.push('free quota text changed');
      if (!changeType) changeType = 'limit_change';
    }
    if (priorFacts.endpoint_source && curFacts.endpoint_source &&
        priorFacts.endpoint_source !== curFacts.endpoint_source) {
      diffs.push(`endpoint_source: ${priorFacts.endpoint_source} -> ${curFacts.endpoint_source}`);
      if (!changeType) changeType = 'provider_change';
    }
    if (!changeType && prior.status !== current.status) {
      changeType = 'availability_change';
      diffs.push(`liveness: ${prior.status} -> ${current.status}`);
    }
    if (changeType) {
      changes.push({ offer_key: key, offer_name: name, change_type: changeType, diffs });
    }
  }
  return changes;
}

const CHANGE_FALLBACK_JA = {
  new: (n) => `${n} が新たにランキング対象になりました。`,
  ended: (n) => `${n} の無料提供が終了しました。`,
  revived: (n) => `${n} の無料提供が再開しました。`,
  price_change: (n) => `${n} の無料枠・価格条件が変わりました。`,
  limit_change: (n) => `${n} の無料枠の条件が変わりました。`,
  provider_change: (n) => `${n} の提供元・エンドポイントが変わりました。`,
  availability_change: (n) => `${n} の提供状況が変わりました。`,
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
    provider_count: null,
    recent_activity: (prose && prose.summary) || candidate.description || null,
    normal_price_per_million: candidate.normal_price_per_million || null,
    effective_price_per_million: candidate.effective_price_per_million || null,
    effective_discount_percent: null,
    data_retention: null,
    training_use: candidate.training_use || null,
    suspicion_score: candidate.suspicion_score,
    suspicion_reasons: [],
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
  if (classifications && Array.isArray(classifications.classifications)) {
    for (const entry of classifications.classifications) {
      if (!entry || typeof entry.classification !== 'string') continue;
      if (typeof entry.offer_key === 'string' && entry.offer_key.length > 0) {
        classificationByKey.set(entry.offer_key, entry.classification);
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
  const ranked = [];
  const conditional = [];
  const caution = [];
  const excluded = [];

  for (const candidate of view.candidates) {
    const prose = proseByKey.get(candidate.offer_key) || null;
    const legacyValues = legacyClassificationsByName.get(candidate.name);
    const legacyClassification = legacyValues && legacyValues.length === 1
      ? legacyValues[0]
      : null;
    const classification = classificationByKey.get(candidate.offer_key) ||
      legacyClassification || candidate.classification;
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

    if (candidate.in_caution) {
      // Stale run four: move to caution, keep prior facts, disclose staleness.
      offer.ranking_eligible = false;
      offer.exclusion_reason = `[stale] ${candidate.consecutive_failures} consecutive failed verifications; moved to caution (AC-3)`;
      caution.push(offer);
      continue;
    }

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

  // Change records: deterministic diff plus editorial Japanese summaries.
  const priorOffers = loadOffersFromBackup(runDir);
  const database = db.openCollectorDb(options);
  let currentOffers;
  try {
    currentOffers = database.prepare('SELECT * FROM offers ORDER BY provider_key, exact_model_id')
      .all().map((row) => db.parseRow('offers', row));
  } finally {
    database.close();
  }
  const rawChanges = computeChanges(currentOffers, priorOffers);
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
    .map((change) => {
      const fallback = CHANGE_FALLBACK_JA[change.change_type] || ((n) => `${n} の状況が変わりました。`);
      const summary = changeProseByKey.get(`${change.offer_name}\u0000${change.change_type}`) ||
        fallback(change.offer_name);
      return { offer_name: change.offer_name, change_type: change.change_type, summary };
    });

  // New models from the discovery candidate set (best effort, deterministic).
  const newModels = buildNewModels(runDir);

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
    conditional_credits: conditional,
    caution_offers: caution,
    excluded_offers: excluded,
    new_seed_candidates: seedCandidates,
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
      conditional: conditional.length,
      caution: caution.length,
      excluded: excluded.length,
      changes: changes.length,
      newModels: newModels.length,
    },
  };
}

// Builds new_models entries from the discovery candidate set the lane reducer
// wrote. Only entries carrying the schema required fields are emitted; the
// rest are skipped (a thin, deterministic path; the discovery lane owns the
// underlying facts).
function buildNewModels(runDir) {
  const file = runDir && path.join(runDir, 'reduced', 'discovery-candidates.json');
  const data = readJsonIfPresent(file);
  if (!data || !Array.isArray(data.candidates)) return [];
  const models = [];
  const seen = new Set();
  for (const candidate of data.candidates) {
    if (candidate.reappearance) continue;
    const facts = candidate.facts && typeof candidate.facts === 'object' ? candidate.facts : {};
    const canonicalName = candidate.model_name || candidate.canonical_model_id;
    if (!canonicalName || seen.has(canonicalName)) continue;
    const officialSource = facts.endpoint_source || facts.docs_url || facts.official_source || null;
    if (!officialSource || !/^https?:\/\//.test(officialSource)) continue;
    seen.add(canonicalName);
    models.push({
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
    });
  }
  return models;
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
  computeChanges,
  toPublicOffer,
  assembleReport,
  buildNewModels,
};
