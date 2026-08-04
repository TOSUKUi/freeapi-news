'use strict';

// Publication pipeline tests. Spec 0003, child 0004 (AC-13, AC-14, AC-15).
//
// Covers: staged output preservation, promotion rollback, deploy retry,
// startup recovery, candidate hash, manifest phases, superseded runs, and
// run cleanup. Uses node:test and node:assert/strict per project convention.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const db = require('./collector-db');
const publication = require('./publication');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-test-'));
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(stateDir, { recursive: true });

  // Minimal project structure.
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.mkdirSync(path.join(root, '.agents', 'skills', 'llm-deals-intelligence-skill', 'schemas'), { recursive: true });

  // Minimal provider registry.
  fs.writeFileSync(path.join(root, 'build', 'provider-registry.json'), JSON.stringify({
    version: 1,
    providers: [
      { key: 'openrouter', label: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', delivery_type: 'router', match: ['openrouter'] },
    ],
  }, null, 2) + '\n');

  // Minimal daily report schema (enough for the validator to not crash).
  fs.writeFileSync(
    path.join(root, '.agents', 'skills', 'llm-deals-intelligence-skill', 'schemas', 'daily_report.schema.json'),
    JSON.stringify({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', required: ['ranked_offers'] }, null, 2) + '\n'
  );

  // Stub validator (the real one needs ajv and network; tests use a stub).
  fs.writeFileSync(path.join(root, 'build', 'validate-report.js'), `
    'use strict';
    const fs = require('fs');
    const p = process.argv[2];
    if (!fs.existsSync(p)) { console.error('not found'); process.exit(1); }
    const r = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!Array.isArray(r.ranked_offers)) { console.error('bad'); process.exit(1); }
    console.log('ok');
  `);

  // Stub HTML builder.
  fs.writeFileSync(path.join(root, 'build', 'build-html.js'), `
    'use strict';
    const fs = require('fs');
    const inp = process.argv[2]; const out = process.argv[3];
    if (!fs.existsSync(inp)) process.exit(1);
    fs.writeFileSync(out, '<html>test</html>');
    module.exports = { generateHTML: () => '', selectRankedOffers: () => [], computeSnapshot: () => ({}), dayKeyInTz: () => '', TOKEN_CSS: '' };
  `);

  // Stub OG builder (always succeeds, writes a tiny PNG).
  fs.writeFileSync(path.join(root, 'build', 'build-og-image.js'), `
    'use strict';
    const fs = require('fs');
    const inp = process.argv[2]; const outHtml = process.argv[3]; const outPng = process.argv[4];
    if (!fs.existsSync(inp)) process.exit(1);
    fs.writeFileSync(outHtml, '<html>og</html>');
    fs.writeFileSync(outPng, Buffer.from('fake-png'));
    module.exports = { buildOgHTML: () => '' };
  `);

  const options = { projectRoot: root, stateDir };
  return { root, stateDir, options };
}

function seedDb(ctx) {
  db.applyMigrations(ctx.options);
  const database = db.openDatabaseFile(
    path.join(ctx.stateDir, 'collector.sqlite')
  );
  try {
    database.exec('BEGIN IMMEDIATE');
    database.prepare(
      "INSERT INTO runs (run_id, status, started_at) VALUES (?, 'candidate_ready', ?)"
    ).run('test-run-1', new Date().toISOString());
    database.exec('COMMIT');
  } finally {
    database.close();
  }
}

function seedCandidate(ctx, runDir) {
  const candidateDir = path.join(runDir, 'candidate');
  fs.mkdirSync(candidateDir, { recursive: true });
  fs.writeFileSync(path.join(candidateDir, 'report.json'), JSON.stringify({
    generated_at: new Date().toISOString(),
    timezone: 'Asia/Tokyo',
    summary: 'test',
    new_models: [],
    changes: [],
    ranked_offers: [{ name: 'Test Model', model_id: 'test/model', provider: 'OpenRouter', base_url: 'https://openrouter.ai/api/v1', ranking_eligible: true }],
    conditional_credits: [],
    caution_offers: [],
    excluded_offers: [],
    sources: [],
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(candidateDir, 'provider-registry.json'), JSON.stringify({
    version: 'candidate',
    providers: [{
      key: 'openrouter',
      label: 'OpenRouter',
      base_url: 'https://openrouter.ai/api/v1',
      base_url_pattern: '^https://openrouter\\.ai/api/v1/?$',
      delivery_type: 'router',
      docs_url: 'https://openrouter.ai/docs/quickstart',
      match: ['openrouter'],
    }],
  }, null, 2) + '\n');
  return candidateDir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('publication', () => {
  let ctx;

  beforeEach(() => {
    ctx = tmpProject();
  });

  afterEach(() => {
    fs.rmSync(ctx.root, { recursive: true, force: true });
  });

  describe('computeCandidateHash', () => {
    it('produces a deterministic hash excluding prose', () => {
      const report = {
        ranked_offers: [{ name: 'A', model_id: 'a/b', provider: 'P', base_url: 'https://x', ranking_eligible: true, benchmark: { tier: 'S', score: 70 }, free_allowance_rank: 'AMPLE', last_verified: '2025-01-01' }],
        caution_offers: [],
        excluded_offers: [],
        summary: 'this prose changes but hash should not',
      };
      const h1 = publication.computeCandidateHash('r1', report);
      report.summary = 'different prose';
      const h2 = publication.computeCandidateHash('r1', report);
      assert.equal(h1, h2, 'hash must not depend on prose');
      assert.match(h1, /^[0-9a-f]{64}$/);
    });

    it('changes when identity facts change', () => {
      const report = {
        ranked_offers: [{ name: 'A', model_id: 'a/b', provider: 'P', base_url: 'https://x', ranking_eligible: true }],
        caution_offers: [],
        excluded_offers: [],
      };
      const h1 = publication.computeCandidateHash('r1', report);
      report.ranked_offers[0].model_id = 'a/c';
      const h2 = publication.computeCandidateHash('r1', report);
      assert.notEqual(h1, h2);
    });
  });

  describe('validateCandidate', () => {
    it('validates, builds HTML and OG, writes manifest, sets run validated', () => {
      seedDb(ctx);
      const runDir = path.join(ctx.stateDir, 'crawl', 'test-run-1');
      seedCandidate(ctx, runDir);

      const result = publication.validateCandidate('test-run-1', runDir, {
        ...ctx.options,
        skipCitationCheck: true,
      });

      assert.equal(result.runId, 'test-run-1');
      assert.match(result.candidateHash, /^[0-9a-f]{64}$/);
      assert.equal(result.ogProvenance, 'generated');

      // Candidate HTML and OG exist.
      assert.ok(fs.existsSync(path.join(runDir, 'candidate', 'index.html')));
      assert.ok(fs.existsSync(path.join(runDir, 'candidate', 'og-image.png')));

      // Manifest exists with phase prepared.
      const manifest = publication.readManifest(runDir);
      assert.equal(manifest.phase, 'prepared');
      assert.equal(manifest.run_id, 'test-run-1');
      assert.ok(manifest.files['report.json'].sha256);
      assert.ok(manifest.files['index.html'].sha256);

      // Run status is validated.
      const { run } = db.loadRunCandidate('test-run-1', ctx.options);
      assert.equal(run.status, 'validated');
      assert.equal(run.candidate_hash, result.candidateHash);
    });

    it('fails the run when validation fails', () => {
      seedDb(ctx);
      const runDir = path.join(ctx.stateDir, 'crawl', 'test-run-1');
      const candidateDir = path.join(runDir, 'candidate');
      fs.mkdirSync(candidateDir, { recursive: true });
      // Write an invalid report (no ranked_offers array).
      fs.writeFileSync(path.join(candidateDir, 'report.json'), '{"bad": true}');

      assert.throws(
        () => publication.validateCandidate('test-run-1', runDir, {
          ...ctx.options,
          skipCitationCheck: true,
        }),
        /candidate validation failed/
      );

      const { run } = db.loadRunCandidate('test-run-1', ctx.options);
      assert.equal(run.status, 'failed');
    });

    it('marks validate-only prepared manifests without deleting canonical files', () => {
      seedDb(ctx);
      const runDir = path.join(ctx.stateDir, 'crawl', 'test-run-1');
      seedCandidate(ctx, runDir);
      const liveReport = '{"live": true}\n';
      fs.writeFileSync(path.join(ctx.root, 'report.json'), liveReport);
      db.copyDatabaseForRun('test-run-1', ctx.options);

      publication.validateCandidate('test-run-1', runDir, {
        ...ctx.options,
        skipCitationCheck: true,
      });
      const before = publication.readManifest(runDir);
      assert.equal(before.phase, 'prepared');
      assert.equal(before.promotion_started, false);
      assert.deepEqual(before.backups, {});

      const results = publication.recoverInterruptedPromotion(ctx.options);
      assert.ok(results);
      assert.equal(results[0].action, 'restored_exact_database');
      assert.equal(
        fs.readFileSync(path.join(ctx.root, 'report.json'), 'utf8'),
        liveReport,
        'validate-only recovery must preserve the existing publication'
      );
      assert.equal(publication.readManifest(runDir).phase, 'restored');
    });

    it('carries forward OG image when Chrome is unavailable', () => {
      seedDb(ctx);
      const runDir = path.join(ctx.stateDir, 'crawl', 'test-run-1');
      seedCandidate(ctx, runDir);

      // Replace OG builder stub with one that does not produce a PNG.
      fs.writeFileSync(path.join(ctx.root, 'build', 'build-og-image.js'), `
        'use strict';
        const fs = require('fs');
        fs.writeFileSync(process.argv[3], '<html>og</html>');
        // No PNG written (simulates missing Chrome).
        module.exports = { buildOgHTML: () => '' };
      `);

      // Place a current OG image to carry forward.
      fs.writeFileSync(path.join(ctx.root, 'og-image.png'), Buffer.from('existing-png'));

      const result = publication.validateCandidate('test-run-1', runDir, {
        ...ctx.options,
        skipCitationCheck: true,
      });

      assert.equal(result.ogProvenance, 'carried_forward');
      const png = fs.readFileSync(path.join(runDir, 'candidate', 'og-image.png'));
      assert.equal(png.toString(), 'existing-png');
    });
  });

  describe('promoteGeneration', () => {
    it('copies candidate files to canonical paths and finalizes', () => {
      seedDb(ctx);
      const runDir = path.join(ctx.stateDir, 'crawl', 'test-run-1');
      seedCandidate(ctx, runDir);

      // Validate first.
      publication.validateCandidate('test-run-1', runDir, {
        ...ctx.options,
        skipCitationCheck: true,
      });

      // Promote.
      const result = publication.promoteGeneration('test-run-1', runDir, ctx.options);
      assert.equal(result.phase, 'db_finalized');

      // Canonical files exist.
      assert.ok(fs.existsSync(path.join(ctx.root, 'report.json')));
      assert.ok(fs.existsSync(path.join(ctx.root, 'index.html')));
      assert.ok(fs.existsSync(path.join(ctx.root, 'og-image.png')));
      assert.ok(fs.existsSync(path.join(ctx.root, 'build', 'provider-registry.json')));

      // Manifest is at db_finalized.
      const manifest = publication.readManifest(runDir);
      assert.equal(manifest.phase, 'db_finalized');

      // Backups exist.
      const backupDir = path.join(runDir, 'backup', 'canonical');
      assert.ok(fs.existsSync(backupDir));
    });

    it('restores canonical files when copy fails', () => {
      seedDb(ctx);
      const runDir = path.join(ctx.stateDir, 'crawl', 'test-run-1');
      seedCandidate(ctx, runDir);

      // Place existing canonical files.
      fs.writeFileSync(path.join(ctx.root, 'report.json'), '{"old": true}');
      fs.writeFileSync(path.join(ctx.root, 'index.html'), '<html>old</html>');

      publication.validateCandidate('test-run-1', runDir, {
        ...ctx.options,
        skipCitationCheck: true,
      });

      // Corrupt a candidate file hash in the manifest to force a mismatch.
      const manifest = publication.readManifest(runDir);
      manifest.files['report.json'].sha256 = 'deadbeef'.repeat(8);
      publication.writeManifest(runDir, manifest);

      assert.throws(
        () => publication.promoteGeneration('test-run-1', runDir, ctx.options),
        /hash mismatch/
      );

      // Old canonical files are restored.
      const restored = JSON.parse(fs.readFileSync(path.join(ctx.root, 'report.json'), 'utf8'));
      assert.deepEqual(restored, { old: true });

      // Run is failed.
      const { run } = db.loadRunCandidate('test-run-1', ctx.options);
      assert.equal(run.status, 'failed');
    });

    it('removes newly copied canonical files on a first-run rollback', () => {
      seedDb(ctx);
      const runDir = path.join(ctx.stateDir, 'crawl', 'test-run-1');
      seedCandidate(ctx, runDir);

      // Simulate a first publication: none of the canonical files existed.
      fs.rmSync(path.join(ctx.root, 'build', 'provider-registry.json'), { force: true });
      publication.validateCandidate('test-run-1', runDir, {
        ...ctx.options,
        skipCitationCheck: true,
      });

      // The first file copies successfully, then the next one fails its
      // manifest hash. Rollback must remove the newly created first file.
      const manifest = publication.readManifest(runDir);
      manifest.files['index.html'].sha256 = 'deadbeef'.repeat(8);
      publication.writeManifest(runDir, manifest);

      assert.throws(
        () => publication.promoteGeneration('test-run-1', runDir, ctx.options),
        /hash mismatch/
      );

      for (const rel of publication.CANONICAL_FILES) {
        assert.equal(
          fs.existsSync(path.join(ctx.root, rel)),
          false,
          `first-run rollback must remove ${rel}`
        );
      }
      const { run } = db.loadRunCandidate('test-run-1', ctx.options);
      assert.equal(run.status, 'failed');
    });
  });

  describe('recoverInterruptedPromotion', () => {
    it('restores backups for a run interrupted before db_finalized', () => {
      seedDb(ctx);
      const runDir = path.join(ctx.stateDir, 'crawl', 'test-run-1');
      seedCandidate(ctx, runDir);

      // Simulate an interrupted promotion: manifest at files_promoted but
      // canonical files were partially replaced.
      fs.mkdirSync(path.join(runDir, 'backup', 'canonical'), { recursive: true });
      fs.writeFileSync(
        path.join(runDir, 'backup', 'canonical', 'report.json'),
        '{"original": true}'
      );
      fs.writeFileSync(path.join(ctx.root, 'report.json'), '{"partial": true}');

      publication.writeManifest(runDir, {
        run_id: 'test-run-1',
        phase: 'files_promoted',
        phase_at: { prepared: new Date().toISOString(), files_promoted: new Date().toISOString() },
        files: {},
        backups: {
          'report.json': {
            path: path.join(runDir, 'backup', 'canonical', 'report.json'),
            sha256: db.sha256File(path.join(runDir, 'backup', 'canonical', 'report.json')),
          },
        },
      });

      const results = publication.recoverInterruptedPromotion(ctx.options);
      assert.ok(results);
      assert.equal(results[0].runId, 'test-run-1');
      assert.equal(results[0].action, 'restored');

      // Canonical file is restored.
      const restored = JSON.parse(fs.readFileSync(path.join(ctx.root, 'report.json'), 'utf8'));
      assert.deepEqual(restored, { original: true });

      // Manifest is at restored.
      const manifest = publication.readManifest(runDir);
      assert.equal(manifest.phase, 'restored');
    });

    it('reports resumable for a run interrupted after db_finalized', () => {
      seedDb(ctx);
      const runDir = path.join(ctx.stateDir, 'crawl', 'test-run-1');
      seedCandidate(ctx, runDir);

      // Place matching canonical files.
      const reportContent = fs.readFileSync(path.join(runDir, 'candidate', 'report.json'));
      fs.writeFileSync(path.join(ctx.root, 'report.json'), reportContent);

      publication.writeManifest(runDir, {
        run_id: 'test-run-1',
        phase: 'db_finalized',
        phase_at: {},
        files: {
          'report.json': { sha256: db.sha256File(path.join(ctx.root, 'report.json')) },
        },
        backups: {},
      });

      const results = publication.recoverInterruptedPromotion(ctx.options);
      assert.ok(results);
      assert.equal(results[0].action, 'resumable');
    });

    it('throws and preserves files and manifest on hash mismatch after db_finalized', () => {
      seedDb(ctx);
      const runDir = path.join(ctx.stateDir, 'crawl', 'test-run-1');
      fs.mkdirSync(runDir, { recursive: true });

      fs.writeFileSync(path.join(ctx.root, 'report.json'), '{"tampered": true}');

      publication.writeManifest(runDir, {
        run_id: 'test-run-1',
        phase: 'db_finalized',
        phase_at: {},
        files: {
          'report.json': { sha256: 'aaaa'.repeat(16) },
        },
        backups: {},
      });

      const beforeManifest = fs.readFileSync(publication.manifestPath(runDir), 'utf8');
      const beforeReport = fs.readFileSync(path.join(ctx.root, 'report.json'), 'utf8');
      assert.throws(
        () => publication.recoverInterruptedPromotion(ctx.options),
        /requires manual inspection/
      );
      assert.equal(fs.readFileSync(publication.manifestPath(runDir), 'utf8'), beforeManifest);
      assert.equal(fs.readFileSync(path.join(ctx.root, 'report.json'), 'utf8'), beforeReport);
    });

    it('checks only the newest active finalized generation across historical manifests', () => {
      db.applyMigrations(ctx.options);
      const database = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'));
      try {
        database.exec('BEGIN IMMEDIATE');
        database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('old-validated', 'validated', '2026-08-01T00:00:00Z')").run();
        database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('old-superseded', 'superseded', '2026-08-01T01:00:00Z')").run();
        database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('new-validated', 'validated', '2026-08-01T02:00:00Z')").run();
        database.exec('COMMIT');
      } finally { database.close(); }
      const report = path.join(ctx.root, 'report.json');
      fs.writeFileSync(report, '{"current":true}');
      const currentHash = db.sha256File(report);
      for (const [runId, hash] of [['old-validated', 'bad'], ['old-superseded', 'bad'], ['new-validated', currentHash]]) {
        const runDir = path.join(ctx.stateDir, 'crawl', runId);
        fs.mkdirSync(runDir, { recursive: true });
        publication.writeManifest(runDir, {
          run_id: runId, phase: 'db_finalized', phase_at: {}, backups: {},
          files: { 'report.json': { sha256: hash } },
        });
      }
      assert.doesNotThrow(() => publication.assertNoManualInspectionRequired(ctx.options));
      fs.writeFileSync(report, '{"tampered":true}');
      assert.throws(() => publication.assertNoManualInspectionRequired(ctx.options), /new-validated requires manual inspection/);
    });

    it('does not restore an exact DB backup after db_finalized', () => {
      db.applyMigrations(ctx.options);
      db.copyDatabaseForRun('safe-db-finalized', ctx.options);
      db.startRun('safe-db-finalized', [], ctx.options);
      db.finalizeRun('safe-db-finalized', {
        offers: [{
          provider_key: 'openrouter',
          exact_model_id: 'acme/a:free',
          canonical_model_id: 'acme/a',
          source_kind: 'catalog',
          status: 'verified',
          first_seen_at: '2026-07-30T00:00:00.000Z',
          facts_json: { mutated: true },
        }],
        runStatus: 'validated',
      }, ctx.options);
      const runDir = path.join(ctx.stateDir, 'crawl', 'safe-db-finalized');
      publication.writeManifest(runDir, {
        run_id: 'safe-db-finalized',
        phase: 'db_finalized',
        phase_at: {},
        files: {},
        backups: {},
      });

      const results = publication.recoverInterruptedPromotion(ctx.options);
      assert.ok(results);
      assert.equal(results[0].action, 'resumable');
      const database = db.openCollectorDb(ctx.options);
      try {
        assert.ok(database.prepare(
          "SELECT 1 FROM offers WHERE exact_model_id = 'acme/a:free'"
        ).get(), 'finalized generation state must remain live');
      } finally {
        database.close();
      }
    });
  });

  describe('supersedeOlderRuns', () => {
    it('marks older validated_not_deployed runs as superseded', () => {
      db.applyMigrations(ctx.options);
      const database = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'));
      try {
        database.exec('BEGIN IMMEDIATE');
        database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('old-run', 'validated_not_deployed', '2025-01-01')").run();
        database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('old-validated', 'validated', '2025-01-01T12:00:00Z')").run();
        database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('new-run', 'promoted', '2025-01-02')").run();
        database.exec('COMMIT');
      } finally {
        database.close();
      }

      publication.supersedeOlderRuns('new-run', ctx.options);

      const check = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'), { readOnly: true });
      try {
        const old = check.prepare("SELECT status FROM runs WHERE run_id = 'old-run'").get();
        assert.equal(old.status, 'superseded');
        const oldValidated = check.prepare("SELECT status FROM runs WHERE run_id = 'old-validated'").get();
        assert.equal(oldValidated.status, 'superseded');
        const newer = check.prepare("SELECT status FROM runs WHERE run_id = 'new-run'").get();
        assert.equal(newer.status, 'promoted');
      } finally {
        check.close();
      }
    });
  });

  it('supersedes old validated generation before next preflight while checking newest active generation', () => {
    db.applyMigrations(ctx.options);
    const report = path.join(ctx.root, 'report.json');
    fs.writeFileSync(report, '{"current":true}');
    const currentHash = db.sha256File(report);
    const database = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'));
    try {
      database.exec('BEGIN IMMEDIATE');
      database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('old-validated', 'validated', '2026-08-01T00:00:00Z')").run();
      database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('new-promoted', 'promoted', '2026-08-01T01:00:00Z')").run();
      database.exec('COMMIT');
    } finally { database.close(); }
    for (const [runId, hash] of [['old-validated', 'bad'], ['new-promoted', currentHash]]) {
      const runDir = path.join(ctx.stateDir, 'crawl', runId);
      fs.mkdirSync(runDir, { recursive: true });
      publication.writeManifest(runDir, {
        run_id: runId, phase: 'db_finalized', phase_at: {}, backups: {},
        files: { 'report.json': { sha256: hash } },
      });
    }

    publication.supersedeOlderRuns('new-promoted', ctx.options);
    assert.doesNotThrow(() => publication.assertNoManualInspectionRequired(ctx.options));

    const nextDir = path.join(ctx.stateDir, 'crawl', 'next-validated');
    fs.mkdirSync(nextDir, { recursive: true });
    const check = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'));
    try {
      check.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('next-validated', 'validated', '2026-08-01T02:00:00Z')").run();
    } finally { check.close(); }
    publication.writeManifest(nextDir, {
      run_id: 'next-validated', phase: 'db_finalized', phase_at: {}, backups: {},
      files: { 'report.json': { sha256: currentHash } },
    });
    fs.writeFileSync(report, '{"tampered":true}');
    assert.throws(() => publication.assertNoManualInspectionRequired(ctx.options), /next-validated requires manual inspection/);
  });

  describe('deployGeneration', () => {
    function gitIn(root, args) {
      return execFileSync(
        'git',
        ['-c', 'commit.gpgsign=false', ...args],
        { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
    }

    function sha256File(file) {
      return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }

    function initGitRepo(root) {
      gitIn(root, ['init', '-q']);
      gitIn(root, ['config', 'user.email', 'test@example.com']);
      gitIn(root, ['config', 'user.name', 'test']);
    }

    function writeCanonicalFiles(root) {
      fs.writeFileSync(path.join(root, 'report.json'), '{"ranked_offers": []}\n');
      fs.writeFileSync(path.join(root, 'index.html'), '<html>canonical</html>\n');
      fs.writeFileSync(path.join(root, 'og-image.png'), 'png-bytes');
    }

    function writeFinalizedManifest(root, stateDir, runId) {
      const runDir = path.join(stateDir, 'crawl', runId);
      fs.mkdirSync(runDir, { recursive: true });
      const files = {};
      for (const [name, rel] of [
        ['report.json', 'report.json'],
        ['index.html', 'index.html'],
        ['og-image.png', 'og-image.png'],
        ['provider-registry.json', path.join('build', 'provider-registry.json')],
      ]) {
        const p = path.join(root, rel);
        files[name] = { sha256: sha256File(p), size: fs.statSync(p).size, provenance: 'generated' };
      }
      fs.writeFileSync(path.join(runDir, 'promotion-manifest.json'), JSON.stringify({
        run_id: runId,
        schema_version: '0004',
        created_at: new Date().toISOString(),
        phase: 'db_finalized',
        phase_at: { prepared: new Date().toISOString(), db_finalized: new Date().toISOString() },
        candidate_hash: 'test-candidate-hash',
        files,
        backups: {},
        promotion_started: true,
      }, null, 2) + '\n');
      return runDir;
    }

    it('resumes with a noop commit when the allowlist is already committed', () => {
      db.applyMigrations(ctx.options);
      const database = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'));
      try {
        database.prepare(
          "INSERT INTO runs (run_id, status, started_at) VALUES ('deploy-noop', 'validated', ?)"
        ).run(new Date().toISOString());
      } finally {
        database.close();
      }
      writeCanonicalFiles(ctx.root);
      initGitRepo(ctx.root);
      gitIn(ctx.root, ['add', '-A']);
      gitIn(ctx.root, ['commit', '-qm', 'initial']);
      const runDir = writeFinalizedManifest(ctx.root, ctx.stateDir, 'deploy-noop');

      // No remote exists, so the push fails gracefully after the noop commit.
      const result = publication.deployGeneration('deploy-noop', runDir, ctx.options);
      assert.equal(result.deployed, false);
      assert.equal(result.status, 'validated_not_deployed');

      const manifest = JSON.parse(
        fs.readFileSync(path.join(runDir, 'promotion-manifest.json'), 'utf8')
      );
      assert.equal(manifest.phase, 'committed');
      assert.equal(manifest.commit, 'noop');
    });

    it('commits uncommitted allowlist changes before pushing', () => {
      db.applyMigrations(ctx.options);
      const database = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'));
      try {
        database.prepare(
          "INSERT INTO runs (run_id, status, started_at) VALUES ('deploy-dirty', 'validated', ?)"
        ).run(new Date().toISOString());
      } finally {
        database.close();
      }
      initGitRepo(ctx.root);
      gitIn(ctx.root, ['add', '-A']);
      gitIn(ctx.root, ['commit', '-qm', 'initial']);
      // Mutate canonical files after the initial commit (post-finalization).
      writeCanonicalFiles(ctx.root);
      const runDir = writeFinalizedManifest(ctx.root, ctx.stateDir, 'deploy-dirty');

      const result = publication.deployGeneration('deploy-dirty', runDir, ctx.options);
      assert.equal(result.deployed, false);
      assert.equal(result.status, 'validated_not_deployed');

      const manifest = JSON.parse(
        fs.readFileSync(path.join(runDir, 'promotion-manifest.json'), 'utf8')
      );
      assert.equal(manifest.phase, 'committed');
      assert.notEqual(manifest.commit, 'noop');
      const committed = gitIn(ctx.root, ['log', '--format=%H', '-1']).trim();
      assert.equal(manifest.commit, committed);
    });
  });

  describe('findDeployRetryTarget', () => {
    it('returns the newest validated_not_deployed run', () => {
      db.applyMigrations(ctx.options);
      const database = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'));
      try {
        database.exec('BEGIN IMMEDIATE');
        database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('r1', 'validated_not_deployed', '2025-01-01')").run();
        database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('r2', 'validated_not_deployed', '2025-01-02')").run();
        database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('r3', 'superseded', '2025-01-03')").run();
        database.exec('COMMIT');
      } finally {
        database.close();
      }

      const target = publication.findDeployRetryTarget(ctx.options);
      assert.equal(target.run_id, 'r2');
    });

    it('returns null when no retry target exists', () => {
      db.applyMigrations(ctx.options);
      const target = publication.findDeployRetryTarget(ctx.options);
      assert.equal(target, null);
    });
  });

  describe('cleanupOldRuns', () => {
    function insertRuns(rows) {
      db.applyMigrations(ctx.options);
      const database = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'));
      try {
        database.exec('BEGIN IMMEDIATE');
        for (const row of rows) {
          database.prepare(
            'INSERT INTO runs (run_id, status, started_at, finished_at) VALUES (?, ?, ?, ?)'
          ).run(row.run_id, row.status, row.started_at || '2025-01-01', row.finished_at || '2025-01-01');
        }
        database.exec('COMMIT');
      } finally {
        database.close();
      }
    }

    function oldDir(runId, phase = null) {
      const runDir = path.join(ctx.stateDir, 'crawl', runId);
      fs.mkdirSync(runDir, { recursive: true });
      if (phase) publication.writeManifest(runDir, { run_id: runId, phase, files: {} });
      const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(runDir, old, old);
      return runDir;
    }

    it('preserves unsafe statuses, unknown directories, and retry targets', () => {
      insertRuns([
        { run_id: 'collecting-run', status: 'collecting' },
        { run_id: 'candidate-run', status: 'candidate_ready' },
        { run_id: 'validated-run', status: 'validated' },
        { run_id: 'retry-run', status: 'validated_not_deployed' },
      ]);
      for (const runId of ['collecting-run', 'candidate-run', 'validated-run', 'retry-run']) {
        oldDir(runId, runId === 'retry-run' ? 'db_finalized' : null);
      }
      const unknownDir = oldDir('unknown-run');
      const cleaned = publication.cleanupOldRuns(ctx.options);
      assert.equal(cleaned, 0);
      for (const runId of ['collecting-run', 'candidate-run', 'validated-run', 'retry-run', 'unknown-run']) {
        assert.ok(fs.existsSync(path.join(ctx.stateDir, 'crawl', runId)));
      }
      assert.equal(publication.findDeployTarget(ctx.options).run_id, 'retry-run');
      assert.ok(fs.existsSync(unknownDir));
    });

    it('removes old safe terminal directories without deleting DB records', () => {
      insertRuns([
        { run_id: 'failed-run', status: 'failed' },
        { run_id: 'superseded-run', status: 'superseded' },
        { run_id: 'deployed-old', status: 'promoted', started_at: '2025-01-01', finished_at: '2025-01-01' },
        { run_id: 'deployed-new', status: 'promoted', started_at: '2025-01-02', finished_at: '2025-01-02' },
      ]);
      oldDir('failed-run');
      oldDir('superseded-run');
      oldDir('deployed-old', 'pushed');
      oldDir('deployed-new', 'pushed');
      const databaseBefore = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'));
      try {
        databaseBefore.prepare(
          "INSERT INTO tasks (run_id, task_id, kind, status) VALUES ('failed-run', 'task', 'known_refresh', 'pending')"
        ).run();
        databaseBefore.prepare(
          "INSERT INTO source_cache (url, subject_key, fetched_at, http_status, content_hash) VALUES ('https://example.test/source', 'shared', '2025-01-01', 200, 'hash')"
        ).run();
      } finally {
        databaseBefore.close();
      }

      const cleaned = publication.cleanupOldRuns(ctx.options);
      assert.equal(cleaned, 3);
      for (const runId of ['failed-run', 'superseded-run', 'deployed-old']) {
        assert.ok(!fs.existsSync(path.join(ctx.stateDir, 'crawl', runId)));
      }
      assert.ok(fs.existsSync(path.join(ctx.stateDir, 'crawl', 'deployed-new')));

      const database = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'), { readOnly: true });
      try {
        const rows = database.prepare('SELECT run_id, status FROM runs ORDER BY run_id').all();
        assert.equal(rows.length, 4, 'cleanup must not delete run rows');
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1,
          'cleanup must not delete task rows');
        assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_cache').get().count, 1,
          'cleanup must not delete source_cache rows');
        assert.deepEqual(rows.map((row) => row.run_id), [
          'deployed-new', 'deployed-old', 'failed-run', 'superseded-run',
        ]);
      } finally {
        database.close();
      }
    });

    it('preserves the newest promoted run directory', () => {
      insertRuns([
        { run_id: 'keep-run', status: 'promoted', started_at: '2025-01-01', finished_at: '2025-01-01' },
      ]);
      const keepDir = oldDir('keep-run', 'pushed');
      const cleaned = publication.cleanupOldRuns(ctx.options);
      assert.equal(cleaned, 0);
      assert.ok(fs.existsSync(keepDir));
    });
  });

  describe('manifest phases', () => {
    it('advances through phases in order', () => {
      const runDir = path.join(ctx.stateDir, 'crawl', 'phase-test');
      fs.mkdirSync(runDir, { recursive: true });

      publication.writeManifest(runDir, {
        run_id: 'phase-test',
        phase: 'prepared',
        phase_at: { prepared: new Date().toISOString() },
        files: {},
      });

      publication.advanceManifest(runDir, 'files_promoted');
      let m = publication.readManifest(runDir);
      assert.equal(m.phase, 'files_promoted');
      assert.ok(m.phase_at.files_promoted);

      publication.advanceManifest(runDir, 'db_finalized');
      m = publication.readManifest(runDir);
      assert.equal(m.phase, 'db_finalized');

      publication.advanceManifest(runDir, 'committed', { commit: 'abc123' });
      m = publication.readManifest(runDir);
      assert.equal(m.phase, 'committed');
      assert.equal(m.commit, 'abc123');

      publication.advanceManifest(runDir, 'pushed');
      m = publication.readManifest(runDir);
      assert.equal(m.phase, 'pushed');
    });
  });
});

describe('validateCandidateRegistry', () => {
  it('accepts a structurally valid registry and rejects malformed entries', () => {
    const valid = { providers: [{
      key: 'neonstack', label: 'NeonStack', base_url: 'https://api.neonstack.example/v1',
      base_url_pattern: '^https://api\\.neonstack\\.example/v1/?$', docs_url: 'https://docs.neonstack.example',
    }] };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-test-'));
    const p = path.join(dir, 'registry.json');
    fs.writeFileSync(p, JSON.stringify(valid));
    assert.deepEqual(publication.validateCandidateRegistry(p), []);

    fs.writeFileSync(p, JSON.stringify({ providers: [
      valid.providers[0],
      { key: 'dupe', label: 'Dup', base_url: 'https://x.example/v1', base_url_pattern: '^https://x\\.example/v1/?$' },
      { key: 'dupe', label: 'Dup2', base_url: 'https://y.example/v1', base_url_pattern: '^https://y\\.example/v1/?$' },
      { key: 'badpattern', label: 'Bad', base_url: 'https://z.example/v1', base_url_pattern: '[' },
      { key: 'nobase', label: 'NoBase', base_url: 'ftp://x.example', base_url_pattern: null },
      { key: 'page', label: 'Page', base_url: 'https://p.example/v1', base_url_pattern: '^https://p\\.example/v1/?$', model_page_template: 'https://p.example/models' },
    ] }));
    const problems = publication.validateCandidateRegistry(p);
    assert.ok(problems.some((x) => /duplicate provider key dupe/.test(x)));
    assert.ok(problems.some((x) => /base_url_pattern is not a valid regex/.test(x)));
    assert.ok(problems.some((x) => /base_url must be http/.test(x)));
    assert.ok(problems.some((x) => /model_page_template must contain/.test(x)));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
