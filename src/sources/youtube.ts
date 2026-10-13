import type { ContentItem, Monitor } from '../types.ts';
import { entries, fetchTextBounded, parseDate, requiredText, tagText } from './xml.ts';

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/** The feed-level yt:channelId may omit the 'UC' prefix, whereas
 * entry-level identifiers generally carry the full UC... channel ID.
 * Compare only an exact full ID or its exact 22-character suffix.
 */
function sameYouTubeChannelId(observed: string, expected: string): boolean {
  return observed === expected || (CHANNEL_ID.test(expected) && observed === expected.slice(2));
}
export function normalizeChannelReference(raw: string): string {
  const value = raw.trim();
  if (CHANNEL_ID.test(value)) return value;
  if (/^@[A-Za-z0-9._-]{2,80}$/.test(value)) return value.toLowerCase();
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Expected YouTube channel ID, @handle or URL'); }
  if (url.protocol !== 'https:' || !['youtube.com', 'www.youtube.com'].includes(url.hostname))
    throw new Error('Invalid YouTube host');
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'channel' && CHANNEL_ID.test(segments[1] ?? '')) return segments[1]!;
  if (/^@[A-Za-z0-9._-]{2,80}$/.test(segments[0] ?? '')) return segments[0]!.toLowerCase();
  throw new Error('Expected YouTube /channel/UC... or /@handle URL');
}
export function extractChannelId(html: string): string {
  // Only page-OWNER metadata is authoritative. A YouTube channel homepage
  // also contains sister/recommended channel links and arbitrary "channelId"
  // fields. The old broad regex could cache a related channel's ID.
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\bitemprop\s*=\s*["']channelId["']/i.test(tag)) continue;
    const id = /\bcontent\s*=\s*["'](UC[A-Za-z0-9_-]{22})["']/i.exec(tag)?.[1];
    if (id) return id;
  }
  throw new Error('Could not identify YouTube channel owner from metadata; configure pinned channelId');
}
export function parseYouTube(xml: string, expectedChannelId?: string): ContentItem[] {
  return entries(xml, 'entry').map((entry) => {
    const entryChannelId = tagText(entry, 'yt:channelId');
    if (expectedChannelId && entryChannelId && !sameYouTubeChannelId(entryChannelId, expectedChannelId))
      throw new Error('YouTube RSS entry channel mismatch: expected=' + expectedChannelId +
        ', received=' + entryChannelId);
    const raw = tagText(entry, 'yt:videoId') || requiredText(entry, 'id').split(':').at(-1)!;
    if (!VIDEO_ID.test(raw)) throw new Error('Invalid YouTube video ID');
    return {
      id: 'youtube:' + raw,
      title: requiredText(entry, 'title'),
      url: 'https://www.youtube.com/watch?v=' + raw,
      publishedAt: parseDate(requiredText(entry, 'published')),
    };
  });
}
export interface ChannelIdCache {
  get(reference: string): Promise<string | null>;
  set(reference: string, channelId: string): Promise<void>;
}
export async function fetchYouTube(
  monitor: Monitor, fetcher: typeof fetch = fetch, cache?: ChannelIdCache,
): Promise<{ items: ContentItem[]; potentiallyTruncated: boolean }> {
  const reference = normalizeChannelReference(monitor.query);
  // A pinned ID bypasses page scraping and any stale/wrong cached ID.
  let channelId = monitor.youtubeChannelId ?? reference;
  if (!CHANNEL_ID.test(channelId)) {
    const cached = await cache?.get(reference);
    if (cached && CHANNEL_ID.test(cached)) {
      channelId = cached;
    } else {
      channelId = extractChannelId(await fetchTextBounded(
        new URL('https://www.youtube.com/' + reference), 'YouTube channel', fetcher, 2 * 1024 * 1024,
      ));
      await cache?.set(reference, channelId);
    }
  }
  const videosOnly = monitor.youtubeVideoType === 'videos';
  // YouTube's undocumented UULF virtual playlist contains ordinary videos
  // (no Shorts/live). This is a feed selection, not a hashtag/duration guess.
  // Never fall back to the all-uploads feed if UULF is unavailable.
  if (videosOnly && !monitor.youtubeChannelId)
    throw new Error('YouTube videos-only feed requires a pinned channel ID');
  const playlistId = 'UULF' + channelId.slice(2);
  const url = new URL('https://www.youtube.com/feeds/videos.xml');
  if (videosOnly) url.searchParams.set('playlist_id', playlistId);
  else url.searchParams.set('channel_id', channelId);
  const xml = await fetchTextBounded(url, 'YouTube RSS', fetcher);
  // Only the feed-level identity is authoritative. An entry may itself
  // contain metadata mentioning another channel; never treat that as the
  // identity of the RSS document. Channel IDs are public, safe diagnostics.
  const entryStart = /<entry(?:\s|>)/i.exec(xml)?.index ?? xml.length;
  const header = xml.slice(0, entryStart);
  const feedChannelId = tagText(header, 'yt:channelId');
  // A videos-only response must identify the exact UULF virtual playlist,
  // otherwise a substituted all-uploads feed could reintroduce Shorts.
  if (videosOnly) {
    const feedPlaylistId = tagText(header, 'yt:playlistId');
    const rootId = tagText(header, 'id');
    const rootPlaylistId = rootId?.startsWith('yt:playlist:') ? rootId.slice('yt:playlist:'.length) : null;
    if ((feedPlaylistId && feedPlaylistId !== playlistId) ||
        (rootPlaylistId && rootPlaylistId !== playlistId) ||
        (!feedPlaylistId && !rootPlaylistId))
      throw new Error('YouTube videos-only playlist identity mismatch for ' + monitor.id);
  }
  if (feedChannelId && !sameYouTubeChannelId(feedChannelId, channelId))
    throw new Error('YouTube RSS channel mismatch for ' + monitor.id +
      ': expected=' + channelId + ', received=' + feedChannelId);
  // A pinned subscription must not silently accept a response without any
  // channel-identity marker. Standard YouTube RSS includes yt:channelId.
  if (monitor.youtubeChannelId && !feedChannelId && !videosOnly)
    throw new Error('YouTube RSS channel identity missing for ' + monitor.id +
      ': expected=' + channelId + ', received=missing');
  // For UULF, feed-level channel metadata can be absent, but the playlist
  // marker already binds the response to the immutable requested channel.
  // If a channel marker exists, always verify it independently.
  // Entries may contain a full channel ID even when the feed header is
  // prefixless. A contradictory entry must fail closed before any staging.
  const items = parseYouTube(xml, channelId);
  // A YouTube channel feed exposes only a bounded number of recent videos.
  return { items, potentiallyTruncated: items.length >= 15 };
}
