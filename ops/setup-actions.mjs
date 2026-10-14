import { existsSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const flags = process.argv.slice(2);
const selected = flags.length === 0 ? 'private' :
  flags.length === 1 && ['--config-mode=private','--config-mode=public'].includes(flags[0])
    ? flags[0].slice('--config-mode='.length) : null;
if (selected === null) {
  console.error('Usage: npm run setup:actions -- [--config-mode=private|public]');
  process.exit(1);
}
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
if (selected === 'private' && !existsSync(privatePath)) {
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
} else if (selected === 'private') {
  console.log('Existing .private/monitor-config.json preserved.');
}
if (!existsSync(keyPath)) {
  writeFileSync(keyPath, randomBytes(32).toString('hex') + '\n', { mode: 0o600 });
  console.log('Created ignored .private/notify-state-key.txt (never commit or rotate).');
} else {
  console.log('Existing .private/notify-state-key.txt preserved.');
}
console.log('Selected GitHub Actions config mode: ' + selected);
if (selected === 'public') {
  console.log('Edit the public config/targets.json and config/intervals.json FIRST.');
  console.log('Next: gh variable set MONITOR_CONFIG_MODE --body public');
  console.log('      remove any prior MONITOR_CONFIG_JSON Secret (public mode refuses a conflicting private Secret).');
} else {
  console.log('Next: gh variable set MONITOR_CONFIG_MODE --body private');
  console.log('      gh secret set MONITOR_CONFIG_JSON < .private/monitor-config.json');
}
console.log('      gh secret set NOTIFY_STATE_KEY < .private/notify-state-key.txt');
console.log('      plus selected Discord Webhook GitHub Secrets.');
console.log('Then commit the workflow file and run it once with workflow_dispatch.');
console.log('Existing workflow copies are preserved: sync the newer template manually if upgrading.');
