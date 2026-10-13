import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflowDir = resolve(root, '.github/workflows');
const workflowPath = resolve(workflowDir, 'notifier.yml');
const privateDir = resolve(root, '.private');
const privatePath = resolve(privateDir, 'monitor-config.json');
mkdirSync(workflowDir, { recursive: true });
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
if (!existsSync(workflowPath)) {
  copyFileSync(resolve(root, 'templates/github-actions/notifier.yml'), workflowPath);
  console.log('Created .github/workflows/notifier.yml (commit only after adding GitHub Secrets).');
} else {
  console.log('Existing .github/workflows/notifier.yml preserved.');
}
if (!existsSync(privatePath)) {
  const targets = JSON.parse(readFileSync(resolve(root, 'config/targets.json'), 'utf8'));
  const intervals = JSON.parse(readFileSync(resolve(root, 'config/intervals.json'), 'utf8'));
  writeFileSync(privatePath,
    JSON.stringify({ targets, intervals, wikipediaEnabled: true }, null, 2) + '\n',
    { mode: 0o600 });
  console.log('Created .private/monitor-config.json (gitignored). Edit before publishing workflow.');
} else {
  console.log('Existing .private/monitor-config.json preserved.');
}
console.log('Next: set NOTIFY_STATE_KEY, MONITOR_CONFIG_JSON and Discord Webhook GitHub Secrets.');
console.log('Then commit the workflow file and run it once with workflow_dispatch.');
