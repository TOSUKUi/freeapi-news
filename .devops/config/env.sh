#!/bin/bash
# .devops/config/env.sh
# Environment configuration for the free-api-news pipeline.
# Source this file from other scripts: source .devops/config/env.sh

# ── Project paths ────────────────────────────────────────────────
export PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export SKILL_DIR="${PROJECT_ROOT}/.agents/skills/llm-deals-intelligence-skill"
export REPORT_FILE="${PROJECT_ROOT}/report.json"
export HTML_FILE="${PROJECT_ROOT}/index.html"
export BUILD_SCRIPT="${PROJECT_ROOT}/build/build-html.js"

# ── Deploy (GitHub Pages) ────────────────────────────────────────
# The batch runs locally and pushes the generated files to the current
# branch. GitHub Pages serves directly from that branch — no CI involved.
# Optional: override the commit identity for the local batch. Leave unset
# to inherit your normal git config.
# export GIT_COMMIT_USER="free-api-news-bot"
# export GIT_COMMIT_EMAIL="bot@free-api-news.workers.dev"

# ── Schedule (local scheduler, e.g. cron) ────────────────────────
# The collection batch runs on THIS machine, not in CI. Register it with
# your OS scheduler via .devops/batch/install-cron.sh. The expression is in
# the machine's local time; keep the machine in Asia/Tokyo for 11:00 JST.
export SCHEDULE_CRON="0 11 * * *"   # daily 11:00 (machine local time)
export TIMEZONE="Asia/Tokyo"

# ── Skill inputs ─────────────────────────────────────────────────
export SKILL_SCHEMA_FILE="${SKILL_DIR}/schemas/daily_report.schema.json"
# Provider endpoint registry: single source of truth for base URLs. The skill
# must read it before writing any base_url/model_id and grow it (from fetched
# official docs) when a provider is missing. The validator gates on it and
# re-fetches every endpoint_source citation.
export PROVIDER_REGISTRY="${PROJECT_ROOT}/build/provider-registry.json"

# ── pi agent settings ────────────────────────────────────────────
# pi model used by the local batch (pi must be installed on this machine).
export PI_MODEL="${PI_MODEL:-litellm/deepseek-v4-flash}"
export PI_TIMEOUT="${PI_TIMEOUT:-1800}"   # seconds per non-discovery worker
export DISCOVERY_TIMEOUT="${DISCOVERY_TIMEOUT:-900}"   # seconds per discovery worker
export GLOBAL_CONCURRENCY="${GLOBAL_CONCURRENCY:-6}"   # parallel LLM worker count for the collector

echo "[env] PROJECT_ROOT=${PROJECT_ROOT}"
echo "[env] SKILL_DIR=${SKILL_DIR}"
echo "[env] REPORT_FILE=${REPORT_FILE}"
echo "[env] HTML_FILE=${HTML_FILE}"
