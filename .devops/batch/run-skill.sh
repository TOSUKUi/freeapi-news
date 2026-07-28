#!/bin/bash
# .devops/batch/run-skill.sh
#
# Fail-safe parallel collection batch.
#
# Flow:
#   Step 0: Preflight — flock, run_id, snapshots, manifest
#   Step 1: Discovery + Known refresh (parallel)
#   Step 2: Crawl pool (parallel, manifest-driven)
#   Step 3: Reduce (deterministic, no LLM)
#   Step 4: Edit (1 pi, reads candidates only, no fetch)
#   Step 5: Validate (auto-fix + exclude)
#   Step 6: Atomic promote + deploy (single commit)
#
# Fail-safe guarantees:
#   - flock prevents concurrent runs
#   - workers write .tmp then rename (no half-written JSON)
#   - reducer aborts if >50% tasks fail or zero candidates
#   - validator aborts on top-level schema errors
#   - deploy only if validate + build both succeed
#   - state/registry/report/index committed atomically
#   - on any failure, previous report stays live
#
# Env:
#   CRAWL_CONCURRENCY  — parallel worker count (default: 2)
#   PI_MODEL           — model for pi workers (default: litellm/local)
#   SKIP_CITATION_CHECK — set to 1 to skip live citation re-fetch

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../config/env.sh"

SKILL_DIR="${PROJECT_ROOT}/.agents/skills/llm-deals-intelligence-skill"
SKILL_SCHEMA_FILE="${SKILL_DIR}/schemas/daily_report.schema.json"
REPORT_FILE="${PROJECT_ROOT}/report.json"
HTML_FILE="${PROJECT_ROOT}/index.html"
CRAWL_CONCURRENCY="${CRAWL_CONCURRENCY:-2}"
PI_MODEL="${PI_MODEL:-litellm/local}"
PI_TIMEOUT="${PI_TIMEOUT:-1800}"

# ── Step 0: Preflight ────────────────────────────────────────────

# Prevent concurrent runs.
LOCKFILE="${PROJECT_ROOT}/.devops/batch/.crawl.lock"
exec 9>"${LOCKFILE}"
if ! flock -n 9; then
  echo "❌ Another batch is already running. Exiting."
  exit 1
fi

RUN_ID="$(date -u '+%Y%m%dT%H%M%SZ')"
CRAWL_DIR="${SKILL_DIR}/state/crawl/${RUN_ID}"
echo "============================================"
echo "  LLM Deals Intelligence — Parallel Batch"
echo "  Run: ${RUN_ID}"
echo "  Concurrency: ${CRAWL_CONCURRENCY}"
echo "  Model: ${PI_MODEL}"
echo "============================================"

# Create directory structure.
mkdir -p "${CRAWL_DIR}"/{snapshots,discovery,refresh,offers,deltas,reduced}

# Read-only snapshots for workers.
cp "${SKILL_DIR}/state/benchmarks.json" "${CRAWL_DIR}/snapshots/" 2>/dev/null || echo '{"models":[]}' > "${CRAWL_DIR}/snapshots/benchmarks.json"
cp "${SKILL_DIR}/state/known_offers.json" "${CRAWL_DIR}/snapshots/" 2>/dev/null || echo '{"offers":[]}' > "${CRAWL_DIR}/snapshots/known_offers.json"
cp "${PROJECT_ROOT}/build/provider-registry.json" "${CRAWL_DIR}/snapshots/" 2>/dev/null || echo '{"providers":[]}' > "${CRAWL_DIR}/snapshots/provider-registry.json"

# Generate manifest.
echo ""
echo "[0/6] Building manifest..."
node "${SCRIPT_DIR}/build-manifest.js" "${CRAWL_DIR}"

# ── Helper: run a pi worker ──────────────────────────────────────
run_worker() {
  local task_id="$1"
  local prompt="$2"
  local output_file="$3"

  echo "  → Starting worker: ${task_id}"
  timeout "${PI_TIMEOUT}" pi \
    --skill "${SKILL_DIR}" \
    --model "${PI_MODEL}" \
    --approve \
    --no-session \
    -p "${prompt}" \
    2>/dev/null || true

  # Check if the worker produced output.
  if [[ ! -f "${output_file}" ]]; then
    # Worker failed to write. Create a failure artifact.
    echo "{\"schema_version\":1,\"task_id\":\"${task_id}\",\"status\":\"failed\",\"crawled_at\":\"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\",\"offers\":[],\"excluded\":[],\"benchmark_deltas\":[],\"registry_deltas\":[],\"errors\":[\"worker did not produce output file\"]}" > "${output_file}"
    echo "  ⚠️  ${task_id}: no output, wrote failure artifact"
  fi
}

# ── Step 1: Discovery + Refresh (parallel) ───────────────────────
echo ""
echo "[1/6] Discovery + Known refresh (parallel)..."

DISCOVERY_TASK=$(node -e "
  const m = require('${CRAWL_DIR}/manifest.json');
  const t = m.tasks.find(t => t.kind === 'discovery');
  if (t) console.log(JSON.stringify(t));
")

REFRESH_TASKS=$(node -e "
  const m = require('${CRAWL_DIR}/manifest.json');
  for (const t of m.tasks.filter(t => t.kind === 'refresh')) console.log(JSON.stringify(t));
")

# Launch discovery.
if [[ -n "${DISCOVERY_TASK}" ]]; then
  run_worker "discovery" \
    "You are the discovery worker. Read your task from ${CRAWL_DIR}/manifest.json (task_id: discovery). Read snapshots from ${CRAWL_DIR}/snapshots/. Search for newly announced LLMs, previews, betas, API launches, pricing changes from the last 24h/72h/30d. For each new model, collect benchmark data (check snapshots/benchmarks.json first, then HuggingFace model cards, vendor blogs, X posts). Write your output to ${CRAWL_DIR}/discovery/task-discovery.json.tmp then rename to task-discovery.json. Use the crawl-worker.md output schema. Do NOT edit any shared state files." \
    "${CRAWL_DIR}/discovery/task-discovery.json" &
  DISCOVERY_PID=$!
fi

# Launch refresh workers (up to CRAWL_CONCURRENCY at a time).
REFRESH_PIDS=()
while IFS= read -r task_json; do
  [[ -z "${task_json}" ]] && continue
  TASK_ID=$(echo "${task_json}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).task_id))")
  PROVIDER_KEY=$(echo "${task_json}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).provider_key||''))")
  OUTPUT=$(echo "${task_json}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).output))")
  KNOWN_NAMES=$(echo "${task_json}" | node -e "process.stdin.on('data',d=>console.log((JSON.parse(d).known_offers||[]).join(', ')))")

  # Wait if we have too many background jobs.
  while [[ $(jobs -rp | wc -l) -ge $((CRAWL_CONCURRENCY + 1)) ]]; do
    wait -n 2>/dev/null || true
  done

  run_worker "${TASK_ID}" \
    "You are a refresh worker. Read your task from ${CRAWL_DIR}/manifest.json (task_id: ${TASK_ID}). Provider: ${PROVIDER_KEY}. Known offers: ${KNOWN_NAMES}. Read snapshots from ${CRAWL_DIR}/snapshots/ and the registry from build/provider-registry.json. Re-verify the known offers: fetch the docs page, confirm base_url is unchanged, confirm the model is still available, check if free quota or pricing changed. If nothing changed, copy the known offer data with updated last_verified. Write to ${CRAWL_DIR}/${OUTPUT}.tmp then rename. Use the crawl-worker.md output schema. Do NOT edit shared state files." \
    "${CRAWL_DIR}/${OUTPUT}" &
  REFRESH_PIDS+=($!)
done <<< "${REFRESH_TASKS}"

# Wait for all Step 1 workers.
wait
echo "  Step 1 complete."

# ── Step 2: Crawl pool (parallel, manifest-driven) ───────────────
echo ""
echo "[2/6] Crawl pool (parallel, concurrency=${CRAWL_CONCURRENCY})..."

CRAWL_TASKS=$(node -e "
  const m = require('${CRAWL_DIR}/manifest.json');
  for (const t of m.tasks.filter(t => t.kind === 'crawl')) console.log(JSON.stringify(t));
")

# Also check if discovery found new providers/models that need crawling.
DISCOVERY_FILE="${CRAWL_DIR}/discovery/task-discovery.json"
if [[ -f "${DISCOVERY_FILE}" ]]; then
  NEW_PROVIDER_TASKS=$(node -e "
    try {
      const d = require('${DISCOVERY_FILE}');
      const m = require('${CRAWL_DIR}/manifest.json');
      const knownKeys = new Set(m.tasks.filter(t=>t.provider_key).map(t=>t.provider_key));
      const seen = new Set();
      for (const o of d.offers||[]) {
        const k = (o.provider_key||'').toLowerCase();
        if (k && !knownKeys.has(k) && !seen.has(k)) {
          seen.add(k);
          console.log(JSON.stringify({task_id:'crawl:'+k, kind:'crawl', provider_key:k, provider_label:o.provider||k, base_url:o.base_url||null, docs_url:null, status:'pending', output:'offers/task-'+k+'.json', from_discovery:true}));
        }
      }
    } catch {}
  " 2>/dev/null || true)
  if [[ -n "${NEW_PROVIDER_TASKS}" ]]; then
    CRAWL_TASKS="${CRAWL_TASKS}
${NEW_PROVIDER_TASKS}"
    echo "  + New providers from discovery: $(echo "${NEW_PROVIDER_TASKS}" | wc -l) task(s)"
  fi
fi

while IFS= read -r task_json; do
  [[ -z "${task_json}" ]] && continue
  TASK_ID=$(echo "${task_json}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).task_id))")
  PROVIDER_KEY=$(echo "${task_json}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).provider_key||''))")
  OUTPUT=$(echo "${task_json}" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).output))")

  # Throttle: wait if too many background jobs.
  while [[ $(jobs -rp | wc -l) -ge "${CRAWL_CONCURRENCY}" ]]; do
    wait -n 2>/dev/null || true
  done

  run_worker "${TASK_ID}" \
    "You are a crawl worker. Read your task from ${CRAWL_DIR}/manifest.json (task_id: ${TASK_ID}). Provider: ${PROVIDER_KEY}. Read snapshots from ${CRAWL_DIR}/snapshots/ and the registry from build/provider-registry.json. If discovery found new models for this provider, read ${DISCOVERY_FILE}. Investigate free/discounted API offers: fetch pricing page, model catalog, API docs. For each candidate, verify endpoint, model ID, limits. Collect benchmarks (check snapshots/benchmarks.json first). Apply the quality gate. Write to ${CRAWL_DIR}/${OUTPUT}.tmp then rename. Use the crawl-worker.md output schema. Do NOT edit shared state files. Process one provider at a time; write after each provider to avoid context overflow." \
    "${CRAWL_DIR}/${OUTPUT}" &
done <<< "${CRAWL_TASKS}"

wait
echo "  Step 2 complete."

# ── Step 3: Reduce (deterministic, no LLM) ───────────────────────
echo ""
echo "[3/6] Reducing artifacts..."
if ! node "${SCRIPT_DIR}/reduce-crawl.js" "${CRAWL_DIR}"; then
  echo "⚠️  Reducer aborted. Falling back to simple single-pi run..."
  timeout "${PI_TIMEOUT}" pi \
    --skill "${SKILL_DIR}" \
    --model "${PI_MODEL}" \
    --approve \
    --no-session \
    -p "Run the llm-deals-intelligence-skill full collection workflow (Phase 0-9). MANDATORY: before writing ANY base_url or model_id, read build/provider-registry.json. Listed provider: use registry base_url verbatim, re-fetch docs_url, cite as endpoint_source. Unlisted provider: fetch official docs, add registry entry with added_from, cite as endpoint_source. Never write endpoints from memory. Write the final report to ${REPORT_FILE} following ${SKILL_SCHEMA_FILE}. Read previous state from ${SKILL_DIR}/state/known_offers.json and ${SKILL_DIR}/state/benchmarks.json." \
    2>/dev/null || true
  if [[ ! -f "${REPORT_FILE}" ]]; then
    echo "❌ Fallback also failed. Previous report stays live."
    exit 1
  fi
  # Skip Steps 4-5, go straight to validate below.
  SKIP_PARALLEL=true
fi

# ── Step 4: Edit (1 pi, reads candidates only) ───────────────────
if [[ "${SKIP_PARALLEL:-}" != "true" ]]; then
  echo ""
  echo "[4/6] Editor (reading candidates, no fetch)..."
  CANDIDATES_FILE="${CRAWL_DIR}/reduced/candidates.json"

  timeout "${PI_TIMEOUT}" pi \
    --skill "${SKILL_DIR}" \
    --model "${PI_MODEL}" \
    --approve \
    --no-session \
    -p "You are the editor. Read ${CANDIDATES_FILE} — it contains all candidates, exclusions, coverage info, and disappeared known offers from this crawl run. Also read ${CRAWL_DIR}/reduced/benchmarks.json (merged benchmark state) and ${CRAWL_DIR}/reduced/provider-registry.json (merged registry). Do NOT fetch any URLs. Do NOT run web searches. Work only from the files. Produce the daily Japanese report at ${REPORT_FILE} following the schema at ${SKILL_SCHEMA_FILE}. Apply tier rules, quality gate, allowance ranking, and classification. Update ${SKILL_DIR}/state/known_offers.json from the final ranked offers. If coverage.rate is low or disappeared_known_offers is non-empty, note it in the report's changes section. Write report.json, then write the merged benchmarks to ${SKILL_DIR}/state/benchmarks.json and the merged registry to build/provider-registry.json." \
    2>/dev/null || true

  if [[ ! -f "${REPORT_FILE}" ]]; then
    echo "❌ Editor did not produce report.json. Previous report stays live."
    exit 1
  fi
fi

# ── Step 5: Validate → pi fix → re-validate ──────────────────────
echo ""
echo "[5/6] Validating..."
VALIDATE_STDERR="$(mktemp)"
FIX_REPORT="$(mktemp)"

if ! node "${PROJECT_ROOT}/build/validate-report.js" "${REPORT_FILE}" "${SKILL_SCHEMA_FILE}" 2>"${VALIDATE_STDERR}"; then
  # Top-level schema error = fatal, no fix possible.
  if grep -q "Top-level schema error" "${VALIDATE_STDERR}"; then
    echo "❌ Fatal schema error. Previous report stays live."
    cat "${VALIDATE_STDERR}"
    rm -f "${VALIDATE_STDERR}" "${FIX_REPORT}"
    exit 1
  fi

  # Extract fix-report JSON between markers.
  sed -n '/__FIX_REPORT_START__/,/__FIX_REPORT_END__/{ /__FIX_REPORT/d; p; }' "${VALIDATE_STDERR}" > "${FIX_REPORT}"

  # Ask pi to fix the specific issues (1 round).
  if command -v pi &>/dev/null && [[ -s "${FIX_REPORT}" ]]; then
    echo "  Violations found. Asking pi to fix..."
    timeout 300 pi \
      --skill "${SKILL_DIR}" \
      --model "${PI_MODEL}" \
      --approve \
      --no-session \
      -p "The validator found violations in ${REPORT_FILE}. Read the fix-report at ${FIX_REPORT} (JSON array of {offer, gate, field, current, action, source_hint}). For each entry: fix the specific field in report.json using the action and source_hint. Do NOT remove offers from the report — fix the data in place. After fixing, save report.json." \
      2>/dev/null || true

    # Re-validate after pi's fix.
    echo "  Re-validating after pi fix..."
    if ! node "${PROJECT_ROOT}/build/validate-report.js" "${REPORT_FILE}" "${SKILL_SCHEMA_FILE}" 2>"${VALIDATE_STDERR}"; then
      if grep -q "Top-level schema error" "${VALIDATE_STDERR}"; then
        echo "❌ Still fatal after fix. Previous report stays live."
        rm -f "${VALIDATE_STDERR}" "${FIX_REPORT}"
        exit 1
      fi
      echo "  Still has violations. Validator auto-fixed/excluded remaining."
    else
      echo "  ✅ Fixed successfully."
    fi
  else
    echo "  Validator auto-fixed/excluded some offers. Continuing."
  fi
fi
rm -f "${VALIDATE_STDERR}" "${FIX_REPORT}"

# ── Step 6: Build + atomic deploy ────────────────────────────────
echo ""
echo "[6/6] Building + deploying..."
node "${PROJECT_ROOT}/build/build-html.js" "${REPORT_FILE}" "${HTML_FILE}"
node "${PROJECT_ROOT}/build/build-og-image.js" "${REPORT_FILE}" "${PROJECT_ROOT}/og-image.html" "${PROJECT_ROOT}/og-image.png" 2>/dev/null || echo "  (OGP image skipped)"

# Atomic commit: report + state + registry + HTML in one commit.
cd "${PROJECT_ROOT}"
git add report.json index.html og-image.png og-image.html \
  build/provider-registry.json \
  "${SKILL_DIR}/state/benchmarks.json" \
  "${SKILL_DIR}/state/known_offers.json" \
  2>/dev/null || true

if git diff --cached --quiet; then
  echo "  No changes to deploy."
else
  git commit -q -m "chore: daily report ${RUN_ID} (parallel crawl, ${CRAWL_CONCURRENCY} workers)"
  git push origin main
  echo "  ✅ Deployed."
fi

# ── Cleanup old crawl runs (keep last 3) ─────────────────────────
CRAWL_BASE="${SKILL_DIR}/state/crawl"
ls -1d "${CRAWL_BASE}"/2* 2>/dev/null | sort | head -n -3 | xargs rm -rf 2>/dev/null || true

echo ""
echo "============================================"
echo "  Batch complete: ${RUN_ID}"
echo "============================================"
