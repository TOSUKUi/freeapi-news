'use strict';

// Spec 0008 Phase 1: the deterministic model lane.
//
// Three jobs, all code, no LLM:
//   1. detectNewModels  new models from this run's catalog artifacts and the
//                        Hugging Face new-models feed, matched against the
//                        models table by canonical id and aliases.
//   2. planFanoutTasks  at most three model_fanout worker tasks per run, each
//                        carrying the catalog verdicts (present/absent per
//                        catalog provider) so the worker never re-checks a
//                        route the deterministic lane already decided.
//   3. applyModelFacts  after ingest + lane reduction: verify vendor-facts
//                        announcements and distribution evidence with bounded
//                        fetches, write the models table, the known provider
//                        map, the leads table (with 7 day expiry), and the
//                        reduced files the report assembler reads.
//
// The models table is the model-of-record: offers stay the offer-of-record
// keyed by (provider_key, exact_model_id).

const fs = require('node:fs');
const path = require('node:path');

const db = require('./collector-db');

const FANOUT_MAX_PER_DAY = 3;
const LEAD_EXPIRY_DAYS = 7;
const VERIFY_TIMEOUT_MS = 20000;
const VERIFY_USER_AGENT = 'Mozilla/5.0 (compatible; free-api-news/1.0; +https://github.com)';

// ---------------------------------------------------------------------------
// 1 + 2. New model detection and fan out planning
// ---------------------------------------------------------------------------

function withinWindow(dateStr, windowDays, now) {
  if (typeof dateStr !== 'string') return false;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return false;
  return t >= Date.parse(now) - windowDays * 86400000 && t <= Date.parse(now) + 3600000;
}

function normalizeModelKey(value) {
  return String(value || '').replace(/\//g, '').toLowerCase();
}

// Reads every catalog artifact of the run and returns, per provider, the
// model list plus whether the provider publishes created dates at all.
function readCatalogArtifacts(runDir) {
  const dir = path.join(runDir, 'artifacts');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const file of fs.readdirSync(dir)) {
    if (!/^catalog-.*\.json$/.test(file)) continue;
    let artifact;
    try {
      artifact = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!artifact || artifact.kind !== 'catalog' || artifact.status === 'failed' ||
        !Array.isArray(artifact.models)) continue;
    const models = artifact.models
      .filter((m) => m && typeof m.model_id === 'string' && m.model_id)
      .map((m) => ({
        model_id: m.model_id,
        name: typeof m.model_name === 'string' ? m.model_name : null,
        created: typeof m.created === 'string' ? m.created : (typeof m.created_at === 'string' ? m.created_at : null),
      }));
    out.push({
      provider_key: artifact.provider_key,
      models,
      publishes_dates: models.some((m) => m.created),
    });
  }
  return out;
}

// Reads the api:hf-new-models watch artifact (items carry created=ISO text).
function readHfFeedItems(runDir) {
  const file = path.join(runDir, 'reduced', 'watch-signals.json');
  if (!fs.existsSync(file)) return [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const signal = (data.signals || []).find((s) => s.entity_key === 'api:hf-new-models');
  const factsPath = path.join(runDir, 'artifacts', `${db.sanitizeTaskId('watch:api:hf-new-models')}.json`);
  if (!fs.existsSync(factsPath)) return [];
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
  } catch {
    return [];
  }
  const items = Array.isArray(artifact.items) ? artifact.items : [];
  return items
    .filter((item) => item && typeof item.key === 'string')
    .map((item) => {
      const match = String(item.text || '').match(/created=(\S+)/);
      return {
        model_id: item.key,
        created: match ? match[1] : null,
      };
    });
}

function existingModelKeys(baseOpts) {
  const rows = db.listModels(baseOpts);
  const keys = new Set();
  for (const row of rows) {
    keys.add(normalizeModelKey(row.canonical_model_id));
    for (const alias of (row.aliases_json || [])) keys.add(normalizeModelKey(alias));
  }
  return { rows, keys };
}

// Detects models new to the models table from this run's catalog artifacts
// and the HF new-models feed. A model becomes a fan out CANDIDATE only with a
// dated release inside the window (catalog created= or HF feed created=);
// undated catalog newcomers are registered as baseline rows without fan out,
// so a newly added catalog provider never floods the fan out lane.
function detectNewModels({ runDir, baseOpts, now, windowDays = 7, watchlist = null }) {
  const { rows, keys } = existingModelKeys(baseOpts);
  const catalogs = readCatalogArtifacts(runDir);
  const hfItems = readHfFeedItems(runDir);
  const watchOrgs = new Set();
  if (watchlist) {
    for (const vendor of watchlist.vendors || []) {
      const org = vendor.channels && vendor.channels.hf_org;
      if (typeof org === 'string' && org.trim()) watchOrgs.add(org.toLowerCase());
    }
  }

  const seen = new Set();
  const candidates = [];
  const baselines = [];
  const consider = (entry, reason, sourceUrl = null) => {
    const canonical = db.canonicalModelId(entry.model_id);
    if (!canonical) return;
    const key = normalizeModelKey(canonical);
    if (keys.has(key) || seen.has(key)) return;
    seen.add(key);
    const row = {
      model_id: entry.model_id,
      display_name: entry.name || entry.model_id,
      release_date: entry.created || null,
      reason,
      source_url: sourceUrl,
    };
    if (entry.created && withinWindow(entry.created, windowDays, now)) {
      candidates.push(row);
    } else {
      baselines.push(row);
    }
  };

  for (const catalog of catalogs) {
    if (catalog.publishes_dates) {
      for (const model of catalog.models) {
        consider(model, 'catalog_new', null);
      }
    } else {
      // Provider does not publish dates: only fan out a model when the HF
      // feed independently dates it inside the window; otherwise baseline.
      const dated = new Map(hfItems.map((h) => [normalizeModelKey(h.model_id), h.created]));
      for (const model of catalog.models) {
        if (!model.created) {
          model.created = dated.get(normalizeModelKey(model.model_id)) || null;
        }
        consider(model, model.created ? 'catalog_new' : 'catalog_baseline', null);
      }
    }
  }

  for (const item of hfItems) {
    // Vendor scoped: only orgs present in the watchlist are tracked as model
    // discovery input; the rest of the global feed is out of scope.
    const org = item.model_id.includes('/') ? item.model_id.split('/')[0].toLowerCase() : '';
    if (!watchOrgs.has(org)) continue;
    consider(item, 'hf_feed', `https://huggingface.co/${item.model_id}`);
  }

  // Cap the fan out lane; frontier orgs and newest dates first. Frontier is
  // judged by vendor key OR the vendor's hugging face org name, so a frontier
  // vendor's models win the cap whether they arrive as vendor/key or org/model.
  const frontierSet = new Set();
  for (const v of (watchlist && watchlist.frontier_vendors || [])) {
    const key = String(v).toLowerCase();
    frontierSet.add(key);
    const vendor = (watchlist && watchlist.vendors || []).find((x) => x.key === v);
    const org = vendor && vendor.channels && vendor.channels.hf_org;
    if (typeof org === 'string' && org.trim()) frontierSet.add(org.toLowerCase());
  }
  const scored = candidates.map((c) => ({
    row: c,
    frontier: (() => {
      const org = c.model_id.includes('/') ? c.model_id.split('/')[0].toLowerCase() : '';
      return frontierSet.has(org);
    })(),
  }));
  scored.sort((a, b) => {
    if (a.frontier !== b.frontier) return a.frontier ? -1 : 1;
    return String(b.row.release_date || '').localeCompare(String(a.row.release_date || ''));
  });

  return {
    candidates: scored.slice(0, FANOUT_MAX_PER_DAY).map((s) => s.row),
    deferred_candidates: scored.slice(FANOUT_MAX_PER_DAY).map((s) => s.row),
    baselines,
  };
}

// Builds the model_fanout task list for the run. Catalog verdicts are the
// deterministic present/absent judgment per catalog provider for THIS model,
// computed from this run's catalog artifacts. routes_to_check is the
// complement: provider monitor keys without a catalog verdict, which the
// worker must check on the official pages.
function planFanoutTasks(candidates, catalogs, watchlist = null) {
  const catalogProviders = new Set((catalogs || []).map((c) => c.provider_key));
  const monitorKeys = [...new Set(
    ((watchlist && watchlist.provider_monitors) || [])
      .map((m) => m.provider_key)
      .filter((k) => typeof k === 'string' && k.trim() && !catalogProviders.has(k)),
  )].sort();
  return (candidates || []).map((candidate) => {
    const key = normalizeModelKey(candidate.model_id);
    const catalogVerdicts = (catalogs || []).map((catalog) => ({
      provider_key: catalog.provider_key,
      verdict: catalog.models.some((m) => normalizeModelKey(m.model_id) === key)
        ? 'present'
        : 'absent',
    }));
    return {
      task_id: `model_fanout:${db.canonicalModelId(candidate.model_id)}`,
      kind: 'model_fanout',
      provider_key: null,
      assigned_model_ids: [candidate.model_id],
      model: candidate,
      catalog_verdicts: catalogVerdicts,
      routes_to_check: monitorKeys,
    };
  });
}

// ---------------------------------------------------------------------------
// 3. Apply vendor-facts: models table, known providers, leads
// ---------------------------------------------------------------------------

async function verifyUrlContains(url, needles, fetchImpl, nowIso) {
  if (!url || !/^https?:\/\//.test(url) || needles.length === 0) return false;
  const doFetch = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  try {
    const res = await doFetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': VERIFY_USER_AGENT, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
    });
    const body = await res.text();
    clearTimeout(timer);
    if (!res.ok) return false;
    const text = body.toLowerCase();
    return needles.some((needle) => needle && text.includes(String(needle).toLowerCase()));
  } catch {
    return false;
  }
}

// Deterministic source tier from URL patterns (spec 0008 §4.5). Defined in
// collector-db.js (shared with the source_cache writer); re-exported here
// for the model lane and tests.
const { sourceTierFromUrl } = db;

function vendorKeyOf(watchlist, vendorKey) {
  if (!watchlist) return null;
  const found = (watchlist.vendors || []).find((v) => v.key === vendorKey);
  return found ? found.key : null;
}

// Applies the ingested vendor-facts / leads results to the models and leads
// tables. Announcements and served distribution routes require a bounded
// fetch that shows the model name on the cited page; anything unverifiable is
// kept in the reduced output but never written to the models table.
async function applyModelFacts({ runId, runDir, baseOpts, fetchImpl, now, watchlist = null, log = () => {} }) {
  const { tasks } = db.loadRunCandidate(runId, baseOpts);
  const nowIso = now || new Date().toISOString();
  const reducedDir = path.join(runDir, 'reduced');
  fs.mkdirSync(reducedDir, { recursive: true });

  const announcements = [];
  const distributionNotes = [];
  const pricingNews = [];
  const leads = [];
  const unverified = [];

  for (const task of tasks) {
    if (!['news_scan', 'vendor_deep_dive', 'model_fanout', 'community'].includes(task.kind)) continue;
    const result = task.result_json;
    if (!result || typeof result !== 'object') continue;

    for (const ann of Array.isArray(result.announcements) ? result.announcements : []) {
      if (!ann || typeof ann.model_name !== 'string' || !ann.model_name.trim()) continue;
      const modelId = typeof ann.model_id === 'string' && ann.model_id.trim() ? ann.model_id.trim() : null;
      const needles = [ann.model_name.trim()];
      if (modelId) needles.push(modelId);
      const ok = await verifyUrlContains(ann.announcement_url, needles, fetchImpl, nowIso);
      if (!ok) {
        unverified.push({ kind: 'announcement', task_id: task.task_id, model_name: ann.model_name, url: ann.announcement_url });
        continue;
      }
      const canonical = modelId || ann.model_name.trim();
      const row = db.upsertModel(canonical, {
        display_name: ann.model_name.trim(),
        vendor_key: vendorKeyOf(watchlist, ann.vendor_key) || null,
        aliases: Array.isArray(ann.aliases) ? ann.aliases : (modelId ? [modelId] : []),
        release_status: ann.release_status || 'announced',
        release_date: ann.announcement_date || null,
        total_parameters_b: ann.total_parameters_b ?? null,
        active_parameters_b: ann.active_parameters_b ?? null,
        open_weight: ann.open_weight === true || ann.open_weight === false ? ann.open_weight : undefined,
        source_url: ann.announcement_url,
        last_run_id: runId,
        last_seen_at: nowIso,
      }, baseOpts);
      announcements.push({
        task_id: task.task_id,
        model_name: ann.model_name,
        canonical_model_id: row ? row.canonical_model_id : null,
        created: !!(row && row.created),
        source_url: ann.announcement_url,
        release_date: row && row.release_date ? row.release_date : (ann.announcement_date || null),
        vendor_key: row && row.vendor_key ? row.vendor_key : (vendorKeyOf(watchlist, ann.vendor_key) || null),
        aliases: row ? (row.aliases_json || []) : [],
      });
      log(`  model ${row && row.created ? 'NEW' : 'updated'} ${row ? row.canonical_model_id : canonical}`);
    }

    for (const dist of Array.isArray(result.distribution) ? result.distribution : []) {
      if (!dist || typeof dist.model_id !== 'string' || !dist.model_id) continue;
      const note = {
        task_id: task.task_id,
        model_id: dist.model_id,
        provider_key: dist.provider_key || null,
        status: dist.status,
        evidence_url: dist.evidence_url || null,
        note: dist.note || null,
        verified: false,
      };
      if (dist.status === 'served' && dist.evidence_url) {
        const found = db.findModelsByIds([dist.model_id], baseOpts);
        const row = found[0];
        const needles = [dist.model_id];
        if (row && row.display_name) needles.push(row.display_name);
        note.verified = await verifyUrlContains(dist.evidence_url, needles, fetchImpl, nowIso);
        if (note.verified && row) {
          db.upsertModel(row.canonical_model_id, { known_providers: [dist.provider_key] }, baseOpts);
        }
      }
      distributionNotes.push(note);
    }

    for (const claim of Array.isArray(result.pricing_claims) ? result.pricing_claims : []) {
      if (!claim || typeof claim.model_id !== 'string' || !claim.model_id) continue;
      pricingNews.push({
        task_id: task.task_id,
        model_id: claim.model_id,
        vendor_key: claim.vendor_key || null,
        provider_key: claim.provider_key || null,
        pricing_url: claim.pricing_url || null,
        pricing_text: claim.pricing_text || null,
        free_quota_text: claim.free_quota_text || null,
        is_free_signal: claim.is_free_signal === true,
        discount_start_at: claim.discount_start_at || null,
        discount_end_at: claim.discount_end_at || null,
      });
    }

    for (const lead of Array.isArray(result.leads) ? result.leads : []) {
      if (!lead || typeof lead.claim_text !== 'string' || !lead.claim_text.trim()) continue;
      if (!lead.source_url || !/^https?:\/\//.test(lead.source_url)) continue;
      leads.push({
        task_id: task.task_id,
        claim_text: lead.claim_text.trim(),
        source_url: lead.source_url,
        model_name: typeof lead.model_name === 'string' ? lead.model_name : null,
        provider_key: typeof lead.provider_key === 'string' ? lead.provider_key : null,
        claim_kind: lead.claim_kind || null,
        source_tier: sourceTierFromUrl(lead.source_url),
      });
    }
  }

  // Lead lifecycle: dedupe by (source_url, claim_text), 7 day expiry.
  const leadResults = [];
  for (const lead of leads) {
    const added = db.addLead({
      run_id: runId,
      source_url: lead.source_url,
      claim_text: lead.claim_text,
      source_tier: lead.source_tier,
      model_name: lead.model_name,
      provider_key: lead.provider_key,
      note: lead.claim_kind ? `kind=${lead.claim_kind}; task=${lead.task_id}` : `task=${lead.task_id}`,
      detected_at: nowIso,
    }, baseOpts);
    leadResults.push({ ...lead, created: added.created, lead_id: added.lead_id || null, status: added.status || 'open' });
  }
  const openLeads = db.listOpenLeads(baseOpts);
  const expired = [];
  for (const lead of openLeads) {
    const age = Date.parse(nowIso) - Date.parse(lead.detected_at);
    if (Number.isFinite(age) && age > LEAD_EXPIRY_DAYS * 86400000) {
      db.resolveLead(lead.lead_id, { status: 'expired', resolved_at: nowIso }, baseOpts);
      expired.push(lead.lead_id);
    }
  }

  const summary = {
    run_id: runId,
    generated_at: nowIso,
    announcements_verified: announcements.length,
    announcements_unverified: unverified.length,
    distribution_notes: distributionNotes.length,
    distribution_served_verified: distributionNotes.filter((d) => d.verified).length,
    pricing_news: pricingNews.length,
    leads_reported: leadResults.length,
    leads_created: leadResults.filter((l) => l.created).length,
    leads_expired: expired.length,
  };
  fs.writeFileSync(path.join(reducedDir, 'model-updates.json'),
    `${JSON.stringify({ ...summary, announcements, unverified }, null, 2)}\n`);
  fs.writeFileSync(path.join(reducedDir, 'distribution-notes.json'),
    `${JSON.stringify({ run_id: runId, generated_at: nowIso, notes: distributionNotes }, null, 2)}\n`);
  fs.writeFileSync(path.join(reducedDir, 'vendor-pricing-news.json'),
    `${JSON.stringify({ run_id: runId, generated_at: nowIso,
      note: 'Pricing/discount change claims from vendor and news_scan workers. Editorial change_prose input only; never offer state in Phase 1.',
      news: pricingNews }, null, 2)}\n`);
  fs.writeFileSync(path.join(reducedDir, 'leads-summary.json'),
    `${JSON.stringify({ run_id: runId, generated_at: nowIso,
      note: 'Community and worker leads. open leads are verified by official lanes; verified leads are reported as community-sourced (back-checked).',
      leads: leadResults, expired }, null, 2)}\n`);
  return summary;
}

module.exports = {
  FANOUT_MAX_PER_DAY,
  LEAD_EXPIRY_DAYS,
  readCatalogArtifacts,
  readHfFeedItems,
  detectNewModels,
  planFanoutTasks,
  applyModelFacts,
  sourceTierFromUrl,
  withinWindow,
};
