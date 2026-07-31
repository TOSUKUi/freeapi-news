#!/usr/bin/env node
'use strict';

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

const USAGE = [
  'usage: node .devops/db/cli.js <command>',
  '',
  'commands:',
  '  migrate             create or update the collector SQLite schema',
  '  status              print schema version, active run, last promoted run, DB copies',
  '  bootstrap [--force] explicit one time import of the current report.json',
  '  restore             restore the newest validated database copy',
  '  manifest <run_dir>  build the lane manifest from current state and write <run_dir>/manifest.json',
  '  ingest <run_id> <run_dir>  validate run artifacts and stage them in the tasks table',
  '  reduce <run_id> <run_dir>  reduce staged lane results, apply offer changes, report the gate',
  '  bench-queue <run_dir>  build the daily benchmark search queue and write needs-lists',
  '  bench-reduce <run_id> <run_dir>  validate benchmark proposals and apply accepted facts',
  '  candidate-view <run_dir>  write the deterministic candidate view for the classifier and editor',
  '  assemble <run_id> <run_dir>  assemble the staged report.json from SQLite state and prose',
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
      const queue = benchmarks.buildBenchmarkQueue();
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
      const result = benchmarks.reduceBenchmarkTasks(runId, runDir);
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
