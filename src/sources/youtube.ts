import type { ContentItem, Monitor } from '../types.ts';
import { entries, fetchTextBounded, parseDate, requiredText, tagText } from './xml.ts';

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
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
export function parseYouTube(xml: string): ContentItem[] {
  return entries(xml, 'entry').map((entry) => {
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
  const url = new URL('https://www.youtube.com/feeds/videos.xml');
  url.searchParams.set('channel_id', channelId);
  const xml = await fetchTextBounded(url, 'YouTube RSS', fetcher);
  const feedChannelId = tagText(xml, 'yt:channelId');
  if (feedChannelId && feedChannelId !== channelId)
    throw new Error('YouTube RSS channel ID differs from requested channel');
  // A pinned subscription must not silently accept a response without any
  // channel-identity marker. Standard YouTube RSS includes yt:channelId.
  if (monitor.youtubeChannelId && feedChannelId !== channelId)
    throw new Error('YouTube RSS has no verified channel ID for pinned monitor');
  const items = parseYouTube(xml);
  // A YouTube channel feed exposes only a bounded number of recent videos.
  return { items, potentiallyTruncated: items.length >= 15 };
}
