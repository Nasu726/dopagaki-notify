import { readFileSync } from 'node:fs';
const targets = JSON.parse(readFileSync(new URL('../config/targets.json', import.meta.url), 'utf8'));
const intervals = JSON.parse(readFileSync(new URL('../config/intervals.json', import.meta.url), 'utf8'));
process.stdout.write(JSON.stringify({ targets, intervals, wikipediaEnabled: true, notificationWindowJst: null }, null, 2) + '\n');
