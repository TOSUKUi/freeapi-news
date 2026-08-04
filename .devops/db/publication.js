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
  //    Verify it exists and validate the candidate Registry structure so a
  //    malformed provider candidate can never reach the canonical Registry
  //    (spec 0004 AC-11).
  const candidateRegistry = path.join(candidateDir, 'provider-registry.json');
  if (!fs.existsSync(candidateRegistry)) {
    throw new Error(`candidate provider-registry.json not found at ${candidateRegistry}`);
  }
  const registryProblems = validateCandidateRegistry(candidateRegistry);
  if (registryProblems.length > 0) {
    db.finalizeRun(runId, {
      runStatus: 'failed',
      error: `candidate registry validation failed: ${registryProblems.join('; ')}`,
    }, options);
    throw new Error(
      `candidate registry validation failed for run ${runId}: ${registryProblems.join('; ')}`
    );
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
    // Validation creates a prepared manifest before promotion starts. Keep an
    // explicit marker so startup recovery does not mistake a validate-only
    // dry-run manifest with no canonical backups for a partial promotion.
    backups: {},
    promotion_started: false,
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

// Deterministic candidate Registry validation (spec 0004 AC-11): every
// provider must have a unique key, an http(s) base_url, a compilable
// base_url_pattern, and (when present) a compilable model_page template and
// catalog URL. Returns a list of problems; an empty list means the Registry
// is structurally valid.
function validateCandidateRegistry(registryPath) {
  const problems = [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  } catch (err) {
    return [`provider registry is not valid JSON: ${err.message}`];
  }
  const providers = Array.isArray(raw) ? raw : raw.providers;
  if (!Array.isArray(providers)) {
    return ['provider registry has no providers array'];
  }
  const seen = new Set();
  providers.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      problems.push(`providers[${index}] is not an object`);
      return;
    }
    if (typeof entry.key !== 'string' || !/^[a-z][a-z0-9_]*$/.test(entry.key)) {
      problems.push(`providers[${index}].key must be a lowercase identifier`);
      return;
    }
    if (seen.has(entry.key)) {
      problems.push(`duplicate provider key ${entry.key}`);
    }
    seen.add(entry.key);
    if (typeof entry.base_url !== 'string' || !/^https?:\/\//.test(entry.base_url)) {
      problems.push(`provider ${entry.key} base_url must be http(s)`);
    }
    if (entry.base_url_pattern !== null && entry.base_url_pattern !== undefined) {
      if (typeof entry.base_url_pattern !== 'string') {
        problems.push(`provider ${entry.key} base_url_pattern must be a string or null`);
      } else {
        try {
          new RegExp(entry.base_url_pattern);
        } catch {
          problems.push(`provider ${entry.key} base_url_pattern is not a valid regex`);
        }
      }
    }
    if (entry.model_page_template !== undefined && entry.model_page_template !== null) {
      if (typeof entry.model_page_template !== 'string' ||
          !entry.model_page_template.includes('{model_id}')) {
        problems.push(`provider ${entry.key} model_page_template must contain {model_id}`);
      }
    }
  });
  return problems;
}

// Computes a deterministic candidate identity hash (spec value sourcing): SHA-256 of
// canonical JSON containing run candidate identity, liveness, pricing,
// benchmark, access kind, and classification facts, excluding prose.
function computeCandidateHash(runId, report) {
  const identity = {
    run_id: runId,
    ranked: (report.ranked_offers || []).map((o) => ({
      name: o.name,
      model_id: o.model_id,
      provider: o.provider,
      provider_key: o.provider_key,
      canonical_model_id: o.canonical_model_id,
      access_kind: o.access_kind,
      base_url: o.base_url,
      ranking_eligible: o.ranking_eligible,
      tier: o.benchmark && o.benchmark.tier,
      score: o.benchmark && o.benchmark.score,
      benchmark_version: o.benchmark && o.benchmark.version,
      effective_input: o.effective_price_per_million && o.effective_price_per_million.input,
      effective_output: o.effective_price_per_million && o.effective_price_per_million.output,
      price_verified_at: o.price_verified_at,
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
  advanceManifest(runDir, 'prepared', { backups, promotion_started: true });

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
    throw failPromotion(runId, runDir, options, err, backups, 'promotion file copy failed');
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

  try {
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
          throw new Error(`post promotion hash mismatch for ${name}`);
        }
      }
    }
  } catch (err) {
    throw failPromotion(runId, runDir, options, err, manifest.backups || {}, 'post promotion verification failed');
  }

  try {
    advanceManifest(runDir, 'db_finalized');
  } catch (err) {
    throw failPromotion(runId, runDir, options, err, manifest.backups || {}, 'promotion finalization failed');
  }
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

// Restores canonical files from backup entries. A missing backup entry means
// the canonical file did not exist before this promotion, so remove any file
// that the failed promotion may have created. Errors are returned together so
// callers can preserve the original promotion failure.
function restoreCanonicalFiles(paths, backups = {}, options = {}) {
  const errors = [];
  const backupEntries = backups && typeof backups === 'object' ? backups : {};
  for (const rel of CANONICAL_FILES) {
    const dest = path.join(paths.projectRoot, rel);
    const entry = backupEntries[rel];
    try {
      if (entry && entry.path) {
        if (!fs.existsSync(entry.path)) {
          throw new Error(`backup file is missing: ${entry.path}`);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(entry.path, dest);
      } else {
        fs.rmSync(dest, { force: true });
      }
    } catch (err) {
      errors.push(new Error(`canonical ${rel} cleanup failed: ${err.message}`, { cause: err }));
    }

    if (options.runId) {
      try {
        fs.rmSync(`${dest}.promoting-${options.runId}`, { force: true });
      } catch (err) {
        errors.push(new Error(`temporary canonical ${rel} cleanup failed: ${err.message}`, { cause: err }));
      }
    }
  }
  return errors;
}

function aggregatePromotionFailure(original, cleanupErrors, context) {
  if (!cleanupErrors || cleanupErrors.length === 0) return original;
  const details = cleanupErrors.map((error) => error.message).join('; ');
  const aggregate = new AggregateError(
    [original, ...cleanupErrors],
    `${context}: ${original.message}; cleanup errors: ${details}`
  );
  aggregate.cause = original;
  aggregate.cleanupErrors = cleanupErrors;
  return aggregate;
}

// Attempt every rollback/status update, then throw the original failure unless
// cleanup itself also failed. AggregateError keeps the promotion failure as
// the first error and reports all cleanup failures without masking it.
function failPromotion(runId, runDir, options, original, backups, context) {
  const paths = db.resolvePaths(options);
  const cleanupErrors = restoreCanonicalFiles(paths, backups, { runId });
  try {
    db.finalizeRun(runId, {
      runStatus: 'failed',
      error: `${context}: ${original.message}`,
    }, options);
  } catch (err) {
    cleanupErrors.push(new Error(`failed to record promotion failure: ${err.message}`, { cause: err }));
  }
  try {
    advanceManifest(runDir, 'restored', { restore_reason: original.message });
  } catch (err) {
    cleanupErrors.push(new Error(`failed to mark promotion restored: ${err.message}`, { cause: err }));
  }
  return aggregatePromotionFailure(original, cleanupErrors, context);
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

// Marks every older undeployed validated generation as superseded (AC-14).
// A successfully promoted generation replaces both local validated candidates
// and failed deploy retries, while already deployed promoted history remains.
function supersedeOlderRuns(promotedRunId, options = {}) {
  const database = db.openCollectorDb(options);
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(
        "UPDATE runs SET status = 'superseded', finished_at = ? " +
        "WHERE status IN ('validated', 'validated_not_deployed') AND run_id != ?"
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
    if (!status || db.RUN_TERMINAL_STATUSES.includes(status)) continue;
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

// Returns promotion manifests that require canonical hash verification. This
// read-only preflight is intentionally separate from recovery so a mismatch
// can abort collection before database recovery or a new run starts.
function listPostFinalizationManifests(options = {}) {
  const paths = db.resolvePaths(options);
  const crawlDir = path.join(paths.stateDir, 'crawl');
  if (!fs.existsSync(crawlDir)) return [];

  // A finalized manifest is a historical record, not automatically the
  // current recovery target. Only the newest active deploy target owns the
  // canonical files. Older validated generations are normal after local
  // promotion and must not be compared with the newer canonical output.
  let byId;
  if (fs.existsSync(paths.dbPath)) {
    const database = db.openDatabaseFile(paths.dbPath, { readOnly: true });
    let runs;
    try {
      runs = database.prepare(
        "SELECT run_id, status, started_at, finished_at FROM runs " +
        "WHERE status IN ('candidate_ready', 'validated', 'validated_not_deployed')"
      ).all();
    } finally {
      database.close();
    }
    byId = new Map(runs.map((row) => [row.run_id, row]));
  } else {
    // Before SQLite exists there is no status/order authority. Preserve the
    // conservative legacy behavior and require inspection of the manifest.
    byId = new Map();
  }
  const candidates = [];
  for (const runId of fs.readdirSync(crawlDir)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) continue;
    const runDir = path.join(crawlDir, runId);
    if (!fs.statSync(runDir).isDirectory()) continue;
    const manifest = readManifest(runDir);
    const row = byId.get(runId) || (!fs.existsSync(paths.dbPath)
      ? { run_id: runId, status: 'unknown', started_at: runId, finished_at: null }
      : null);
    if (!manifest || manifest.run_id !== runId || !row) continue;
    const phaseIdx = MANIFEST_PHASES.indexOf(manifest.phase);
    if (phaseIdx >= MANIFEST_PHASES.indexOf('db_finalized') &&
        phaseIdx < MANIFEST_PHASES.indexOf('pushed')) {
      candidates.push({ runId, runDir, manifest, row });
    }
  }
  candidates.sort((a, b) => {
    const aKey = a.row.finished_at || a.row.started_at || '';
    const bKey = b.row.finished_at || b.row.started_at || '';
    return bKey.localeCompare(aKey) || b.runId.localeCompare(a.runId);
  });
  return candidates.slice(0, 1).map(({ runId, runDir, manifest }) => ({ runId, runDir, manifest }));
}

function assertNoManualInspectionRequired(options = {}) {
  for (const { runId, manifest } of listPostFinalizationManifests(options)) {
    try {
      verifyCanonicalHashes(db.resolvePaths(options), manifest);
    } catch (err) {
      throw new Error(
        `run ${runId} requires manual inspection: ${err.message}`,
        { cause: err }
      );
    }
  }
}

// Checks for interrupted promotions and recovers. Only mutating commands
// call this; read only commands (db:status, migrate) never restore files.
//
// Before db_finalized: restore canonical backups and the exact pre-run DB
// snapshot when one exists. After db_finalized: verify hashes and allow resume;
// never roll back a finalized or deploy-retry generation.
function recoverInterruptedPromotion(options = {}) {
  const paths = db.resolvePaths(options);
  const crawlDir = path.join(paths.stateDir, 'crawl');
  if (!fs.existsSync(crawlDir)) return null;

  // Preflight only the current finalized recovery target before changing any
  // files or the DB. Historical finalized generations are never candidates.
  assertNoManualInspectionRequired(options);
  const finalizedTargets = new Set(listPostFinalizationManifests(options).map((entry) => entry.runId));

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
      // A validated_not_deployed/promoted status is a safe generation even if
      // its manifest marker is stale; never restore its pre-run DB copy.
      let runStatus = null;
      try {
        runStatus = db.loadRunCandidate(runId, options).run.status;
      } catch {
        // An exact DB restore may already have removed this run row.
      }
      if (runStatus === 'validated_not_deployed' || runStatus === 'promoted') {
        results.push({ runId, action: 'preserved', fromPhase: phase, status: runStatus });
        continue;
      }

      // validateCandidate writes a prepared manifest before promotion begins.
      // Such a dry-run has no canonical backups and must leave the current
      // publication untouched. Once promotion starts, the explicit marker is
      // set even when the first-run backup map is legitimately empty.
      const promotionStarted = manifest.promotion_started === true ||
        phaseIdx >= MANIFEST_PHASES.indexOf('files_promoted') ||
        Object.keys(manifest.backups || {}).length > 0;
      const canonicalErrors = promotionStarted
        ? restoreCanonicalFiles(paths, manifest.backups || {}, { runId })
        : [];
      const exactBackup = db.exactRunDatabaseBackup(runId, options);
      if (exactBackup) {
        let restored;
        try {
          restored = db.restoreExactRunDatabase(exactBackup, options);
        } catch (err) {
          const original = new Error(
            `startup recovery from phase ${phase} could not restore the exact pre-run database`
          );
          throw aggregatePromotionFailure(
            original,
            [...canonicalErrors, err],
            'interrupted promotion recovery failed'
          );
        }
        if (canonicalErrors.length > 0) {
          const original = new Error(
            `startup recovery from phase ${phase} could not restore all canonical files`
          );
          throw aggregatePromotionFailure(
            original,
            canonicalErrors,
            'interrupted promotion recovery failed'
          );
        }
        advanceManifest(runDir, 'restored', {
          restore_reason: `startup recovery from phase ${phase}; exact pre-run DB restored`,
        });
        results.push({
          runId,
          action: 'restored_exact_database',
          fromPhase: phase,
          restoredFrom: restored.restoredFrom,
          sha256: restored.sha256,
        });
      } else {
        // Legacy/manual fixtures may not have an exact DB copy. Preserve the
        // old terminal marking behavior, but still aggregate cleanup errors.
        const cleanupErrors = [...canonicalErrors];
        try {
          db.finalizeRun(runId, {
            runStatus: 'failed',
            error: `interrupted promotion at phase ${phase}; restored backups`,
          }, options);
        } catch {
          // Run may already be terminal or absent.
        }
        try {
          advanceManifest(runDir, 'restored', {
            restore_reason: `startup recovery from phase ${phase}`,
          });
        } catch (err) {
          cleanupErrors.push(new Error(`failed to mark promotion restored: ${err.message}`, { cause: err }));
        }
        if (cleanupErrors.length > 0) {
          const original = new Error(`interrupted promotion at phase ${phase}; restored backups`);
          throw aggregatePromotionFailure(original, cleanupErrors, 'interrupted promotion recovery failed');
        }
        results.push({ runId, action: 'restored', fromPhase: phase });
      }
    } else if (phaseIdx >= MANIFEST_PHASES.indexOf('db_finalized') &&
               phaseIdx < MANIFEST_PHASES.indexOf('pushed')) {
      if (!finalizedTargets.has(runId)) continue;
      // After DB finalization: verify hashes, report resumable. No DB restore.
      try {
        verifyCanonicalHashes(paths, manifest);
        results.push({ runId, action: 'resumable', phase, manifest: manifestPath(runDir) });
      } catch (err) {
        throw new Error(
          `run ${runId} requires manual inspection: ${err.message}`,
          { cause: err }
        );
      }
    }
  }
  return results.length > 0 ? results : null;
}

// ---------------------------------------------------------------------------
// Run directory cleanup (AC-17)
// ---------------------------------------------------------------------------

// Removes only old, safe terminal run directories. Unknown directories and
// every nonterminal/retry state are retained for recovery and forensics. This
// function never deletes rows from runs, tasks, or source_cache.
function cleanupOldRuns(options = {}) {
  const paths = db.resolvePaths(options);
  const crawlDir = path.join(paths.stateDir, 'crawl');
  if (!fs.existsSync(crawlDir)) return 0;

  const statuses = new Map();
  let newestPromotedRunId = null;
  if (fs.existsSync(paths.dbPath) && db.checkIntegrity(paths.dbPath)) {
    const database = db.openDatabaseFile(paths.dbPath, { readOnly: true });
    try {
      const rows = database.prepare(
        'SELECT run_id, status, started_at, finished_at FROM runs'
      ).all();
      for (const row of rows) statuses.set(row.run_id, row);
      const newest = database.prepare(
        "SELECT run_id FROM runs WHERE status = 'promoted' " +
        'ORDER BY COALESCE(finished_at, started_at) DESC, run_id DESC LIMIT 1'
      ).get();
      newestPromotedRunId = newest ? newest.run_id : null;
    } finally {
      database.close();
    }
  }

  const cutoff = Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  for (const runId of fs.readdirSync(crawlDir)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) continue;
    const runDir = path.join(crawlDir, runId);
    const stat = fs.statSync(runDir);
    if (!stat.isDirectory() || stat.mtimeMs > cutoff) continue;

    const row = statuses.get(runId);
    if (!row) continue;
    if (row.status === 'failed' || row.status === 'superseded') {
      fs.rmSync(runDir, { recursive: true, force: true });
      cleaned += 1;
      continue;
    }
    // A promoted run is removable only after its manifest records a
    // successful push. A locally promoted generation remains a deploy target.
    if (row.status === 'promoted' && runId !== newestPromotedRunId) {
      const manifest = readManifest(runDir);
      if (manifest && manifest.phase === 'pushed') {
        fs.rmSync(runDir, { recursive: true, force: true });
        cleaned += 1;
      }
    }
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Git helper
// ---------------------------------------------------------------------------

function git(cwd, args, { allowFail = false } = {}) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    });
    // With allowFail the caller inspects .status, so success must return the
    // same object shape as failure (execFileSync returns a stdout string).
    if (allowFail) return { status: 0, stdout, stderr: '' };
    return stdout;
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
  validateCandidateRegistry,
  computeCandidateHash,
  // promotion
  promoteGeneration,
  // deploy
  deployGeneration,
  findDeployRetryTarget,
  findDeployTarget,
  // recovery
  recoverInterruptedPromotion,
  assertNoManualInspectionRequired,
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
