import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync(new URL('../config/targets.json', import.meta.url), 'utf8'));
const { notificationWindowJst: _publicWindow, retentionDays: publicRetention,
  wikipediaEnabled: publicWikipediaEnabled, ...targets } = raw;
const intervals = JSON.parse(readFileSync(new URL('../config/intervals.json', import.meta.url), 'utf8'));
if (publicWikipediaEnabled === false) delete intervals['wikipedia-ja-discovery'];
// When the private roster omits Wikipedia, retaining its interval would
// cause runtime validation to reject the entire private configuration.
// The public targets file also contains *top-level* notification/retention
// controls. Private config keeps these siblings of targets, not within it.
process.stdout.write(JSON.stringify({
  targets, intervals, retentionDays: publicRetention ?? {},
  wikipediaEnabled: publicWikipediaEnabled !== false, notificationWindowJst: null,
}, null, 2) + '\n');
