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

# ── GitHub Pages ─────────────────────────────────────────────────
export GH_PAGES_BRANCH="gh-pages"
export GH_PAGES_FOLDER="${PROJECT_ROOT}"
export GIT_COMMIT_USER="${GIT_COMMIT_USER:-free-api-news-bot}"
export GIT_COMMIT_EMAIL="${GIT_COMMIT_EMAIL:-bot@free-api-news.workers.dev}"

# ── Schedule ─────────────────────────────────────────────────────
# Skill recommends daily at 11:00 Asia/Tokyo
export SCHEDULE_CRON="0 2 * * *"   # UTC = 11:00 JST
export TIMEZONE="Asia/Tokyo"

# ── Skill inputs ─────────────────────────────────────────────────
export SKILL_CONFIG_SOURCES="${SKILL_DIR}/config/sources.yaml"
export SKILL_CONFIG_QUERIES="${SKILL_DIR}/config/search_queries.yaml"
export SKILL_STATE_FILE="${SKILL_DIR}/state/known_offers.json"
export SKILL_SCHEMA_FILE="${SKILL_DIR}/schemas/daily_report.schema.json"

# ── pi agent settings ────────────────────────────────────────────
# Set PI_API_KEY if running pi in CI
export PI_MODEL="${PI_MODEL:-claude-sonnet-4}"
export PI_TIMEOUT="${PI_TIMEOUT:-600}"   # seconds

echo "[env] PROJECT_ROOT=${PROJECT_ROOT}"
echo "[env] SKILL_DIR=${SKILL_DIR}"
echo "[env] REPORT_FILE=${REPORT_FILE}"
echo "[env] HTML_FILE=${HTML_FILE}"
