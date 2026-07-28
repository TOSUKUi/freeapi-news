#!/bin/bash
# .devops/deploy/git-push.sh
#
# Last step of the LOCAL batch: commits the generated artifacts
# (report.json + index.html) and pushes the current branch to origin.
# GitHub Pages serves directly from that branch — there is no CI step.
#
# Usage:
#   .devops/deploy/git-push.sh [commit_message]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../config/env.sh"

cd "${PROJECT_ROOT}"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
COMMIT_MSG="${1:-"chore: update report $(date '+%Y-%m-%d %H:%M %Z')"}"

echo "Deploying (local batch → git push)"
echo "  Branch:  ${BRANCH}"
echo "  Message: ${COMMIT_MSG}"

# Optional commit identity. A local batch normally inherits your git config;
# set GIT_COMMIT_USER / GIT_COMMIT_EMAIL to override.
if [[ -n "${GIT_COMMIT_USER:-}" ]]; then
  git config user.name "${GIT_COMMIT_USER}"
fi
if [[ -n "${GIT_COMMIT_EMAIL:-}" ]]; then
  git config user.email "${GIT_COMMIT_EMAIL}"
fi

# Stage the generated artifacts (report + rendered page + OGP image).
# og-image.png is a served artifact; stage it only if the build produced one
# (the OGP render is skipped gracefully on machines without Chrome).
OG_IMAGE="${PROJECT_ROOT}/og-image.png"
git add "${REPORT_FILE}" "${HTML_FILE}"
if [[ -f "${OG_IMAGE}" ]]; then
  git add "${OG_IMAGE}"
fi

if git diff --cached --quiet; then
  echo "No changes to commit — page already up to date."
  exit 0
fi

git commit -m "${COMMIT_MSG}"

# Push. If no remote is configured yet, keep the commit local with a clear hint.
if ! git remote get-url origin &>/dev/null; then
  echo ""
  echo "WARNING: no 'origin' remote configured — committed locally only."
  echo "  Add one:  git remote add origin <url>"
  echo "  Then:     git push -u origin ${BRANCH}"
  exit 0
fi

git push origin "${BRANCH}"

echo ""
echo "Pushed to origin/${BRANCH}. GitHub Pages refreshes from this branch."
