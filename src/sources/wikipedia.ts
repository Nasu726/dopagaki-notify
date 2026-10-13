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

// Discovery deliberately differs from the legacy "new page" adapter:
// a curated featured-article pool plus sufficiently substantial random pages.
// Each 2-hour poll makes only two MediaWiki requests and never paginates.
// Do not use old creation timestamps as these are recommendations, not news.
const FEATURED_CATEGORY = 'Category:秀逸な記事';
const FEATURED_POOL_MAX = 500;
const DISCOVERY_CANDIDATES_PER_KIND = 8;
const RANDOM_MIN_BYTES = 10_000;

interface WikiPage {
  ns: number;
  pageid: number;
  title: string;
}
function discoveryCandidates(raw: unknown, field: 'categorymembers' | 'random',
  lang: string, kind: 'featured' | 'random'): ContentItem[] {
  if (!raw || typeof raw !== 'object') throw new Error('Malformed MediaWiki discovery response');
  const response = raw as { error?: unknown; query?: Record<string, unknown> };
  if (response.error) throw new Error('MediaWiki discovery API error: ' + JSON.stringify(response.error).slice(0, 256));
  const pages = response.query?.[field];
  if (!Array.isArray(pages) || !pages.length)
    throw new Error('Missing or empty MediaWiki ' + field + ' response');
  return pages.map((page: WikiPage) => {
    if (page.ns !== 0 || !Number.isSafeInteger(page.pageid) || page.pageid <= 0 ||
      typeof page.title !== 'string' || !page.title)
      throw new Error('Malformed MediaWiki discovery page');
    return {
      id: 'wikipedia:' + lang + ':' + page.pageid,
      title: page.title,
      url: 'https://' + lang + '.wikipedia.org/?curid=' + page.pageid,
      publishedAt: 0, // runner replaces this with the actual recommendation time
      discoveryKind: kind,
    };
  });
}
function randomSubset<T>(items: readonly T[], limit: number): T[] {
  const shuffled = [...items];
  // Partial Fisher-Yates: sample up to 8 without replacement, no dependency or external API.
  for (let i = 0; i < Math.min(limit, shuffled.length); i++) {
    const j = i + Math.floor(Math.random() * (shuffled.length - i));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return shuffled.slice(0, limit);
}
async function wikiJson(url: URL, fetcher: typeof fetch): Promise<unknown> {
  const response = await fetcher(url, {
    headers: { Accept: 'application/json', 'User-Agent': WIKIMEDIA_USER_AGENT,
      'Api-User-Agent': WIKIMEDIA_USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  requireSuccess(response, 'MediaWiki');
  return response.json();
}
export async function fetchWikipediaDiscovery(
  monitor: Monitor, fetcher: typeof fetch = fetch,
): Promise<{ items: ContentItem[]; potentiallyTruncated: boolean; nextCursor: null }> {
  const match = /^([a-z]{2,12}(?:-[a-z]{2,12})?):discover$/.exec(monitor.query.trim().toLowerCase());
  if (!match) throw new Error('Invalid Wikipedia discovery query');
  const lang = match[1]!;
  const base = 'https://' + lang + '.wikipedia.org/w/api.php';
  const featured = new URL(base);
  for (const [key, value] of Object.entries({
    action: 'query', list: 'categorymembers', format: 'json', formatversion: '2',
    cmtitle: FEATURED_CATEGORY, cmnamespace: '0', cmtype: 'page',
    cmlimit: String(FEATURED_POOL_MAX),
  })) featured.searchParams.set(key, value);
  const random = new URL(base);
  for (const [key, value] of Object.entries({
    action: 'query', list: 'random', format: 'json', formatversion: '2',
    rnnamespace: '0', rnfilterredir: 'nonredirects',
    rnminsize: String(RANDOM_MIN_BYTES),
    rnlimit: String(DISCOVERY_CANDIDATES_PER_KIND),
  })) random.searchParams.set(key, value);
  const [featuredData, randomData] = await Promise.all([
    wikiJson(featured, fetcher), wikiJson(random, fetcher),
  ]);
  const curated = discoveryCandidates(featuredData, 'categorymembers', lang, 'featured');
  const candidates = discoveryCandidates(randomData, 'random', lang, 'random');
  return {
    items: [
      ...randomSubset(curated, DISCOVERY_CANDIDATES_PER_KIND),
      ...randomSubset(candidates, DISCOVERY_CANDIDATES_PER_KIND),
    ],
    potentiallyTruncated: false, nextCursor: null,
  };
}
