#!/bin/bash
# .devops/batch/run-skill.sh
#
# Scheduled collection batch for the LLM Deals Intelligence Skill.
#
# Flow:
#   1. pi runs the skill → writes report.json
#   2. validate: auto-fix what it can (state merge, tier cap, allowance
#      default), exclude what it can't (fake URL, bad citation, paid API).
#      Rewrites report.json. Emits fix-report on stderr.
#   3. If fix-report has "exclude" entries that pi could have prevented:
#      pass the fix-report to pi for 1 correction round, then re-validate.
#   4. Build + deploy the cleaned report.
#
# Usage:
#   .devops/batch/run-skill.sh           # full run
#   .devops/batch/run-skill.sh --dry-run # validate existing report only

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
    echo "[dry-run] No report found."
    exit 0
  fi
  node "${PROJECT_ROOT}/build/validate-report.js" "${REPORT_FILE}" "${SKILL_SCHEMA_FILE}"
  echo "[dry-run] Done."
  exit 0
fi

# ── Step 1: Skill directory check ────────────────────────────────
if [[ ! -d "${SKILL_DIR}" ]]; then
  echo "ERROR: Skill directory not found: ${SKILL_DIR}"
  exit 1
fi

# ── Step 2: Run the skill via pi ─────────────────────────────────
echo "[1/4] Running collection skill via pi..."

if command -v pi &>/dev/null; then
  timeout "${PI_TIMEOUT}" pi \
    --skill "${SKILL_DIR}" \
    --model "${PI_MODEL}" \
    --approve \
    --no-session \
    -p "Run the llm-deals-intelligence-skill full collection workflow (Phase 0-9). MANDATORY: before writing ANY base_url or model_id, read ${PROVIDER_REGISTRY}. Listed provider: use registry base_url verbatim, re-fetch docs_url, cite as endpoint_source. Unlisted provider: fetch official docs, add registry entry with added_from, cite as endpoint_source. Never write endpoints from memory. Write the final report to ${REPORT_FILE} following ${SKILL_SCHEMA_FILE}. Read previous state from ${SKILL_STATE_FILE}."
else
  echo "WARNING: pi CLI not found. Run manually or use fallback."
  node "${SCRIPT_DIR}/collect-fallback.js" "${REPORT_FILE}"
fi

# ── Step 3: Validate (auto-fix + exclude) ────────────────────────
# The validator rewrites report.json: auto-fixes what it can, excludes
# what it can't. Emits a JSON fix-report on stderr between markers.
echo ""
echo "[2/4] Validating (auto-fix + exclude)..."

VALIDATE_STDERR="$(mktemp)"
node "${PROJECT_ROOT}/build/validate-report.js" "${REPORT_FILE}" "${SKILL_SCHEMA_FILE}" 2>"${VALIDATE_STDERR}" || true

# Extract fix-report JSON between markers.
FIX_REPORT="$(mktemp)"
sed -n '/__FIX_REPORT_START__/,/__FIX_REPORT_END__/{ /__FIX_REPORT/d; p; }' "${VALIDATE_STDERR}" > "${FIX_REPORT}"

# Show what happened.
cat "${VALIDATE_STDERR}" | grep -v '__FIX_REPORT' | grep -v '^\[' || true
grep -E '✅|Auto-fixed|Excluded|Ranked' "${VALIDATE_STDERR}" || true

# If there are excludes that pi could have prevented, ask pi to fix.
EXCLUDE_COUNT=$(grep -c '"action": "exclude"' "${FIX_REPORT}" 2>/dev/null || echo 0)
if [[ "${EXCLUDE_COUNT}" -gt 0 ]] && command -v pi &>/dev/null; then
  echo ""
  echo "[3/4] ${EXCLUDE_COUNT} offer(s) excluded. Asking pi to fix for next run..."
  # Don't re-run the full skill — just fix the specific issues.
  timeout 300 pi \
    --skill "${SKILL_DIR}" \
    --model "${PI_MODEL}" \
    --approve \
    --no-session \
    -p "The validator excluded some offers from ${REPORT_FILE}. Read the fix-report at ${FIX_REPORT}. For each excluded offer: investigate the issue (fetch the source_hint URL, check state/benchmarks.json, etc.) and if you can fix it, add the offer back to ranked_offers with the corrected data. If you truly cannot fix it, leave it excluded. Save report.json." \
    2>/dev/null || true

  # Re-validate after pi's fix attempt.
  echo "  Re-validating after pi fix..."
  node "${PROJECT_ROOT}/build/validate-report.js" "${REPORT_FILE}" "${SKILL_SCHEMA_FILE}" 2>/dev/null || true
else
  echo "[3/4] No excludes to fix, or pi not available."
fi

rm -f "${VALIDATE_STDERR}" "${FIX_REPORT}"

# ── Step 4: Build + deploy ───────────────────────────────────────
echo ""
echo "[4/4] Building HTML + OGP..."
node "${PROJECT_ROOT}/build/build-html.js" "${REPORT_FILE}" "${HTML_FILE}"
node "${PROJECT_ROOT}/build/build-og-image.js" "${REPORT_FILE}" "${PROJECT_ROOT}/og-image.html" "${PROJECT_ROOT}/og-image.png" 2>/dev/null || echo "  (OGP image skipped — no Chrome)"

# ── Step 5: Update state ─────────────────────────────────────────
echo ""
echo "Updating state..."
node -e "
const fs = require('fs');
const report = JSON.parse(fs.readFileSync('${REPORT_FILE}', 'utf8'));
const state = {
  updated_at: report.generated_at,
  offers: (report.ranked_offers || []).filter(o => o.ranking_eligible === true).map(o => ({
    name: o.name, provider: o.provider, classification: o.classification,
    end_at: o.end_at, operational_confidence: o.operational_confidence,
    suspicion_score: o.suspicion_score, base_url: o.base_url, model_id: o.model_id,
  })),
};
fs.writeFileSync('${SKILL_STATE_FILE}', JSON.stringify(state, null, 2));
console.log('State updated.');
"

# ── Step 6: Deploy ───────────────────────────────────────────────
echo ""
echo "Deploying..."
"${SCRIPT_DIR}/../deploy/git-push.sh"

echo ""
echo "============================================"
echo "  Batch run complete!"
echo "============================================"
