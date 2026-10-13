#!/usr/bin/env bash
set -euo pipefail
if [[ -z "${PREVIOUS_ARTIFACT_ID:-}" ]]; then exit 0; fi
# Only called after the replacement artifact was uploaded successfully.
gh api --method DELETE "repos/${GITHUB_REPOSITORY}/actions/artifacts/${PREVIOUS_ARTIFACT_ID}"
echo "Previous encrypted state artifact removed"
