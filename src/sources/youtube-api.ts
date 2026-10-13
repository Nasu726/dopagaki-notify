import { requireSuccess } from '../http.ts';
import type { ContentItem, Monitor } from '../types.ts';
import { normalizeChannelReference } from './youtube.ts';

const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const PER_PAGE = 50;

function requireRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid YouTube Data API response');
  return value as Record<string, unknown>;
}

/** Official Data API alternative to unreliable RSS. API key is optional.
 * channels.list resolves @handles and the uploads playlist, then
 * playlistItems.list reads the newest page (at most 50 videos).
 * Does not use search.list (100 quota units).
 */
export async function fetchYouTubeDataApi(
  monitor: Monitor, apiKey: string, fetcher: typeof fetch = fetch,
): Promise<{ items: ContentItem[]; potentiallyTruncated: boolean }> {
  if (!apiKey || apiKey.length > 512 || /\s/.test(apiKey))
    throw new Error('Invalid YOUTUBE_API_KEY');
  const channelRef = normalizeChannelReference(monitor.query);
  const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
  channelUrl.searchParams.set('part', 'contentDetails');
  channelUrl.searchParams.set(CHANNEL_ID.test(channelRef) ? 'id' : 'forHandle', channelRef);
  const request = async (url: URL): Promise<Record<string, unknown>> => {
    // Send the key in the API query parameter; never log complete URLs.
    url.searchParams.set('key', apiKey);
    const response = await fetcher(url, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
    });
    requireSuccess(response, 'YouTube Data API');
    return requireRecord(await response.json());
  };
  const channels = requireRecord(await request(channelUrl)).items;
  if (!Array.isArray(channels) || channels.length !== 1)
    throw new Error('YouTube Data API did not return the requested channel');
  const details = requireRecord(requireRecord(channels[0]).contentDetails);
  const uploads = requireRecord(details.relatedPlaylists).uploads;
  if (typeof uploads !== 'string' || !/^[A-Za-z0-9_-]{10,80}$/.test(uploads))
    throw new Error('YouTube Data API returned an invalid uploads playlist');
  const playlistUrl = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
  playlistUrl.searchParams.set('part', 'snippet,contentDetails,status');
  playlistUrl.searchParams.set('playlistId', uploads);
  playlistUrl.searchParams.set('maxResults', String(PER_PAGE));
  const payload = await request(playlistUrl);
  if (!Array.isArray(payload.items)) throw new Error('YouTube Data API missing playlist items');
  const items: ContentItem[] = [];
  for (const entry of payload.items) {
    const row = requireRecord(entry);
    const status = row.status === undefined ? null : requireRecord(row.status);
    if (status !== null && status.privacyStatus !== 'public') continue;
    const snippet = requireRecord(row.snippet);
    const content = requireRecord(row.contentDetails);
    const id = content.videoId;
    const title = snippet.title;
    const publishedAt = Date.parse(String(content.videoPublishedAt ?? ''));
    if (typeof id !== 'string' || !VIDEO_ID.test(id) ||
        typeof title !== 'string' || !title.trim() || !Number.isFinite(publishedAt))
      throw new Error('YouTube Data API returned malformed public video data');
    items.push({
      id: 'youtube:' + id, title, url: 'https://www.youtube.com/watch?v=' + id, publishedAt,
    });
  }
  return { items, potentiallyTruncated: Boolean(payload.nextPageToken) || payload.items.length >= PER_PAGE };
}
