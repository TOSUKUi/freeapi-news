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
  'validated_not_deployed', 'promoted', 'superseded', 'failed',
];
const RUN_TERMINAL_STATUSES = ['promoted', 'superseded', 'failed'];
const TASK_KINDS = [
  'catalog', 'known_refresh', 'discovery',
  'benchmark_scout', 'classifier', 'editorial',
  // Spec 0008 Phase 1: deterministic watch channel fetch + model first
  // research workers.
  'watch', 'news_scan', 'vendor_deep_dive', 'community', 'model_fanout',
  // Spec 0008 Phase 2: operational evidence workers (Phase 3 reservation
  // for product / program monitors lives here so 0012 rebuilds tasks once).
  'provider_monitor', 'nim_verify', 'product_monitor', 'program_monitor',
];
const TASK_STATUSES = ['pending', 'complete', 'partial', 'failed'];
const TASK_RESULT_STATUSES = ['complete', 'partial', 'failed'];
const OFFER_STATUSES = ['verified', 'stale', 'confirmed_removed'];

// Offer price columns carried by finalizeRun, bootstrap, and import legacy.
// Spec 0004 AC-3: core prices live in typed columns, never in facts_json.
// All prices are USD per million tokens (source_amount_* are in the source
// currency and unit) and nullable with a database check of zero or greater.
// This list is the single source of truth for the offer write paths.
const OFFER_PRICE_COLUMNS = [
  'normal_input_price_usd', 'normal_output_price_usd',
  'normal_cache_read_price_usd', 'normal_cache_write_price_usd',
  'effective_input_price_usd', 'effective_output_price_usd',
  'effective_cache_read_price_usd', 'effective_cache_write_price_usd',
  'source_amount_input', 'source_amount_output',
  'normal_source_amount_input', 'normal_source_amount_output',
  'normal_source_amount_cache_read', 'normal_source_amount_cache_write',
  'effective_source_amount_input', 'effective_source_amount_output',
  'effective_source_amount_cache_read', 'effective_source_amount_cache_write',
  'source_currency', 'source_unit',
  'conversion_rate', 'conversion_source', 'conversion_confirmed_at',
  'price_source_url', 'price_verified_at',
  'discount_start_at', 'discount_end_at',
];

// Known transport suffixes removed from an exact model ID to form the
// canonical model ID. Nothing else is stripped.
const TRANSPORT_SUFFIXES = [':free'];

// Explicit benchmark alias map. Display variants collapse to one internal
// key. Names without an alias fall back to a deterministic slug.
const BENCHMARK_ALIASES = [
  { key: 'terminal_bench_2_0', pattern: /^terminal[\s._/-]*bench[\s._/-]*2[\s._/-]*0\b/i },
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
    watchlistPath: options.watchlistPath
      ? path.resolve(options.watchlistPath)
      : path.join(projectRoot, 'build', 'research-watchlist.json'),
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
  offers: ['removal_evidence_json', 'facts_json', 'data_policy_json'],
  benchmarks: ['facts_json'],
  models: ['aliases_json', 'known_providers_json'],
  watch_facts: ['facts_json'],
  changes: ['before_json', 'after_json'],
  contradictions: ['values_json'],
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
  const sha256 = sha256File(backupPath);
  // Persist the hash beside the copy so a process that dies before a
  // promotion manifest exists can still identify and verify this exact
  // pre-run snapshot on the next startup.
  const hashPath = `${backupPath}.sha256`;
  const hashTmp = `${hashPath}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  try {
    fs.writeFileSync(hashTmp, `${sha256}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(hashTmp, hashPath);
  } finally {
    try { fs.rmSync(hashTmp, { force: true }); } catch { /* best effort */ }
  }
  return { runId, backupPath, sha256, copiedAt: nowIso() };
}

// Returns the persisted descriptor for one run's exact pre-run copy. This
// deliberately does not search or sort other run directories.
function exactRunDatabaseBackup(runId, options = {}) {
  assertRunId(runId);
  const paths = resolvePaths(options);
  const backupPath = path.join(crawlDirFor(paths), runId, 'backup', DB_FILE_NAME);
  const hashPath = `${backupPath}.sha256`;
  if (!fs.existsSync(backupPath) || !fs.existsSync(hashPath)) return null;
  const sha256 = fs.readFileSync(hashPath, 'utf8').trim();
  return { runId, backupPath, sha256 };
}

// Restores one exact run backup. The caller must provide the run id, the
// canonical backup path for that run, and its expected hash. No other run's
// copy is considered. Both the source and a same-directory temporary copy are
// checked for the expected SHA-256 and SQLite integrity before the temporary
// file atomically replaces the live database.
function restoreExactRunDatabase(backup, options = {}) {
  if (!backup || typeof backup !== 'object') {
    throw new Error('exact database restore requires a backup descriptor');
  }
  assertRunId(backup.runId);
  const paths = resolvePaths(options);
  const expectedPath = path.resolve(
    path.join(crawlDirFor(paths), backup.runId, 'backup', DB_FILE_NAME)
  );
  const backupPath = path.resolve(backup.backupPath || '');
  if (backupPath !== expectedPath) {
    throw new Error(
      `exact database restore path does not match run ${backup.runId}: ${backup.backupPath}`
    );
  }
  if (typeof backup.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(backup.sha256)) {
    throw new Error(`exact database restore requires a valid expected SHA-256 for run ${backup.runId}`);
  }
  if (!fs.existsSync(backupPath)) {
    throw new Error(`exact database backup is missing for run ${backup.runId}: ${backupPath}`);
  }
  let stat;
  try { stat = fs.lstatSync(backupPath); } catch (err) {
    throw new Error(`cannot inspect exact database backup for run ${backup.runId}: ${err.message}`);
  }
  if (!stat.isFile()) {
    throw new Error(`exact database backup is not a regular file for run ${backup.runId}`);
  }
  const sourceHash = sha256File(backupPath);
  if (sourceHash !== backup.sha256) {
    throw new Error(
      `exact database backup hash mismatch for run ${backup.runId}: ` +
      `expected ${backup.sha256}, got ${sourceHash}`
    );
  }
  if (!checkIntegrity(backupPath)) {
    throw new Error(`exact database backup fails integrity_check for run ${backup.runId}`);
  }

  if (options.db && typeof options.db.close === 'function') {
    try { options.db.close(); } catch { /* already closed */ }
  }
  const liveDir = path.dirname(paths.dbPath);
  fs.mkdirSync(liveDir, { recursive: true });
  const tempPath = path.join(
    liveDir,
    `.${DB_FILE_NAME}.restore-${backup.runId}-${process.pid}-` +
      crypto.randomBytes(8).toString('hex')
  );
  try {
    fs.copyFileSync(backupPath, tempPath, fs.constants.COPYFILE_EXCL);
    const tempHash = sha256File(tempPath);
    if (tempHash !== backup.sha256) {
      throw new Error(
        `temporary exact database copy hash mismatch for run ${backup.runId}: ` +
        `expected ${backup.sha256}, got ${tempHash}`
      );
    }
    if (!checkIntegrity(tempPath)) {
      throw new Error(`temporary exact database copy fails integrity_check for run ${backup.runId}`);
    }
    // Both paths are in the live database directory's filesystem, so this is
    // an atomic replacement rather than a delete-then-copy window.
    fs.renameSync(tempPath, paths.dbPath);
    if (sha256File(paths.dbPath) !== backup.sha256 || !checkIntegrity(paths.dbPath)) {
      throw new Error(`live database verification failed after exact restore for run ${backup.runId}`);
    }
    return {
      runId: backup.runId,
      restoredFrom: backupPath,
      sha256: backup.sha256,
    };
  } finally {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
  }
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
// assigned_model_ids?, assigned_json? }.
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
          task.assigned_json !== undefined
            ? JSON.stringify(task.assigned_json)
            : (Array.isArray(task.assigned_model_ids) && task.assigned_model_ids.length > 0
              ? JSON.stringify(task.assigned_model_ids)
              : null),
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

// Adds task rows to a run that already exists. The benchmark scout tasks are
// only known after the lane reduction builds the daily benchmark queue, which
// happens after startRun has created the run from the lane manifest. This
// inserts those scout tasks as pending so ingest can stage their artifacts.
// Existing task_ids are skipped, never overwritten (idempotent).
function addRunTasks(runId, tasks, options = {}) {
  assertRunId(runId);
  const db = openCollectorDb(options);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!getRunRow(db, runId)) {
        throw new Error(`unknown run: ${runId}`);
      }
      const insertTask = db.prepare(
        'INSERT INTO tasks (run_id, task_id, kind, provider_key, assigned_json, status) '
        + 'VALUES (?, ?, ?, ?, ?, ?) '
        + 'ON CONFLICT(run_id, task_id) DO NOTHING'
      );
      let added = 0;
      for (const task of tasks || []) {
        if (!task || typeof task.task_id !== 'string' || task.task_id.length === 0) {
          throw new Error('task requires a task_id');
        }
        if (!TASK_KINDS.includes(task.kind)) {
          throw new Error(`unknown task kind: ${JSON.stringify(task.kind)}`);
        }
        const info = insertTask.run(
          runId,
          task.task_id,
          task.kind,
          task.provider_key ?? null,
          Array.isArray(task.assigned_model_ids) && task.assigned_model_ids.length > 0
            ? JSON.stringify(task.assigned_model_ids)
            : null,
          'pending'
        );
        if (info.changes > 0) added += 1;
      }
      db.exec('COMMIT');
      return { runId, added };
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* connection state already reset */ }
      throw err;
    }
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

// Replaces a previously ingested task result after deterministic evidence
// auditing. Network work has completed before this short SQLite transaction.
function updateTaskResult(runId, taskId, result, options = {}) {
  const database = openCollectorDb(options);
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const task = database.prepare('SELECT * FROM tasks WHERE run_id = ? AND task_id = ?').get(runId, taskId);
      if (!task) throw new Error(`unknown task ${taskId} in run ${runId}`);
      if (!TASK_RESULT_STATUSES.includes(task.status)) throw new Error(`task ${taskId} has no recorded result`);
      database.prepare('UPDATE tasks SET result_json = ? WHERE run_id = ? AND task_id = ?')
        .run(result === undefined || result === null ? null : JSON.stringify(result), runId, taskId);
      database.exec('COMMIT');
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  } finally {
    database.close();
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
    const versionRequired = field === 'version' &&
      ['terminal_bench_2_0', 'terminal_bench_2_1'].includes(benchmark.benchmark_key);
    const nonEmptyRequired = field !== 'version' || versionRequired;
    if (typeof benchmark[field] !== 'string' ||
        (nonEmptyRequired && benchmark[field].length === 0) ||
        (versionRequired && benchmark[field].trim().length === 0)) {
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

// SQL fragments for the typed offer price columns (spec 0004 AC-3). The base
// offer columns plus OFFER_PRICE_COLUMNS form the full write surface. The
// update clause sets every column from excluded except first_seen_at (and
// removal_evidence_json which is replaced wholesale).
function buildOfferUpsertSql(extraUpdate = '') {
  const columns = [
    'provider_key', 'exact_model_id', 'canonical_model_id', 'source_kind', 'status',
    'consecutive_failures', 'first_seen_at', 'last_attempted_at', 'last_verified_at',
    'last_seen_run_id', 'pricing_hash', 'removal_evidence_json', 'facts_json',
    ...OFFER_PRICE_COLUMNS,
  ];
  const placeholders = columns.map(() => '?').join(', ');
  const update = columns
    .filter((column) => column !== 'first_seen_at')
    .map((column) => `${column} = excluded.${column}`)
    .join(', ');
  return `INSERT INTO offers (${columns.join(', ')})
    VALUES (${placeholders})
    ON CONFLICT(provider_key, exact_model_id) DO UPDATE SET ${update}${extraUpdate}`;
}

function offerUpsertParams(offer, now, runId) {
  return [
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
      : JSON.stringify(sanitizeOfferFacts(offer.facts_json)),
    ...OFFER_PRICE_COLUMNS.map((column) => {
      const value = offer[column];
      return value === undefined || value === null ? null : value;
    }),
  ];
}

// Changes the operator controlled visibility flag without allowing a catalog
// or worker upsert to clear it. Hidden offers remain in SQLite for audit and
// can be made visible again explicitly.
function setOfferHidden(providerKey, exactModelId, hidden, options = {}) {
  if (typeof providerKey !== 'string' || !providerKey.trim()) {
    throw new Error('provider_key is required');
  }
  if (typeof exactModelId !== 'string' || !exactModelId.trim()) {
    throw new Error('exact_model_id is required');
  }
  if (hidden !== true && hidden !== false && hidden !== 0 && hidden !== 1) {
    throw new Error('hidden must be a boolean or 0/1');
  }
  applyMigrations(options);
  const database = openCollectorDb(options);
  try {
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = database.prepare(
        'SELECT provider_key, exact_model_id, hidden FROM offers ' +
        'WHERE provider_key = ? AND exact_model_id = ?'
      ).get(providerKey, exactModelId);
      if (!existing) {
        throw new Error(`unknown offer: ${providerKey} ${exactModelId}`);
      }
      const value = hidden === true || hidden === 1 ? 1 : 0;
      database.prepare(
        'UPDATE offers SET hidden = ? WHERE provider_key = ? AND exact_model_id = ?'
      ).run(value, providerKey, exactModelId);
      database.exec('COMMIT');
      return { ...existing, hidden: value };
    } catch (err) {
      try { database.exec('ROLLBACK'); } catch { /* ok */ }
      throw err;
    }
  } finally {
    database.close();
  }
}

// Deterministic status transition (Gate 3 removals: NIM deprecated endpoint,
// DISCOUNTED liveness). The lane offer upsert owns normal verification; this
// is the only other write path to offers.status besides it.
function setOfferStatus(providerKey, exactModelId, status, removalEvidence = null, options = {}) {
  if (!['verified', 'stale', 'confirmed_removed'].includes(status)) {
    throw new Error(`setOfferStatus: unknown status ${status}`);
  }
  const database = openCollectorDb(options);
  try {
    const now = nowIso();
    const result = database.prepare(
      'UPDATE offers SET status = ?, removal_evidence_json = ?, last_attempted_at = ? '
      + 'WHERE provider_key = ? AND exact_model_id = ?'
    ).run(
      status,
      removalEvidence === null || removalEvidence === undefined ? null : JSON.stringify(removalEvidence),
      now, providerKey, exactModelId,
    );
    return { updated: result.changes > 0 };
  } finally {
    database.close();
  }
}

function getOffer(providerKey, exactModelId, options = {}) {
  const database = openCollectorDb(options);
  try {
    return parseRow('offers', database.prepare(
      'SELECT * FROM offers WHERE provider_key = ? AND exact_model_id = ?'
    ).get(providerKey, exactModelId)) || null;
  } finally {
    database.close();
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
      const upsertOffer = db.prepare(buildOfferUpsertSql());
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
        upsertOffer.run(...offerUpsertParams(offer, now, runId));
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

      // source_cache records only real fetch evidence: an integer 2xx
      // status plus url, subject_key, content_hash, and fetched_at.
      // Spec 0007: discovery no longer maintains a source pool, so a
      // non-2xx attempt leaves no state behind.
      const evidence = [];
      for (const fetch of changes.sourceCache || []) {
        if (typeof fetch.url !== 'string' || !fetch.url) continue;
        const hasStatus = Number.isInteger(fetch.http_status);
        const is2xx = hasStatus && fetch.http_status >= 200 && fetch.http_status <= 299;
        const isEvidence = is2xx &&
          typeof fetch.subject_key === 'string' && fetch.subject_key.length > 0 &&
          typeof fetch.content_hash === 'string' && fetch.content_hash.length > 0 &&
          typeof fetch.fetched_at === 'string' && fetch.fetched_at.length > 0;
        if (isEvidence) evidence.push(fetch);
      }

      const upsertCache = db.prepare(
        'INSERT INTO source_cache (' +
        '  url, subject_key, provider_key, exact_model_id, fetched_at, http_status, content_hash, source_tier' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(url, subject_key) DO UPDATE SET' +
        '  provider_key = excluded.provider_key,' +
        '  exact_model_id = excluded.exact_model_id,' +
        '  fetched_at = excluded.fetched_at,' +
        '  http_status = excluded.http_status,' +
        '  content_hash = excluded.content_hash,' +
        '  source_tier = excluded.source_tier'
      );
      for (const entry of evidence) {
        validateSourceCacheChange(entry);
        upsertCache.run(
          entry.url,
          entry.subject_key,
          entry.provider_key ?? null,
          entry.exact_model_id ?? null,
          entry.fetched_at,
          entry.http_status,
          entry.content_hash,
          Number.isInteger(entry.source_tier) ? entry.source_tier : sourceTierFromUrl(entry.url),
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

// Spec 0008 db:status additions: watch/leads/contradictions summaries.
// Tables are queried defensively because older schema versions do not have
// them yet (contradictions arrives with migration 0011).
function tableExists(db, name) {
  const row = db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', name);
  return Boolean(row);
}

function getStatus(options = {}) {
  const paths = resolvePaths(options);
  const dbExists = fs.existsSync(paths.dbPath);
  const integrityOk = dbExists ? checkIntegrity(paths.dbPath) : null;
  let schemaVersion = null;
  let currentRun = null;
  let lastPromotedRun = null;
  let watchSummary = null;
  if (dbExists && integrityOk) {
    const db = openDatabaseFile(paths.dbPath, { readOnly: true });
    try {
      schemaVersion = currentSchemaVersion(db);
      currentRun = db.prepare(
        "SELECT * FROM runs WHERE status NOT IN ('promoted', 'superseded', 'failed') " +
        'ORDER BY started_at DESC LIMIT 1'
      ).get() || null;
      lastPromotedRun = db.prepare(
        "SELECT * FROM runs WHERE status = 'promoted' " +
        'ORDER BY COALESCE(finished_at, started_at) DESC LIMIT 1'
      ).get() || null;
      watchSummary = {
        models: tableExists(db, 'models')
          ? db.prepare('SELECT COUNT(*) AS c FROM models').get().c
          : null,
        models_frontier: tableExists(db, 'models')
          ? db.prepare('SELECT COUNT(*) AS c FROM models WHERE frontier = 1').get().c
          : null,
        leads: tableExists(db, 'leads')
          ? db.prepare(
            "SELECT status, COUNT(*) AS c FROM leads GROUP BY status"
          ).all()
          : null,
        leads_open: tableExists(db, 'leads')
          ? db.prepare("SELECT COUNT(*) AS c FROM leads WHERE status = 'open'").get().c
          : null,
        watch_facts_domains: tableExists(db, 'watch_facts')
          ? db.prepare(
            'SELECT domain, COUNT(*) AS c FROM watch_facts GROUP BY domain ORDER BY domain'
          ).all()
          : null,
        contradictions_open: tableExists(db, 'contradictions')
          ? db.prepare('SELECT COUNT(*) AS c FROM contradictions WHERE open = 1').get().c
          : null,
      };
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
    watch: watchSummary,
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
// Spec 0008: models, leads, watch facts (migration 0010)
// ---------------------------------------------------------------------------

// Upserts a model row. The model key is the canonical id; callers pass only
// the fields they want to touch (absent fields stay as-is). Aliases and known
// providers merge with the existing lists. Returns the stored row plus a
// created flag.
function upsertModel(canonicalModelIdValue, fields = {}, options = {}) {
  const database = openCollectorDb(options);
  try {
    const requested = canonicalModelId(canonicalModelIdValue);
    if (!requested) return null;
    // Resolve aliases to an existing canonical row first, so an alias never
    // fragments the model into a second row.
    let id = requested;
    const exact = modelRowOf(database, requested);
    if (!exact) {
      const norm = (v) => String(v || '').replace(/\//g, '').toLowerCase();
      const needle = norm(requested);
      const all = database.prepare('SELECT * FROM models').all().map((row) => parseRow('models', row));
      const hit = all.find((m) =>
        norm(m.canonical_model_id) === needle
        || parseJsonStringList(m.aliases_json).some((a) => norm(a) === needle));
      if (hit) {
        id = hit.canonical_model_id;
        // The incoming id becomes a known alias of the canonical row.
        fields.aliases = [...(Array.isArray(fields.aliases) ? fields.aliases : []), requested];
      }
    }
    const existing = modelRowOf(database, id);
    const now = new Date().toISOString();
    if (!existing) {
      database.prepare(
        'INSERT INTO models (canonical_model_id, display_name, vendor_key, aliases_json, '
        + 'known_providers_json, frontier, release_status, release_date, total_parameters_b, '
        + 'active_parameters_b, open_weight, first_seen_at, last_seen_at, source_url, last_run_id) '
        + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        id,
        fields.display_name || id,
        fields.vendor_key || null,
        JSON.stringify(uniqueList(modelAliasValues(fields.aliases))),
        JSON.stringify(uniqueList(modelAliasValues(fields.known_providers))),
        fields.frontier === undefined ? 0 : (fields.frontier ? 1 : 0),
        nullableString(fields.release_status),
        nullableString(fields.release_date),
        numberOrNull(fields.total_parameters_b),
        numberOrNull(fields.active_parameters_b),
        fields.open_weight === undefined ? null : (fields.open_weight ? 1 : 0),
        fields.first_seen_at || now,
        fields.last_seen_at || now,
        nullableString(fields.source_url),
        fields.last_run_id || null,
      );
      return { ...modelRowOf(database, id), created: true };
    }
    const sets = [];
    const params = [];
    const setCol = (col, value) => { sets.push(`${col} = ?`); params.push(value); };
    if (typeof fields.display_name === 'string' && fields.display_name.trim()) setCol('display_name', fields.display_name.trim());
    if (fields.vendor_key !== undefined) setCol('vendor_key', fields.vendor_key || null);
    if (Array.isArray(fields.aliases)) {
      const merged = uniqueList(modelAliasValues([
        ...parseJsonStringList(existing.aliases_json), ...fields.aliases,
      ]));
      if (JSON.stringify(merged) !== existing.aliases_json) setCol('aliases_json', JSON.stringify(merged));
    }
    if (fields.frontier !== undefined) setCol('frontier', fields.frontier ? 1 : 0);
    if (Array.isArray(fields.known_providers)) {
      const merged = uniqueList(modelAliasValues([
        ...parseJsonStringList(existing.known_providers_json), ...fields.known_providers,
      ]));
      if (JSON.stringify(merged) !== existing.known_providers_json) setCol('known_providers_json', JSON.stringify(merged));
    }
    if (fields.release_status !== undefined) setCol('release_status', nullableString(fields.release_status));
    if (fields.release_date !== undefined) setCol('release_date', nullableString(fields.release_date));
    if (fields.total_parameters_b !== undefined) setCol('total_parameters_b', numberOrNull(fields.total_parameters_b));
    if (fields.active_parameters_b !== undefined) setCol('active_parameters_b', numberOrNull(fields.active_parameters_b));
    if (fields.open_weight !== undefined) setCol('open_weight', fields.open_weight ? 1 : 0);
    if (fields.last_seen_at) setCol('last_seen_at', fields.last_seen_at);
    if (typeof fields.source_url === 'string' && fields.source_url.trim()) setCol('source_url', fields.source_url.trim());
    if (fields.last_run_id) setCol('last_run_id', fields.last_run_id);
    if (sets.length > 0) {
      params.push(id);
      database.prepare(`UPDATE models SET ${sets.join(', ')} WHERE canonical_model_id = ?`).run(...params);
    }
    return { ...modelRowOf(database, id), created: false };
  } finally {
    database.close();
  }
}

function modelAliasValues(values) {
  if (!Array.isArray(values)) return [];
  return values.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim());
}

function parseJsonStringList(value) {
  if (Array.isArray(value)) return value.filter((v) => typeof v === 'string');
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function nullableString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function modelRowOf(database, id) {
  const row = database.prepare('SELECT * FROM models WHERE canonical_model_id = ?').get(id);
  return row ? parseRow('models', row) : null;
}

// Finds models by exact canonical id or by alias. Matching is case-insensitive
// and ignores namespace slashes, so 'Kimi-K3' matches 'moonshotai/kimi-k3'.
function findModelsByIds(ids = [], options = {}) {
  const database = openCollectorDb(options);
  try {
    const rows = [];
    const all = database.prepare('SELECT * FROM models').all().map((row) => parseRow('models', row));
    const norm = (v) => String(v || '').replace(/\//g, '').toLowerCase();
    for (const raw of ids) {
      const id = canonicalModelId(raw);
      if (!id) continue;
      const needle = norm(id);
      const hit = all.find((m) =>
        norm(m.canonical_model_id) === needle
        || parseJsonStringList(m.aliases_json).some((a) => norm(a) === needle));
      if (hit && !rows.some((r) => r.canonical_model_id === hit.canonical_model_id)) rows.push(hit);
    }
    return rows;
  } finally {
    database.close();
  }
}

function listModels(options = {}) {
  const database = openCollectorDb(options);
  try {
    return database.prepare('SELECT * FROM models ORDER BY canonical_model_id').all()
      .map((row) => parseRow('models', row));
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Leads (community / news claims; spec 0008)
// ---------------------------------------------------------------------------

// Adds a lead. The lead identity is sha1(source_url + claim_text), so the same
// claim from the same page never duplicates. A lead that already exists is
// returned as-is (dismissed leads are never re-opened). Returns the row plus
// a created flag.
function addLead(lead, options = {}) {
  const database = openCollectorDb(options);
  try {
    const sourceUrl = nullableString(lead.source_url);
    const claimText = nullableString(lead.claim_text);
    if (!sourceUrl || !claimText || !lead.run_id) throw new Error('addLead requires run_id, source_url, claim_text');
    const leadId = crypto.createHash('sha1').update(`${sourceUrl}\u0000${claimText}`).digest('hex');
    const existing = parseRow('leads', database.prepare('SELECT * FROM leads WHERE lead_id = ?').get(leadId));
    if (existing) return { ...existing, created: false };
    const detectedAt = lead.detected_at || new Date().toISOString();
    database.prepare(
      "INSERT INTO leads (lead_id, run_id, detected_at, source_url, source_tier, claim_text, "
      + "model_name, provider_key, status, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)"
    ).run(
      leadId, lead.run_id, detectedAt, sourceUrl,
      Number.isInteger(lead.source_tier) ? lead.source_tier : 3,
      claimText, nullableString(lead.model_name), nullableString(lead.provider_key),
      nullableString(lead.note),
    );
    return { ...parseRow('leads', database.prepare('SELECT * FROM leads WHERE lead_id = ?').get(leadId)), created: true };
  } finally {
    database.close();
  }
}

// Moves an open lead to verified / dismissed / expired. Returns true when a
// transition happened.
function resolveLead(leadId, resolution = {}, options = {}) {
  const status = resolution.status;
  if (!['verified', 'dismissed', 'expired'].includes(status)) {
    throw new Error(`resolveLead: unknown status ${status}`);
  }
  const database = openCollectorDb(options);
  try {
    const result = database.prepare(
      "UPDATE leads SET status = ?, resolved_at = ?, note = COALESCE(?, note), "
      + 'linked_offer_key = ? WHERE lead_id = ? AND status = \'open\''
    ).run(
      status,
      resolution.resolved_at || new Date().toISOString(),
      nullableString(resolution.note),
      nullableString(resolution.linked_offer_key),
      leadId,
    );
    return result.changes > 0;
  } finally {
    database.close();
  }
}

function listOpenLeads(options = {}) {
  const database = openCollectorDb(options);
  try {
    return database.prepare(
      "SELECT * FROM leads WHERE status = 'open' ORDER BY detected_at ASC, lead_id ASC"
    ).all().map((row) => parseRow('leads', row));
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Watch facts (per-run deterministic triage snapshots; spec 0008)
// ---------------------------------------------------------------------------

// Records one fetched watch channel snapshot for this run. The primary key
// includes run_id, so history is preserved. Returns the previous latest row
// for the same (domain, entity_key) (null on first fetch) so the caller can
// derive change signals deterministically.
function recordWatchFact(fact, options = {}) {
  const database = openCollectorDb(options);
  try {
    if (!fact.domain || !fact.entity_key || !fact.run_id) {
      throw new Error('recordWatchFact requires domain, entity_key, run_id');
    }
    const previous = parseRow('watch_facts', database.prepare(
      'SELECT * FROM watch_facts WHERE domain = ? AND entity_key = ? AND run_id != ? '
      + 'ORDER BY run_id DESC LIMIT 1'
    ).get(fact.domain, fact.entity_key, fact.run_id));
    database.prepare(
      'INSERT OR REPLACE INTO watch_facts (domain, entity_key, url, run_id, fetched_at, http_status, content_hash, facts_json) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      fact.domain, fact.entity_key, nullableString(fact.url), fact.run_id,
      fact.fetched_at || new Date().toISOString(),
      Number.isInteger(fact.http_status) ? fact.http_status : null,
      nullableString(fact.content_hash),
      fact.facts_json === undefined ? null : JSON.stringify(fact.facts_json),
    );
    return { previous: previous || null };
  } finally {
    database.close();
  }
}

// The latest row per (domain, entity_key). Run ids are ISO timestamps, so
// lexicographic order is chronological order.
function latestWatchFacts(options = {}) {
  const database = openCollectorDb(options);
  try {
    return database.prepare(
      'SELECT wf.* FROM watch_facts wf '
      + 'JOIN (SELECT domain, entity_key, MAX(run_id) AS m FROM watch_facts GROUP BY domain, entity_key) t '
      + 'ON wf.domain = t.domain AND wf.entity_key = t.entity_key AND wf.run_id = t.m '
      + 'ORDER BY wf.domain, wf.entity_key'
    ).all().map((row) => parseRow('watch_facts', row));
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Gate 3 operational evidence + condition facts (spec 0008 Phase 2)
// ---------------------------------------------------------------------------

// Deterministic-only write path for Gate 3 evidence columns. These columns
// are never written by the lane offer upsert (the worker never sets them);
// the deterministic observer (OR endpoints, NIM verify) owns them.
const OPERATIONAL_EVIDENCE_COLUMNS = [
  'provider_count', 'uptime_percent', 'activity_evidence',
  'free_endpoint_status', 'api_calls_30d',
];
const OFFER_CONDITION_COLUMNS = [
  'card_required', 'minimum_deposit_usd', 'subscription_required',
  'referral_required', 'data_policy_json', 'data_policy_hash',
  'data_policy_verified_at', 'suspicion_score',
];

function setOfferOperationalEvidence(providerKey, exactModelId, evidence = {}, options = {}) {
  const keys = OPERATIONAL_EVIDENCE_COLUMNS.filter((column) => column in evidence);
  if (!keys.length) return { updated: false };
  const assignments = keys.map((column) => `${column} = ?`).join(', ');
  const database = openCollectorDb(options);
  try {
    const result = database.prepare(
      `UPDATE offers SET ${assignments} WHERE provider_key = ? AND exact_model_id = ?`
    ).run(...keys.map((column) => evidence[column] === undefined ? null : evidence[column]), providerKey, exactModelId);
    return { updated: result.changes > 0 };
  } finally {
    database.close();
  }
}

// Condition facts derived from crawl-facts (worker proposal, deterministically
// stored; booleans arrive as 0/1 or null). suspicion_score is the classifier
// value adopted by the assembler (0..5).
function setOfferConditionFacts(providerKey, exactModelId, facts = {}, options = {}) {
  const keys = OFFER_CONDITION_COLUMNS.filter((column) => column in facts);
  if (!keys.length) return { updated: false };
  const assignments = keys.map((column) => `${column} = ?`).join(', ');
  const database = openCollectorDb(options);
  try {
    const result = database.prepare(
      `UPDATE offers SET ${assignments} WHERE provider_key = ? AND exact_model_id = ?`
    ).run(
      ...keys.map((column) => {
        const value = facts[column];
        if (value === undefined || value === null) return null;
        // JSON columns (data_policy_json) arrive as objects; SQLite binds
        // only primitives, so stringify on the way in. parseRow handles the
        // read side via ROW_JSON_COLUMNS.
        return (typeof value === 'object') ? JSON.stringify(value) : value;
      }),
      providerKey, exactModelId
    );
    return { updated: result.changes > 0 };
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Change engine persistence (spec 0008 §4.6): per-run append of the
// structured before / after diff. The report reads the current run's computed
// changes; the table is the durable audit trail.
// ---------------------------------------------------------------------------

function recordChange(runId, change, options = {}) {
  if (!change.change_key || !change.change_type) {
    throw new Error('recordChange requires change_key and change_type');
  }
  const database = openCollectorDb(options);
  try {
    database.prepare(
      'INSERT INTO changes (run_id, change_key, change_type, field, before_json, after_json, detected_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(
      runId, change.change_key, change.change_type,
      nullableString(change.field),
      change.before === undefined || change.before === null ? null : JSON.stringify(change.before),
      change.after === undefined || change.after === null ? null : JSON.stringify(change.after),
      change.detected_at || new Date().toISOString(),
    );
    return { recorded: true };
  } finally {
    database.close();
  }
}

function listChanges({ runId = null, limit = 500 } = {}, options = {}) {
  const database = openCollectorDb(options);
  try {
    if (runId) {
      return database.prepare(
        'SELECT * FROM changes WHERE run_id = ? ORDER BY change_id ASC LIMIT ?'
      ).all(runId, limit).map((row) => parseRow('changes', row));
    }
    return database.prepare(
      'SELECT * FROM changes ORDER BY detected_at DESC, change_id DESC LIMIT ?'
    ).all(limit).map((row) => parseRow('changes', row));
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Within-run contradictions (spec 0008 §4.5): two or more fetch evidences in
// the same run disagree on one (offer, fact). The lowest source tier wins.
// If a later run reaches the same adopted value the contradiction closes;
// a new disagreement keeps it open.
// ---------------------------------------------------------------------------

function addContradiction(runId, entry, options = {}) {
  if (!entry.change_key || !entry.fact || !Array.isArray(entry.values) || entry.values.length < 2) {
    throw new Error('addContradiction requires change_key, fact, and at least two values');
  }
  const database = openCollectorDb(options);
  try {
    database.prepare(
      'INSERT INTO contradictions (run_id, change_key, fact, values_json, resolved_value, '
      + "resolution_rule, open, detected_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, NULL)"
    ).run(
      runId, entry.change_key, entry.fact, JSON.stringify(entry.values),
      nullableString(entry.resolved_value), nullableString(entry.resolution_rule),
      entry.detected_at || new Date().toISOString(),
    );
    return { added: true };
  } finally {
    database.close();
  }
}

// Reconciles today's contradiction finding with the open history for the same
// (change_key, fact). Same adopted value -> close (open = 0, resolved_at);
// different value -> keep open with today's values appended history.
function reconcileContradiction(runId, entry, options = {}) {
  const database = openCollectorDb(options);
  try {
    const open = parseRow('contradictions', database.prepare(
      'SELECT * FROM contradictions WHERE change_key = ? AND fact = ? AND open = 1 '
      + 'ORDER BY contradiction_id DESC LIMIT 1'
    ).get(entry.change_key, entry.fact)) || null;
    const now = entry.detected_at || new Date().toISOString();
    if (!open) return addContradiction(runId, entry, options);
    if (String(open.resolved_value ?? '') === String(entry.resolved_value ?? '')) {
      database.prepare(
        'UPDATE contradictions SET open = 0, resolved_at = ? WHERE contradiction_id = ?'
      ).run(now, open.contradiction_id);
      return { closed: open.contradiction_id };
    }
    database.prepare(
      'UPDATE contradictions SET open = 1, resolved_at = NULL WHERE contradiction_id = ?'
    ).run(open.contradiction_id);
    return addContradiction(runId, entry, options);
  } finally {
    database.close();
  }
}

function listContradictions({ openOnly = false, limit = 200 } = {}, options = {}) {
  const database = openCollectorDb(options);
  try {
    const where = openOnly ? 'WHERE open = 1 ' : '';
    return database.prepare(
      `SELECT * FROM contradictions ${where}ORDER BY contradiction_id DESC LIMIT ?`
    ).all(limit).map((row) => parseRow('contradictions', row));
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// NIM verification candidates + known normal price baselines (§4.3-4, §4.11)
// ---------------------------------------------------------------------------

// Nvidia offers that are not confirmed removed are the NIM free endpoint
// check list: their historical state is free / ultra-low by definition of
// how nvidia offers enter this table (the catalog lane admits only free or
// ultra-low prices).
function listNimCandidateOffers(options = {}) {
  const database = openCollectorDb(options);
  try {
    return database.prepare(
      "SELECT provider_key, exact_model_id, canonical_model_id, status, "
      + 'effective_input_price_usd, effective_output_price_usd, price_source_url '
      + "FROM offers WHERE provider_key = 'nvidia' AND status != 'confirmed_removed' "
      + 'ORDER BY exact_model_id'
    ).all();
  } finally {
    database.close();
  }
}

function listOffersByProvider(providerKey, options = {}) {
  const database = openCollectorDb(options);
  try {
    return database.prepare('SELECT * FROM offers WHERE provider_key = ?').all(providerKey);
  } finally {
    database.close();
  }
}

// Known normal prices per canonical model from the offers history: the
// discount_signal baseline for catalog price drops (§4.11). Returns a map of
// canonical_model_id -> { input, output } using the most recently verified
// normal prices when present, else the latest stored normals.
function knownNormalPricesByCanonical(options = {}) {
  const database = openCollectorDb(options);
  try {
    const rows = database.prepare(
      'SELECT canonical_model_id, normal_input_price_usd, normal_output_price_usd, '
      + 'price_verified_at, last_seen_run_id FROM offers '
      + 'WHERE canonical_model_id IS NOT NULL '
      + 'AND (normal_input_price_usd IS NOT NULL OR normal_output_price_usd IS NOT NULL) '
      + 'ORDER BY last_seen_run_id ASC, price_verified_at ASC'
    ).all();
    const byCanonical = new Map();
    for (const row of rows) {
      byCanonical.set(row.canonical_model_id, {
        input: row.normal_input_price_usd,
        output: row.normal_output_price_usd,
      });
    }
    return byCanonical;
  } finally {
    database.close();
  }
}

// All leads (CLI + lead lifecycle); listOpenLeads is the pipeline view.
function listLeads({ status = null, limit = 500 } = {}, options = {}) {
  const database = openCollectorDb(options);
  try {
    if (status) {
      return database.prepare(
        'SELECT * FROM leads WHERE status = ? ORDER BY detected_at DESC, lead_id DESC LIMIT ?'
      ).all(status, limit).map((row) => parseRow('leads', row));
    }
    return database.prepare(
      'SELECT * FROM leads ORDER BY detected_at DESC, lead_id DESC LIMIT ?'
    ).all(limit).map((row) => parseRow('leads', row));
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Deterministic source tier (spec 0008 §4.5). 1 is the strongest evidence,
// 11 the weakest. The LLM never writes a tier: this is the single code path
// that assigns tiers from URL patterns (crawl-facts carries no
// source_tier_hint either).
// ---------------------------------------------------------------------------

function sourceTierFromUrl(url) {
  if (!url || typeof url !== 'string') return 11;
  let host = '';
  let pathname = '';
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    pathname = u.pathname.toLowerCase();
  } catch {
    return 11;
  }
  const community = ['reddit.com', 'redd.it', 'news.ycombinator.com', 'hn.algolia.com', 'discord.com', 'x.com', 'twitter.com'];
  if (community.some((h) => host === h || host.endsWith(`.${h}`))) return 9;
  const githubHf = ['github.com', 'huggingface.co'];
  if (githubHf.some((h) => host === h || host.endsWith(`.${h}`))) {
    return /\/(releases|tags)\b/.test(pathname) ? 5 : 7;
  }
  const pricing = /(^|\/)(pricing|price|plans?)(\/|$)/.test(pathname);
  const changelog = /(^|\/)(changelog|release-notes?|whats-new|news)(\/|$)/.test(pathname);
  const blog = host.startsWith('blog.') || /(^|\/)blog(\/|$)/.test(pathname);
  const apiDocs = /(^|\/)(api|docs)(\/|$)/.test(pathname) && !pricing;
  const modelPage = /(^|\/)models?(\/|$)/.test(pathname);
  if (pricing) return 2;
  if (changelog) return 5;
  if (blog) return 6;
  if (apiDocs) return 3;
  if (host === 'openrouter.ai') return 8; // router listing, not the model page
  if (/^integrate\.api\./.test(host)) return 8; // raw API model listing (aggregator)
  if (modelPage) return 4;
  return 11;
}

// Spec 0008 §4.11: frontier is re-derived every run (never LLM-written).
// A model is frontier when a verified Terminal-Bench 2.0/2.1 score is at or
// above 80, or its vendor is in the watchlist frontier_vendors. Returns the
// number of updated rows.
function rederiveFrontier(frontierVendorKeys = [], options = {}) {
  const database = openCollectorDb(options);
  try {
    const rows = database.prepare('SELECT canonical_model_id, vendor_key FROM models').all();
    const frontierVendors = new Set(frontierVendorKeys);
    let updated = 0;
    const stmt = database.prepare('UPDATE models SET frontier = ? WHERE canonical_model_id = ?');
    for (const row of rows) {
      const bench = database.prepare(
        "SELECT score FROM benchmarks WHERE canonical_model_id = ? "
        + "AND benchmark_key IN ('terminal_bench_2_0', 'terminal_bench_2_1') ORDER BY score DESC LIMIT 1"
      ).get(row.canonical_model_id);
      const byScore = bench && typeof bench.score === 'number' && bench.score >= 80;
      const byVendor = row.vendor_key !== null && frontierVendors.has(row.vendor_key);
      const frontier = byScore || byVendor ? 1 : 0;
      if (stmt.run(frontier, row.canonical_model_id).changes > 0) updated += 1;
    }
    return { updated };
  } finally {
    database.close();
  }
}

function uniqueList(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    const k = typeof v === 'string' ? v.trim() : v;
    if (k === null || k === undefined || k === '') continue;
    const key = String(k);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
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

// Source currency / unit / conversion defaults for prices found in report
// offers or worker facts. Returns a normalized price column object with only
// the keys whose values are known (all null values are dropped so an
// undefined normal price never masks a later real price).
function extractOfferPriceColumns(offer) {
  const out = {};
  const priceKeys = [
    ['input', 'normal_input_price_usd'],
    ['output', 'normal_output_price_usd'],
    ['cache_read', 'normal_cache_read_price_usd'],
    ['cache_write', 'normal_cache_write_price_usd'],
  ];
  const effectiveKeys = [
    ['input', 'effective_input_price_usd'],
    ['output', 'effective_output_price_usd'],
    ['cache_read', 'effective_cache_read_price_usd'],
    ['cache_write', 'effective_cache_write_price_usd'],
  ];
  const setPrice = (obj, key, value) => {
    if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
      obj[key] = Number(value);
    }
  };
  const normal = offer && offer.normal_price_per_million && typeof offer.normal_price_per_million === 'object'
    ? offer.normal_price_per_million
    : {};
  const effective = offer && offer.effective_price_per_million && typeof offer.effective_price_per_million === 'object'
    ? offer.effective_price_per_million
    : {};
  for (const [field, column] of priceKeys) setPrice(out, column, normal[field]);
  for (const [field, column] of effectiveKeys) setPrice(out, column, effective[field]);
  for (const [key, column] of [
    ['price_source', 'price_source_url'],
    ['price_verified_at', 'price_verified_at'],
    ['discount_start_at', 'discount_start_at'],
    ['discount_end_at', 'discount_end_at'],
  ]) {
    const value = offer && offer[key];
    if (typeof value === 'string' && value.length > 0) out[column] = value;
  }
  return out;
}

// Sanitizes offer facts_json so typed price values never leak into the JSON
// blob (spec 0004 AC-3). Prose evidence such as pricing_text is preserved.
// Removed keys: every typed *_price_usd column name, legacy
// normal_price_per_million / effective_price_per_million objects, pricing
// hashes, is_free signals, source amount / currency / unit, conversion
// evidence, price source / dates, discount prices, and prompt/completion
// price keys.
const SANITIZED_FACT_KEYS = new Set([
  'pricing', 'prompt_price', 'completion_price', 'pricing_hash', 'is_free', 'free_model_names',
  'normal_price_per_million', 'effective_price_per_million',
  'normal_input_price_usd', 'normal_output_price_usd',
  'normal_cache_read_price_usd', 'normal_cache_write_price_usd',
  'effective_input_price_usd', 'effective_output_price_usd',
  'effective_cache_read_price_usd', 'effective_cache_write_price_usd',
  'source_amount_input', 'source_amount_output',
  'normal_source_amount_input', 'normal_source_amount_output',
  'normal_source_amount_cache_read', 'normal_source_amount_cache_write',
  'effective_source_amount_input', 'effective_source_amount_output',
  'effective_source_amount_cache_read', 'effective_source_amount_cache_write',
  'source_currency', 'source_unit',
  'conversion_rate', 'conversion_source', 'conversion_confirmed_at',
  'price_source_url', 'price_verified_at',
  'discount_start_at', 'discount_end_at',
]);

function sanitizeOfferFacts(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return facts;
  const sanitize = (value) => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (SANITIZED_FACT_KEYS.has(key) || /_price_usd$/.test(key) || key === 'fact_type' || key === 'classification' || key === 'delivery_type' || key === 'tier' || key === 'access_kind' || key === 'free_allowance_rank') continue;
      out[key] = sanitize(child);
    }
    return out;
  };
  return sanitize(facts);
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

    const upsertOffer = db.prepare(buildOfferUpsertSql(
      // Bootstrap refreshes status and prices but deliberately keeps legacy
      // canonical/source_kind/first_seen values untouched on a forced rerun.
      ', ' +
      '  canonical_model_id = excluded.canonical_model_id,' +
      '  source_kind = excluded.source_kind,' +
      '  last_seen_run_id = excluded.last_seen_run_id,' +
      '  pricing_hash = excluded.pricing_hash,' +
      '  removal_evidence_json = excluded.removal_evidence_json'
    ));
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
        const priceFacts = extractOfferPriceColumns(offer);
        upsertOffer.run(...offerUpsertParams({
          provider_key: providerKey,
          exact_model_id: exactModelId,
          canonical_model_id: canonicalModelId(exactModelId),
          source_kind: 'report',
          status: 'verified',
          consecutive_failures: 0,
          first_seen_at: verifiedAt,
          last_attempted_at: verifiedAt,
          last_verified_at: verifiedAt,
          pricing_hash: null,
          removal_evidence_json: null,
          facts_json: offer,
          ...priceFacts,
        }, verifiedAt, null));
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
  OFFER_PRICE_COLUMNS,
  buildOfferUpsertSql,
  offerUpsertParams,
  setOfferHidden,
  setOfferStatus,
  getOffer,
  extractOfferPriceColumns,
  sanitizeOfferFacts,
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
  exactRunDatabaseBackup,
  restoreExactRunDatabase,
  listDatabaseCopies,
  restoreLatestDatabase,
  sha256File,
  // runs and tasks
  startRun,
  addRunTasks,
  recordTaskResult,
  updateTaskResult,
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
  // spec 0008: models, leads, watch facts
  upsertModel,
  findModelsByIds,
  listModels,
  addLead,
  resolveLead,
  listOpenLeads,
  recordWatchFact,
  latestWatchFacts,
  // spec 0008 Phase 2: gate 3 evidence, changes, contradictions
  setOfferOperationalEvidence,
  setOfferConditionFacts,
  recordChange,
  listChanges,
  addContradiction,
  reconcileContradiction,
  listContradictions,
  listNimCandidateOffers,
  listOffersByProvider,
  knownNormalPricesByCanonical,
  listLeads,
  sourceTierFromUrl,
  rederiveFrontier,
  // run directory layout
  sanitizeTaskId,
  artifactPathFor,
  // row parsing
  parseRow,
  // bootstrap
  bootstrapFromReport,
  resolveProviderKey,
  loadProviderRegistry,
};
