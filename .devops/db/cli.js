#!/usr/bin/env node
'use strict';

// Load environment configuration (sets defaults on process.env).
require('../config/env.config');

// Collector database commands (spec 0003, children 0001 through 0004).
//   node .devops/db/cli.js migrate            apply numbered migrations
//   node .devops/db/cli.js status             schema, runs, copies as JSON
//   node .devops/db/cli.js bootstrap [--force]  one time import from report.json
//   node .devops/db/cli.js restore            restore newest validated DB copy
//   node .devops/db/cli.js manifest <run_dir>  build the lane manifest from current state
//   node .devops/db/cli.js ingest <run_id> <run_dir>  validate and stage task artifacts
//   node .devops/db/cli.js reduce <run_id> <run_dir>  deterministic lane reduction
//   node .devops/db/cli.js bench-queue <run_dir>  build the benchmark search queue
//   node .devops/db/cli.js bench-reduce <run_id> <run_dir>  validate benchmark proposals, apply accepted facts
//   node .devops/db/cli.js candidate-view <run_dir>  write the deterministic candidate view for classifier and editor
//   node .devops/db/cli.js assemble <run_id> <run_dir>  deterministic staged report assembly

const path = require('node:path');
const fs = require('node:fs');

const db = require('./collector-db');
const lanes = require('./lanes');
const benchmarks = require('./benchmarks');
const assemble = require('./assemble');
const publication = require('./publication');
const collect = require('./collect');
const importLegacy = require('./import-legacy');
const researchWatchlist = require('../../build/research-watchlist');

function flagValues(flags, name) {
  const values = [];
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i];
    if (flag === name && typeof flags[i + 1] === 'string' && !flags[i + 1].startsWith('--')) {
      values.push(flags[++i]);
    } else if (typeof flag === 'string' && flag.startsWith(`${name}=`)) {
      const value = flag.slice(name.length + 1);
      if (value) values.push(value);
    }
  }
  return values;
}

const USAGE = [
  'usage: node .devops/db/cli.js <command>',
  '',
  'commands:',
  '  migrate             create or update the collector SQLite schema',
  '  status              print schema version, active run, last promoted run, DB copies',
  '  bootstrap [--force] explicit one time import of the current report.json',
  '  import-legacy [--force]  one time cutover import of known_offers.json + benchmarks.json',
  '  restore             restore the newest validated database copy',
  '  manifest <run_dir>  build the lane manifest from current state and write <run_dir>/manifest.json',
  '  ingest <run_id> <run_dir>  validate run artifacts and stage them in the tasks table',
  '  reduce <run_id> <run_dir>  reduce staged lane results, apply offer changes, report the gate',
  '  bench-queue <run_dir> [--model <id>] [--benchmark <name>]  build the benchmark search queue',
  '  bench-reduce <run_id> <run_dir> [--model <id>] [--benchmark <name>]  validate benchmark proposals',
  '  candidate-view <run_dir>  write the deterministic candidate view for the classifier and editor',
  '  assemble <run_id> <run_dir>  assemble the staged report.json from SQLite state and prose',
  '  set-hidden <provider_key> <exact_model_id> <true|false>  change the operator publication flag',
  '  watch:list [<domain>]           list research watchlist entries (spec 0008)',
  '  watch:add <domain> <json>       add or replace a schema validated watchlist entry',
  '  watch:remove <domain> <key>     remove a watchlist entry',
  '  leads:list [<status>]          list leads (open | verified | dismissed | expired | all)',
  '  leads:resolve <lead_id> <verified|dismissed|expired> [--note <text>] [--link <offer_key>]  resolve an open lead',
  '  collect [--dry-run] [--push] [--skip-citation] [--vision] [--model <id>] [--benchmark <name>]  run the full fail safe pipeline',
  '  validate-candidate <run_id> <run_dir>  validate candidate, build HTML and OG, record manifest',
  '  promote <run_id> <run_dir>  promote validated candidate to canonical tracked files',
  '  deploy [run_id] [run_dir]  commit and push the promoted generation (retries validated_not_deployed)',
  '  recover             check and recover interrupted promotions',
  '  cleanup             remove run directories older than seven days',
].join('\n');

function main() {
  const [command, ...flags] = process.argv.slice(2);
  db.assertRuntime();
  switch (command) {
    case 'migrate': {
      const result = db.applyMigrations();
      console.log(
        `schema version ${result.schemaVersion}` +
        (result.applied.length > 0 ? ` (applied ${result.applied.join(', ')})` : ' (no new migrations)')
      );
      return;
    }
    case 'status': {
      console.log(JSON.stringify(db.getStatus(), null, 2));
      return;
    }
    case 'bootstrap': {
      const summary = db.bootstrapFromReport({ force: flags.includes('--force') });
      console.log(JSON.stringify(summary, null, 2));
      console.log(
        `bootstrap complete: ${summary.offersImported} offers imported, ` +
        `${summary.offersSkipped} skipped, ${summary.benchmarksImported} benchmarks imported, ` +
        `${summary.benchmarksExisting} already present, ${summary.benchmarksInvalid} invalid`
      );
      return;
    }
    case 'import-legacy': {
      const summary = importLegacy.importLegacyState({ force: flags.includes('--force') });
      console.log(JSON.stringify(summary, null, 2));
      console.log(
        `import-legacy complete: ${summary.offersImported} offers imported, `
        + `${summary.offersSkipped} skipped, ${summary.benchmarksImported} benchmarks imported, `
        + `${summary.benchmarksExisting} already present, ${summary.benchmarksInvalid} invalid`
      );
      return;
    }
    case 'restore': {
      const result = db.restoreLatestDatabase();
      if (!result) {
        console.error('no validated database copy found under <skill state>/crawl/*/backup/');
        process.exitCode = 1;
        return;
      }
      console.log(
        `restored ${result.sha256} from run ${result.runId} (${result.restoredFrom})`
      );
      return;
    }
    case 'manifest': {
      const runDir = flags[0];
      if (!runDir) {
        console.error('manifest requires <run_dir>');
        process.exitCode = 1;
        return;
      }
      const runId = path.basename(path.resolve(runDir));
      const manifest = lanes.buildLaneManifest({ runId });
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      const kinds = manifest.tasks.reduce((acc, task) => {
        acc[task.kind] = (acc[task.kind] || 0) + 1;
        return acc;
      }, {});
      console.log(
        `manifest for run ${runId}: ${manifest.tasks.length} task(s) ` +
        `(${Object.entries(kinds).map(([kind, count]) => `${count} ${kind}`).join(', ')}), ` +
        `${manifest.lanes.known.assigned_offers} known offer(s) assigned`
      );
      return;
    }
    case 'ingest': {
      const [runId, runDir] = flags;
      if (!runId || !runDir) {
        console.error('ingest requires <run_id> <run_dir>');
        process.exitCode = 1;
        return;
      }
      const summary = lanes.ingestTaskArtifacts(runId, runDir);
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    case 'reduce': {
      const [runId, runDir] = flags;
      if (!runId || !runDir) {
        console.error('reduce requires <run_id> <run_dir>');
        process.exitCode = 1;
        return;
      }
      const result = lanes.reduceLanes(runId, runDir);
      console.log(JSON.stringify({
        run_status: result.run.status,
        can_promote: result.canPromote,
        gate_reason: result.gateReason,
        coverage: result.coverage,
        caution: result.caution,
        discovery_candidates: result.discoveryCandidates.length,
      }, null, 2));
      if (!result.canPromote) process.exitCode = 2;
      return;
    }
    case 'bench-queue': {
      const runDir = flags[0];
      if (!runDir) {
        console.error('bench-queue requires <run_dir>');
        process.exitCode = 1;
        return;
      }
      const forceModelIds = flagValues(flags.slice(1), '--model');
      const forceBenchmarkKeys = flagValues(flags.slice(1), '--benchmark')
        .map((value) => db.benchmarkKey(value))
        .filter((value) => value && value !== 'unknown_benchmark');
      const queue = benchmarks.buildBenchmarkQueue({ forceModelIds, forceBenchmarkKeys });
      const written = benchmarks.writeBenchmarkQueue(runDir, queue);
      console.log(JSON.stringify({
        queued: queue.queued,
        chunks: queue.chunks.length,
        needs_files: written.written,
      }, null, 2));
      return;
    }
    case 'bench-reduce': {
      const [runId, runDir] = flags;
      if (!runId || !runDir) {
        console.error('bench-reduce requires <run_id> <run_dir>');
        process.exitCode = 1;
        return;
      }
      const forceModelIds = flagValues(flags.slice(2), '--model');
      const forceBenchmarkKeys = flagValues(flags.slice(2), '--benchmark')
        .map((value) => db.benchmarkKey(value))
        .filter((value) => value && value !== 'unknown_benchmark');
      const result = benchmarks.reduceBenchmarkTasks(runId, runDir, {
        forceModelIds,
        forceBenchmarkKeys,
      });
      // Apply accepted facts in one short finalization transaction. Insert
      // only: an existing verified benchmark row is never replaced (AC-8).
      if (result.benchmarkChanges.length > 0 || result.searchChanges.length > 0) {
        db.finalizeRun(runId, {
          benchmarks: result.benchmarkChanges,
          benchmarkSearches: result.searchChanges,
        });
      }
      console.log(JSON.stringify({
        coverage: result.coverage,
        accepted: result.accepted.length,
        rejected: result.rejected.length,
        applied_benchmarks: result.benchmarkChanges.length,
        search_updates: result.searchChanges.length,
      }, null, 2));
      return;
    }
    case 'candidate-view': {
      const runDir = flags[0];
      if (!runDir) {
        console.error('candidate-view requires <run_dir>');
        process.exitCode = 1;
        return;
      }
      const view = assemble.buildCandidateView();
      const reducedDir = path.join(runDir, 'reduced');
      fs.mkdirSync(reducedDir, { recursive: true });
      fs.writeFileSync(
        path.join(reducedDir, 'candidate-view.json'),
        `${JSON.stringify(view, null, 2)}\n`
      );
      console.log(`candidate view: ${view.candidates.length} candidate(s) → reduced/candidate-view.json`);
      return;
    }
    case 'assemble': {
      const [runId, runDir] = flags;
      if (!runId || !runDir) {
        console.error('assemble requires <run_id> <run_dir>');
        process.exitCode = 1;
        return;
      }
      const result = assemble.assembleReport(runId, runDir);
      console.log(JSON.stringify({
        candidate_dir: result.candidateDir,
        counts: result.counts,
      }, null, 2));
      return;
    }
    case 'set-hidden': {
      const [providerKey, exactModelId, value] = flags;
      if (!providerKey || !exactModelId || !['true', 'false', '1', '0'].includes(value)) {
        console.error('set-hidden requires <provider_key> <exact_model_id> <true|false>');
        process.exitCode = 1;
        return;
      }
      const result = db.setOfferHidden(
        providerKey,
        exactModelId,
        value === 'true' || value === '1'
      );
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'watch:list': {
      const domain = flags[0];
      const data = researchWatchlist.loadWatchlist();
      if (domain) {
        if (domain === 'frontier_vendors') {
          console.log(JSON.stringify(data.frontier_vendors, null, 2));
          return;
        }
        if (!researchWatchlist.DOMAIN_KEYS.includes(domain)) {
          console.error(`watch:list domain must be one of ${[...researchWatchlist.DOMAIN_KEYS, 'frontier_vendors'].join(', ')}`);
          process.exitCode = 1;
          return;
        }
        console.log(JSON.stringify(data[domain], null, 2));
        return;
      }
      console.log(JSON.stringify({
        path: researchWatchlist.WATCHLIST_PATH,
        version: data.version,
        windows: data.windows,
        counts: Object.fromEntries(
          Object.keys(data)
            .filter((key) => Array.isArray(data[key]))
            .map((key) => [key, data[key].length])
        ),
      }, null, 2));
      return;
    }
    case 'watch:add': {
      const [domain, rawJson] = flags;
      if (!domain || rawJson === undefined) {
        console.error('watch:add requires <domain> <json>');
        process.exitCode = 1;
        return;
      }
      let entry;
      try {
        entry = JSON.parse(rawJson);
      } catch (err) {
        console.error(`watch:add json is not valid JSON: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      const data = researchWatchlist.loadWatchlist();
      const next = researchWatchlist.addEntry(data, domain, entry);
      researchWatchlist.writeWatchlist(next);
      console.log(JSON.stringify({ added: domain, key: entry.key || entry.provider_key || entry.kind }, null, 2));
      return;
    }
    case 'watch:remove': {
      const [domain, key] = flags;
      if (!domain || !key) {
        console.error('watch:remove requires <domain> <key>');
        process.exitCode = 1;
        return;
      }
      const data = researchWatchlist.loadWatchlist();
      const next = researchWatchlist.removeEntry(data, domain, key);
      researchWatchlist.writeWatchlist(next);
      console.log(JSON.stringify({ removed: domain, key }, null, 2));
      return;
    }
    case 'leads:list': {
      const [statusArg] = flags;
      const status = statusArg && statusArg !== 'all' ? statusArg : null;
      if (statusArg && !['open', 'verified', 'dismissed', 'expired', 'all'].includes(statusArg)) {
        console.error('leads:list status must be one of open, verified, dismissed, expired, all');
        process.exitCode = 1;
        return;
      }
      const rows = db.listLeads({ status }, {});
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    case 'leads:resolve': {
      const leadId = flags[0];
      const status = flags[1];
      if (!leadId || !status) {
        console.error('leads:resolve requires <lead_id> <verified|dismissed|expired>');
        process.exitCode = 1;
        return;
      }
      if (!['verified', 'dismissed', 'expired'].includes(status)) {
        console.error('leads:resolve status must be verified, dismissed, or expired');
        process.exitCode = 1;
        return;
      }
      const note = flagValues(flags, '--note')[0] || null;
      const link = flagValues(flags, '--link')[0] || null;
      const changed = db.resolveLead(leadId, { status, note, linked_offer_key: link }, {});
      console.log(JSON.stringify({ lead_id: leadId, status, resolved: changed }, null, 2));
      if (!changed) process.exitCode = 1;
      return;
    }
    case 'collect': {
      const options = {
        dryRun: flags.includes('--dry-run'),
        push: flags.includes('--push'),
        skipCitation: flags.includes('--skip-citation') || process.env.SKIP_CITATION_CHECK === '1',
        visionCapable: flags.includes('--vision'),
        forceModelIds: flagValues(flags, '--model'),
        forceBenchmarkKeys: flagValues(flags, '--benchmark')
          .map((value) => db.benchmarkKey(value))
          .filter((value) => value && value !== 'unknown_benchmark'),
      };
      collect.runPipeline(options).then((result) => {
        // pipelineStartAt() is a millisecond timestamp, so the elapsed value has
        // to be divided down: logging raw ms as "wall_seconds" overstated every
        // run's duration by 1000x (e.g. 1221842 for a 1222s run).
        const wallSeconds = Math.round((Date.now() - collect.pipelineStartAt()) / 1000);
        console.log(JSON.stringify({
          run_id: result.runId,
          mode: options.dryRun ? 'dry-run' : options.push ? 'full' : 'collect',
          wall_seconds: wallSeconds,
          promoted: result.promoted,
          deployed: result.deployed,
          can_promote: result.canPromote,
          gate_reason: result.gateReason || null,
          candidate_hash: result.candidateHash || null,
          counts: result.counts || null,
        }, null, 2));
        if (!result.canPromote) process.exitCode = 2;
        else if (options.push && !result.deployed) process.exitCode = 3;
      }).catch((err) => {
        console.error(`collect failed: ${err.message}`);
        process.exitCode = 1;
      });
      return;
    }
    case 'validate-candidate': {
      const [runId, runDir] = flags;
      if (!runId || !runDir) {
        console.error('validate-candidate requires <run_id> <run_dir>');
        process.exitCode = 1;
        return;
      }
      const skipCitation = flags.includes('--skip-citation') ||
        process.env.SKIP_CITATION_CHECK === '1';
      const result = publication.validateCandidate(runId, runDir, { skipCitationCheck: skipCitation });
      console.log(JSON.stringify({
        run_id: result.runId,
        candidate_hash: result.candidateHash,
        og_provenance: result.ogProvenance,
        files: Object.fromEntries(
          Object.entries(result.files).map(([k, v]) => [k, { sha256: v.sha256, provenance: v.provenance }])
        ),
      }, null, 2));
      return;
    }
    case 'promote': {
      const [runId, runDir] = flags;
      if (!runId || !runDir) {
        console.error('promote requires <run_id> <run_dir>');
        process.exitCode = 1;
        return;
      }
      const result = publication.promoteGeneration(runId, runDir);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case 'deploy': {
      let [runId, runDir] = flags;
      // Without explicit args, find the newest locally promoted run that has
      // not been pushed yet (a fresh collect or a failed push retry).
      if (!runId) {
        const target = publication.findDeployTarget();
        if (!target) {
          console.error('no promoted run awaiting deploy found (nothing to push)');
          process.exitCode = 1;
          return;
        }
        runId = target.run_id;
        runDir = target.run_dir;
        console.log(`deploy: targeting run ${runId} (phase ${target.phase}, status ${target.status})`);
      }
      if (!runDir) {
        const paths = db.resolvePaths();
        runDir = path.join(paths.stateDir, 'crawl', runId);
      }
      const result = publication.deployGeneration(runId, runDir);
      console.log(JSON.stringify(result, null, 2));
      if (!result.deployed) process.exitCode = 2;
      return;
    }
    case 'recover': {
      const results = publication.recoverInterruptedPromotion();
      if (!results) {
        console.log('no interrupted promotions found');
        return;
      }
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    case 'cleanup': {
      const cleaned = publication.cleanupOldRuns();
      console.log(`removed ${cleaned} old run directory(ies)`);
      return;
    }
    default: {
      console.error(command ? `unknown command: ${command}\n` : USAGE);
      process.exitCode = 1;
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`db ${process.argv[2] || ''} failed: ${err.message}`.trim());
  process.exitCode = 1;
}
