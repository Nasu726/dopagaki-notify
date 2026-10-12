import intervals from '../config/intervals.json' with { type: 'json' };
import targets from '../config/targets.json' with { type: 'json' };
import type { Monitor } from './types.ts';

// Only interval minutes belong in config/intervals.json. Keep monitor definitions here.
// Public target selection lives in config/targets.json. Add a stable monitor
// id and an interval in config/intervals.json when adding another source target.
// Keep arXiv and YouTube disabled until the owner selects actual targets.
export function arxivCategoryQuery(categories: readonly string[]): string {
  if (!categories.length || categories.length > 12 ||
      categories.some((category) => !/^[a-z][a-zA-Z0-9.-]{0,31}$/.test(category))) {
    throw new Error('Invalid arXiv categories: use e.g. cs.AI, cs.LG, math.CO');
  }
  return categories.map((category) => 'cat:' + category).join(' OR ');
}

const definitions: readonly Omit<Monitor, 'intervalMinutes'>[] = [
  { id: 'qiita-rust', source: 'qiita', query: 'tag:Rust', enabled: true },
  { id: 'wikipedia-ja', source: 'wikipedia', query: 'ja', enabled: true },
  ...targets.arxiv.map((target) => ({
    id: target.id, source: 'arxiv' as const,
    query: arxivCategoryQuery(target.categories), enabled: false,
  })),
  { id: 'zenn-topic-typescript', source: 'zenn', query: 'topic:typescript', enabled: false },
  ...targets.youtube.map((target) => ({
    id: target.id, source: 'youtube' as const,
    query: target.channel.trim(), enabled: false,
  })),
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
    if (monitor.enabled && !monitor.query.trim())
      throw new Error('Enabled monitor ' + monitor.id + ' requires a configured query/target');
    ids.add(monitor.id);
  }
}
