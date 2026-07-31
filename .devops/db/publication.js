'use strict';

// Staged publication pipeline. Spec 0003 fail safe collection pipeline,
// child 0004 (AC-13, AC-14, AC-15, AC-16).
//
// Every run builds all candidate JSON, HTML, and OG assets under
// <run_dir>/candidate/. Validation and build operate only on those files.
// Current tracked files change only after all checks pass (AC-13).
//
// Promotion uses a run local manifest, hashes, backups, and explicit phase
// markers. Any copy or rename failure restores all canonical files. On
// startup, an interrupted promotion before DB finalization restores backups;
// an interrupted promotion after DB finalization with matching hashes resumes
// commit or deploy (AC-14).
//
// A git push failure records validated_not_deployed, keeps the validated
// generation for deploy retry, and leaves the remote Pages revision
// unchanged (AC-14).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const db = require('./collector-db');

// Canonical tracked files that promotion replaces. Paths are relative to the
// project root. Git tracks exactly these (AC-17): public report.json,
// generated HTML and OG assets, and human managed provider-registry.json.
const CANONICAL_FILES = [
  'report.json',
  'index.html',
  'og-image.png',
  'build/provider-registry.json',
];

// Candidate file names (inside <run_dir>/candidate/).
const CANDIDATE_FILES = [
  'report.json',
  'index.html',
  'og-image.png',
  'provider-registry.json',
];

// Promotion manifest phases in order.
const MANIFEST_PHASES = [
  'prepared', 'files_promoted', 'db_finalized', 'committed', 'pushed',
];

// Git allowlist: exact paths staged for commit (AC-17).
const GIT_ALLOWLIST = [
  'report.json',
  'index.html',
  'og-image.png',
  'build/provider-registry.json',
];

// Run directories older than this many days are removed after a successful
// promotion (AC-17).
const RUN_RETENTION_DAYS = 7;

function nowIso() {
  return new Date().toISOString();
}

function sha256File(filePath) {
  return db.sha256File(filePath);
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

function manifestPath(runDir) {
  return path.join(runDir, 'promotion-manifest.json');
}

function readManifest(runDir) {
  const p = manifestPath(runDir);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(runDir, manifest) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(manifestPath(runDir), `${JSON.stringify(manifest, null, 2)}\n`);
}

function advanceManifest(runDir, phase, extra) {
  const manifest = readManifest(runDir);
  if (!manifest) throw new Error(`no promotion manifest at ${manifestPath(runDir)}`);
  manifest.phase = phase;
  manifest.phase_at = manifest.phase_at || {};
  manifest.phase_at[phase] = nowIso();
  if (extra) Object.assign(manifest, extra);
  writeManifest(runDir, manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Candidate validation and build (AC-13)
// ---------------------------------------------------------------------------

// Validates the candidate report.json against the daily report schema, builds
// candidate HTML and OG image, and records file hashes in the promotion
// manifest. Updates run status to validated on success. All work happens
// inside <run_dir>/candidate/; current tracked files are not touched.
function validateCandidate(runId, runDir, options = {}) {
  const paths = db.resolvePaths(options);
  const candidateDir = path.join(runDir, 'candidate');
  const candidateReport = path.join(candidateDir, 'report.json');

  if (!fs.existsSync(candidateReport)) {
    throw new Error(`candidate report.json not found at ${candidateReport}`);
  }

  // 1. Schema validation (auto fix + exclude, candidate only).
  //    The validator mutates the file in place, which is correct here because
  //    it operates on the candidate copy, not the current tracked file.
  const schemaPath = path.join(
    paths.projectRoot, '.agents', 'skills', 'llm-deals-intelligence-skill',
    'schemas', 'daily_report.schema.json'
  );
  const validatorPath = path.join(paths.projectRoot, 'build', 'validate-report.js');

  const validateEnv = { ...process.env };
  if (options.skipCitationCheck) {
    validateEnv.SKIP_CITATION_CHECK = '1';
  }

  try {
    execFileSync(process.execPath, [validatorPath, candidateReport, schemaPath], {
      cwd: paths.projectRoot,
      env: validateEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });
  } catch (err) {
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';
    db.finalizeRun(runId, {
      runStatus: 'failed',
      error: `candidate validation failed: ${stderr.slice(0, 2000) || stdout.slice(0, 2000) || err.message}`,
    }, options);
    throw new Error(`candidate validation failed for run ${runId}: ${err.message}`);
  }

  // 2. Build candidate HTML.
  const candidateHtml = path.join(candidateDir, 'index.html');
  const buildHtmlPath = path.join(paths.projectRoot, 'build', 'build-html.js');
  execFileSync(process.execPath, [buildHtmlPath, candidateReport, candidateHtml], {
    cwd: paths.projectRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });

  // 3. Build candidate OG image. If Chrome is unavailable, carry forward the
  //    current verified og-image.png and mark that manifest entry
  //    carried_forward rather than pretending it was generated (child 0004).
  const candidatePng = path.join(candidateDir, 'og-image.png');
  const buildOgPath = path.join(paths.projectRoot, 'build', 'build-og-image.js');
  const candidateOgHtml = path.join(candidateDir, 'og-image.html');
  let ogProvenance = 'generated';

  try {
    execFileSync(process.execPath, [buildOgPath, candidateReport, candidateOgHtml, candidatePng], {
      cwd: paths.projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    // The OG builder exits 0 even when Chrome is missing (it skips the
    // render). Check whether the PNG was actually produced.
    if (!fs.existsSync(candidatePng)) {
      ogProvenance = 'carried_forward';
      carryForwardOgImage(paths, candidatePng);
    }
  } catch {
    // Non zero exit means a real Chrome failure. Try carry forward.
    ogProvenance = 'carried_forward';
    carryForwardOgImage(paths, candidatePng);
  }

  // Clean up the intermediate OG HTML (gitignored pattern).
  try { fs.rmSync(candidateOgHtml, { force: true }); } catch { /* ok */ }

  // 4. Copy candidate provider-registry.json (assemble already wrote it).
  //    Verify it exists.
  const candidateRegistry = path.join(candidateDir, 'provider-registry.json');
  if (!fs.existsSync(candidateRegistry)) {
    throw new Error(`candidate provider-registry.json not found at ${candidateRegistry}`);
  }

  // 5. Compute candidate hash: SHA-256 of canonical JSON containing run
  //    candidate identity, liveness, pricing, benchmark, and classification
  //    facts, excluding prose (spec value sourcing).
  const report = JSON.parse(fs.readFileSync(candidateReport, 'utf8'));
  const candidateHash = computeCandidateHash(runId, report);

  // 6. Record file hashes in the promotion manifest.
  const files = {};
  for (const name of CANDIDATE_FILES) {
    const filePath = path.join(candidateDir, name);
    if (!fs.existsSync(filePath)) {
      if (name === 'og-image.png') {
        files[name] = { sha256: null, size: 0, provenance: 'missing' };
        continue;
      }
      throw new Error(`required candidate file missing: ${name}`);
    }
    const stat = fs.statSync(filePath);
    files[name] = {
      sha256: sha256File(filePath),
      size: stat.size,
      provenance: name === 'og-image.png' ? ogProvenance : 'generated',
    };
  }

  const manifest = {
    run_id: runId,
    schema_version: '0004',
    created_at: nowIso(),
    phase: 'prepared',
    phase_at: { prepared: nowIso() },
    candidate_hash: candidateHash,
    db_backup: null,
    files,
    backups: {},
  };

  // Include DB backup hash if a pre run copy exists.
  const backupDbPath = path.join(runDir, 'backup', 'collector.sqlite');
  if (fs.existsSync(backupDbPath)) {
    manifest.db_backup = { sha256: sha256File(backupDbPath), path: backupDbPath };
  }

  writeManifest(runDir, manifest);

  // 7. Update run status to validated.
  db.finalizeRun(runId, {
    runStatus: 'validated',
    candidateHash,
  }, options);

  return {
    runId,
    candidateDir,
    candidateHash,
    ogProvenance,
    files,
  };
}

// Carries forward the current verified og-image.png when Chrome is
// unavailable (child 0004: mark carried_forward, never pretend generated).
function carryForwardOgImage(paths, candidatePng) {
  const currentPng = path.join(paths.projectRoot, 'og-image.png');
  if (fs.existsSync(currentPng)) {
    fs.copyFileSync(currentPng, candidatePng);
  }
  // If neither exists, the candidate simply has no OG image. The manifest
  // records provenance missing and promotion skips it.
}

// Deterministic candidate identity hash (spec value sourcing): SHA-256 of
// canonical JSON containing run candidate identity, liveness, pricing,
// benchmark, and classification facts, excluding prose.
function computeCandidateHash(runId, report) {
  const identity = {
    run_id: runId,
    ranked: (report.ranked_offers || []).map((o) => ({
      name: o.name,
      model_id: o.model_id,
      provider: o.provider,
      base_url: o.base_url,
      ranking_eligible: o.ranking_eligible,
      tier: o.benchmark && o.benchmark.tier,
      score: o.benchmark && o.benchmark.score,
      free_allowance_rank: o.free_allowance_rank,
      last_verified: o.last_verified,
    })),
    caution: (report.caution_offers || []).map((o) => ({
      name: o.name,
      model_id: o.model_id,
    })),
    excluded: (report.excluded_offers || []).map((o) => ({
      name: o.name,
      reason: o.reason,
    })),
  };
  return sha256Buffer(Buffer.from(JSON.stringify(identity)));
}

// ---------------------------------------------------------------------------
// Promotion (AC-14)
// ---------------------------------------------------------------------------

// Promotes a validated candidate generation to the canonical tracked files.
// Phases: prepared (already set by validateCandidate) → files_promoted →
// db_finalized. Commit and push are separate (deployGeneration).
function promoteGeneration(runId, runDir, options = {}) {
  const paths = db.resolvePaths(options);
  const candidateDir = path.join(runDir, 'candidate');
  const manifest = readManifest(runDir);

  if (!manifest) {
    throw new Error(`no promotion manifest found at ${manifestPath(runDir)}; run validate-candidate first`);
  }
  if (manifest.run_id !== runId) {
    throw new Error(`manifest run_id ${manifest.run_id} does not match ${runId}`);
  }

  // Verify the run is in a promotable state.
  const { run } = db.loadRunCandidate(runId, options);
  if (run.status !== 'validated' && run.status !== 'validated_not_deployed') {
    throw new Error(`run ${runId} has status ${run.status}; expected validated or validated_not_deployed`);
  }

  // If files are already promoted (resuming), skip to DB finalization.
  if (MANIFEST_PHASES.indexOf(manifest.phase) >= MANIFEST_PHASES.indexOf('files_promoted')) {
    return resumePromotion(runId, runDir, manifest, options);
  }

  // 1. Backup current canonical files.
  const backupDir = path.join(runDir, 'backup', 'canonical');
  fs.mkdirSync(backupDir, { recursive: true });
  const backups = {};
  for (const rel of CANONICAL_FILES) {
    const src = path.join(paths.projectRoot, rel);
    if (fs.existsSync(src)) {
      const dest = path.join(backupDir, rel.replace(/\//g, '__'));
      fs.copyFileSync(src, dest);
      backups[rel] = { path: dest, sha256: sha256File(dest) };
    }
  }
  advanceManifest(runDir, 'prepared', { backups });

  // 2. Copy candidate files to temporary names, verify hashes, rename.
  try {
    for (const name of CANDIDATE_FILES) {
      const candidateFile = path.join(candidateDir, name);
      const canonicalRel = name === 'provider-registry.json'
        ? 'build/provider-registry.json'
        : name;
      const canonicalPath = path.join(paths.projectRoot, canonicalRel);
      const fileEntry = manifest.files[name];

      // OG image may be missing (no Chrome, no prior image).
      if (!fs.existsSync(candidateFile)) {
        if (name === 'og-image.png') continue;
        throw new Error(`candidate file missing: ${name}`);
      }

      // Verify hash before copying.
      if (fileEntry && fileEntry.sha256) {
        const actual = sha256File(candidateFile);
        if (actual !== fileEntry.sha256) {
          throw new Error(
            `candidate file ${name} hash mismatch: manifest ${fileEntry.sha256}, actual ${actual}`
          );
        }
      }

      // Copy to a temporary name in the same directory, then rename.
      fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
      const tmpPath = `${canonicalPath}.promoting-${runId}`;
      fs.copyFileSync(candidateFile, tmpPath);

      // Verify the copy.
      const tmpHash = sha256File(tmpPath);
      const expectedHash = fileEntry ? fileEntry.sha256 : sha256File(candidateFile);
      if (tmpHash !== expectedHash) {
        fs.rmSync(tmpPath, { force: true });
        throw new Error(`copy verification failed for ${name}`);
      }

      fs.renameSync(tmpPath, canonicalPath);
    }
  } catch (err) {
    // Restore all canonical files from backup.
    restoreCanonicalFiles(paths, backups);
    db.finalizeRun(runId, {
      runStatus: 'failed',
      error: `promotion file copy failed: ${err.message}`,
    }, options);
    advanceManifest(runDir, 'restored', { restore_reason: err.message });
    throw err;
  }

  advanceManifest(runDir, 'files_promoted');

  // 3. SQLite finalization: verify exported state hashes.
  return finalizePromotion(runId, runDir, options);
}

// SQLite finalization after file promotion. Verifies that the promoted files
// match the manifest hashes, then the promotion is considered DB finalized.
function finalizePromotion(runId, runDir, options) {
  const paths = db.resolvePaths(options);
  const manifest = readManifest(runDir);

  // Verify promoted file hashes match the manifest.
  for (const name of CANDIDATE_FILES) {
    const canonicalRel = name === 'provider-registry.json'
      ? 'build/provider-registry.json'
      : name;
    const canonicalPath = path.join(paths.projectRoot, canonicalRel);
    const fileEntry = manifest.files[name];

    if (!fs.existsSync(canonicalPath)) {
      if (name === 'og-image.png' && (!fileEntry || !fileEntry.sha256)) continue;
      throw new Error(`promoted file missing after copy: ${canonicalRel}`);
    }
    if (fileEntry && fileEntry.sha256) {
      const actual = sha256File(canonicalPath);
      if (actual !== fileEntry.sha256) {
        // Restore backups and fail.
        restoreCanonicalFiles(paths, manifest.backups || {});
        db.finalizeRun(runId, {
          runStatus: 'failed',
          error: `post promotion hash mismatch for ${name}`,
        }, options);
        advanceManifest(runDir, 'restored', { restore_reason: `hash mismatch: ${name}` });
        throw new Error(`post promotion hash mismatch for ${name}`);
      }
    }
  }

  advanceManifest(runDir, 'db_finalized');
  return { runId, phase: 'db_finalized' };
}

// Resumes an interrupted promotion after files_promoted.
function resumePromotion(runId, runDir, manifest, options) {
  const phaseIdx = MANIFEST_PHASES.indexOf(manifest.phase);

  if (phaseIdx < MANIFEST_PHASES.indexOf('db_finalized')) {
    // Interrupted before DB finalization: verify hashes and finalize.
    return finalizePromotion(runId, runDir, options);
  }

  // Already past db_finalized: nothing more to do here (deploy is separate).
  return { runId, phase: manifest.phase, resumed: true };
}

// Restores canonical files from backup entries.
function restoreCanonicalFiles(paths, backups) {
  for (const [rel, entry] of Object.entries(backups)) {
    if (!entry || !entry.path) continue;
    const dest = path.join(paths.projectRoot, rel);
    if (fs.existsSync(entry.path)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(entry.path, dest);
    }
  }
}

// ---------------------------------------------------------------------------
// Deploy (AC-14: commit, push, retry)
// ---------------------------------------------------------------------------

// Deploys a promoted generation: stages the exact tracked file allowlist,
// commits, and pushes. A push failure marks the run validated_not_deployed
// and preserves the generation for deploy retry.
function deployGeneration(runId, runDir, options = {}) {
  const paths = db.resolvePaths(options);
  const manifest = readManifest(runDir);

  if (!manifest) {
    throw new Error(`no promotion manifest at ${manifestPath(runDir)}`);
  }

  // Must be at least db_finalized.
  const phaseIdx = MANIFEST_PHASES.indexOf(manifest.phase);
  if (phaseIdx < MANIFEST_PHASES.indexOf('db_finalized')) {
    throw new Error(
      `run ${runId} manifest phase is ${manifest.phase}; must be at least db_finalized before deploy`
    );
  }

  // Verify canonical file hashes still match (resume safety).
  if (phaseIdx < MANIFEST_PHASES.indexOf('committed')) {
    verifyCanonicalHashes(paths, manifest);
  }

  // 1. Git add exact allowlist.
  const existingFiles = GIT_ALLOWLIST.filter((rel) =>
    fs.existsSync(path.join(paths.projectRoot, rel))
  );
  if (existingFiles.length === 0) {
    throw new Error('no tracked files to deploy');
  }

  git(paths.projectRoot, ['add', '--', ...existingFiles]);

  // Check if there is anything to commit.
  const diffResult = git(paths.projectRoot, ['diff', '--cached', '--quiet'], { allowFail: true });
  if (diffResult.status === 0) {
    // Nothing staged: already committed (idempotent resume).
    if (phaseIdx < MANIFEST_PHASES.indexOf('committed')) {
      advanceManifest(runDir, 'committed', { commit: 'noop' });
    }
  } else {
    // 2. Commit.
    const date = new Date().toISOString().slice(0, 10);
    const message = options.commitMessage || `chore: update report ${date} (run ${runId})`;
    git(paths.projectRoot, ['commit', '-m', message]);
    const commitHash = git(paths.projectRoot, ['rev-parse', 'HEAD']).trim();
    advanceManifest(runDir, 'committed', { commit: commitHash });
  }

  // 3. Push.
  try {
    const branch = git(paths.projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    git(paths.projectRoot, ['push', 'origin', branch]);
    advanceManifest(runDir, 'pushed');
  } catch (err) {
    // Push failure: mark validated_not_deployed, preserve for retry.
    db.finalizeRun(runId, {
      runStatus: 'validated_not_deployed',
      error: `deploy push failed: ${err.message}`,
    }, options);
    return {
      runId,
      deployed: false,
      status: 'validated_not_deployed',
      error: err.message,
    };
  }

  // 4. Mark run promoted.
  db.finalizeRun(runId, { runStatus: 'promoted' }, options);

  // 5. Supersede older un-deployed runs.
  supersedeOlderRuns(runId, options);

  // 6. Clean up old run directories.
  const cleaned = cleanupOldRuns(options);

  return {
    runId,
    deployed: true,
    status: 'promoted',
    cleanedRuns: cleaned,
  };
}

// Verifies that canonical file hashes match the manifest (resume safety).
// A mismatch stops for manual inspection rather than guessing (AC-14).
function verifyCanonicalHashes(paths, manifest) {
  for (const name of CANDIDATE_FILES) {
    const canonicalRel = name === 'provider-registry.json'
      ? 'build/provider-registry.json'
      : name;
    const canonicalPath = path.join(paths.projectRoot, canonicalRel);
    const fileEntry = manifest.files[name];
    if (!fileEntry || !fileEntry.sha256) continue;
    if (!fs.existsSync(canonicalPath)) {
      throw new Error(
        `canonical file ${canonicalRel} is missing but manifest records a hash. ` +
        'Manual inspection required.'
      );
    }
    const actual = sha256File(canonicalPath);
    if (actual !== fileEntry.sha256) {
      throw new Error(
        `canonical file ${canonicalRel} hash mismatch: manifest ${fileEntry.sha256}, ` +
        `actual ${actual}. Manual inspection required.`
      );
    }
  }
}

// Marks every older validated_not_deployed run as superseded (AC-14).
function supersedeOlderRuns(promotedRunId, options = {}) {
  const database = db.openCollectorDb(options);
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(
        "UPDATE runs SET status = 'superseded', finished_at = ? " +
        "WHERE status = 'validated_not_deployed' AND run_id != ?"
      ).run(nowIso(), promotedRunId);
      database.exec('COMMIT');
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch { /* ok */ }
      throw err;
    }
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Deploy retry
// ---------------------------------------------------------------------------

// Finds the newest non-superseded validated_not_deployed run for retry.
function findDeployRetryTarget(options = {}) {
  const database = db.openCollectorDb(options);
  try {
    const row = database.prepare(
      "SELECT * FROM runs WHERE status = 'validated_not_deployed' " +
      'ORDER BY COALESCE(finished_at, started_at) DESC LIMIT 1'
    ).get();
    return row || null;
  } finally {
    database.close();
  }
}

// Finds the newest run that is promoted locally but not yet pushed: its
// promotion manifest phase is db_finalized or committed (at least
// db_finalized, before pushed). This covers both a fresh collect (run status
// validated, awaiting its first deploy) and a failed push retry (run status
// validated_not_deployed). Returns { run_id, run_dir, phase, status } or
// null. Superseded and failed runs are ignored.
function findDeployTarget(options = {}) {
  const paths = db.resolvePaths(options);
  const crawlDir = path.join(paths.stateDir, 'crawl');
  if (!fs.existsSync(crawlDir)) return null;

  const database = db.openCollectorDb(options);
  const statusByRun = new Map();
  const sortByRun = new Map();
  try {
    const rows = database.prepare(
      'SELECT run_id, status, started_at, finished_at FROM runs'
    ).all();
    for (const row of rows) {
      statusByRun.set(row.run_id, row.status);
      sortByRun.set(row.run_id, row.finished_at || row.started_at || '');
    }
  } finally {
    database.close();
  }

  let best = null;
  for (const runId of fs.readdirSync(crawlDir)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) continue;
    const runDir = path.join(crawlDir, runId);
    const manifest = readManifest(runDir);
    if (!manifest || manifest.run_id !== runId) continue;
    const phaseIdx = MANIFEST_PHASES.indexOf(manifest.phase);
    if (phaseIdx < MANIFEST_PHASES.indexOf('db_finalized')) continue;
    if (phaseIdx >= MANIFEST_PHASES.indexOf('pushed')) continue;
    const status = statusByRun.get(runId);
    if (status === 'superseded' || status === 'failed') continue;
    const sortKey = sortByRun.get(runId) || '';
    if (!best || sortKey > best.sortKey) {
      best = { run_id: runId, run_dir: runDir, phase: manifest.phase, status, sortKey };
    }
  }
  if (!best) return null;
  return { run_id: best.run_id, run_dir: best.run_dir, phase: best.phase, status: best.status };
}

// ---------------------------------------------------------------------------
// Startup recovery (AC-14)
// ---------------------------------------------------------------------------

// Checks for interrupted promotions and recovers. Only mutating commands
// call this; read only commands (db:status, migrate) never restore files.
//
// Before db_finalized: restore canonical backups, mark run failed.
// After db_finalized: verify hashes match, allow resume. Mismatch stops for
// manual inspection.
function recoverInterruptedPromotion(options = {}) {
  const paths = db.resolvePaths(options);
  const crawlDir = path.join(paths.stateDir, 'crawl');
  if (!fs.existsSync(crawlDir)) return null;

  const results = [];
  for (const runId of fs.readdirSync(crawlDir)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) continue;
    const runDir = path.join(crawlDir, runId);
    const manifest = readManifest(runDir);
    if (!manifest) continue;

    // Only process manifests stuck in an intermediate phase.
    const phase = manifest.phase;
    if (phase === 'pushed' || phase === 'restored') continue;

    const phaseIdx = MANIFEST_PHASES.indexOf(phase);
    if (phaseIdx < 0) continue;

    if (phaseIdx < MANIFEST_PHASES.indexOf('db_finalized')) {
      // Interrupted before DB finalization: restore backups, mark failed.
      restoreCanonicalFiles(paths, manifest.backups || {});
      try {
        db.finalizeRun(runId, {
          runStatus: 'failed',
          error: `interrupted promotion at phase ${phase}; restored backups`,
        }, options);
      } catch {
        // Run may already be terminal.
      }
      advanceManifest(runDir, 'restored', {
        restore_reason: `startup recovery from phase ${phase}`,
      });
      results.push({ runId, action: 'restored', fromPhase: phase });
    } else if (phaseIdx >= MANIFEST_PHASES.indexOf('db_finalized') &&
               phaseIdx < MANIFEST_PHASES.indexOf('pushed')) {
      // After DB finalization: verify hashes, report resumable.
      try {
        verifyCanonicalHashes(paths, manifest);
        results.push({ runId, action: 'resumable', phase, manifest: manifestPath(runDir) });
      } catch (err) {
        results.push({
          runId, action: 'manual_inspection', phase,
          error: err.message,
        });
      }
    }
  }
  return results.length > 0 ? results : null;
}

// ---------------------------------------------------------------------------
// Run directory cleanup (AC-17)
// ---------------------------------------------------------------------------

// Removes ignored run directories older than seven days after a successful
// promotion.
function cleanupOldRuns(options = {}) {
  const paths = db.resolvePaths(options);
  const crawlDir = path.join(paths.stateDir, 'crawl');
  if (!fs.existsSync(crawlDir)) return 0;

  const cutoff = Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const runId of fs.readdirSync(crawlDir)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) continue;
    const runDir = path.join(crawlDir, runId);
    const stat = fs.statSync(runDir);
    if (stat.mtimeMs > cutoff) continue;

    // Never remove a run that is the latest promoted (its DB copy is the
    // recovery source).
    const manifest = readManifest(runDir);
    if (manifest && manifest.phase === 'pushed') {
      // Check if this is the newest promoted run.
      const status = db.getStatus(options);
      if (status.lastPromotedRun && status.lastPromotedRun.run_id === runId) continue;
    }

    fs.rmSync(runDir, { recursive: true, force: true });
    cleaned += 1;
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Git helper
// ---------------------------------------------------------------------------

function git(cwd, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
  } catch (err) {
    if (allowFail) return { status: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
    throw new Error(`git ${args.join(' ')} failed: ${(err.stderr || err.message).slice(0, 500)}`);
  }
}

module.exports = {
  // constants
  CANONICAL_FILES,
  CANDIDATE_FILES,
  MANIFEST_PHASES,
  GIT_ALLOWLIST,
  RUN_RETENTION_DAYS,
  // candidate validation
  validateCandidate,
  computeCandidateHash,
  // promotion
  promoteGeneration,
  // deploy
  deployGeneration,
  findDeployRetryTarget,
  findDeployTarget,
  // recovery
  recoverInterruptedPromotion,
  // cleanup
  cleanupOldRuns,
  // manifest helpers (exported for tests)
  readManifest,
  writeManifest,
  advanceManifest,
  manifestPath,
  verifyCanonicalHashes,
  restoreCanonicalFiles,
  supersedeOlderRuns,
};
