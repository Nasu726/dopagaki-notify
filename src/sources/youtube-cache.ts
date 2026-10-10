import type { Database } from '../types.ts';
import type { ChannelIdCache } from './youtube.ts';

// Refresh channel references weekly in case a handle has changed ownership.
// Cache keys are validated/canonicalized by normalizeChannelReference().
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export function d1ChannelCache(db: Database, now = Date.now()): ChannelIdCache {
  return {
    async get(reference) {
      const cached = await db.prepare(
        'SELECT channel_id FROM youtube_channel_cache WHERE reference = ? AND resolved_at > ?'
      ).bind(reference, now - CACHE_TTL_MS).first<{ channel_id: string }>();
      return cached?.channel_id ?? null;
    },
    async set(reference, channelId) {
      await db.prepare(
        'INSERT INTO youtube_channel_cache (reference, channel_id, resolved_at) VALUES (?,?,?) ' +
        'ON CONFLICT(reference) DO UPDATE SET channel_id=excluded.channel_id, resolved_at=excluded.resolved_at'
      ).bind(reference, channelId, now).run();
    },
  };
}
