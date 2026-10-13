import { requireSuccess } from '../http.ts';
import type { ContentItem, Monitor } from '../types.ts';

/** Snapshot adapter; OpenAlex has publication dates, not reliable exact
 * publication timestamps. Initial IDs are persisted as ignored receipts so
 * later same-day additions are detectable without retroactive floods.
 */
export const OPENALEX_PER_PAGE = 25;
export const OPENALEX_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

export function openAlexQuery(query: string): { search?: string; filter?: string } {
  if (typeof query !== 'string' || query.length > 200 || /[\x00-\x1f\x7f]/.test(query))
    throw new Error('Invalid OpenAlex monitoring query');
  const match = /^(search|topic|author):(.+)$/.exec(query.trim());
  if (!match) throw new Error('OpenAlex query must be search:terms, topic:T123, or author:A123');
  const mode = match[1]!;
  const value = match[2]!;
  if (mode === 'search') {
    if (!value || value.length > 160 || !value.trim())
      throw new Error('Invalid OpenAlex search query');
    return { search: value.trim() };
  }
  if (mode === 'topic' && /^T[1-9][0-9]*$/.test(value))
    return { filter: 'topics.id:' + value };
  if (mode === 'author' && /^A[1-9][0-9]*$/.test(value))
    return { filter: 'authorships.author.id:' + value };
  throw new Error('Invalid OpenAlex topic or author identifier');
}

export function parseOpenAlexWorks(raw: unknown, now = Date.now()): ContentItem[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as {results?: unknown}).results))
    throw new Error('Invalid OpenAlex Works response');
  const results = (raw as {results: unknown[]}).results;
  if (results.length > OPENALEX_PER_PAGE) throw new Error('Oversized OpenAlex Works page');
  return results.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid OpenAlex work');
    const work = entry as Record<string, unknown>;
    if (typeof work.id !== 'string' || !/^https:\/\/openalex\.org\/W[0-9]+$/.test(work.id) ||
        typeof work.display_name !== 'string' || !work.display_name.trim() ||
        typeof work.publication_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(work.publication_date))
      throw new Error('Invalid OpenAlex work ID, title or publication date');
    const publishedAt = Date.parse(work.publication_date + 'T00:00:00Z');
    if (!Number.isFinite(publishedAt) ||
        new Date(publishedAt).toISOString().slice(0, 10) !== work.publication_date)
      throw new Error('Invalid OpenAlex publication date');
    return {
      id: 'openalex:' + work.id.slice('https://openalex.org/'.length),
      title: work.display_name, url: work.id, publishedAt,
    };
  }).filter((item) => item.publishedAt <= now);
}

export async function fetchOpenAlex(
  monitor: Monitor, apiKey?: string, fetcher: typeof fetch = fetch, now = Date.now(),
): Promise<{items: ContentItem[]; potentiallyTruncated: boolean}> {
  const selector = openAlexQuery(monitor.query);
  if (apiKey !== undefined && (!apiKey || apiKey.length > 512 || /[\s\r\n]/.test(apiKey)))
    throw new Error('Invalid OPENALEX_API_KEY');
  const url = new URL('https://api.openalex.org/works');
  url.searchParams.set('per_page', String(OPENALEX_PER_PAGE));
  url.searchParams.set('sort', 'publication_date:desc');
  url.searchParams.set('select', 'id,display_name,publication_date');
  const since = new Date(now - OPENALEX_LOOKBACK_MS).toISOString().slice(0, 10);
  url.searchParams.set('filter',
    [selector.filter, 'from_publication_date:' + since].filter(Boolean).join(','));
  if (selector.search) url.searchParams.set('search', selector.search);
  const response = await fetcher(url, {
    headers: {
      Accept: 'application/json',
      ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  requireSuccess(response, 'OpenAlex');
  const payload: unknown = await response.json();
  const items = parseOpenAlexWorks(payload, now);
  return {
    items,
    potentiallyTruncated: (payload as {results: unknown[]}).results.length >= OPENALEX_PER_PAGE,
  };
}
