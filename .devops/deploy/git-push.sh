#!/bin/bash
# .devops/deploy/git-push.sh
#
# Commits the generated HTML page and pushes to GitHub.
#
# Usage:
#   .devops/deploy/git-push.sh [commit_message]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../config/env.sh"

COMMIT_MSG="${1:-"Update free API report: $(date -u '+%Y-%m-%d %H:%M UTC' 2>/dev/null || date)"}"

echo "Committing and pushing..."
echo "  Branch: ${GH_PAGES_BRANCH}"
echo "  Message: ${COMMIT_MSG}"

cd "${PROJECT_ROOT}"

# Configure git
git config user.name "${GIT_COMMIT_USER}"
git config user.email "${GIT_COMMIT_EMAIL}"

# Check if there are changes
if git diff --quiet && git diff --cached --quiet; then
  echo "No changes to commit."
  exit 0
fi

# Stage the HTML and report
git add "${HTML_FILE}" "${REPORT_FILE}"

# Commit
git commit -m "${COMMIT_MSG}"

# Push
git push origin "${GH_PAGES_BRANCH}"

echo ""
echo "Pushed to ${GH_PAGES_BRANCH} successfully."
