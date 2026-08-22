#!/usr/bin/env node
'use strict';

// Environment configuration — single source of truth.
// Import this from any entry point (cli.js, collect.js, etc.):
//   require('../config/env.config')
// It applies sensible defaults to process.env only when unset.
// To override, export the variable before requiring this module,
// or pass it inline: PI_MODEL=litellm/foo npm run collect

const path = require('node:path');
const fs = require('node:fs');

// Resolve paths relative to this config file (.devops/config/env.config.js)
const CONFIG_DIR = __dirname;
const PROJECT_ROOT = path.resolve(CONFIG_DIR, '../..');

/**
 * Apply a default to process.env only if the key is not already set.
 */
function envDefault(key, value) {
  if (process.env[key] === undefined) {
    process.env[key] = String(value);
  }
}

// ── Project paths ────────────────────────────────────────────────
envDefault('PROJECT_ROOT', PROJECT_ROOT);
envDefault('SKILL_DIR', path.join(PROJECT_ROOT, '.agents/skills/llm-deals-intelligence-skill'));
envDefault('REPORT_FILE', path.join(PROJECT_ROOT, 'report.json'));
envDefault('HTML_FILE', path.join(PROJECT_ROOT, 'index.html'));
envDefault('BUILD_SCRIPT', path.join(PROJECT_ROOT, 'build/build-html.js'));

// ── Schedule ─────────────────────────────────────────────────────
envDefault('SCHEDULE_CRON', '0 11 * * *');
envDefault('TIMEZONE', 'Asia/Tokyo');

// ── Skill inputs ─────────────────────────────────────────────────
envDefault('SKILL_SCHEMA_FILE', path.join(
  process.env.SKILL_DIR, 'schemas/daily_report.schema.json'
));
envDefault('PROVIDER_REGISTRY', path.join(PROJECT_ROOT, 'build/provider-registry.json'));

// ── pi agent settings ────────────────────────────────────────────
envDefault('PI_MODEL', 'litellm/local');
envDefault('PI_TIMEOUT', '1800');
envDefault('DISCOVERY_TIMEOUT', '900');
envDefault('GLOBAL_CONCURRENCY', '6');

module.exports = {}; // no public API — side effects only
