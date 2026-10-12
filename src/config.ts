import intervals from '../config/intervals.json' with { type: 'json' };
import type { Monitor } from './types.ts';

// Only interval minutes belong in config/intervals.json. Keep monitor definitions here.
// Staging smoke test: only Qiita is enabled after D1 migrations and Secrets setup.
// Other sources remain disabled until their live behavior is verified.
const definitions: readonly Omit<Monitor, 'intervalMinutes'>[] = [
  { id: 'qiita-rust', source: 'qiita', query: 'tag:Rust', enabled: true },
  { id: 'wikipedia-ja', source: 'wikipedia', query: 'ja', enabled: false },
  { id: 'arxiv-cs-ai', source: 'arxiv', query: 'cat:cs.AI', enabled: false },
  { id: 'zenn-topic-typescript', source: 'zenn', query: 'topic:typescript', enabled: false },
  { id: 'youtube-example', source: 'youtube', query: '@example', enabled: false },
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
    ids.add(monitor.id);
  }
}
