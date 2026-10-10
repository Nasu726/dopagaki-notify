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
  const markers = [
    /<meta[^>]*itemprop=["']channelId["'][^>]*content=["'](UC[A-Za-z0-9_-]{22})["']/i,
    /"channelId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/,
    /"externalId"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/,
    /\/channel\/(UC[A-Za-z0-9_-]{22})/,
  ];
  for (const marker of markers) {
    const match = marker.exec(html);
    if (match?.[1]) return match[1];
  }
  throw new Error('Could not resolve YouTube @handle; configure channel UC... ID instead');
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
export async function fetchYouTube(
  monitor: Monitor, fetcher: typeof fetch = fetch,
): Promise<{ items: ContentItem[]; potentiallyTruncated: boolean }> {
  const reference = normalizeChannelReference(monitor.query);
  const channelId = CHANNEL_ID.test(reference) ? reference
    : extractChannelId(await fetchTextBounded(new URL('https://www.youtube.com/' + reference), 'YouTube channel', fetcher, 2 * 1024 * 1024));
  const url = new URL('https://www.youtube.com/feeds/videos.xml');
  url.searchParams.set('channel_id', channelId);
  const items = parseYouTube(await fetchTextBounded(url, 'YouTube RSS', fetcher));
  // A YouTube channel feed exposes only a bounded number of recent videos.
  return { items, potentiallyTruncated: items.length >= 15 };
}
