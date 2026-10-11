import { requireSuccess } from '../http.ts';
import type { ContentItem, Monitor } from '../types.ts';

const ENDPOINT = 'https://qiita.com/api/v2/items';
const PER_PAGE = 20;
const MAX_PAGE = 100;

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
  nextCursor?: string | null;
}

// Search window lower bound reduces old-page traversal without relying on result order.
// An extra UTC day protects Qiita date-only queries from timezone boundary loss.
export function qiitaQueryWithWindow(query: string, createdAfter?: number | null): string {
  const base = query.trim();
  if (createdAfter == null) return base;
  if (!Number.isFinite(createdAfter)) throw new Error('Invalid Qiita creation-time window');
  const date = new Date(createdAfter - 86_400_000).toISOString().slice(0, 10);
  return (base + ' created:>=' + date).trim();
}

// Fetch just one API page; D1 checkpoints the cursor for later scheduled ticks.
export async function fetchQiita(
  monitor: Monitor, fetcher: typeof fetch = fetch, cursor?: string | null, createdAfter?: number | null,
): Promise<FetchResult> {
  const page = cursor == null ? 1 : Number(cursor);
  if (!Number.isSafeInteger(page) || page < 1 || page > MAX_PAGE) throw new Error('Invalid Qiita page cursor');
  const url = new URL(ENDPOINT);
  url.searchParams.set('page', String(page));
  url.searchParams.set('per_page', String(PER_PAGE));
  const query = qiitaQueryWithWindow(monitor.query, createdAfter);
  if (query) url.searchParams.set('query', query);
  const response = await fetcher(url, {
    headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000),
  });
  requireSuccess(response, 'Qiita');
  const items = parseQiita(await response.json());
  return {
    items,
    nextCursor: items.length >= PER_PAGE && page < MAX_PAGE ? String(page + 1) : null,
    potentiallyTruncated: items.length >= PER_PAGE && page === MAX_PAGE,
  };
}
