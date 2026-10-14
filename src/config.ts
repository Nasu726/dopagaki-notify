import intervals from '../config/intervals.json' with { type: 'json' };
import targets from '../config/targets.json' with { type: 'json' };
import type { Monitor } from './types.ts';
import { normalizeChannelReference } from './sources/youtube.ts';
import { zennFeedUrl } from './sources/zenn.ts';
import { openAlexQuery } from './sources/openalex.ts';
import { isWeeklyJstDay, parseNotificationWindowJst } from './schedule.ts';
import type { NotificationWindowJst } from './schedule.ts';

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
  readonly channelId?: string;
  readonly videoType?: 'all' | 'videos';
}

export function youtubeMonitorsFromTargets(
  configured: readonly YouTubeTarget[],
): readonly Omit<Monitor, 'intervalMinutes'>[] {
  return configured.map((target) => ({
    id: target.id, source: 'youtube' as const,
    query: target.channel.trim(), enabled: target.enabled,
    ...(target.weekdayJst !== undefined ? { weeklyJstDay: target.weekdayJst } : {}),
    ...(target.channelId !== undefined ? { youtubeChannelId: target.channelId } : {}),
    ...(target.videoType !== undefined ? { youtubeVideoType: target.videoType } : {}),
  }));
}

const definitions: readonly Omit<Monitor, 'intervalMinutes'>[] = [
  ...queryMonitorsFromTargets('qiita', targets.qiita),
  { id: 'wikipedia-ja-discovery', source: 'wikipedia', query: 'ja:discover', enabled: true },
  ...targets.arxiv.map((target) => ({
    id: target.id, source: 'arxiv' as const,
    query: arxivCategoryQuery(target.categories), enabled: target.enabled,
  })),
  ...(targets.openalex as readonly QueryTarget[]).map((target) => ({
    id: target.id, source: 'openalex' as const,
    query: target.query.trim(), enabled: target.enabled,
  })),
  ...queryMonitorsFromTargets('zenn', targets.zenn),
  // JSON imports widen string literals; validateMonitors checks the actual
  // values at runtime (also used by config:check before deployment).
  ...youtubeMonitorsFromTargets(targets.youtube as unknown as readonly YouTubeTarget[]),
];

export function withIntervals(
  configured: readonly Omit<Monitor, 'intervalMinutes'>[],
  values: Record<string, unknown>,
  retentionDays: Record<string, unknown> = {},
): readonly Monitor[] {
  const ids = new Set(configured.map((monitor) => monitor.id));
  for (const id of Object.keys(values)) {
    if (!ids.has(id)) throw new Error('Unknown interval setting: ' + id);
  }
  for (const [id, value] of Object.entries(retentionDays)) {
    if (!ids.has(id)) throw new Error('Unknown retention setting: ' + id);
    if (value !== null && (!Number.isSafeInteger(value) || (value as number) < 1 ||
        (value as number) > 36500))
      throw new Error('Monitor ' + id + ': retentionDays must be a positive integer up to 36500 or null');
  }
  return configured.map((monitor) => {
    const value = values[monitor.id];
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new Error('Monitor ' + monitor.id + ': interval must be a positive integer (minutes)');
    }
    return { ...monitor, intervalMinutes: value as number,
      ...(Object.hasOwn(retentionDays, monitor.id)
        ? { retentionDays: retentionDays[monitor.id] as number | null } : {}) };
  });
}

export const MONITORS: readonly Monitor[] = withIntervals(definitions, intervals,
  (targets as unknown as { retentionDays?: Record<string, unknown> }).retentionDays ?? {});


/**
 * A complete runtime override for public forks that keep their chosen
 * subjects private. The Secret uses the same target and interval shapes as
 * the checked-in JSON files; it never merges with public monitor targets.
 * A malformed override fails closed rather than silently activating defaults.
 */
function objectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


/** Override order: deployment Secret > private monitor JSON > public sample JSON.
 * Absence or null means unrestricted notifications, including at night.
 * The deployment Secret lets a public fork or the maintainer customize this
 * without committing personal preferences or replacing all monitor targets.
 */
export function resolveNotificationWindowJst(
  privateConfigJson: string | undefined, secret: string | undefined,
): NotificationWindowJst | null {
  if (secret !== undefined) return parseNotificationWindowJst(secret);
  if (privateConfigJson !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(privateConfigJson); }
    catch { throw new Error('MONITOR_CONFIG_JSON contains invalid JSON'); }
    if (!objectRecord(parsed)) throw new Error('MONITOR_CONFIG_JSON must be an object');
    try { return parseNotificationWindowJst(parsed.notificationWindowJst); }
    catch { throw new Error('MONITOR_CONFIG_JSON has an invalid notificationWindowJst'); }
  }
  return parseNotificationWindowJst(targets.notificationWindowJst);
}

export function loadRuntimeMonitors(json: string | undefined): readonly Monitor[] {
  if (json === undefined) return MONITORS;
  if (json.length === 0 || json.length > 65_536)
    throw new Error('MONITOR_CONFIG_JSON must contain a nonempty configuration (max 64 KiB)');
  let raw: unknown;
  try { raw = JSON.parse(json); }
  catch { throw new Error('MONITOR_CONFIG_JSON contains invalid JSON'); }
  if (!objectRecord(raw) || !objectRecord(raw.targets) || !objectRecord(raw.intervals) ||
      (raw.retentionDays !== undefined && !objectRecord(raw.retentionDays))) {
    throw new Error('MONITOR_CONFIG_JSON requires targets and intervals objects');
  }
  if (raw.wikipediaEnabled !== undefined && typeof raw.wikipediaEnabled !== 'boolean') {
    throw new Error('MONITOR_CONFIG_JSON wikipediaEnabled must be boolean');
  }
  const targetConfig = raw.targets;
  const allowed = ['qiita', 'zenn', 'arxiv', 'youtube', 'openalex'];
  if (Object.keys(targetConfig).some((key) => !allowed.includes(key)))
    throw new Error('MONITOR_CONFIG_JSON targets contains an unknown source');
  const targetsBySource: Record<string, Record<string, unknown>[]> = {};
  for (const source of allowed) {
    // Older private Secrets remain valid when a new optional provider is added.
    const entries: unknown = source === 'openalex' && targetConfig[source] === undefined
      ? [] : targetConfig[source];
    if (!Array.isArray(entries) || entries.length > 100 || !entries.every(objectRecord)) {
      throw new Error('MONITOR_CONFIG_JSON targets.' + source + ' must be an array of objects (max 100)');
    }
    targetsBySource[source] = entries;
    for (const target of entries) {
      if (typeof target.id !== 'string' || typeof target.enabled !== 'boolean') {
        throw new Error('MONITOR_CONFIG_JSON targets require string id and boolean enabled');
      }
      if ((source === 'qiita' || source === 'zenn' || source === 'openalex') && typeof target.query !== 'string') {
        throw new Error('MONITOR_CONFIG_JSON query targets require string query');
      }
      if (source === 'youtube' && (
        typeof target.channel !== 'string' ||
        (target.weekdayJst !== undefined && typeof target.weekdayJst !== 'string') ||
        (target.channelId !== undefined && typeof target.channelId !== 'string') ||
        (target.videoType !== undefined && !['all', 'videos'].includes(target.videoType as string))
      )) {
        throw new Error('MONITOR_CONFIG_JSON YouTube targets require channel and optional weekdayJst');
      }
      if (source === 'arxiv' && (!Array.isArray(target.categories) ||
        !target.categories.every((v: unknown) => typeof v === 'string'))) {
        throw new Error('MONITOR_CONFIG_JSON arXiv targets require string categories array');
      }
    }
  }
  // Do not echo names/queries from a private Secret into exception logs.
  try {
    const definitions: Omit<Monitor, 'intervalMinutes'>[] = [
      ...queryMonitorsFromTargets('qiita', targetsBySource.qiita as unknown as QueryTarget[]),
      ...(raw.wikipediaEnabled === false ? [] : [{
        id: 'wikipedia-ja-discovery', source: 'wikipedia' as const,
        query: 'ja:discover', enabled: true,
      }]),
      ...(targetsBySource.arxiv ?? []).map((target) => ({
        id: target.id as string, source: 'arxiv' as const,
        query: arxivCategoryQuery(target.categories as string[]),
        enabled: target.enabled as boolean,
      })),
      ...(targetsBySource.openalex ?? []).map((target) => ({
        id: target.id as string, source: 'openalex' as const,
        query: (target.query as string).trim(), enabled: target.enabled as boolean,
      })),
      ...queryMonitorsFromTargets('zenn', targetsBySource.zenn as unknown as QueryTarget[]),
      ...youtubeMonitorsFromTargets(targetsBySource.youtube as unknown as YouTubeTarget[]),
    ];
    const result = withIntervals(definitions, raw.intervals, raw.retentionDays as Record<string, unknown> | undefined);
    validateMonitors(result);
    return result;
  } catch {
    throw new Error('MONITOR_CONFIG_JSON has invalid target values or intervals');
  }
}

export function validateMonitors(monitors: readonly Monitor[]): void {
  const ids = new Set<string>();
  for (const monitor of monitors) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(monitor.id)) throw new Error('Invalid monitor id: ' + monitor.id);
    if (ids.has(monitor.id)) throw new Error('Duplicate monitor id: ' + monitor.id);
    if (!Number.isSafeInteger(monitor.intervalMinutes) || monitor.intervalMinutes < 1)
      throw new Error('Monitor ' + monitor.id + ': intervalMinutes must be a positive integer');
    if (monitor.retentionDays !== undefined && monitor.retentionDays !== null &&
        (!Number.isSafeInteger(monitor.retentionDays) || monitor.retentionDays < 1 || monitor.retentionDays > 36500))
      throw new Error('Monitor ' + monitor.id + ': retentionDays must be 1..36500 or null');
    if (monitor.query.length > 512) throw new Error('Monitor ' + monitor.id + ': query too long');
    if (typeof monitor.enabled !== 'boolean')
      throw new Error('Monitor ' + monitor.id + ': enabled must be a boolean');
    if (monitor.weeklyJstDay !== undefined &&
        (monitor.source !== 'youtube' || !isWeeklyJstDay(monitor.weeklyJstDay))) {
      throw new Error('Monitor ' + monitor.id +
        ': weeklyJstDay requires a YouTube monitor and a valid weekday');
    }
    if (monitor.enabled && !monitor.query.trim())
      throw new Error('Enabled monitor ' + monitor.id + ' requires a configured query/target');
    if (monitor.enabled && monitor.source === 'wikipedia' && !/^[a-z]{2,12}(?:-[a-z]{2,12})?(?::discover)?$/.test(monitor.query))
      throw new Error('Wikipedia monitor requires a language code, optionally :discover');
    if (monitor.enabled && monitor.source === 'openalex') {
      try { openAlexQuery(monitor.query); }
      catch { throw new Error('Enabled OpenAlex monitor ' + monitor.id + ': invalid query'); }
    }
    if (monitor.enabled && monitor.source === 'zenn') {
      try { zennFeedUrl(monitor.query); }
      catch { throw new Error('Enabled Zenn monitor ' + monitor.id + ': invalid user/topic feed query'); }
    }
    if (monitor.youtubeVideoType !== undefined &&
        (monitor.source !== 'youtube' || !['all', 'videos'].includes(monitor.youtubeVideoType)))
      throw new Error('Invalid YouTube videoType for monitor ' + monitor.id);
    // The videos-only feed is derived from an immutable UC ID, never a
    // potentially poisoned @handle cache or scraped channel-page result.
    if (monitor.youtubeVideoType === 'videos' && !monitor.youtubeChannelId)
      throw new Error('YouTube videos-only monitor ' + monitor.id + ' requires pinned channelId');
    if (monitor.youtubeChannelId !== undefined) {
      if (monitor.source !== 'youtube' || !/^UC[A-Za-z0-9_-]{22}$/.test(monitor.youtubeChannelId))
        throw new Error('Invalid pinned YouTube channel ID for monitor ' + monitor.id);
      const normalized = normalizeChannelReference(monitor.query);
      if (normalized.startsWith('UC') && normalized !== monitor.youtubeChannelId)
        throw new Error('Pinned YouTube channel ID does not match query for monitor ' + monitor.id);
    }
    if (monitor.enabled && monitor.source === 'youtube') {
      try { normalizeChannelReference(monitor.query); }
      catch { throw new Error('Enabled YouTube monitor ' + monitor.id + ': invalid channel reference'); }
    }
    ids.add(monitor.id);
  }
}
