'use strict';

// Collector state store. Spec 0003 fail safe collection pipeline, child 0001.
//
// One local SQLite file is the sole operational state. Node 24 built in
// node:sqlite is the only interface. No ORM, no WAL, no service process.
// Every SQL value goes through a prepared statement. Mutating work runs in
// one short BEGIN IMMEDIATE transaction with rollback on error. The database
// file, its copies, and run directories are never Git tracked.
//
// Recovery model (AC-1): before mutation a closed database is copied into the
// current ignored run directory. On a missing or corrupt database the newest
// validated copy is restored. When no copy exists, collection stops until an
// operator runs the explicit bootstrap command (npm run db:bootstrap), which
// imports the current report.json with documented legacy defaults.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SKILL_STATE_DIR = path.join(
  PROJECT_ROOT, '.agents', 'skills', 'llm-deals-intelligence-skill', 'state'
);
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const DB_FILE_NAME = 'collector.sqlite';

const RUN_STATUSES = [
  'collecting', 'candidate_ready', 'validated',
  'validated_not_deployed', 'promoted', 'failed',
];
const RUN_TERMINAL_STATUSES = ['promoted', 'failed'];
const TASK_KINDS = [
  'catalog', 'known_refresh', 'discovery',
  'benchmark_scout', 'classifier', 'editorial',
];
const TASK_STATUSES = ['pending', 'complete', 'partial', 'failed'];
const TASK_RESULT_STATUSES = ['complete', 'partial', 'failed'];
const OFFER_STATUSES = ['verified', 'stale', 'confirmed_removed'];

// Known transport suffixes removed from an exact model ID to form the
// canonical model ID. Nothing else is stripped.
const TRANSPORT_SUFFIXES = [':free'];

// Explicit benchmark alias map. Display variants collapse to one internal
// key. Names without an alias fall back to a deterministic slug.
const BENCHMARK_ALIASES = [
  { key: 'terminal_bench_2_1', pattern: /^terminal[\s._/-]*bench[\s._/-]*2[\s._/-]*1\b/i },
];

class BootstrapRequiredError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BootstrapRequiredError';
    this.code = 'BOOTSTRAP_REQUIRED';
  }
}

class IdentityConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IdentityConflictError';
    this.code = 'IDENTITY_CONFLICT';
  }
}

function nowIso() {
  return new Date().toISOString();
}

// Runtime preflight. Node 24 is mandatory (engines >=24.0.0 <25) and its
// node:sqlite API must be present.
function assertRuntime() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 24) {
    throw new Error(
      `Node 24 is required (engines ">=24.0.0 <25"); found ${process.versions.node}. ` +
      'Install Node 24 before running the collector.'
    );
  }
  let sqlite;
  try {
    sqlite = require('node:sqlite');
  } catch (err) {
    throw new Error(`node:sqlite is unavailable on this Node build: ${err.message}`);
  }
  if (typeof sqlite.DatabaseSync !== 'function') {
    throw new Error('node:sqlite.DatabaseSync is missing from this Node build.');
  }
  return sqlite;
}

function resolvePaths(options = {}) {
  const projectRoot = path.resolve(options.projectRoot || PROJECT_ROOT);
  const stateDir = options.stateDir
    ? path.resolve(options.stateDir)
    : (options.projectRoot
        ? path.join(projectRoot, 'state')
        : SKILL_STATE_DIR);
  return {
    projectRoot,
    stateDir,
    dbPath: options.dbPath ? path.resolve(options.dbPath) : path.join(stateDir, DB_FILE_NAME),
    migrationsDir: options.migrationsDir ? path.resolve(options.migrationsDir) : MIGRATIONS_DIR,
    registryPath: options.registryPath
      ? path.resolve(options.registryPath)
      : path.join(projectRoot, 'build', 'provider-registry.json'),
    reportPath: options.reportPath
      ? path.resolve(options.reportPath)
      : path.join(projectRoot, 'report.json'),
  };
}

function assertRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) {
    throw new Error(`invalid run_id: ${JSON.stringify(runId)}`);
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function openDatabaseFile(dbPath, { readOnly = false } = {}) {
  const { DatabaseSync } = assertRuntime();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // Extension loading stays disabled. The default rollback journal remains.
  const db = new DatabaseSync(dbPath, { readOnly, allowExtension: false });
  db.exec('PRAGMA foreign_keys=ON');
  db.exec('PRAGMA busy_timeout=5000');
  return db;
}

// True when the file opens and PRAGMA integrity_check returns ok.
function checkIntegrity(dbPath) {
  if (!fs.existsSync(dbPath)) return false;
  let db;
  try {
    db = openDatabaseFile(dbPath, { readOnly: true });
    const row = db.prepare('PRAGMA integrity_check').get();
    return !!row && row.integrity_check === 'ok';
  } catch {
    return false;
  } finally {
    if (db) {
      try { db.close(); } catch { /* already closed */ }
    }
  }
}

function parseJsonColumn(value) {
  if (value === null || value === undefined || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const ROW_JSON_COLUMNS = {
  tasks: ['assigned_json', 'result_json', 'error_json'],
  offers: ['removal_evidence_json', 'facts_json'],
  benchmarks: ['facts_json'],
};

function parseRow(table, row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of ROW_JSON_COLUMNS[table] || []) {
    if (col in out) out[col] = parseJsonColumn(out[col]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

function ensureMigrationsTable(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (' +
    ' version INTEGER PRIMARY KEY,' +
    ' applied_at TEXT NOT NULL' +
    ')'
  );
}

function currentSchemaVersion(db) {
  ensureMigrationsTable(db);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return row && row.v !== null ? row.v : null;
}

function listMigrationFiles(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs.readdirSync(migrationsDir)
    .filter((name) => /^\d{3,}[^/]*\.sql$/.test(name))
    .sort((a, b) => migrationVersion(a) - migrationVersion(b) || a.localeCompare(b));
}

function migrationVersion(fileName) {
  return Number(fileName.match(/^(\d+)/)[1]);
}

// Applies numbered SQL files in order, one transaction per migration.
// Returns { schemaVersion, applied }.
function applyMigrations(options = {}) {
  const paths = resolvePaths(options);
  const db = openDatabaseFile(paths.dbPath);
  try {
    ensureMigrationsTable(db);
    const done = new Set(
      db.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version)
    );
    const applied = [];
    for (const fileName of listMigrationFiles(paths.migrationsDir)) {
      const version = migrationVersion(fileName);
      if (done.has(version)) continue;
      const sql = fs.readFileSync(path.join(paths.migrationsDir, fileName), 'utf8');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(sql);
        db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
          .run(version, nowIso());
        db.exec('COMMIT');
        applied.push(version);
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* connection state already reset */ }
        throw new Error(`migration ${fileName} failed: ${err.message}`);
      }
    }
    return { schemaVersion: currentSchemaVersion(db), applied };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Open, copy, restore
// ---------------------------------------------------------------------------

// Opens the collector database with recovery (AC-1).
//   file present and intact  -> open
//   file corrupt             -> move aside, restore newest validated copy
//   file missing             -> restore newest validated copy
//   no copy                  -> throw BootstrapRequiredError unless
//                               options.allowCreate is true (used by the
//                               migrate and bootstrap commands and tests)
function openCollectorDb(options = {}) {
  const paths = resolvePaths(options);
  if (fs.existsSync(paths.dbPath)) {
    if (checkIntegrity(paths.dbPath)) {
      return openDatabaseFile(paths.dbPath);
    }
    const movedAside = `${paths.dbPath}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(paths.dbPath, movedAside);
    } catch {
      fs.rmSync(paths.dbPath, { force: true });
    }
    const restored = restoreLatestDatabase(options);
    if (restored) return openDatabaseFile(paths.dbPath);
    throw new BootstrapRequiredError(
      `collector database at ${paths.dbPath} failed integrity check and no validated ` +
      `copy exists (corrupt file moved to ${movedAside}). Run "npm run db:bootstrap" ` +
      'to import the current report.json, or "npm run db:migrate" to start empty.'
    );
  }
  const restored = restoreLatestDatabase(options);
  if (restored) return openDatabaseFile(paths.dbPath);
  if (options.allowCreate) {
    return openDatabaseFile(paths.dbPath);
  }
  throw new BootstrapRequiredError(
    `collector database is missing at ${paths.dbPath} and no validated copy exists. ` +
    'Run "npm run db:bootstrap" to import the current report.json (one time), ' +
    'or "npm run db:migrate" to start empty.'
  );
}

function crawlDirFor(paths) {
  return path.join(paths.stateDir, 'crawl');
}

// Lists validated DB copies under <state>/crawl/<run_id>/backup/, newest first.
function listDatabaseCopies(options = {}) {
  const paths = resolvePaths(options);
  const crawlDir = crawlDirFor(paths);
  if (!fs.existsSync(crawlDir)) return [];
  const copies = [];
  for (const runId of fs.readdirSync(crawlDir)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId)) continue;
    const copyPath = path.join(crawlDir, runId, 'backup', DB_FILE_NAME);
    if (!fs.existsSync(copyPath)) continue;
    const stat = fs.statSync(copyPath);
    copies.push({ runId, path: copyPath, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  copies.sort((a, b) => b.mtimeMs - a.mtimeMs || b.runId.localeCompare(a.runId));
  return copies;
}

// Closes the database (when a handle is passed) and copies the closed file
// into <state>/crawl/<run_id>/backup/ before mutation. Returns the backup
// path and hash, or null when there is no database file yet.
function copyDatabaseForRun(runId, options = {}) {
  assertRunId(runId);
  const paths = resolvePaths(options);
  if (options.db && typeof options.db.close === 'function') {
    try { options.db.close(); } catch { /* already closed */ }
  }
  if (!fs.existsSync(paths.dbPath)) return null;
  if (!checkIntegrity(paths.dbPath)) {
    throw new Error(`refusing to copy a database that fails integrity_check: ${paths.dbPath}`);
  }
  const backupDir = path.join(crawlDirFor(paths), runId, 'backup');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, DB_FILE_NAME);
  fs.copyFileSync(paths.dbPath, backupPath);
  return { runId, backupPath, sha256: sha256File(backupPath), copiedAt: nowIso() };
}

// Restores the newest copy whose hash (when a promotion manifest records one)
// and SQLite integrity check pass. Returns restore details or null.
function restoreLatestDatabase(options = {}) {
  const paths = resolvePaths(options);
  for (const copy of listDatabaseCopies(options)) {
    const manifestPath = path.join(crawlDirFor(paths), copy.runId, 'promotion-manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const want = manifest && manifest.db_backup && manifest.db_backup.sha256;
        if (want && sha256File(copy.path) !== want) continue;
      } catch {
        // Unreadable manifest: fall through to the integrity check only.
      }
    }
    if (!checkIntegrity(copy.path)) continue;
    fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });
    fs.copyFileSync(copy.path, paths.dbPath);
    return { restoredFrom: copy.path, runId: copy.runId, sha256: sha256File(paths.dbPath) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runs and tasks
// ---------------------------------------------------------------------------

function getRunRow(db, runId) {
  const row = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId);
  return row || null;
}

// Inserts a collecting run and its manifest tasks (all pending) in one
// transaction. manifestTasks items: { task_id, kind, provider_key?,
// assigned_model_ids? }.
function startRun(runId, manifestTasks, options = {}) {
  assertRunId(runId);
  const db = openCollectorDb(options);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (getRunRow(db, runId)) {
        throw new Error(`run already exists: ${runId}`);
      }
      db.prepare('INSERT INTO runs (run_id, status, started_at) VALUES (?, ?, ?)')
        .run(runId, 'collecting', nowIso());
      const insertTask = db.prepare(
        'INSERT INTO tasks (run_id, task_id, kind, provider_key, assigned_json, status) ' +
        'VALUES (?, ?, ?, ?, ?, ?)'
      );
      for (const task of manifestTasks || []) {
        if (!task || typeof task.task_id !== 'string' || task.task_id.length === 0) {
          throw new Error('manifest task requires a task_id');
        }
        if (!TASK_KINDS.includes(task.kind)) {
          throw new Error(`unknown task kind: ${JSON.stringify(task.kind)}`);
        }
        insertTask.run(
          runId,
          task.task_id,
          task.kind,
          task.provider_key ?? null,
          Array.isArray(task.assigned_model_ids) && task.assigned_model_ids.length > 0
            ? JSON.stringify(task.assigned_model_ids)
            : null,
          'pending'
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* connection state already reset */ }
      throw err;
    }
    const run = getRunRow(db, runId);
    const tasks = db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id')
      .all(runId).map((row) => parseRow('tasks', row));
    return { run, tasks };
  } finally {
    db.close();
  }
}

// Validates manifest identity and stores one task result. Never touches
// current offers. outcome: { status: complete|partial|failed, result?,
// error? }. A result carrying task_id or provider_key must match the
// manifest row (AC-11 identity, enforced fully by the reducer in slice 2).
function recordTaskResult(runId, taskId, outcome, options = {}) {
  if (!outcome || !TASK_RESULT_STATUSES.includes(outcome.status)) {
    throw new Error(
      `task outcome status must be one of ${TASK_RESULT_STATUSES.join(', ')}`
    );
  }
  const db = openCollectorDb(options);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const task = db.prepare(
        'SELECT * FROM tasks WHERE run_id = ? AND task_id = ?'
      ).get(runId, taskId);
      if (!task) {
        throw new Error(`unknown task ${JSON.stringify(taskId)} in run ${runId}`);
      }
      if (task.status !== 'pending') {
        throw new Error(`task ${taskId} already recorded with status ${task.status}`);
      }
      const result = outcome.result ?? null;
      if (result && typeof result === 'object') {
        if (result.task_id !== undefined && String(result.task_id) !== String(taskId)) {
          throw new Error(
            `task result task_id ${JSON.stringify(result.task_id)} does not match ` +
            `manifest task_id ${JSON.stringify(taskId)}`
          );
        }
        if (result.provider_key !== undefined && task.provider_key !== null &&
            result.provider_key !== task.provider_key) {
          throw new Error(
            `task result provider_key ${JSON.stringify(result.provider_key)} does not ` +
            `match manifest provider_key ${JSON.stringify(task.provider_key)}`
          );
        }
      }
      db.prepare(
        'UPDATE tasks SET status = ?, result_json = ?, error_json = ?, completed_at = ? ' +
        'WHERE run_id = ? AND task_id = ?'
      ).run(
        outcome.status,
        result === null ? null : JSON.stringify(result),
        outcome.error === undefined ? null : JSON.stringify(outcome.error),
        nowIso(),
        runId,
        taskId
      );
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* connection state already reset */ }
      throw err;
    }
    return parseRow('tasks', db.prepare(
      'SELECT * FROM tasks WHERE run_id = ? AND task_id = ?'
    ).get(runId, taskId));
  } finally {
    db.close();
  }
}

// Returns the run row and its tasks with parsed JSON, the input for
// deterministic reduction and report assembly.
function loadRunCandidate(runId, options = {}) {
  const db = openCollectorDb(options);
  try {
    const run = getRunRow(db, runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    const tasks = db.prepare('SELECT * FROM tasks WHERE run_id = ? ORDER BY task_id')
      .all(runId).map((row) => parseRow('tasks', row));
    return { run, tasks };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Finalization (the one short mutating transaction)
// ---------------------------------------------------------------------------

function validateOfferChange(offer) {
  const required = ['provider_key', 'exact_model_id', 'canonical_model_id', 'source_kind'];
  for (const field of required) {
    if (typeof offer[field] !== 'string' || offer[field].length === 0) {
      throw new Error(`offer change requires non empty string field ${field}`);
    }
  }
  if (!OFFER_STATUSES.includes(offer.status)) {
    throw new Error(`offer status must be one of ${OFFER_STATUSES.join(', ')}`);
  }
  if (offer.consecutive_failures !== undefined &&
      (!Number.isInteger(offer.consecutive_failures) || offer.consecutive_failures < 0)) {
    throw new Error('offer consecutive_failures must be a non negative integer');
  }
}

function validateBenchmarkChange(benchmark) {
  const required = [
    'canonical_model_id', 'benchmark_key', 'display_name', 'version',
    'source_url', 'source_hash', 'verified_at',
  ];
  for (const field of required) {
    if (typeof benchmark[field] !== 'string' || benchmark[field].length === 0) {
      throw new Error(`benchmark change requires non empty string field ${field}`);
    }
  }
  if (typeof benchmark.score !== 'number' || !Number.isFinite(benchmark.score) ||
      benchmark.score < 0 || benchmark.score > 100) {
    throw new Error(
      `benchmark score must be a finite number from 0 through 100, got ${benchmark.score}`
    );
  }
}

function validateSourceCacheChange(entry) {
  if (typeof entry.url !== 'string' || entry.url.length === 0) {
    throw new Error('source_cache change requires non empty url');
  }
  if (typeof entry.subject_key !== 'string' || entry.subject_key.length === 0) {
    throw new Error('source_cache change requires non empty subject_key');
  }
  if (!Number.isInteger(entry.http_status)) {
    throw new Error('source_cache change requires integer http_status');
  }
  if (typeof entry.content_hash !== 'string' || entry.content_hash.length === 0) {
    throw new Error('source_cache change requires non empty content_hash');
  }
  if (typeof entry.fetched_at !== 'string' || entry.fetched_at.length === 0) {
    throw new Error('source_cache change requires non empty fetched_at');
  }
}

// Applies current offer, benchmark, cache, search, and run changes in one
// BEGIN IMMEDIATE transaction. Any error rolls back and leaves current rows
// unchanged (AC-15). Existing benchmark rows are immutable: a benchmark
// change inserts only when absent, so a higher proposed score never replaces
// an existing score. One exact provider offer ID mapping to two canonical
// IDs aborts finalization.
function finalizeRun(runId, changes = {}, options = {}) {
  const db = openCollectorDb(options);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const run = getRunRow(db, runId);
      if (!run) throw new Error(`unknown run: ${runId}`);
      if (RUN_TERMINAL_STATUSES.includes(run.status)) {
        throw new Error(`run ${runId} is already terminal with status ${run.status}`);
      }

      const canonicalByIdentity = new Map();
      const upsertOffer = db.prepare(
        'INSERT INTO offers (' +
        '  provider_key, exact_model_id, canonical_model_id, source_kind, status,' +
        '  consecutive_failures, first_seen_at, last_attempted_at, last_verified_at,' +
        '  last_seen_run_id, pricing_hash, removal_evidence_json, facts_json' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(provider_key, exact_model_id) DO UPDATE SET' +
        '  canonical_model_id = excluded.canonical_model_id,' +
        '  source_kind = excluded.source_kind,' +
        '  status = excluded.status,' +
        '  consecutive_failures = excluded.consecutive_failures,' +
        '  last_attempted_at = excluded.last_attempted_at,' +
        '  last_verified_at = excluded.last_verified_at,' +
        '  last_seen_run_id = excluded.last_seen_run_id,' +
        '  pricing_hash = excluded.pricing_hash,' +
        '  removal_evidence_json = excluded.removal_evidence_json,' +
        '  facts_json = excluded.facts_json'
        // first_seen_at is deliberately preserved on conflict.
      );
      for (const offer of changes.offers || []) {
        validateOfferChange(offer);
        const identityKey = `${offer.provider_key}\u0000${offer.exact_model_id}`;
        const seen = canonicalByIdentity.get(identityKey);
        if (seen !== undefined && seen !== offer.canonical_model_id) {
          throw new IdentityConflictError(
            `offer ${identityKey.replace('\u0000', ' ')} maps to two canonical IDs: ` +
            `${seen} and ${offer.canonical_model_id}`
          );
        }
        canonicalByIdentity.set(identityKey, offer.canonical_model_id);
        const existing = db.prepare(
          'SELECT canonical_model_id FROM offers WHERE provider_key = ? AND exact_model_id = ?'
        ).get(offer.provider_key, offer.exact_model_id);
        if (existing && existing.canonical_model_id !== offer.canonical_model_id) {
          throw new IdentityConflictError(
            `offer ${offer.provider_key} ${offer.exact_model_id} already maps to ` +
            `${existing.canonical_model_id}; refusing to remap to ${offer.canonical_model_id}`
          );
        }
        const now = nowIso();
        upsertOffer.run(
          offer.provider_key,
          offer.exact_model_id,
          offer.canonical_model_id,
          offer.source_kind,
          offer.status,
          offer.consecutive_failures ?? 0,
          offer.first_seen_at || now,
          offer.last_attempted_at ?? null,
          offer.last_verified_at ?? null,
          offer.last_seen_run_id ?? runId,
          offer.pricing_hash ?? null,
          offer.removal_evidence_json === undefined || offer.removal_evidence_json === null
            ? null
            : JSON.stringify(offer.removal_evidence_json),
          offer.facts_json === undefined || offer.facts_json === null
            ? null
            : JSON.stringify(offer.facts_json)
        );
      }

      // Insert only. Existing verified benchmark rows are immutable.
      const insertBenchmark = db.prepare(
        'INSERT INTO benchmarks (' +
        '  canonical_model_id, benchmark_key, display_name, version, score,' +
        '  source_url, source_hash, verified_at, facts_json' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(canonical_model_id, benchmark_key) DO NOTHING'
      );
      for (const benchmark of changes.benchmarks || []) {
        validateBenchmarkChange(benchmark);
        insertBenchmark.run(
          benchmark.canonical_model_id,
          benchmark.benchmark_key,
          benchmark.display_name,
          benchmark.version,
          benchmark.score,
          benchmark.source_url,
          benchmark.source_hash,
          benchmark.verified_at,
          benchmark.facts_json === undefined || benchmark.facts_json === null
            ? null
            : JSON.stringify(benchmark.facts_json)
        );
      }

      const upsertSearch = db.prepare(
        'INSERT INTO benchmark_searches (canonical_model_id, last_searched_at, result, metadata_hash) ' +
        'VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(canonical_model_id) DO UPDATE SET' +
        '  last_searched_at = excluded.last_searched_at,' +
        '  result = excluded.result,' +
        '  metadata_hash = excluded.metadata_hash'
      );
      for (const search of changes.benchmarkSearches || []) {
        if (typeof search.canonical_model_id !== 'string' || search.canonical_model_id.length === 0) {
          throw new Error('benchmark_searches change requires non empty canonical_model_id');
        }
        upsertSearch.run(
          search.canonical_model_id,
          search.last_searched_at || nowIso(),
          search.result ?? null,
          search.metadata_hash ?? null
        );
      }

      const upsertCache = db.prepare(
        'INSERT INTO source_cache (' +
        '  url, subject_key, provider_key, exact_model_id, fetched_at, http_status, content_hash' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(url, subject_key) DO UPDATE SET' +
        '  provider_key = excluded.provider_key,' +
        '  exact_model_id = excluded.exact_model_id,' +
        '  fetched_at = excluded.fetched_at,' +
        '  http_status = excluded.http_status,' +
        '  content_hash = excluded.content_hash'
      );
      for (const entry of changes.sourceCache || []) {
        validateSourceCacheChange(entry);
        upsertCache.run(
          entry.url,
          entry.subject_key,
          entry.provider_key ?? null,
          entry.exact_model_id ?? null,
          entry.fetched_at,
          entry.http_status,
          entry.content_hash
        );
      }

      if (changes.runStatus !== undefined || changes.candidateHash !== undefined ||
          changes.error !== undefined) {
        if (changes.runStatus !== undefined && !RUN_STATUSES.includes(changes.runStatus)) {
          throw new Error(`run status must be one of ${RUN_STATUSES.join(', ')}`);
        }
        const terminal = changes.runStatus !== undefined
          ? RUN_TERMINAL_STATUSES.includes(changes.runStatus)
          : RUN_TERMINAL_STATUSES.includes(run.status);
        db.prepare(
          'UPDATE runs SET status = ?, candidate_hash = ?, error = ?, finished_at = ? ' +
          'WHERE run_id = ?'
        ).run(
          changes.runStatus ?? run.status,
          changes.candidateHash ?? run.candidate_hash,
          changes.error ?? run.error,
          terminal ? nowIso() : null,
          runId
        );
      }

      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* connection state already reset */ }
      throw err;
    }
    return getRunRow(db, runId);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Public report input and status
// ---------------------------------------------------------------------------

// Deterministic current state for public report assembly (slice 4).
function buildPublicReportState(options = {}) {
  const db = openCollectorDb(options);
  try {
    const offers = db.prepare(
      'SELECT * FROM offers ORDER BY provider_key, exact_model_id'
    ).all().map((row) => parseRow('offers', row));
    const benchmarks = db.prepare(
      'SELECT * FROM benchmarks ORDER BY canonical_model_id, benchmark_key'
    ).all().map((row) => parseRow('benchmarks', row));
    const lastPromoted = db.prepare(
      "SELECT * FROM runs WHERE status = 'promoted' " +
      'ORDER BY COALESCE(finished_at, started_at) DESC LIMIT 1'
    ).get() || null;
    return { generatedAt: nowIso(), lastPromotedRun: lastPromoted, offers, benchmarks };
  } finally {
    db.close();
  }
}

function getStatus(options = {}) {
  const paths = resolvePaths(options);
  const dbExists = fs.existsSync(paths.dbPath);
  const integrityOk = dbExists ? checkIntegrity(paths.dbPath) : null;
  let schemaVersion = null;
  let currentRun = null;
  let lastPromotedRun = null;
  if (dbExists && integrityOk) {
    const db = openDatabaseFile(paths.dbPath, { readOnly: true });
    try {
      schemaVersion = currentSchemaVersion(db);
      currentRun = db.prepare(
        "SELECT * FROM runs WHERE status NOT IN ('promoted', 'failed') " +
        'ORDER BY started_at DESC LIMIT 1'
      ).get() || null;
      lastPromotedRun = db.prepare(
        "SELECT * FROM runs WHERE status = 'promoted' " +
        'ORDER BY COALESCE(finished_at, started_at) DESC LIMIT 1'
      ).get() || null;
    } finally {
      db.close();
    }
  }
  return {
    dbExists,
    integrityOk,
    dbPath: paths.dbPath,
    schemaVersion,
    currentRun,
    lastPromotedRun,
    copies: listDatabaseCopies(options),
  };
}

// ---------------------------------------------------------------------------
// Benchmark and model identity helpers (shared with later slices)
// ---------------------------------------------------------------------------

function canonicalModelId(exactModelId) {
  let canonical = exactModelId;
  for (const suffix of TRANSPORT_SUFFIXES) {
    if (canonical.toLowerCase().endsWith(suffix)) {
      canonical = canonical.slice(0, canonical.length - suffix.length);
      break;
    }
  }
  return canonical;
}

function benchmarkKey(displayName) {
  const name = String(displayName || '').trim();
  for (const alias of BENCHMARK_ALIASES) {
    if (alias.pattern.test(name)) return alias.key;
  }
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'unknown_benchmark';
}

function benchmarkVersion(displayName) {
  const match = String(displayName || '').match(/(\d+(?:\.\d+)+|\d+)\s*$/);
  return match ? match[1] : '';
}

// Pricing change detection (spec 0003 value sourcing). Catalog prices are
// decimal strings; the hash runs over canonical NUMERIC values, so "0", "0.0",
// and "0.00000000" hash alike. Returns null when either value is not finite.
function pricingHash(prompt, completion) {
  const p = Number(prompt);
  const c = Number(completion);
  if (!Number.isFinite(p) || !Number.isFinite(c)) return null;
  return crypto.createHash('sha256')
    .update(`${String(p)}\u0000${String(c)}`)
    .digest('hex');
}

// Fallback pricing hash for providers without numeric catalog prices: NFKC
// normalized official pricing text with trimmed and collapsed whitespace. Any
// remaining text change is a review candidate, not an automatic price change.
// Returns null for empty text.
function pricingHashFromText(text) {
  const t = String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return crypto.createHash('sha256').update(t).digest('hex');
}

// ---------------------------------------------------------------------------
// Run directory task artifact layout (shared by the lane and catalog modules)
// ---------------------------------------------------------------------------

// Task ids contain ':' (catalog:openrouter); file names may not on every
// platform. Sanitize to a safe, reversible enough name for artifact files.
function sanitizeTaskId(taskId) {
  return String(taskId).replace(/[^A-Za-z0-9._-]/g, '-');
}

// Task artifacts live at <run_dir>/artifacts/<task_id>.json. Run directories
// are ignored intermediate state (AC-17).
function artifactPathFor(runDir, taskId) {
  return path.join(runDir, 'artifacts', `${sanitizeTaskId(taskId)}.json`);
}

// ---------------------------------------------------------------------------
// Explicit one time bootstrap from report.json
// ---------------------------------------------------------------------------

function loadProviderRegistry(registryPath) {
  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const providers = Array.isArray(raw) ? raw : raw.providers;
  if (!Array.isArray(providers)) {
    throw new Error(`provider registry has no providers array: ${registryPath}`);
  }
  return providers;
}

function resolveProviderKey(providers, displayName) {
  const name = String(displayName || '').trim();
  if (!name) return null;
  const lowered = name.toLowerCase();
  for (const entry of providers) {
    if (typeof entry.label === 'string' && entry.label.toLowerCase() === lowered) {
      return entry.key;
    }
  }
  for (const entry of providers) {
    for (const token of entry.match || []) {
      if (typeof token === 'string' && token.length > 0 && lowered.includes(token.toLowerCase())) {
        return entry.key;
      }
    }
  }
  return null;
}

// Explicit one time emergency import from the current report.json (AC-1).
// Documented legacy defaults:
//   visible offers    ranked_offers + caution_offers + conditional_credits
//   offer status      verified, consecutive_failures 0, source_kind report
//   last_verified_at  the offer last_verified field, else report generated_at
//   canonical ID      exact model ID with only known transport suffixes removed
//   benchmark source  source_hash legacy-bootstrap, url from the offer
//   existing rows     offers refresh to verified; benchmark rows never replaced
// Offers whose provider does not resolve in provider-registry.json and offers
// without a model_id are skipped and counted.
function bootstrapFromReport(options = {}) {
  const paths = resolvePaths(options);
  if (!fs.existsSync(paths.reportPath)) {
    throw new Error(`report.json not found at ${paths.reportPath}`);
  }
  const report = JSON.parse(fs.readFileSync(paths.reportPath, 'utf8'));
  const providers = loadProviderRegistry(paths.registryPath);

  applyMigrations(options);
  const db = openDatabaseFile(paths.dbPath);
  try {
    const existing = db.prepare('SELECT COUNT(*) AS c FROM offers').get();
    if (existing.c > 0 && !options.force) {
      throw new Error(
        'bootstrap refuses to run against a non empty offers table ' +
        `(found ${existing.c} offers). This is a one time emergency import. ` +
        'Pass force to refresh legacy rows anyway.'
      );
    }

    const fallbackTime = report.generated_at || nowIso();
    const visible = [
      ...(Array.isArray(report.ranked_offers) ? report.ranked_offers : []),
      ...(Array.isArray(report.caution_offers) ? report.caution_offers : []),
      ...(Array.isArray(report.conditional_credits) ? report.conditional_credits : []),
    ];

    const summary = {
      reportPath: paths.reportPath,
      visibleOffers: visible.length,
      offersImported: 0,
      offersSkipped: 0,
      benchmarksImported: 0,
      benchmarksExisting: 0,
      benchmarksInvalid: 0,
    };

    const upsertOffer = db.prepare(
      'INSERT INTO offers (' +
      '  provider_key, exact_model_id, canonical_model_id, source_kind, status,' +
      '  consecutive_failures, first_seen_at, last_attempted_at, last_verified_at,' +
      '  last_seen_run_id, pricing_hash, removal_evidence_json, facts_json' +
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(provider_key, exact_model_id) DO UPDATE SET' +
      '  status = excluded.status,' +
      '  consecutive_failures = excluded.consecutive_failures,' +
      '  last_attempted_at = excluded.last_attempted_at,' +
      '  last_verified_at = excluded.last_verified_at,' +
      '  facts_json = excluded.facts_json'
    );
    const insertBenchmark = db.prepare(
      'INSERT INTO benchmarks (' +
      '  canonical_model_id, benchmark_key, display_name, version, score,' +
      '  source_url, source_hash, verified_at, facts_json' +
      ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(canonical_model_id, benchmark_key) DO NOTHING'
    );

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const offer of visible) {
        const providerKey = resolveProviderKey(providers, offer.provider);
        const exactModelId = typeof offer.model_id === 'string' ? offer.model_id : null;
        if (!providerKey || !exactModelId) {
          summary.offersSkipped += 1;
          continue;
        }
        const verifiedAt = offer.last_verified || fallbackTime;
        upsertOffer.run(
          providerKey,
          exactModelId,
          canonicalModelId(exactModelId),
          'report',
          'verified',
          0,
          verifiedAt,
          verifiedAt,
          verifiedAt,
          null,
          null,
          null,
          JSON.stringify(offer)
        );
        summary.offersImported += 1;

        const seenKeys = new Set();
        const benchmarkRows = [];
        if (Array.isArray(offer.benchmarks)) {
          for (const item of offer.benchmarks) {
            if (item && typeof item.name === 'string') {
              benchmarkRows.push({ name: item.name, score: item.score });
            }
          }
        }
        if (offer.benchmark && typeof offer.benchmark.benchmark_name === 'string') {
          benchmarkRows.push({ name: offer.benchmark.benchmark_name, score: offer.benchmark.score });
        }
        const canonical = canonicalModelId(exactModelId);
        const sourceUrl = offer.endpoint_source ||
          (Array.isArray(offer.sources) && typeof offer.sources[0] === 'string' ? offer.sources[0] : '') ||
          offer.base_url || '';
        for (const item of benchmarkRows) {
          const key = benchmarkKey(item.name);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          const score = Number(item.score);
          if (!Number.isFinite(score) || score < 0 || score > 100 || sourceUrl === '') {
            summary.benchmarksInvalid += 1;
            continue;
          }
          const info = insertBenchmark.run(
            canonical,
            key,
            item.name,
            benchmarkVersion(item.name),
            score,
            sourceUrl,
            'legacy-bootstrap',
            verifiedAt,
            JSON.stringify({
              origin: 'report-bootstrap',
              offer_name: offer.name || offer.model_name || exactModelId,
            })
          );
          if (info.changes > 0) summary.benchmarksImported += 1;
          else summary.benchmarksExisting += 1;
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* connection state already reset */ }
      throw err;
    }
    return summary;
  } finally {
    db.close();
  }
}

module.exports = {
  // constants
  RUN_STATUSES,
  RUN_TERMINAL_STATUSES,
  TASK_KINDS,
  TASK_STATUSES,
  TASK_RESULT_STATUSES,
  OFFER_STATUSES,
  TRANSPORT_SUFFIXES,
  BENCHMARK_ALIASES,
  // errors
  BootstrapRequiredError,
  IdentityConflictError,
  // runtime and paths
  assertRuntime,
  resolvePaths,
  // database lifecycle
  openCollectorDb,
  openDatabaseFile,
  checkIntegrity,
  applyMigrations,
  currentSchemaVersion,
  copyDatabaseForRun,
  listDatabaseCopies,
  restoreLatestDatabase,
  sha256File,
  // runs and tasks
  startRun,
  recordTaskResult,
  loadRunCandidate,
  finalizeRun,
  // report state and status
  buildPublicReportState,
  getStatus,
  // identity helpers
  canonicalModelId,
  benchmarkKey,
  benchmarkVersion,
  pricingHash,
  pricingHashFromText,
  // run directory layout
  sanitizeTaskId,
  artifactPathFor,
  // row parsing
  parseRow,
  // bootstrap
  bootstrapFromReport,
  resolveProviderKey,
};
