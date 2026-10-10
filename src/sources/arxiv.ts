import type { ContentItem, Monitor } from '../types.ts';
import { entries, fetchTextBounded, parseDate, requiredText } from './xml.ts';

const PAGE_SIZE = 20;
const MAX_OFFSET = 10_000;
export function stableArxivId(raw: string): string {
  const withoutPrefix = raw.trim().replace(/^https?:\/\/(?:export\.)?arxiv\.org\/abs\//, '');
  const id = withoutPrefix.replace(/v[0-9]+$/, '');
  if (!/^(?:[0-9]{4}\.[0-9]{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/[0-9]{7})$/i.test(id))
    throw new Error('Invalid arXiv paper ID');
  return id;
}
export function parseArxiv(xml: string): ContentItem[] {
  return entries(xml, 'entry').map((entry) => {
    const id = stableArxivId(requiredText(entry, 'id'));
    return {
      id: 'arxiv:' + id,
      title: requiredText(entry, 'title'),
      url: 'https://arxiv.org/abs/' + id,
      publishedAt: parseDate(requiredText(entry, 'published')),
    };
  });
}
export async function fetchArxiv(
  monitor: Monitor, fetcher: typeof fetch = fetch, cursor?: string | null,
): Promise<{ items: ContentItem[]; potentiallyTruncated: boolean; nextCursor?: string | null }> {
  const offset = cursor == null ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET || offset % PAGE_SIZE !== 0)
    throw new Error('Invalid arXiv offset cursor');
  const query = monitor.query.trim();
  if (!query || query.length > 512) throw new Error('Invalid arXiv query');
  const url = new URL('https://export.arxiv.org/api/query');
  for (const [k, v] of Object.entries({
    search_query: query, start: String(offset), max_results: String(PAGE_SIZE),
    sortBy: 'submittedDate', sortOrder: 'descending',
  })) url.searchParams.set(k, v);
  const items = parseArxiv(await fetchTextBounded(url, 'arXiv', fetcher));
  const hasAnotherPage = items.length >= PAGE_SIZE;
  return {
    items,
    nextCursor: hasAnotherPage && offset < MAX_OFFSET ? String(offset + PAGE_SIZE) : null,
    potentiallyTruncated: hasAnotherPage && offset >= MAX_OFFSET,
  };
}
