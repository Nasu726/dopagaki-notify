import type { ContentItem, Monitor } from '../types.ts';

const ENDPOINT = 'https://qiita.com/api/v2/items';
const PER_PAGE = 50;

interface QiitaRow {
  id: string;
  title: string;
  url: string;
  created_at: string;
  updated_at?: string;
}

// Port of the original dopagaki-board Qiita adapter: preserve stable ID and
// creation timestamp. Likes, UI score, and thumbnail enrichment are omitted.
export function parseQiita(body: unknown): ContentItem[] {
  if (!Array.isArray(body)) throw new Error('Qiita response is not an array');
  return body.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Malformed Qiita item');
    const item = raw as Partial<QiitaRow>;
    if (typeof item.id !== 'string' || !item.id ||
        typeof item.title !== 'string' || typeof item.url !== 'string' ||
        typeof item.created_at !== 'string') throw new Error('Malformed Qiita item');
    const publishedAt = Date.parse(item.created_at);
    const url = new URL(item.url);
    if (!Number.isFinite(publishedAt) || url.protocol !== 'https:' || url.hostname !== 'qiita.com') {
      throw new Error('Invalid Qiita published time or article URL');
    }
    return { id: 'qiita:' + item.id, title: item.title, url: url.href, publishedAt };
  });
}

export interface FetchResult {
  items: ContentItem[];
  potentiallyTruncated: boolean;
}

// Initial newest-page fetch. Full catch-up/pagination remains future work.
export async function fetchQiita(monitor: Monitor, fetcher: typeof fetch = fetch): Promise<FetchResult> {
  const url = new URL(ENDPOINT);
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', String(PER_PAGE));
  if (monitor.query.trim()) url.searchParams.set('query', monitor.query.trim());
  const response = await fetcher(url, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Qiita HTTP ' + response.status);
  const items = parseQiita(await response.json());
  return { items, potentiallyTruncated: items.length >= PER_PAGE };
}
