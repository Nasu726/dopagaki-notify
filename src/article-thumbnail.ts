// Optional Qiita / Zenn article thumbnails. The publisher's HTML is read
// only at delivery time: queued rows need no new D1 column or migration.
// A failed/missing image must never prevent a Discord notification.
import type { SourceName } from './types.ts';

const MAX_HTML_BYTES = 256 * 1024;
const TIMEOUT_MS = 4_000;
const META_TAG = /<meta\b[^>]{0,4096}>/gi;

function attribute(tag: string, name: string): string | null {
  const pattern = new RegExp('(?:\\s|^)' + name +
    '\\s*=\\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\\s>]+))', 'i');
  const match = pattern.exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] ?? null : null;
}

function decodeUrlEntities(raw: string): string {
  return raw.replace(/&(?:amp|quot|apos|#(\d+)|#x([0-9a-f]+));/gi,
    (entity, decimal: string | undefined, hex: string | undefined) => {
      if (decimal || hex) {
        const code = Number.parseInt(decimal ?? hex!, decimal ? 10 : 16);
        return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code) : entity;
      }
      return entity.toLowerCase() === '&amp;' ? '&' :
        entity.toLowerCase() === '&quot;' ? '"' : "'";
    });
}

/** Validate an image URL before it is forwarded to Discord.
 * Only globally addressed HTTPS hostnames; no localhost, IPs, credentials,
 * nonstandard ports or control characters. Remote image bodies are never
 * fetched by the Worker.
 */
export function safeImageUrl(raw: string, articleUrl: URL): string | null {
  if (!raw || raw.length > 2048 || /[\x00-\x1f\x7f]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(decodeUrlEntities(raw), articleUrl); }
  catch { return null; }
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !hostname.includes('.') || /^\d+(?:\.\d+){3}$/.test(hostname) ||
      hostname.startsWith('[') || /(?:^|\.)(?:localhost|local|internal)$/.test(hostname))
    return null;
  return url.href;
}

export function articleOgImage(html: string, article: URL): string | null {
  // Only consider head metadata, not a meta-looking example in article body.
  const end = /<\/head\s*>/i.exec(html)?.index;
  const head = html.slice(0, end ?? MAX_HTML_BYTES);
  const candidates: { priority: number; url: string }[] = [];
  for (const match of head.matchAll(META_TAG)) {
    const tag = match[0];
    const property = (attribute(tag, 'property') ?? attribute(tag, 'name') ?? '').toLowerCase();
    const priority = property === 'og:image:secure_url' ? 0 :
      property === 'og:image' || property === 'og:image:url' ? 1 :
      property === 'twitter:image' ? 2 : 99;
    if (priority === 99) continue;
    const content = attribute(tag, 'content');
    if (content) {
      const url = safeImageUrl(content, article);
      if (url) candidates.push({priority, url});
    }
  }
  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0]?.url ?? null;
}

function verifiedArticleUrl(source: SourceName, raw: string): URL | null {
  if (source !== 'qiita' && source !== 'zenn') return null;
  let url: URL;
  try { url = new URL(raw); }
  catch { return null; }
  const hostname = source === 'qiita' ? 'qiita.com' : 'zenn.dev';
  return url.protocol === 'https:' && url.hostname === hostname && !url.port &&
    !url.username && !url.password ? url : null;
}

/** One bounded, nonredirecting request per delivered Qiita/Zenn article.
 * Content is read until </head> or 256 KiB, never the full article body.
 */
export async function fetchArticleThumbnail(
  source: SourceName, articleUrl: string, fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const article = verifiedArticleUrl(source, articleUrl);
  if (!article) return null;
  try {
    const response = await fetcher(article, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      if (source === 'qiita')
        console.info('qiita article thumbnail: HTML unavailable (HTTP ' + response.status + ')');
      return null;
    }
    const contentType = response.headers.get('content-type');
    if (contentType && !/text\/html/i.test(contentType)) {
      await response.body.cancel();
      return null;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let readBytes = 0;
    let html = '';
    try {
      while (readBytes < MAX_HTML_BYTES) {
        const { value, done } = await reader.read();
        if (done) break;
        const remainder = MAX_HTML_BYTES - readBytes;
        const part = value.subarray(0, remainder);
        readBytes += part.byteLength;
        html += decoder.decode(part, { stream: true });
        if (/<\/head\s*>/i.test(html)) break;
      }
      html += decoder.decode();
      const imageUrl = articleOgImage(html, article);
      if (!imageUrl && source === 'qiita')
        console.info('qiita article thumbnail: no Discord-compatible image in HTML metadata');
      return imageUrl;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  } catch {
    if (source === 'qiita') console.info('qiita article thumbnail: HTML request failed');
    return null;
  }
}
