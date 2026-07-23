#!/bin/bash
# .devops/batch/run-skill.sh
#
# Scheduled collection batch for the LLM Deals Intelligence Skill.
#
# Uses pi (or any agent with browser + web_search tools) to:
#   1. Discover newly announced LLMs (Phase 0)
#   2. Search each model for free/discounted offers (Phase 1)
#   3. Check known providers and aggregators (Phase 2)
#   4. Scan community sources (Phase 3)
#   5. Verify offers are actually usable (Phase 4)
#   6. Normalize pricing (Phase 5)
#   7. Classify offers (Phase 6)
#   8. Score risk and confidence (Phase 7)
#   9. Compare with previous state (Phase 8)
#  10. Produce the daily report (Phase 9)
#
# Output: report.json (validated against the JSON schema)
#
# Usage:
#   .devops/batch/run-skill.sh           # Run with pi
#   .devops/batch/run-skill.sh --dry-run # Validate existing report only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../config/env.sh"

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

echo "============================================"
echo "  LLM Deals Intelligence Skill — Batch Run"
echo "  $(date -u '+%Y-%m-%d %H:%M UTC' 2>/dev/null || date)"
echo "============================================"

if $DRY_RUN; then
  echo "[dry-run] Validating existing report: ${REPORT_FILE}"
  if [[ ! -f "${REPORT_FILE}" ]]; then
    echo "[dry-run] No report found. Nothing to validate."
    exit 0
  fi
  node "${PROJECT_ROOT}/build/validate-report.js" "${REPORT_FILE}" "${SKILL_SCHEMA_FILE}"
  echo "[dry-run] Validation complete."
  exit 0
fi

# ── Step 1: Ensure skill directory exists ────────────────────────
if [[ ! -d "${SKILL_DIR}" ]]; then
  echo "ERROR: Skill directory not found: ${SKILL_DIR}"
  exit 1
fi

# ── Step 2: Run the skill via pi ──────────────────────────────────
# The skill is driven by pi using the SKILL.md instructions.
# pi has access to: web_search, browser, and persistent file storage.
#
# The skill runs in 4 phases (discovery → offer → verification → editor)
# and produces a JSON report following the schema.

echo "[1/4] Discovery Agent — finding new models..."
echo "  (using web_search with 24h/72h/30d recency filters)"
echo "  (checking official blogs, pricing pages, GitHub Releases, changelogs)"

echo "[2/4] Offer Agent — searching for free/discounted access..."
echo "  (searching: free API, free tier, launch credits, 50-98% off, off-peak)"
echo "  (languages: EN, JA, ZH)"

echo "[3/4] Verification Agent — confirming offers are usable..."
echo "  (checking: provider count, endpoint, model ID, base URL, rate limits)"
echo "  (OpenRouter rule: zero providers = excluded)"

echo "[4/4] Editor Agent — writing the daily report..."
echo "  (deduplicating, scoring, comparing with previous state)"

# ── Invoke pi with the skill ──────────────────────────────────────
# This uses the pi CLI to run the skill. The skill's SKILL.md
# contains the full workflow, acceptance criteria, and subagent
# decomposition (discovery-agent, offer-agent, verification-agent, editor-agent).
#
# pi reads:
#   - config/sources.yaml      (information sources to check)
#   - config/search_queries.yaml (multilingual search terms)
#   - state/known_offers.json  (previous state for comparison)
#   - prompts/*.md             (subagent prompts)
#   - schemas/daily_report.schema.json (output schema)
#
# pi writes:
#   - report.json              (the daily report, validated against schema)

if command -v pi &>/dev/null; then
  echo "Running skill via pi CLI..."
  timeout "${PI_TIMEOUT}" pi \
    --skill "${SKILL_DIR}" \
    --model "${PI_MODEL}" \
    --approve \
    --no-session \
    -p "Run the llm-deals-intelligence-skill full collection workflow (Phase 0-9). Write the final validated JSON report to ${REPORT_FILE} following the schema at ${SKILL_SCHEMA_FILE}. Read previous state from ${SKILL_STATE_FILE}."
else
  echo "WARNING: pi CLI not found."
  echo "Falling back to manual collection script..."
  echo ""
  echo "To run manually:"
  echo "  1. Open pi"
  echo "  2. Run: /llm-deals-intelligence-skill"
  echo "  3. pi will use web_search + browser to collect the report"
  echo "  4. Save the output as report.json"
  echo ""
  echo "Alternatively, run the fallback collector:"
  node "${SCRIPT_DIR}/collect-fallback.js" "${REPORT_FILE}"
fi

# ── Step 3: Validate the report ──────────────────────────────────
echo ""
echo "Validating report against schema..."
node "${PROJECT_ROOT}/build/validate-report.js" "${REPORT_FILE}" "${SKILL_SCHEMA_FILE}"

# ── Step 4: Update state ─────────────────────────────────────────
echo ""
echo "Updating state..."
node -e "
const fs = require('fs');
const report = JSON.parse(fs.readFileSync('${REPORT_FILE}', 'utf8'));
const state = {
  updated_at: report.generated_at,
  offers: (report.ranked_offers || []).map(o => ({
    name: o.name,
    provider: o.provider,
    classification: o.classification,
    end_at: o.end_at,
    operational_confidence: o.operational_confidence,
    suspicion_score: o.suspicion_score,
    base_url: o.base_url,
    model_id: o.model_id,
  })),
};
fs.writeFileSync('${SKILL_STATE_FILE}', JSON.stringify(state, null, 2));
console.log('State updated: ${SKILL_STATE_FILE}');
"

echo ""
echo "============================================"
echo "  Batch run complete!"
echo "  Report: ${REPORT_FILE}"
echo "  State:  ${SKILL_STATE_FILE}"
echo "============================================"
