// Restore decisions for ops/actions/restore-state.sh. Kept as dependency-free
// Node (no TypeScript, no network) so the shell script stays a thin wrapper
// around `gh api` and these rules are unit tested.
//
// Usage (each reads raw GitHub REST JSON saved by restore-state.sh):
//   node checkpoint-plan.mjs latest <artifacts.json>
//   node checkpoint-plan.mjs workflow-id <run.json>
//   node checkpoint-plan.mjs history <artifacts.json> <successful-runs.json>
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CHECKPOINT_ARTIFACT = 'notifier-state';

function checkpointArtifacts(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.artifacts))
    throw new Error('Unexpected artifact list response');
  return payload.artifacts.filter((artifact) => artifact && artifact.name === CHECKPOINT_ARTIFACT);
}

/** Newest unexpired checkpoint as { artifactId, runId }, or null. */
export function latestLiveCheckpoint(payload) {
  let newest = null;
  for (const artifact of checkpointArtifacts(payload)) {
    const artifactId = artifact.id;
    const runId = artifact.workflow_run?.id;
    if (artifact.expired !== false || !Number.isSafeInteger(artifactId) || !Number.isSafeInteger(runId))
      continue;
    if (newest === null || artifactId > newest.artifactId) newest = { artifactId, runId };
  }
  return newest;
}

export function workflowIdOf(runPayload) {
  const id = runPayload?.workflow_id;
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Unexpected workflow run response');
  return id;
}

/**
 * Called only when no unexpired checkpoint exists. Returns true if anything
 * shows that this repository saved notification state before: a live or
 * expired checkpoint artifact record, or any successful run of this workflow
 * (a successful run always uploaded a checkpoint). Lost or expired state must
 * never be replaced silently; only a repository with no such evidence (every
 * earlier run failed before its first checkpoint) may start a first baseline.
 */
export function hasCheckpointHistory(artifactsPayload, successfulRunsPayload) {
  if (checkpointArtifacts(artifactsPayload).length > 0) return true;
  const listed = artifactsPayload.total_count;
  if (listed !== undefined && (!Number.isSafeInteger(listed) || listed !== 0)) return true;
  const successes = successfulRunsPayload?.total_count;
  if (!Number.isSafeInteger(successes) || successes < 0)
    throw new Error('Unexpected workflow run list response');
  return successes > 0;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function invokedDirectly() {
  try {
    return !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const [command, first, second] = process.argv.slice(2);
  if (command === 'latest' && first && !second) {
    const latest = latestLiveCheckpoint(readJson(first));
    process.stdout.write(latest ? latest.artifactId + ' ' + latest.runId + '\n' : '\n');
  } else if (command === 'workflow-id' && first && !second) {
    process.stdout.write(workflowIdOf(readJson(first)) + '\n');
  } else if (command === 'history' && first && second) {
    process.stdout.write(hasCheckpointHistory(readJson(first), readJson(second)) ? 'found\n' : 'none\n');
  } else {
    console.error('Usage: checkpoint-plan.mjs latest|workflow-id|history <json files>');
    process.exit(2);
  }
}
