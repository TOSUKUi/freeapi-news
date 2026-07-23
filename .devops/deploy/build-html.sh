#!/bin/bash
# .devops/deploy/build-html.sh
#
# Builds the single HTML page from the skill's JSON report.
#
# Usage:
#   .devops/deploy/build-html.sh [input.json] [output.html]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../config/env.sh"

INPUT="${1:-${REPORT_FILE}}"
OUTPUT="${2:-${HTML_FILE}}"

echo "Building HTML page..."
echo "  Input:  ${INPUT}"
echo "  Output: ${OUTPUT}"

if [[ ! -f "${INPUT}" ]]; then
  echo "ERROR: Report file not found: ${INPUT}"
  echo "Run the batch first: .devops/batch/run-skill.sh"
  exit 1
fi

node "${BUILD_SCRIPT}" "${INPUT}" "${OUTPUT}"

echo ""
echo "HTML page built successfully: ${OUTPUT}"
echo "File size: $(wc -c < "${OUTPUT}") bytes"
