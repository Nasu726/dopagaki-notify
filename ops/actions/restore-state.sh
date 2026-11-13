#!/usr/bin/env bash
set -euo pipefail
mkdir -p .private
if [[ -z "${GITHUB_REPOSITORY:-}" || -z "${GH_TOKEN:-}" ]]; then
  echo "Repository or token environment is missing" >&2
  exit 1
fi
plan="$(dirname "$0")/checkpoint-plan.mjs"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

# The GitHub REST API lets this workflow restore the newest encrypted
# checkpoint from *any previous run*, including runs that later failed.
gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts?name=notifier-state&per_page=100" > "${work}/artifacts.json"
latest="$(node "${plan}" latest "${work}/artifacts.json")"
if [[ -n "${latest}" ]]; then
  read -r artifact_id run_id <<< "${latest}"
  echo "previous_id=${artifact_id}" >> "${GITHUB_OUTPUT}"
  if [[ "${RESET_NOTIFY_STATE:-false}" == "true" ]]; then
    echo "Explicit manual reset: ignoring prior encrypted state"
  else
    gh run download "${run_id}" --repo "${GITHUB_REPOSITORY}" --name notifier-state --dir .private
    test -s .private/notify-state.enc || { echo "Checkpoint file missing" >&2; exit 1; }
    echo "Encrypted checkpoint restored"
  fi
elif [[ "${RESET_NOTIFY_STATE:-false}" == "true" || "${GITHUB_RUN_NUMBER:-1}" == "1" ]]; then
  echo "First run or explicitly reset state: starting a fresh baseline"
else
  # If an older checkpoint expired or was deleted, never silently reset the
  # baseline and replay/delete notifications. Require an explicit human reset.
  # Exception: when every earlier run failed before saving its first
  # checkpoint (e.g. a Secret was missing on run #1), there is no state to
  # lose, so this is still the first baseline rather than a reset.
  gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" > "${work}/run.json"
  workflow_id="$(node "${plan}" workflow-id "${work}/run.json")"
  gh api "repos/${GITHUB_REPOSITORY}/actions/workflows/${workflow_id}/runs?status=success&per_page=1" \
    > "${work}/successful-runs.json"
  evidence="$(node "${plan}" history "${work}/artifacts.json" "${work}/successful-runs.json")"
  if [[ "${evidence}" == "none" ]]; then
    echo "No earlier run ever saved a checkpoint: starting the first fresh baseline"
  else
    echo "No saved checkpoint found. Use workflow_dispatch with reset_state=true to start a fresh silent baseline." >&2
    exit 1
  fi
fi
