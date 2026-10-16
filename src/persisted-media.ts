// Only store optional public image URLs from known article sources.
// Rendering is best-effort; invalid/signed/private URLs must never enter D1.
import { safeImageUrl } from './article-thumbnail.ts';
import type { SourceName, ContentItem } from './types.ts';

export type MediaRejectionReason =
  'no_media_or_unsupported_source' | 'invalid_article_url' | 'unsafe_image_url' |
  'image_fragment' | 'unapproved_query_key' | 'unapproved_query_value';

/** Mirrors the precise policy used for D1 persistence, but provides only a
 * bounded reason and sanitized query-key names for local diagnostics.
 * Image URLs, query VALUES, and tokens are NEVER returned by the inspector.
 */
export function inspectPersistentMediaUrl(
  source: SourceName, articleUrl: string, raw: string | undefined,
): { url: string | null; reason: MediaRejectionReason | null; rejectedKeys: string[] } {
  const fail = (reason: MediaRejectionReason, rejectedKeys: string[] = []) =>
    ({ url: null, reason, rejectedKeys });
  if (!raw || (source !== 'qiita' && source !== 'zenn'))
    return fail('no_media_or_unsupported_source');
  let article: URL;
  try { article = new URL(articleUrl); } catch { return fail('invalid_article_url'); }
  if (article.protocol !== 'https:' ||
      article.hostname !== (source === 'qiita' ? 'qiita.com' : 'zenn.dev'))
    return fail('invalid_article_url');
  const safe = safeImageUrl(raw, article);
  if (!safe) return fail('unsafe_image_url');
  const url = new URL(safe);
  if (url.hash) return fail('image_fragment');

  // Zenn's public RSS currently gives Cloudinary uploads an additional
  // 2–4 character underscore-prefixed query key. A one-off public-image
  // experiment confirmed that the entire image bytes (SHA-256) are identical
  // WITH and WITHOUT that query for all 20 sampled live articles.
  //
  // Persist only the canonical QUERY-FREE image URL, never its query value.
  // This is intentionally limited to the exact Zenn Cloudinary upload host,
  // path and *single* observed opaque-key shape. Unknown keys, multiple keys,
  // long values on other hosts, and all token/signature-like query names keep
  // the strict rejection policy below.
  if (source === 'zenn' && url.hostname === 'res.cloudinary.com' &&
      url.pathname.startsWith('/zenn/image/upload/')) {
    const keys = [...url.searchParams.keys()];
    if (keys.length === 1 && /^_[A-Za-z0-9_-]{1,3}$/.test(keys[0]!)) {
      url.search = '';
      return { url: url.href, reason: null, rejectedKeys: [] };
    }
  }

  // Preserve the strict preexisting policy: unknown/signed/private query
  // parameters are not persisted merely to make a production counter nonzero.
  const disallowed = new Set<string>();
  let invalidValue = false;
  url.searchParams.forEach((value, key) => {
    if (!/^(v|s|size|w|h|x|y|width|height|q|quality|fit|format|auto)$/i.test(key)) {
      // Only bounded, non-sensitive public parameter names appear in reports.
      // Suppress arbitrary keys, secrets, auth, signatures, and high-entropy names.
      const printable = /^[a-z][a-z0-9_-]{0,23}$/i.test(key) &&
        !/(?:token|secret|key|pass|auth|sign|sig|credential|session|nonce)/i.test(key)
        ? key.toLowerCase() : '[redacted]';
      disallowed.add(printable);
    }
    if (value.length > 32 || !/^[a-zA-Z0-9,._-]*$/.test(value)) invalidValue = true;
  });
  if (disallowed.size) return fail('unapproved_query_key', [...disallowed].sort().slice(0, 16));
  if (invalidValue) return fail('unapproved_query_value');
  return { url: safe, reason: null, rejectedKeys: [] };
}

export function persistentMediaUrl(source: SourceName, articleUrl: string, raw: string | undefined): string | null {
  return inspectPersistentMediaUrl(source, articleUrl, raw).url;
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
