#!/usr/bin/env bash
set -euo pipefail
mkdir -p .private
if [[ -z "${GITHUB_REPOSITORY:-}" || -z "${GH_TOKEN:-}" ]]; then
  echo "Repository or token environment is missing" >&2
  exit 1
fi

# The GitHub REST API lets this workflow restore the newest encrypted
# checkpoint from *any previous run*, including runs that later failed.
latest="$(gh api "repos/${GITHUB_REPOSITORY}/actions/artifacts?name=notifier-state&per_page=100" \
  --jq '[.artifacts[] | select(.expired == false)] | sort_by(.id) | last | if . == null then "" else "\(.id) \(.workflow_run.id)" end')"
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
else
  # If an older checkpoint expired or was deleted, never silently reset the
  # baseline and replay/delete notifications. Require an explicit human reset.
  if [[ "${GITHUB_RUN_NUMBER:-1}" != "1" && "${RESET_NOTIFY_STATE:-false}" != "true" ]]; then
    echo "No saved checkpoint found. Use workflow_dispatch with reset_state=true to start a fresh silent baseline." >&2
    exit 1
  fi
  echo "First run or explicitly reset state: starting a fresh baseline"
fi
