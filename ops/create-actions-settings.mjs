import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const file = '.private/actions-settings.json';
if (existsSync(file)) throw new Error('Already exists: ' + file + ' (not overwritten)');
const targets = JSON.parse(readFileSync(new URL('../config/targets.json', import.meta.url), 'utf8'));
const intervals = JSON.parse(readFileSync(new URL('../config/intervals.json', import.meta.url), 'utf8'));
const webhooks = { qiita: '', zenn: '', arxiv: '', youtube: '', wikipedia: '' };
const value = { targets, intervals, wikipediaEnabled: true,
  webhooks, stateKey: randomBytes(32).toString('base64') };
mkdirSync('.private', { recursive: true });
writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
console.log('Created ignored ' + file + '. Edit it locally; do not commit or print its contents.');
