'use strict';

// Publication pipeline tests. Spec 0003, child 0004 (AC-13, AC-14, AC-15).
//
// Covers: staged output preservation, promotion rollback, deploy retry,
// startup recovery, candidate hash, manifest phases, superseded runs, and
// run cleanup. Uses node:test and node:assert/strict per project convention.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

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
    providers: [{ key: 'openrouter', label: 'OpenRouter' }],
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

    it('flags manual inspection on hash mismatch after db_finalized', () => {
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

      const results = publication.recoverInterruptedPromotion(ctx.options);
      assert.ok(results);
      assert.equal(results[0].action, 'manual_inspection');
    });
  });

  describe('supersedeOlderRuns', () => {
    it('marks older validated_not_deployed runs as superseded', () => {
      db.applyMigrations(ctx.options);
      const database = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'));
      try {
        database.exec('BEGIN IMMEDIATE');
        database.prepare("INSERT INTO runs (run_id, status, started_at) VALUES ('old-run', 'validated_not_deployed', '2025-01-01')").run();
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
        const newer = check.prepare("SELECT status FROM runs WHERE run_id = 'new-run'").get();
        assert.equal(newer.status, 'promoted');
      } finally {
        check.close();
      }
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
    it('removes run directories older than seven days', () => {
      const crawlDir = path.join(ctx.stateDir, 'crawl');
      const oldRunDir = path.join(crawlDir, 'old-run');
      const newRunDir = path.join(crawlDir, 'new-run');
      fs.mkdirSync(oldRunDir, { recursive: true });
      fs.mkdirSync(newRunDir, { recursive: true });
      fs.writeFileSync(path.join(oldRunDir, 'marker.txt'), 'old');
      fs.writeFileSync(path.join(newRunDir, 'marker.txt'), 'new');

      // Backdate the old run directory.
      const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(oldRunDir, eightDaysAgo, eightDaysAgo);

      const cleaned = publication.cleanupOldRuns(ctx.options);
      assert.equal(cleaned, 1);
      assert.ok(!fs.existsSync(oldRunDir));
      assert.ok(fs.existsSync(newRunDir));
    });

    it('preserves the newest promoted run directory', () => {
      db.applyMigrations(ctx.options);
      const database = db.openDatabaseFile(path.join(ctx.stateDir, 'collector.sqlite'));
      try {
        database.exec('BEGIN IMMEDIATE');
        database.prepare(
          "INSERT INTO runs (run_id, status, started_at, finished_at) VALUES ('keep-run', 'promoted', '2025-01-01', '2025-01-01')"
        ).run();
        database.exec('COMMIT');
      } finally {
        database.close();
      }

      const crawlDir = path.join(ctx.stateDir, 'crawl');
      const keepDir = path.join(crawlDir, 'keep-run');
      fs.mkdirSync(keepDir, { recursive: true });
      publication.writeManifest(keepDir, { run_id: 'keep-run', phase: 'pushed', files: {} });

      // Backdate.
      const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
      fs.utimesSync(keepDir, eightDaysAgo, eightDaysAgo);

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
