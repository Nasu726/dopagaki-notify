import intervals from '../config/intervals.json' with { type: 'json' };
import targets from '../config/targets.json' with { type: 'json' };
import type { Monitor } from './types.ts';
import { normalizeChannelReference } from './sources/youtube.ts';
import { zennFeedUrl } from './sources/zenn.ts';
import { isWeeklyJstDay } from './schedule.ts';

// All per-monitor intervals remain in config/intervals.json.
// Configure any number of Qiita searches, Zenn feeds, arXiv category groups,
// and YouTube channels (plus enabled flags) in config/targets.json.
// Stable monitor IDs preserve their historical D1 identities on migration.
export function arxivCategoryQuery(categories: readonly string[]): string {
  if (!categories.length || categories.length > 12 ||
      categories.some((category) => !/^[a-z][a-zA-Z0-9.-]{0,31}$/.test(category))) {
    throw new Error('Invalid arXiv categories: use e.g. cs.AI, cs.LG, math.CO');
  }
  return categories.map((category) => 'cat:' + category).join(' OR ');
}

export interface QueryTarget {
  readonly id: string;
  readonly query: string;
  readonly enabled: boolean;
}

// Each configured row maps to a separate monitor ID with an independent
// baseline, due time and outbox. Intervals live only in intervals.json.
export function queryMonitorsFromTargets(
  source: 'qiita' | 'zenn',
  configured: readonly QueryTarget[],
): readonly Omit<Monitor, 'intervalMinutes'>[] {
  return configured.map((target) => ({
    id: target.id, source, query: target.query.trim(), enabled: target.enabled,
  }));
}

export interface YouTubeTarget {
  readonly id: string;
  readonly channel: string;
  readonly enabled: boolean;
  readonly weekdayJst?: string;
}

export function youtubeMonitorsFromTargets(
  configured: readonly YouTubeTarget[],
): readonly Omit<Monitor, 'intervalMinutes'>[] {
  return configured.map((target) => ({
    id: target.id, source: 'youtube' as const,
    query: target.channel.trim(), enabled: target.enabled,
    ...(target.weekdayJst !== undefined ? { weeklyJstDay: target.weekdayJst } : {}),
  }));
}

const definitions: readonly Omit<Monitor, 'intervalMinutes'>[] = [
  ...queryMonitorsFromTargets('qiita', targets.qiita),
  { id: 'wikipedia-ja', source: 'wikipedia', query: 'ja', enabled: true },
  ...targets.arxiv.map((target) => ({
    id: target.id, source: 'arxiv' as const,
    query: arxivCategoryQuery(target.categories), enabled: target.enabled,
  })),
  ...queryMonitorsFromTargets('zenn', targets.zenn),
  ...youtubeMonitorsFromTargets(targets.youtube),
];

export function withIntervals(
  configured: readonly Omit<Monitor, 'intervalMinutes'>[],
  values: Record<string, unknown>,
): readonly Monitor[] {
  const ids = new Set(configured.map((monitor) => monitor.id));
  for (const id of Object.keys(values)) {
    if (!ids.has(id)) throw new Error('Unknown interval setting: ' + id);
  }
  return configured.map((monitor) => {
    const value = values[monitor.id];
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new Error('Monitor ' + monitor.id + ': interval must be a positive integer (minutes)');
    }
    return { ...monitor, intervalMinutes: value as number };
  });
}

export const MONITORS: readonly Monitor[] = withIntervals(definitions, intervals);

export function validateMonitors(monitors: readonly Monitor[]): void {
  const ids = new Set<string>();
  for (const monitor of monitors) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(monitor.id)) throw new Error('Invalid monitor id: ' + monitor.id);
    if (ids.has(monitor.id)) throw new Error('Duplicate monitor id: ' + monitor.id);
    if (!Number.isSafeInteger(monitor.intervalMinutes) || monitor.intervalMinutes < 1)
      throw new Error('Monitor ' + monitor.id + ': intervalMinutes must be a positive integer');
    if (monitor.query.length > 512) throw new Error('Monitor ' + monitor.id + ': query too long');
    if (typeof monitor.enabled !== 'boolean')
      throw new Error('Monitor ' + monitor.id + ': enabled must be a boolean');
    if (monitor.weeklyJstDay !== undefined &&
        (monitor.source !== 'youtube' || monitor.intervalMinutes !== 60 ||
         !isWeeklyJstDay(monitor.weeklyJstDay))) {
      throw new Error('Monitor ' + monitor.id +
        ': weeklyJstDay requires a YouTube monitor with interval 60 and a valid weekday');
    }
    if (monitor.enabled && !monitor.query.trim())
      throw new Error('Enabled monitor ' + monitor.id + ' requires a configured query/target');
    if (monitor.enabled && monitor.source === 'zenn') {
      try { zennFeedUrl(monitor.query); }
      catch { throw new Error('Enabled Zenn monitor ' + monitor.id + ': invalid user/topic feed query'); }
    }
    if (monitor.enabled && monitor.source === 'youtube') {
      try { normalizeChannelReference(monitor.query); }
      catch { throw new Error('Enabled YouTube monitor ' + monitor.id + ': invalid channel reference'); }
    }
    ids.add(monitor.id);
  }
}
