'use strict';

// Verified benchmark reuse with bulk leaderboard ingestion and targeted
// fallback research. Spec 0003 fail safe collection pipeline, child 0003
// (AC-7 through AC-10, AC-11, and the benchmark cases of AC-18).
//
// Accepted benchmark facts live only in the SQLite benchmarks table. LLM
// benchmark results stay proposals inside the run task result_json until a
// deterministic check accepts them. A proposal is never a fact.
//
// Rules:
//   * AC-7  Existing benchmark facts resolve by canonical model ID and
//           internal benchmark key and copy into the run candidate without
//           replacement. Source display variants collapse to one internal
//           key (Terminal Bench 2.1 / Terminal-Bench 2.1 -> terminal_bench_2_1).
//           Only current free models without an accepted benchmark fact or a
//           completed benchmark search are searched each day. A completed
//           search is reused even when all proposals were rejected; metadata
//           changes reopen a prior `found` search, and explicit force flags
//           are the re-search escape hatch for any result. Known releases at
//           least six months old are excluded; unknown release dates remain
//           eligible. The queue remains deterministic and is split into chunks
//           of at most four models.
//   * AC-8  A proposal enters current benchmarks only after matching an exact
//           queued model ID, canonical benchmark key and version, a score from
//           0 through 100, and accepted source evidence. A higher proposed
//           score never replaces an existing score (finalizeRun is insert only).
//   * AC-9  Text sources are accepted only when validation confirms the model,
//           benchmark version, and score in the fetched body. Official image
//           sources are accepted only from a vision capable worker that returns
//           all four values with HIGH confidence. Ambiguous, low resolution,
//           unknown version, and MEDIUM or LOW confidence remain pending. The
//           source URL and source hash live in benchmark columns; image hash,
//           extraction time, method, and confidence live in benchmarks.facts_json.
//   * AC-10 an accepted Terminal Bench 2.0 or 2.1 row at 65 or higher is tier
//           S, 50 through 64.999 is tier A. Without either gate row another
//           verified official benchmark supports tier B at most. No verified
//           benchmark is benchmark_pending and is never ranked.
//   * AC-11 A benchmark scout artifact must match its manifest task id and the
//           exact queued model ids; unqueued models are rejected.

const fs = require('node:fs');
const path = require('node:path');

const db = require('./collector-db');
const rankingPolicy = require('../../build/ranking-policy');

// The ranking admission benchmarks (spec 0004 AC-5, child 0002): a model must
// carry a verified Terminal Bench 2.0 or 2.1 score at or above 50. When both
// exist, 2.1 is the representative row. A future version stays pending until
// its key, display name, thresholds, and precedence are added in code and
// tests (spec 0004 follow-up). The keys and threshold are the shared
// ranking-policy module so assembler, validator, and builder never drift.
const RANKING_BENCHMARK_KEYS = rankingPolicy.RANKING_BENCHMARK_KEYS;
const RANKING_BENCHMARK_KEY = rankingPolicy.RANKING_BENCHMARK_KEY;
const RANKING_MIN_SCORE = rankingPolicy.RANKING_MIN_SCORE;

// Tier thresholds for the ranking benchmarks (AC-10 / spec 0004 child 0002).
const TIER_S_SCORE = 65;
const TIER_A_SCORE = 50;

// Search queue chunks hold at most four models for unresolved aliases only
// (AC-7). Complete official leaderboard pages are handled in bulk first.
const QUEUE_CHUNK_SIZE = 4;
const BENCHMARK_RESEARCH_MAX_AGE_MONTHS = 6;

const EXTRACTION_METHODS = ['text', 'official_image'];
const CONFIDENCE_LEVELS = ['HIGH', 'MEDIUM', 'LOW'];
const UNKNOWN_VERSION_VALUES = new Set([
  'unknown', 'n/a', 'na', 'none', 'null', 'undefined', 'undetermined',
]);

// The official Terminal-Bench pages are complete leaderboards. Fetching each
// page once is both faster and safer than asking one LLM worker per model to
// rediscover the same rows. Unmatched aliases remain in the targeted scout
// queue for exceptional cases.
const BULK_LEADERBOARD_SOURCES = Object.freeze([
  {
    benchmark_key: 'terminal_bench_2_1',
    display_name: 'Terminal-Bench 2.1',
    version: '2.1',
    url: 'https://www.tbench.ai/leaderboard/terminal-bench/2.1',
  },
  {
    benchmark_key: 'terminal_bench_2_0',
    display_name: 'Terminal-Bench 2.0',
    version: '2.0',
    url: 'https://www.tbench.ai/leaderboard/terminal-bench/2.0',
  },
]);

function nowIso() {
  return new Date().toISOString();
}

// Fold away punctuation and case so a source page's "Terminal-Bench 2.1",
// "terminal bench 2.1", and a model id like "vendor/model:free" compare
// loosely against prose. Used only for evidence confirmation, never for
// identity (identity is exact).
function fold(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Legacy rows may have been imported before version validation existed. Keep
// those immutable rows in SQLite, but never let an empty or sentinel version
// satisfy a queue gate or tier derivation.
function isUsableBenchmarkVersion(version) {
  if (typeof version !== 'string') return false;
  const normalized = version.trim().toLowerCase();
  return normalized.length > 0 && !UNKNOWN_VERSION_VALUES.has(normalized);
}

function parseReleaseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return null;
  const normalized = value.trim();
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) return null;
  return parsed;
}

function benchmarkResearchCutoff(now) {
  const current = new Date(now);
  if (Number.isNaN(current.getTime())) return null;
  const day = current.getUTCDate();
  const cutoff = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1));
  cutoff.setUTCMonth(cutoff.getUTCMonth() - BENCHMARK_RESEARCH_MAX_AGE_MONTHS);
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay));
  cutoff.setUTCHours(current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds(), current.getUTCMilliseconds());
  return cutoff;
}

function isTooOldForBenchmarkResearch(releaseDate, now) {
  const released = parseReleaseDate(releaseDate);
  const cutoff = benchmarkResearchCutoff(now);
  return !!released && !!cutoff && released <= cutoff;
}

function canonicalForceModelIds(options = {}) {
  const values = Array.isArray(options.forceModelIds) ? options.forceModelIds : [];
  return new Set(values.flatMap((value) => {
    if (typeof value !== 'string' || !value.trim()) return [];
    return [value.trim(), db.canonicalModelId(value.trim())];
  }));
}

// ---------------------------------------------------------------------------
// Existing benchmark reuse (AC-7: copy without replacement)
// ---------------------------------------------------------------------------

// Loads every accepted benchmark row, grouped by canonical model ID. These
// rows are immutable facts: the queue and the report copy them forward
// without replacement.
function loadCurrentBenchmarks(options = {}) {
  const database = db.openCollectorDb(options);
  try {
    const rows = database.prepare(
      'SELECT * FROM benchmarks ORDER BY canonical_model_id, benchmark_key'
    ).all().map((row) => db.parseRow('benchmarks', row));
    const byModel = new Map();
    for (const row of rows) {
      if (!byModel.has(row.canonical_model_id)) byModel.set(row.canonical_model_id, []);
      byModel.get(row.canonical_model_id).push(row);
    }
    return { rows, byModel };
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Deterministic daily search queue (AC-7)
// ---------------------------------------------------------------------------

// Computes a stable metadata hash for a model so a metadata change bumps it
// up the search queue (AC-7 value sourcing: benchmark_searches.metadata_hash).
function modelMetadataHash(facts) {
  const f = facts && typeof facts === 'object' && !Array.isArray(facts) ? facts : {};
  const canonical = JSON.stringify([
    f.canonical_model_id || f.model_id || null,
    f.total_parameters_b ?? null,
    f.active_parameters_b ?? null,
    f.architecture ?? null,
    f.context_tokens ?? null,
    f.release_date ?? null,
  ]);
  return require('node:crypto').createHash('sha256').update(canonical).digest('hex');
}

// Builds the deterministic daily search queue. Normal research considers
// current free canonical models with no accepted benchmark fact, no completed
// benchmark search, and no known release date at least six months old. Unknown
// release dates remain eligible. A force model or benchmark bypasses those
// automatic exclusions for explicit manual re-search. A metadata change
// reopens a prior `found` search, while `not_found` remains terminal until
// forced. "Current free" means an offer that is verified or stale
// (confirmed_removed offers are never searched). One entry per canonical
// model ID. The queue is split into chunks of at most four models.
function buildBenchmarkQueue(options = {}) {
  const now = options.now || nowIso();
  const database = db.openCollectorDb(options);
  let offers;
  let benchmarkRows;
  let searches;
  try {
    offers = database.prepare(
      "SELECT * FROM offers WHERE status IN ('verified', 'stale') AND hidden = 0 " +
      'ORDER BY provider_key, exact_model_id'
    ).all().map((row) => db.parseRow('offers', row));
    benchmarkRows = database.prepare(
      'SELECT canonical_model_id, benchmark_key, version FROM benchmarks'
    ).all();
    searches = database.prepare(
      'SELECT canonical_model_id, last_searched_at, result, metadata_hash FROM benchmark_searches'
    ).all();
  } finally {
    database.close();
  }

  const hasStoppingBenchmark = new Set(
    benchmarkRows
      .filter((row) => {
        if (!row || typeof row.canonical_model_id !== 'string') return false;
        if (RANKING_BENCHMARK_KEYS.includes(row.benchmark_key)) {
          return isUsableBenchmarkVersion(row.version);
        }
        return typeof row.benchmark_key === 'string' &&
          row.benchmark_key.trim().length > 0 &&
          row.benchmark_key !== 'unknown_benchmark';
      })
      .map((row) => row.canonical_model_id)
  );
  const hasCompletedFound = new Set(
    searches
      .filter((row) => row && row.result === 'found')
      .map((row) => row.canonical_model_id)
  );
  const hasTerminalNotFound = new Set(
    searches
      .filter((row) => row && row.result === 'not_found')
      .map((row) => row.canonical_model_id)
  );
  const forceIds = canonicalForceModelIds(options);
  const forceBenchmark = Array.isArray(options.forceBenchmarkKeys) && options.forceBenchmarkKeys.length > 0;
  const searchByModel = new Map(searches.map((row) => [row.canonical_model_id, row]));

  // Collapse offers to canonical models, keeping the richest facts and the
  // earliest first_seen_at (newly discovered models sort first).
  const models = new Map();
  for (const offer of offers) {
    const canonical = offer.canonical_model_id;
    const existing = models.get(canonical);
    const facts = offer.facts_json && typeof offer.facts_json === 'object' && !Array.isArray(offer.facts_json)
      ? offer.facts_json
      : {};
    if (!existing) {
      models.set(canonical, {
        canonical_model_id: canonical,
        first_seen_at: offer.first_seen_at,
        facts,
        release_dates: parseReleaseDate(facts.release_date) ? [facts.release_date.trim()] : [],
        offer_ids: [{ provider_key: offer.provider_key, exact_model_id: offer.exact_model_id }],
      });
    } else {
      existing.offer_ids.push({
        provider_key: offer.provider_key,
        exact_model_id: offer.exact_model_id,
      });
      if (offer.first_seen_at && (!existing.first_seen_at || offer.first_seen_at < existing.first_seen_at)) {
        existing.first_seen_at = offer.first_seen_at;
      }
      existing.facts = { ...existing.facts, ...facts };
      if (parseReleaseDate(facts.release_date)) existing.release_dates.push(facts.release_date.trim());
    }
  }

  const queue = [];
  for (const model of models.values()) {
    const search = searchByModel.get(model.canonical_model_id) || null;
    const forced = forceBenchmark || forceIds.has(model.canonical_model_id) ||
      model.offer_ids.some((id) => forceIds.has(id.exact_model_id));
    const tooOld = model.release_dates.some((date) => isTooOldForBenchmarkResearch(date, now));
    const metadataHash = modelMetadataHash({ ...model.facts, canonical_model_id: model.canonical_model_id });
    const neverSearched = !search;
    const metadataChanged = !!search && !!search.metadata_hash && search.metadata_hash !== metadataHash;
    const foundSearch = hasCompletedFound.has(model.canonical_model_id);
    if (!forced && (hasStoppingBenchmark.has(model.canonical_model_id) ||
      hasTerminalNotFound.has(model.canonical_model_id) ||
      (foundSearch && !metadataChanged) || tooOld)) continue;
    queue.push({
      canonical_model_id: model.canonical_model_id,
      offer_ids: model.offer_ids,
      first_seen_at: model.first_seen_at,
      last_searched_at: search ? search.last_searched_at : null,
      last_result: search ? search.result : null,
      metadata_hash: metadataHash,
      newly_discovered: neverSearched,
      metadata_changed: metadataChanged,
      model_name: typeof model.facts.model_name === 'string' ? model.facts.model_name : null,
      facts: model.facts,
    });
  }

  // Deterministic priority: newly discovered first, then metadata changed,
  // then oldest search (never searched sorts before any timestamp), then
  // canonical model ID.
  queue.sort((a, b) => {
    if (a.newly_discovered !== b.newly_discovered) return a.newly_discovered ? -1 : 1;
    if (a.metadata_changed !== b.metadata_changed) return a.metadata_changed ? -1 : 1;
    const aTime = a.last_searched_at || '';
    const bTime = b.last_searched_at || '';
    if (aTime !== bTime) return aTime < bTime ? -1 : 1;
    return a.canonical_model_id.localeCompare(b.canonical_model_id);
  });

  const chunks = [];
  for (let i = 0; i < queue.length; i += QUEUE_CHUNK_SIZE) {
    const slice = queue.slice(i, i + QUEUE_CHUNK_SIZE);
    chunks.push({
      chunk_index: chunks.length,
      task_id: `benchmark_scout:chunk-${chunks.length}`,
      models: slice.map((entry) => ({
        canonical_model_id: entry.canonical_model_id,
        model_ids: entry.offer_ids.map((id) => id.exact_model_id),
        offer_ids: entry.offer_ids,
        metadata_hash: entry.metadata_hash,
      })),
    });
  }

  return { generated_at: now, queued: queue.length, queue, chunks };
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (_, raw) => {
      const code = raw[0].toLowerCase() === 'x'
        ? parseInt(raw.slice(1), 16)
        : parseInt(raw, 10);
      return Number.isFinite(code) ? String.fromCodePoint(Math.min(code, 0x10ffff)) : ' ';
    });
}

function htmlText(value) {
  return decodeHtml(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlLinks(value) {
  return [...String(value || '').matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => decodeHtml(match[1]));
}

function parseLeaderboardRows(body, source) {
  const tbody = String(body || '').match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || String(body || '');
  const rawRows = [...tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => match[1]);
  const rows = [];
  for (const rawRow of rawRows) {
    const cells = [...rawRow.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length < 7) continue;
    const texts = cells.map(htmlText);
    const is20 = source.version === '2.0';
    const indexes = is20
      ? { rank: 1, agent: 2, model: 3, date: 4, agentOrg: 5, modelOrg: 6, score: 7 }
      : { rank: 0, agent: 1, model: 2, effort: 3, score: 4, date: 5, agentOrg: 6, modelOrg: 7 };
    if (texts.length <= indexes.score) continue;
    const rank = Number.parseInt(texts[indexes.rank], 10);
    const modelName = texts[indexes.model];
    const scoreMatch = texts[indexes.score].match(/(-?\d+(?:\.\d+)?)\s*%/);
    const score = scoreMatch ? Number(scoreMatch[1]) : NaN;
    if (!Number.isInteger(rank) || !modelName || modelName === 'Multiple' || !Number.isFinite(score)) continue;
    rows.push({
      rank,
      agent: texts[indexes.agent] || null,
      model_name: modelName,
      model_url: htmlLinks(cells[indexes.model])[0] || null,
      effort: is20 ? null : texts[indexes.effort] || null,
      score,
      date: texts[indexes.date] || null,
      agent_org: texts[indexes.agentOrg] || null,
      model_org: texts[indexes.modelOrg] || null,
      row_text: texts.join(' | '),
      benchmark_key: source.benchmark_key,
      display_name: source.display_name,
      version: source.version,
      source_url: source.url,
    });
  }
  return rows;
}

function normalizeModelAlias(value) {
  let text = String(value || '').toLocaleLowerCase().normalize('NFKC');
  text = text.replace(/\([^)]*\)/g, ' ')
    .replace(/:(?:free|batch)$/g, '')
    .replace(/\b(?:latest|preview|instruct|chat|model|api)\b/g, ' ')
    .replace(/[-_. ](?:20\d{2}|\d{4})(?=$|[-_. ])/g, ' ')
    .replace(/[^a-z0-9]+/g, '');
  return text;
}

function queueModelAliases(entry) {
  const facts = entry && entry.facts && typeof entry.facts === 'object' ? entry.facts : {};
  return [...new Set([
    entry && entry.canonical_model_id,
    entry && entry.model_name,
    facts.model_name,
    facts.model_id,
    ...(entry && Array.isArray(entry.offer_ids) ? entry.offer_ids.map((id) => id.exact_model_id) : []),
  ].map(normalizeModelAlias).filter((value) => value.length >= 4))];
}

function rowMatchesQueueModel(row, entry) {
  const rowAlias = normalizeModelAlias(row.model_name);
  if (!rowAlias) return false;
  const aliases = queueModelAliases(entry);
  if (aliases.some((alias) => alias === rowAlias)) return true;
  // Allow a dated or provider suffixed model ID to match its displayed base
  // name, but only when the common prefix is distinctive.
  return aliases.some((alias) => {
    const common = alias.startsWith(rowAlias) ? rowAlias : rowAlias.startsWith(alias) ? alias : '';
    return common.length >= 8;
  });
}

function chooseBulkRow(rows, entry) {
  const matches = rows.filter((row) => rowMatchesQueueModel(row, entry));
  if (matches.length === 0) return null;
  const normalizedNames = new Set(matches.map((row) => normalizeModelAlias(row.model_name)));
  if (normalizedNames.size > 1 && !matches.some((row) => queueModelAliases(entry).includes(normalizeModelAlias(row.model_name)))) {
    return null;
  }
  return matches.slice().sort((a, b) =>
    (b.score - a.score) || (a.rank - b.rank) || a.model_name.localeCompare(b.model_name)
  )[0];
}

// Fetch both complete official leaderboards in parallel, parse all rows, and
// directly accept only unambiguous rows for queued models. The source body is
// still passed through the same evidence validator used by scout proposals.
async function collectBulkBenchmarkFacts(queueResult, options = {}) {
  const { fetchEvidence } = require('./evidence');
  const sourceBodies = new Map();
  const sourceHashes = new Map();
  const fetches = [];
  const responses = await Promise.all(BULK_LEADERBOARD_SOURCES.map((source) =>
    fetchEvidence(source.url, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs || 15000,
      attempts: options.attempts || 1,
      maxRedirects: 3,
      maxBodyBytes: options.maxBodyBytes || 3 * 1024 * 1024,
    }).then((result) => ({ source, result }))
  ));
  const rows = [];
  const errors = [];
  for (const { source, result } of responses) {
    fetches.push({
      url: source.url,
      ok: result.ok,
      final_url: result.final_url,
      status: result.status,
      body_hash: result.body_hash,
      error: result.error || null,
    });
    if (!result.ok) {
      errors.push(`${source.version}: ${result.error || 'leaderboard fetch failed'}`);
      continue;
    }
    sourceBodies.set(source.url, result.body);
    sourceHashes.set(source.url, result.body_hash);
    rows.push(...parseLeaderboardRows(result.body, source));
  }

  const existing = loadCurrentBenchmarks(options).byModel;
  const changes = [];
  const coveredModels = [];
  const accepted = [];
  const notFoundModels = [];
  const unresolved = [];
  const complete = errors.length === 0 && rows.length > 0;
  for (const entry of queueResult.queue || []) {
    const matchingRows = rows.filter((row) => rowMatchesQueueModel(row, entry));
    const row = chooseBulkRow(rows, entry);
    if (!row) {
      // Both official leaderboards are exhaustive. Once both pages were
      // fetched and parsed successfully, an exact alias absent from both is
      // a deterministic gate miss, not a reason to launch another scout.
      if (complete && matchingRows.length === 0) {
        coveredModels.push(entry.canonical_model_id);
        notFoundModels.push(entry.canonical_model_id);
      } else {
        unresolved.push(entry);
      }
      continue;
    }
    if ((existing.get(entry.canonical_model_id) || []).some((item) => item.benchmark_key === row.benchmark_key)) {
      coveredModels.push(entry.canonical_model_id);
      continue;
    }
    const exactModelId = entry.offer_ids[0]?.exact_model_id || entry.canonical_model_id;
    const find = {
      model_id: exactModelId,
      display_name: row.display_name,
      version: row.version,
      score: row.score,
      source_url: row.source_url,
      source_hash: sourceHashes.get(row.source_url) || null,
      extraction_method: 'text',
      confidence: 'HIGH',
      body_excerpt: row.row_text,
      row_description: `${row.agent || 'unknown agent'} / ${row.model_name} / ${row.date || 'unknown date'} / ${row.score}%`,
    };
    const evaluation = evaluateProposal({ ...find }, {
      canonical_model_id: entry.canonical_model_id,
      model_ids: entry.offer_ids.map((id) => id.exact_model_id),
      offer_ids: entry.offer_ids,
      // Evidence confirms the displayed row name. The deterministic alias
      // matcher above already bound it to the queued exact model ID.
      model_name: row.model_name,
    }, {
      sourceBodies,
      sourceHashes,
      requireFetchedEvidence: true,
      now: options.now || nowIso(),
    });
    if (!evaluation.accepted) {
      unresolved.push(entry);
      continue;
    }
    evaluation.change.facts_json.origin = 'benchmark_bulk';
    evaluation.change.facts_json.leaderboard_row = row;
    changes.push(evaluation.change);
    coveredModels.push(entry.canonical_model_id);
    accepted.push({
      canonical_model_id: entry.canonical_model_id,
      benchmark_key: row.benchmark_key,
      score: row.score,
      source_url: row.source_url,
      row: row.row_text,
    });
  }

  const searchChanges = coveredModels.map((canonical_model_id) => {
    const entry = (queueResult.queue || []).find((item) => item.canonical_model_id === canonical_model_id);
    return {
      canonical_model_id,
      last_searched_at: options.now || nowIso(),
      result: changes.some((change) => change.canonical_model_id === canonical_model_id) ? 'found' : 'not_found',
      metadata_hash: entry ? entry.metadata_hash : null,
    };
  });
  if (options.runDir) {
    const dir = path.join(options.runDir, 'reduced');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'benchmark-bulk.json'), `${JSON.stringify({
      fetched_at: options.now || nowIso(),
      sources: fetches,
      rows: rows.length,
      accepted,
      not_found: notFoundModels,
      unresolved: unresolved.map((entry) => entry.canonical_model_id),
      errors,
    }, null, 2)}\n`);
  }
  return { changes, searchChanges, coveredModels, notFoundModels, unresolved, accepted, rows, sourceBodies, sourceHashes, fetches, errors, complete };
}

// Writes one needs-list file per chunk into <run_dir>/benchmarks/ and returns
// the chunk manifest. Workers read these lists; the same lists are the
// allowlist the reducer validates proposals against (AC-8, AC-11).
function writeBenchmarkQueue(runDir, queueResult, options = {}) {
  const dir = path.join(runDir, 'benchmarks');
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const chunk of queueResult.chunks) {
    const file = path.join(dir, `needs-${db.sanitizeTaskId(chunk.task_id)}.json`);
    fs.writeFileSync(file, `${JSON.stringify({
      task_id: chunk.task_id,
      kind: 'benchmark_scout',
      chunk_index: chunk.chunk_index,
      generated_at: queueResult.generated_at,
      models: chunk.models,
    }, null, 2)}\n`);
    written.push({ task_id: chunk.task_id, file, models: chunk.models.length });
  }
  return { dir, written };
}

// ---------------------------------------------------------------------------
// Proposal validation (AC-8 shape, AC-9 evidence)
// ---------------------------------------------------------------------------

// Mechanical shape check (AC-8): canonical key resolves, the score is finite
// and from 0 through 100, and the source URL is http(s). Ranking benchmarks
// require a known version. Supplemental benchmarks may omit a version when
// the source does not publish one, because they still provide useful evidence.
// Returns { ok, key, version, reason }.
function validateProposalShape(find) {
  if (!find || typeof find !== 'object') {
    return { ok: false, reason: 'find is not an object' };
  }
  const displayName = find.display_name || find.name;
  if (typeof displayName !== 'string' || !displayName.trim()) {
    return { ok: false, reason: 'find is missing a benchmark display_name' };
  }
  const key = db.benchmarkKey(displayName);
  const displayVersion = db.benchmarkVersion(displayName).trim();
  let version;
  if (find.version !== undefined && find.version !== null) {
    if (typeof find.version !== 'string') {
      return { ok: false, reason: 'benchmark version must be a non-empty string or a nullable unknown value' };
    }
    const explicitVersion = find.version.trim();
    if (explicitVersion) {
      if (!isUsableBenchmarkVersion(explicitVersion)) {
        return { ok: false, reason: 'benchmark version is unknown; unknown version remains pending' };
      }
      if (displayVersion && explicitVersion !== displayVersion) {
        return {
          ok: false,
          reason: `benchmark version ${JSON.stringify(explicitVersion)} conflicts with ` +
            `display_name version ${JSON.stringify(displayVersion)}`,
        };
      }
      version = explicitVersion;
    }
  }
  if (!version) version = displayVersion;
  if (!key || key === 'unknown_benchmark') {
    return { ok: false, reason: `benchmark display_name ${JSON.stringify(displayName)} does not resolve to a key` };
  }
  const score = Number(find.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return { ok: false, reason: `score must be a finite number from 0 through 100, got ${JSON.stringify(find.score)}` };
  }
  if (typeof find.source_url !== 'string' || !/^https?:\/\//.test(find.source_url)) {
    return { ok: false, reason: 'a source_url (http(s)) is required; a URL alone is not evidence but it is required' };
  }
  const method = find.extraction_method || 'text';
  if (!EXTRACTION_METHODS.includes(method)) {
    return { ok: false, reason: `extraction_method must be one of ${EXTRACTION_METHODS.join(', ')}` };
  }
  if (RANKING_BENCHMARK_KEYS.includes(key) && !version) {
    return { ok: false, reason: 'Terminal Bench benchmark version is required; unknown version remains pending' };
  }
  const confidence = find.confidence || 'HIGH';
  if (!CONFIDENCE_LEVELS.includes(confidence)) {
    return { ok: false, reason: `confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}` };
  }
  return { ok: true, key, version, score, displayName, method, confidence };
}

// Text evidence check (AC-9): the fetched body must confirm the model, the
// benchmark version, and the score. A URL alone is never evidence. The body
// is the full fetched text or a worker supplied excerpt; both are part of the
// fetched body. Loose folding stands in for the layout of leaderboards and
// model cards while still requiring every three facts to be present.
function bodyConfirmsModel(body, model) {
  const folded = fold(body);
  const rawCandidates = [
    model.canonical_model_id,
    model.exact_model_id,
    model.model_name,
    ...(Array.isArray(model.model_ids) ? model.model_ids : []),
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);
  const candidates = new Set();
  for (const value of rawCandidates) {
    candidates.add(fold(value));
    const basename = value.split('/').pop();
    if (basename) {
      const shortId = fold(db.canonicalModelId(basename));
      if (shortId.length >= 4) candidates.add(shortId);
    }
  }
  if (candidates.size === 0) return false;
  return [...candidates].some((candidate) => folded.includes(candidate));
}

function bodyConfirmsBenchmark(body, shape) {
  const folded = fold(body);
  if (!shape || typeof shape.key !== 'string') return false;
  // The benchmark family must appear. Ranking benchmarks also require their
  // version in the body. Supplemental benchmarks may have no published
  // version, so family plus score is sufficient for those rows.
  const keyFold = fold(shape.key.replace(/_/g, ' '));
  const familyFold = keyFold.replace(/[0-9.]+$/g, '');
  if (familyFold && !folded.includes(familyFold)) {
    const displayFamily = fold(shape.displayName).replace(/[0-9.]+$/g, '');
    if (!displayFamily || !folded.includes(displayFamily)) return false;
  }
  if (!shape.version) {
    return !RANKING_BENCHMARK_KEYS.includes(shape.key);
  }
  const versionFold = fold(shape.version);
  return !!versionFold && folded.includes(versionFold);
}

function bodyConfirmsScore(body, score) {
  const folded = fold(body);
  const variants = new Set();
  variants.add(fold(String(score)));
  if (Number.isInteger(score)) variants.add(fold(String(score)));
  // Allow a single decimal rendering (57 vs 57.0) and a trailing percent.
  variants.add(fold(score.toFixed(1)));
  for (const variant of variants) {
    if (variant && folded.includes(variant)) return true;
  }
  return false;
}

function validateTextEvidence(find, shape, model, body) {
  if (typeof body !== 'string' || body.trim().length === 0) {
    return { ok: false, reason: 'text source has no fetched body to confirm against' };
  }
  if (!bodyConfirmsModel(body, model)) {
    return { ok: false, reason: 'fetched body does not confirm the model' };
  }
  if (!bodyConfirmsBenchmark(body, shape)) {
    return { ok: false, reason: 'fetched body does not confirm the benchmark name and version' };
  }
  if (!bodyConfirmsScore(body, shape.score)) {
    return { ok: false, reason: 'fetched body does not confirm the score' };
  }
  return { ok: true };
}

// Official image evidence check (AC-9): accepted only from a vision capable
// worker that returns all four values (model, benchmark, version, score) with
// HIGH confidence. MEDIUM or LOW confidence, unknown versions, and non vision
// environments remain pending.
function validateImageEvidence(find, shape, model, options = {}) {
  if (!options.visionCapable) {
    return { ok: false, reason: 'official image source rejected: environment is not vision capable' };
  }
  if (shape.confidence !== 'HIGH') {
    return { ok: false, reason: `official image source rejected: confidence ${shape.confidence} is not HIGH` };
  }
  if (!shape.version) {
    return { ok: false, reason: 'official image source rejected: benchmark version is unknown' };
  }
  const imageFacts = find.image_facts && typeof find.image_facts === 'object' ? find.image_facts : {};
  const hasAllFour = typeof imageFacts.model === 'string' && imageFacts.model.trim() &&
    typeof imageFacts.benchmark === 'string' && imageFacts.benchmark.trim() &&
    typeof imageFacts.version === 'string' && imageFacts.version.trim() &&
    imageFacts.score !== undefined && imageFacts.score !== null && Number.isFinite(Number(imageFacts.score));
  if (!hasAllFour) {
    return { ok: false, reason: 'official image source rejected: worker did not return all four values (model, benchmark, version, score)' };
  }
  if (!bodyConfirmsModel(JSON.stringify(imageFacts), model)) {
    return { ok: false, reason: 'official image extraction does not confirm the model' };
  }
  if (imageFacts.version.trim() !== shape.version) {
    return {
      ok: false,
      reason: `official image extraction version ${JSON.stringify(imageFacts.version.trim())} ` +
        `does not match proposal version ${JSON.stringify(shape.version)}`,
    };
  }
  return { ok: true, imageFacts };
}

// Fetch every proposed text source once before deterministic reduction. The
// worker excerpt is only a locator; production acceptance uses the page body
// fetched by this process. Network work stays outside SQLite transactions.
async function fetchBenchmarkSourceBodies(tasks, options = {}) {
  const { fetchEvidence } = require('./evidence');
  const sourceBodies = options.sourceBodies instanceof Map ? options.sourceBodies : new Map();
  const sourceHashes = options.sourceHashes instanceof Map ? options.sourceHashes : new Map();
  const fetchCache = options.fetchCache instanceof Map ? options.fetchCache : new Map();
  const fetches = [];
  const urls = new Set();
  for (const task of tasks || []) {
    if (!task || task.kind !== 'benchmark_scout') continue;
    const result = task.result_json;
    for (const model of (result && Array.isArray(result.models) ? result.models : [])) {
      for (const find of (model && Array.isArray(model.benchmark_finds) ? model.benchmark_finds : [])) {
        if (find && find.extraction_method !== 'official_image' && typeof find.source_url === 'string') {
          urls.add(find.source_url);
        }
      }
    }
  }
  for (const url of urls) {
    // A scout may have already audited this URL while reporting incremental
    // progress. Reuse that bounded full-body result in the final reduction.
    if (sourceBodies.has(url) || fetchCache.has(url)) {
      if (!sourceBodies.has(url) && fetchCache.has(url)) {
        const cached = await fetchCache.get(url);
        if (cached.ok) {
          sourceBodies.set(url, cached.body);
          sourceHashes.set(url, cached.body_hash);
        }
      }
      continue;
    }
    const pending = fetchEvidence(url, {
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      attempts: options.attempts,
      maxRedirects: options.maxRedirects,
      maxBodyBytes: options.maxBodyBytes,
    });
    fetchCache.set(url, pending);
    const fetched = await pending;
    fetches.push({ url, ok: fetched.ok, final_url: fetched.final_url, status: fetched.status, body_hash: fetched.body_hash, error: fetched.error || null });
    if (fetched.ok) {
      sourceBodies.set(url, fetched.body);
      sourceHashes.set(url, fetched.body_hash);
    }
  }
  // Keep failed fetches reusable too: the final reduction must see exactly the
  // same failed bounded audit, rather than silently retrying a source.
  for (const url of urls) {
    if (sourceBodies.has(url)) continue;
    const pending = fetchCache.get(url);
    if (!pending) continue;
    const fetched = await pending;
    if (!fetched.ok) {
      // No body is intentionally stored for a failed fetch. The cache promise
      // is the durable handoff that prevents a second network attempt.
      continue;
    }
  }
  return { sourceBodies, sourceHashes, fetches };
}

// Evaluates one proposal find against the queue allowlist and source policy.
// Returns { accepted, reason, change? } where change is the benchmarks row to
// insert at finalization (insert only; an existing row is never replaced).
//
// model: the queued model entry { canonical_model_id, model_ids, offer_ids }.
// Production passes requireFetchedEvidence and sourceBodies from the bounded
// HTTP audit. Tests may still supply a body directly for focused validation.
function evaluateProposal(find, model, options = {}) {
  const queuedIds = new Set(model.model_ids || []);
  queuedIds.add(model.canonical_model_id);
  const findModelId = find.model_id || find.canonical_model_id;
  if (!queuedIds.has(findModelId)) {
    return { accepted: false, reason: `model_id ${JSON.stringify(findModelId)} is not in the exact search queue` };
  }

  const shape = validateProposalShape(find);
  if (!shape.ok) {
    return { accepted: false, reason: shape.reason };
  }

  const workerSourceHash = typeof find.source_hash === 'string' && find.source_hash ? find.source_hash : null;

  if (shape.method === 'official_image') {
    const check = validateImageEvidence(find, shape, model, options);
    if (!check.ok) return { accepted: false, reason: check.reason };
    return {
      accepted: true,
      reason: 'official image accepted (HIGH confidence, all four values)',
      change: buildBenchmarkChange(model, shape, find, workerSourceHash, {
        extraction_method: 'official_image',
        confidence: shape.confidence,
        image_hash: find.image_hash || null,
        image_facts: check.imageFacts,
        extracted_at: options.now || nowIso(),
        row_description: find.row_description || null,
      }),
    };
  }

  // Text source: confirm against the body fetched by the deterministic audit.
  const auditedBody = options.sourceBodies instanceof Map
    ? options.sourceBodies.get(find.source_url)
    : null;
  const sourceHash = options.sourceHashes instanceof Map
    ? (options.sourceHashes.get(find.source_url) || workerSourceHash)
    : workerSourceHash;
  if (options.requireFetchedEvidence && typeof auditedBody !== 'string') {
    return { accepted: false, reason: 'text source was not fetched successfully by the evidence audit' };
  }
  let body = typeof auditedBody === 'string' ? auditedBody
    : typeof find.body === 'string' && find.body ? find.body
      : (typeof find.body_excerpt === 'string' && find.body_excerpt ? find.body_excerpt : null);
  if (body === null && typeof options.fetchImpl === 'function') {
    try {
      const res = options.fetchImpl(find.source_url);
      if (res && typeof res.body === 'string') body = res.body;
    } catch {
      body = null;
    }
  }
  const check = validateTextEvidence(find, shape, model, body);
  if (!check.ok) return { accepted: false, reason: check.reason };
  return {
    accepted: true,
    reason: 'text source accepted (model, version, and score confirmed in fetched body)',
    change: buildBenchmarkChange(model, shape, find, sourceHash, {
      extraction_method: 'text',
      confidence: shape.confidence,
      extracted_at: options.now || nowIso(),
    }),
  };
}

// Deterministically classifies one queued model after its artifact has been
// ingested and its evidence bodies audited. This is also the exact evaluator
// used by final reduction, so progress never reports a worker claim as a fact.
function evaluateBenchmarkModelProgress(task, queuedEntry, options = {}) {
  if (!task || task.status === 'failed') return { outcome: 'failed', verified: 0 };
  const result = task.result_json;
  if (!result || !Array.isArray(result.models)) return { outcome: 'failed', verified: 0 };
  const models = result.models.filter((model) => model && typeof model === 'object');
  const model = models.find((candidate) =>
    candidate.canonical_model_id === queuedEntry.canonical_model_id ||
    queuedEntry.offer_ids.some((id) => id.exact_model_id === candidate.model_id)
  );
  if (!model) return { outcome: 'not_found', verified: 0 };
  if (model.canonical_model_id && model.canonical_model_id !== queuedEntry.canonical_model_id &&
      !queuedEntry.offer_ids.some((id) => id.exact_model_id === model.model_id)) {
    return { outcome: 'rejected', verified: 0 };
  }
  const evalModel = {
    canonical_model_id: queuedEntry.canonical_model_id,
    model_ids: queuedEntry.offer_ids.map((id) => id.exact_model_id),
    offer_ids: queuedEntry.offer_ids,
    model_name: model.model_name || queuedEntry.canonical_model_id,
  };
  let verified = 0;
  for (const find of Array.isArray(model.benchmark_finds) ? model.benchmark_finds : []) {
    const evaluation = evaluateProposal(
      { ...find, model_id: find.model_id || model.model_id },
      evalModel,
      options
    );
    if (evaluation.accepted) verified += 1;
  }
  if (verified > 0) return { outcome: 'verified', verified };
  return {
    outcome: Array.isArray(model.benchmark_finds) && model.benchmark_finds.length > 0
      ? 'rejected' : 'not_found',
    verified: 0,
  };
}

function buildBenchmarkChange(model, shape, find, sourceHash, factsExtra) {
  const facts = {
    origin: 'benchmark_scout',
    ...(factsExtra || {}),
  };
  return {
    canonical_model_id: model.canonical_model_id,
    benchmark_key: shape.key,
    display_name: shape.displayName,
    version: shape.version,
    score: shape.score,
    source_url: find.source_url,
    source_hash: sourceHash || 'unverified',
    verified_at: factsExtra.extracted_at || nowIso(),
    facts_json: facts,
  };
}

// ---------------------------------------------------------------------------
// Benchmark task reduction (proposals -> accepted facts)
// ---------------------------------------------------------------------------

// Validates a benchmark scout artifact against its manifest task and the
// queued allowlist (AC-11). Returns { ok, errors, status }.
function validateBenchmarkArtifact(task, artifact, queuedIdsForTask) {
  const errors = [];
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    return { ok: false, errors: ['artifact is not a JSON object'], status: 'failed' };
  }
  if (artifact.task_id !== undefined && String(artifact.task_id) !== String(task.task_id)) {
    errors.push(`artifact task_id ${JSON.stringify(artifact.task_id)} does not match manifest task ${JSON.stringify(task.task_id)}`);
  }
  if (!['complete', 'partial', 'failed'].includes(artifact.status)) {
    errors.push('artifact status must be one of complete, partial, failed');
  }
  if (artifact.models !== undefined && !Array.isArray(artifact.models)) {
    errors.push('artifact models must be an array');
  }
  if (errors.length > 0) return { ok: false, errors, status: 'failed' };

  // Every model in the artifact must be an assigned (queued) model. Models
  // outside the assignment are rejected, never added (AC-8, AC-11).
  if (Array.isArray(artifact.models) && queuedIdsForTask) {
    for (const model of artifact.models) {
      const id = model && (model.model_id || model.canonical_model_id);
      if (id && !queuedIdsForTask.has(id)) {
        errors.push(`artifact model ${JSON.stringify(id)} is not in the assigned search queue`);
      }
    }
  }
  return { ok: true, errors, status: artifact.status };
}

// Reduces one run's benchmark scout task results against the search queue.
// Accepted proposals become benchmark changes (applied later in the single
// finalizeRun transaction); rejected and pending proposals stay only in the
// task record. Also produces benchmark_searches updates for completed scout
// artifacts; failed and partial workers remain retryable.
//
// Returns { accepted, rejected, benchmarkChanges, searchChanges, coverage }.
function reduceBenchmarkTasks(runId, runDir, options = {}) {
  const now = options.now || nowIso();
  const { tasks } = db.loadRunCandidate(runId, options);
  const { byModel } = loadCurrentBenchmarks(options);
  const scoutTasks = tasks.filter((t) => t.kind === 'benchmark_scout');

  // Rebuild the queue allowlist from the run's needs-list files when present,
  // else from current state. The needs-lists are what the workers received,
  // so they are the authoritative allowlist for this run.
  const queueResult = buildBenchmarkQueue({ ...options, now });
  const queuedByTask = new Map();
  const queuedCanonicalsByTask = new Map();
  const queuedModelByCanonical = new Map(queueResult.queue.map((entry) => [entry.canonical_model_id, entry]));
  for (const chunk of queueResult.chunks) {
    const ids = new Set();
    for (const model of chunk.models) {
      ids.add(model.canonical_model_id);
      for (const exactId of model.model_ids) ids.add(exactId);
    }
    queuedByTask.set(chunk.task_id, ids);
    queuedCanonicalsByTask.set(chunk.task_id, chunk.models.map((model) => model.canonical_model_id));
  }
  // The live collector may split chunks into one task per model for progress
  // granularity. Resolve those task IDs from the exact assigned model IDs while
  // retaining compatibility with older chunk artifacts.
  for (const task of scoutTasks) {
    if (queuedByTask.has(task.task_id)) continue;
    const assignedIds = Array.isArray(task.assigned_json)
      ? task.assigned_json
      : Array.isArray(task.assigned_model_ids) ? task.assigned_model_ids : [];
    const assigned = new Set(assignedIds);
    const matches = queueResult.queue.filter((entry) =>
      entry.offer_ids.some((id) => assigned.has(id.exact_model_id))
    );
    if (matches.length === 1) {
      const ids = new Set([matches[0].canonical_model_id, ...matches[0].offer_ids.map((id) => id.exact_model_id)]);
      queuedByTask.set(task.task_id, ids);
      queuedCanonicalsByTask.set(task.task_id, [matches[0].canonical_model_id]);
    }
  }

  const accepted = [];
  const rejected = [];
  const benchmarkChanges = [];
  const seenInsert = new Set(); // one insert per canonical+key this run
  const searchedModels = new Set();
  const coveredModels = new Set();
  const coverage = { tasks: 0, complete: 0, partial: 0, failed: 0, accepted: 0, rejected: 0 };

  for (const task of scoutTasks) {
    coverage.tasks += 1;
    if (task.status === 'complete') coverage.complete += 1;
    else if (task.status === 'partial') coverage.partial += 1;
    else coverage.failed += 1;

    const queuedIdsForTask = queuedByTask.get(task.task_id) || null;
    const result = task.result_json;
    // Only a completed artifact that contains a models array proves that all
    // allowed sources were checked. A failed/partial worker result must not
    // become a terminal not_found search record (429 and connection errors
    // remain retryable). Partial artifacts may still contribute individually
    // validated proposals.
    if (task.status === 'failed' || !result || !Array.isArray(result.models)) continue;
    if (task.status === 'complete') {
      for (const canonical of queuedCanonicalsByTask.get(task.task_id) || []) coveredModels.add(canonical);
    }

    for (const model of result.models) {
      if (!model || typeof model !== 'object') continue;
      const canonical = model.canonical_model_id || db.canonicalModelId(model.model_id || '');
      const queuedEntry = queuedModelByCanonical.get(canonical);
      if (!queuedEntry) {
        rejected.push({ task_id: task.task_id, model_id: model.model_id, reason: 'model not in the search queue' });
        coverage.rejected += 1;
        continue;
      }
      searchedModels.add(canonical);
      const evalModel = {
        canonical_model_id: canonical,
        model_ids: queuedEntry.offer_ids.map((id) => id.exact_model_id),
        offer_ids: queuedEntry.offer_ids,
        model_name: model.model_name || canonical,
      };
      for (const find of model.benchmark_finds || []) {
        const evaluation = evaluateProposal({ ...find, model_id: find.model_id || model.model_id }, evalModel, options);
        if (!evaluation.accepted) {
          rejected.push({
            task_id: task.task_id,
            model_id: model.model_id,
            canonical_model_id: canonical,
            benchmark: find.display_name || find.name,
            reason: evaluation.reason,
          });
          coverage.rejected += 1;
          continue;
        }
        const change = evaluation.change;
        const insertKey = `${change.canonical_model_id}\u0000${change.benchmark_key}`;
        // Never replace an existing verified row, and never insert the same
        // key twice in one run (the first accepted fact wins) (AC-8).
        const existingRows = byModel.get(change.canonical_model_id) || [];
        if (existingRows.some((row) => row.benchmark_key === change.benchmark_key)) {
          rejected.push({
            task_id: task.task_id,
            model_id: model.model_id,
            canonical_model_id: canonical,
            benchmark: change.display_name,
            reason: `existing verified ${change.benchmark_key} is immutable; proposal not applied`,
          });
          coverage.rejected += 1;
          continue;
        }
        if (seenInsert.has(insertKey)) {
          rejected.push({
            task_id: task.task_id,
            model_id: model.model_id,
            canonical_model_id: canonical,
            benchmark: change.display_name,
            reason: 'a proposal for this benchmark key was already accepted this run',
          });
          coverage.rejected += 1;
          continue;
        }
        seenInsert.add(insertKey);
        benchmarkChanges.push(change);
        accepted.push({
          task_id: task.task_id,
          canonical_model_id: canonical,
          benchmark_key: change.benchmark_key,
          score: change.score,
          source_url: change.source_url,
        });
        coverage.accepted += 1;
      }
    }
  }

  // Every model covered by a completed scout artifact is marked searched this
  // run. A complete artifact with no model findings is a terminal not_found;
  // failed and partial artifacts produce no terminal search record.
  const searchChanges = [];
  for (const model of queueResult.queue) {
    if (!coveredModels.has(model.canonical_model_id)) continue;
    searchChanges.push({
      canonical_model_id: model.canonical_model_id,
      last_searched_at: now,
      result: searchedModels.has(model.canonical_model_id) ? 'found' : 'not_found',
      metadata_hash: model.metadata_hash,
    });
  }

  // Run local outputs for inspection and the assembly stage.
  if (runDir) {
    const dir = path.join(runDir, 'reduced');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'benchmark-proposals.json'), `${JSON.stringify({
      run_id: runId,
      reduced_at: now,
      coverage,
      accepted,
      rejected,
    }, null, 2)}\n`);
  }

  return { accepted, rejected, benchmarkChanges, searchChanges, coverage };
}

// ---------------------------------------------------------------------------
// Tier derivation (AC-10)
// ---------------------------------------------------------------------------

// Derives the tier and representative benchmark for one model from its
// accepted benchmark rows. Terminal Bench 2.0 and 2.1 both use 65+ for S and
// 50 through 64.999 for A (spec 0004 child 0002). When both rows exist 2.1 is
// the representative row. Without either gate row another verified official
// benchmark supports tier B at most. No verified benchmark is benchmark_pending
// (tier null, not ranked). The representative score comes from the same
// benchmark that sets the tier so raw scores from different benchmarks are
// never compared (AGENTS.md).
function deriveTier(benchmarkRows) {
  const rows = (Array.isArray(benchmarkRows) ? benchmarkRows : [])
    .filter((row) => row && isUsableBenchmarkVersion(row.version));
  const terminal =
    rows.find((row) => row.benchmark_key === 'terminal_bench_2_1') ||
    rows.find((row) => row.benchmark_key === 'terminal_bench_2_0') ||
    null;
  if (terminal) {
    // Spec 0004 AC-5: only a verified Terminal Bench 2.0/2.1 score at or
    // above the shared 50 gate admits to the ranking. A score below 50 is
    // benchmark_pending (never a rankable tier B). This uses the shared
    // ranking policy gate so assembler, validator, and builder agree.
    if (!rankingPolicy.qualifiesTerminalBench(terminal.benchmark_key, terminal.score)) {
      return {
        tier: null,
        score: terminal.score,
        version: terminal.version,
        benchmark_key: terminal.benchmark_key,
        benchmark_name: terminal.display_name,
        terminal_bench: terminal.score,
        benchmark_pending: true,
      };
    }
    let tier = 'B';
    if (terminal.score >= TIER_S_SCORE) tier = 'S';
    else if (terminal.score >= TIER_A_SCORE) tier = 'A';
    return {
      tier,
      score: terminal.score,
      version: terminal.version,
      benchmark_key: terminal.benchmark_key,
      benchmark_name: terminal.display_name,
      terminal_bench: terminal.score,
      benchmark_pending: false,
    };
  }
  if (rows.length > 0) {
    // Another verified official benchmark supports tier B at most. Pick the
    // representative deterministically: highest score, then benchmark_key.
    const best = rows.slice().sort((a, b) =>
      (b.score - a.score) || a.benchmark_key.localeCompare(b.benchmark_key))[0];
    return {
      tier: 'B',
      score: best.score,
      version: best.version,
      benchmark_key: best.benchmark_key,
      benchmark_name: best.display_name,
      terminal_bench: null,
      benchmark_pending: false,
    };
  }
  return {
    tier: null,
    score: null,
    version: null,
    benchmark_key: null,
    benchmark_name: null,
    terminal_bench: null,
    benchmark_pending: true,
  };
}

module.exports = {
  RANKING_BENCHMARK_KEYS,
  RANKING_BENCHMARK_KEY,
  TIER_S_SCORE,
  TIER_A_SCORE,
  QUEUE_CHUNK_SIZE,
  BENCHMARK_RESEARCH_MAX_AGE_MONTHS,
  EXTRACTION_METHODS,
  CONFIDENCE_LEVELS,
  fold,
  isUsableBenchmarkVersion,
  parseReleaseDate,
  benchmarkResearchCutoff,
  isTooOldForBenchmarkResearch,
  modelMetadataHash,
  loadCurrentBenchmarks,
  buildBenchmarkQueue,
  BULK_LEADERBOARD_SOURCES,
  parseLeaderboardRows,
  collectBulkBenchmarkFacts,
  writeBenchmarkQueue,
  validateProposalShape,
  validateTextEvidence,
  validateImageEvidence,
  bodyConfirmsModel,
  bodyConfirmsBenchmark,
  bodyConfirmsScore,
  evaluateProposal,
  evaluateBenchmarkModelProgress,
  fetchBenchmarkSourceBodies,
  validateBenchmarkArtifact,
  reduceBenchmarkTasks,
  deriveTier,
};
