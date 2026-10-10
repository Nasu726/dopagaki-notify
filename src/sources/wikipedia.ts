import type { ContentItem, Monitor } from '../types.ts';

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
  monitor: Monitor, fetcher: typeof fetch = fetch,
): Promise<{ items: ContentItem[]; potentiallyTruncated: boolean }> {
  const language = monitor.query.trim().toLowerCase();
  if (!/^[a-z]{2,12}(?:-[a-z]{2,12})?$/.test(language))
    throw new Error('Invalid Wikipedia language code');
  const url = new URL('https://' + language + '.wikipedia.org/w/api.php');
  for (const [key, value] of Object.entries({
    action: 'query', list: 'recentchanges', format: 'json', formatversion: '2',
    rctype: 'new', rcnamespace: '0', rcdir: 'older', rcprop: 'title|ids|timestamp', rclimit: '50',
  })) url.searchParams.set(key, value);
  const response = await fetcher(url, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('MediaWiki HTTP ' + response.status);
  const raw = await response.json() as { continue?: unknown };
  const items = parseNewPages(raw, language);
  return { items, potentiallyTruncated: Boolean(raw.continue) };
}
