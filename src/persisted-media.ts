// Only store optional public image URLs from known article sources.
// Rendering is best-effort; invalid/signed/private URLs must never enter D1.
import { safeImageUrl } from './article-thumbnail.ts';
import type { SourceName, ContentItem } from './types.ts';

export function persistentMediaUrl(source: SourceName, articleUrl: string, raw: string | undefined): string | null {
  if (!raw || (source !== 'qiita' && source !== 'zenn')) return null;
  let article: URL;
  try { article = new URL(articleUrl); } catch { return null; }
  if (article.protocol !== 'https:' ||
      article.hostname !== (source === 'qiita' ? 'qiita.com' : 'zenn.dev'))
    return null;
  const safe = safeImageUrl(raw, article);
  if (!safe) return null;
  const url = new URL(safe);
  if (url.hash) return null;
  // Reject all credentials, signatures, sensitive or arbitrary query strings.
  // Known public image-resizing switches are acceptable, with short values.
  let unsafeQuery = false;
  url.searchParams.forEach((value, key) => {
    if (!/^(v|s|size|w|h|x|y|width|height|q|quality|fit|format|auto)$/i.test(key)
        || value.length > 32 || !/^[a-zA-Z0-9,._-]*$/.test(value))
      unsafeQuery = true;
  });
  if (unsafeQuery) return null;
  return safe;
}

export function persistentMedia(source: SourceName, item: ContentItem) {
  return {
    imageUrl: persistentMediaUrl(source, item.url, item.imageUrl),
    thumbnailUrl: persistentMediaUrl(source, item.url, item.thumbnailUrl),
  };
}

/** Temporary read/write fallback for Workers already deployed before D1 migration 0010.
 * Only fallback on the specific missing image column, never on general D1 failures.
 */
export function missingDeliveryMediaColumns(error: unknown): boolean {
  return error instanceof Error &&
    /(?:no such column:|has no column named)\s*(?:deliveries\.)?(?:image_url|thumbnail_url)\b/i.test(error.message);
}
