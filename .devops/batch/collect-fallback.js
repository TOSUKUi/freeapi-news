#!/usr/bin/env node
/**
 * collect-fallback.js
 *
 * Fallback collector for when pi CLI is not available.
 * Uses web_search and browser tools (via pi's MCP) to collect
 * free API information and generate a report.json.
 *
 * This script is designed to be run by pi or an agent with
 * web_search and browser capabilities. It reads the skill's
 * config files and produces a JSON report.
 *
 * Usage:
 *   node .devops/batch/collect-fallback.js [output.json]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const SKILL_DIR = path.join(ROOT, '.agents', 'skills', 'llm-deals-intelligence-skill');
const OUTPUT = process.argv[2] || path.join(ROOT, 'report.json');

// ── Load skill config ───────────────────────────────────────────
function loadYAML(filePath) {
  try {
    const yaml = require('js-yaml');
    return yaml.load(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    // Fallback: simple parsing for the known structure
    const content = fs.readFileSync(filePath, 'utf8');
    return { _raw: content, _parseError: e.message };
  }
}

const sources = loadYAML(path.join(SKILL_DIR, 'config', 'sources.yaml'));
const queries = loadYAML(path.join(SKILL_DIR, 'config', 'search_queries.yaml'));
const state = JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'state', 'known_offers.json'), 'utf8'));

console.log('[collect-fallback] Starting collection...');
console.log('[collect-fallback] Sources loaded:', sources ? 'OK' : 'MISSING');
console.log('[collect-fallback] Previous state:', state.offers?.length || 0, 'offers');

// ── This function is called by pi or an agent ────────────────────
// When run by pi, the agent uses web_search and browser tools
// to execute the skill workflow and fills in the report below.
//
// The agent should:
// 1. Use web_search with the queries from search_queries.yaml
// 2. Use browser to verify official pages
// 3. Follow the 10-phase workflow in SKILL.md
// 4. Call this script with the collected data

function buildReport(collectedData) {
  return {
    generated_at: new Date().toISOString(),
    timezone: 'Asia/Tokyo',
    new_models: collectedData.new_models || [],
    changes: collectedData.changes || [],
    ranked_offers: collectedData.ranked_offers || [],
    conditional_credits: collectedData.conditional_credits || [],
    caution_offers: collectedData.caution_offers || [],
    excluded_offers: collectedData.excluded_offers || [],
    new_seed_candidates: collectedData.new_seed_candidates || [],
    sources: collectedData.sources || [],
  };
}

// ── If running interactively (by pi), output instructions ─────────
if (require.main === module && !process.stdin.isTTY) {
  // Piped input mode: read JSON from stdin
  let data = '';
  process.stdin.on('data', chunk => data += chunk);
  process.stdin.on('end', () => {
    try {
      const collected = JSON.parse(data);
      const report = buildReport(collected);
      fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
      console.log('[collect-fallback] Report written to:', OUTPUT);
    } catch (e) {
      console.error('[collect-fallback] Failed to parse stdin:', e.message);
      process.exit(1);
    }
  });
} else {
  // Interactive mode: print instructions for the agent
  console.log('');
  console.log('=== LLM Deals Intelligence Skill — Fallback Collector ===');
  console.log('');
  console.log('This script is designed to be run by pi or an agent with');
  console.log('web_search and browser tools.');
  console.log('');
  console.log('Follow the SKILL.md workflow:');
  console.log('  Phase 0: Discover new models (web_search, 24h/72h/30d)');
  console.log('  Phase 1: Search for offers (free API, free tier, credits)');
  console.log('  Phase 2: Check providers and aggregators');
  console.log('  Phase 3: Community early-warning scan (Reddit, GitHub)');
  console.log('  Phase 4: Verify offers are usable');
  console.log('  Phase 5: Normalize pricing (USD per 1M tokens)');
  console.log('  Phase 6: Classify offers (A_TRUE_FREE, B_PERMANENT, etc.)');
  console.log('  Phase 7: Score risk and confidence');
  console.log('  Phase 8: Compare with previous state');
  console.log('  Phase 9: Produce the daily report');
  console.log('');
  console.log('Config files:');
  console.log('  Sources:    ', path.join(SKILL_DIR, 'config', 'sources.yaml'));
  console.log('  Queries:    ', path.join(SKILL_DIR, 'config', 'search_queries.yaml'));
  console.log('  State:      ', path.join(SKILL_DIR, 'state', 'known_offers.json'));
  console.log('  Schema:     ', path.join(SKILL_DIR, 'schemas', 'daily_report.schema.json'));
  console.log('  Prompts:    ', path.join(SKILL_DIR, 'prompts'));
  console.log('');
  console.log('Output:');
  console.log('  Report:     ', OUTPUT);
  console.log('');
  console.log('After collecting data, pipe it as JSON to this script:');
  console.log('  echo \'{"new_models":[...],"ranked_offers":[...],...}\' | node collect-fallback.js');
  console.log('');
  console.log('Or use pi directly:');
  console.log('  pi run llm-deals-intelligence-skill --output report.json');
}
