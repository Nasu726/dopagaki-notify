import { existsSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflowDir = resolve(root, '.github/workflows');
const workflowPath = resolve(workflowDir, 'notifier.yml');
const privateDir = resolve(root, '.private');
const privatePath = resolve(privateDir, 'monitor-config.json');
const keyPath = resolve(privateDir, 'notify-state-key.txt');
mkdirSync(workflowDir, { recursive: true });
mkdirSync(privateDir, { recursive: true, mode: 0o700 });
if (!existsSync(workflowPath)) {
  copyFileSync(resolve(root, 'templates/github-actions/notifier.yml'), workflowPath);
  console.log('Created .github/workflows/notifier.yml (commit only after adding GitHub Secrets).');
} else {
  console.log('Existing .github/workflows/notifier.yml preserved.');
}
if (!existsSync(privatePath)) {
  // Do not silently copy the original author's enabled topics/channels.
  const targets = {
    qiita: [{ id: 'qiita-example', query: 'tag:Python', enabled: true }],
    zenn: [], arxiv: [], openalex: [], youtube: [],
  };
  const intervals = { 'qiita-example': 240 };
  writeFileSync(privatePath,
    JSON.stringify({ targets, intervals, wikipediaEnabled: false, notificationWindowJst: null }, null, 2) + '\n',
    { mode: 0o600 });
  console.log('Created .private/monitor-config.json (gitignored). Edit before publishing workflow.');
} else {
  console.log('Existing .private/monitor-config.json preserved.');
}
if (!existsSync(keyPath)) {
  writeFileSync(keyPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  console.log('Created ignored .private/notify-state-key.txt (never commit or rotate).');
} else {
  console.log('Existing .private/notify-state-key.txt preserved.');
}
console.log('Next: gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json');
console.log('      gh secret set NOTIFY_STATE_KEY < .private/notify-state-key.txt');
console.log('      plus Discord Webhook GitHub Secrets.');
console.log('Then commit the workflow file and run it once with workflow_dispatch.');
