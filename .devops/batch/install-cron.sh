#!/bin/bash
# .devops/batch/install-cron.sh
#
# The collection batch runs on THIS machine (pi + camofox browser + web_search),
# NOT in CI. This helper registers the daily run with the local scheduler (cron).
#
# Usage:
#   .devops/batch/install-cron.sh            # print the cron line only
#   .devops/batch/install-cron.sh --install  # add it to the current crontab (idempotent)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../config/env.sh"

LOG_DIR="${PROJECT_ROOT}/.devops/logs"
TAG="# free-api-news local batch"
# cron has a minimal PATH, so run through a login shell to pick up nodenv/nvm/etc.
CRON_LINE="${SCHEDULE_CRON} /bin/bash -lc 'cd ${PROJECT_ROOT} && npm run full' >> ${LOG_DIR}/batch.log 2>&1 ${TAG}"

echo "Local batch schedule (machine local time; keep TZ=${TIMEZONE} for 11:00 JST):"
echo "  ${CRON_LINE}"

if [[ "${1:-}" != "--install" ]]; then
  echo ""
  echo "Run with --install to add it to your crontab."
  exit 0
fi

mkdir -p "${LOG_DIR}"

# Idempotent: drop any previous entry, then append the current one.
( crontab -l 2>/dev/null | grep -v "free-api-news local batch" || true; echo "${CRON_LINE}" ) | crontab -

echo ""
echo "Installed. Active entry:"
crontab -l | grep "free-api-news local batch" || true
