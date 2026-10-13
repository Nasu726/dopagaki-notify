import intervals from '../config/intervals.json' with { type: 'json' };
import targets from '../config/targets.json' with { type: 'json' };
import type { Monitor } from './types.ts';
import { normalizeChannelReference } from './sources/youtube.ts';
import { isWeeklyJstDay } from './schedule.ts';

// All per-monitor intervals remain in config/intervals.json.
// Configure arXiv category groups and any number of YouTube channels, including
// their enabled flags, in config/targets.json; no TypeScript edits are needed.
// The owner must intentionally select real targets before enabling them.
export function arxivCategoryQuery(categories: readonly string[]): string {
  if (!categories.length || categories.length > 12 ||
      categories.some((category) => !/^[a-z][a-zA-Z0-9.-]{0,31}$/.test(category))) {
    throw new Error('Invalid arXiv categories: use e.g. cs.AI, cs.LG, math.CO');
  }
  return categories.map((category) => 'cat:' + category).join(' OR ');
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
  { id: 'qiita-rust', source: 'qiita', query: 'tag:Rust', enabled: true },
  { id: 'wikipedia-ja', source: 'wikipedia', query: 'ja', enabled: true },
  ...targets.arxiv.map((target) => ({
    id: target.id, source: 'arxiv' as const,
    query: arxivCategoryQuery(target.categories), enabled: target.enabled,
  })),
  { id: 'zenn-topic-typescript', source: 'zenn', query: 'topic:typescript', enabled: true },
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
    if (monitor.enabled && monitor.source === 'youtube') {
      try { normalizeChannelReference(monitor.query); }
      catch { throw new Error('Enabled YouTube monitor ' + monitor.id + ': invalid channel reference'); }
    }
    ids.add(monitor.id);
  }
}
