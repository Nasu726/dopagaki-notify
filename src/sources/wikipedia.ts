import { requireSuccess } from '../http.ts';
import type { ContentItem, Monitor } from '../types.ts';

// Sample only the newest page creations; exhaustive pagination is intentionally
// disabled for Wikipedia to bound both alerts and D1 operations.
export const WIKIPEDIA_SAMPLE_SIZE = 3;

// Wikimedia requires a descriptive bot User-Agent with contact information.
// This repository's issue tracker is the publicly reachable operator contact.
export const WIKIMEDIA_USER_AGENT =
  'dopagaki-notify/0.1 (https://github.com/Nasu726/dopagaki-notify)';

interface RecentChange {
  type: string;
  ns: number;
  pageid: number;
  title: string;
  timestamp: string;
}

export function parseNewPages(raw: unknown, language: string): ContentItem[] {
  if (!raw || typeof raw !== 'object') throw new Error('Malformed MediaWiki API response');
  const result = raw as { query?: { recentchanges?: unknown } };
  const changes = result.query?.recentchanges;
  if (!Array.isArray(changes)) throw new Error('No recentchanges in MediaWiki response');
  return changes.map((change: RecentChange) => {
    if (change.type !== 'new' || change.ns !== 0 || !Number.isSafeInteger(change.pageid) ||
        change.pageid <= 0 || typeof change.title !== 'string') {
      throw new Error('Malformed or non-new MediaWiki entry');
    }
    const publishedAt = Date.parse(change.timestamp);
    if (!Number.isFinite(publishedAt)) throw new Error('Invalid MediaWiki new-page timestamp');
    return {
      id: 'wikipedia:' + language + ':' + change.pageid,
      title: change.title,
      url: 'https://' + language + '.wikipedia.org/?curid=' + change.pageid,
      publishedAt,
    };
  });
}

export async function fetchWikipedia(
  monitor: Monitor, fetcher: typeof fetch = fetch, _cursor?: string | null,
): Promise<{ items: ContentItem[]; potentiallyTruncated: boolean; nextCursor?: string | null }> {
  const language = monitor.query.trim().toLowerCase();
  if (!/^[a-z]{2,12}(?:-[a-z]{2,12})?$/.test(language))
    throw new Error('Invalid Wikipedia language code');
  const url = new URL('https://' + language + '.wikipedia.org/w/api.php');
  for (const [key, value] of Object.entries({
    action: 'query', list: 'recentchanges', format: 'json', formatversion: '2',
    rctype: 'new', rcnamespace: '0', rcdir: 'older', rcprop: 'title|ids|timestamp',
    rclimit: String(WIKIPEDIA_SAMPLE_SIZE),
  })) url.searchParams.set(key, value);
  // Ignore legacy pagination cursors; always use the current newest page.

  const response = await fetcher(url, {
    headers: { Accept: 'application/json', 'User-Agent': WIKIMEDIA_USER_AGENT,
      'Api-User-Agent': WIKIMEDIA_USER_AGENT }, signal: AbortSignal.timeout(15_000),
  });
  requireSuccess(response, 'MediaWiki');
  const raw = await response.json();
  return { items: parseNewPages(raw, language).slice(0, WIKIPEDIA_SAMPLE_SIZE), potentiallyTruncated: false, nextCursor: null };
}
