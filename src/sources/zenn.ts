import type { ContentItem, Monitor } from '../types.ts';
import { entries, fetchTextBounded, parseDate, requiredText, tagText } from './xml.ts';
import { safeImageUrl } from '../article-thumbnail.ts';

export function zennFeedUrl(query: string): URL {
  const match = /^(user|topic):([a-zA-Z0-9_-]{1,80})$/.exec(query.trim());
  if (!match) throw new Error('Zenn requires user:<slug> or topic:<slug>; trend feeds are not chronological');
  const path = match[1] === 'user' ? match[2] : 'topics/' + match[2];
  return new URL('https://zenn.dev/' + path + '/feed');
}

/** Zenn RSS supplies article OGP images in <enclosure url="..."/>.
 * Its length/type fields are nonstandard, so validate only the URL.
 */
export function zennEnclosureImage(entry: string, articleUrl: URL): string | null {
  // Do not mistake enclosure-like strings in comments or CDATA for tags.
  const structural = entry.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const tag = /<enclosure\b[^>]{0,4096}>/i.exec(structural)?.[0];
  if (!tag) return null;
  const attrs = /(?:\s|^)url\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const raw = attrs?.[1] ?? attrs?.[2];
  return raw ? safeImageUrl(raw, articleUrl) : null;
}

export function parseZenn(xml: string): ContentItem[] {
  return entries(xml, 'item').map((entry) => {
    const url = new URL(requiredText(entry, 'link'));
    if (url.protocol !== 'https:' || url.hostname !== 'zenn.dev') throw new Error('Invalid Zenn article URL');
    const guid = tagText(entry, 'guid') || url.href;
    const imageUrl = zennEnclosureImage(entry, url);
    return {
      id: 'zenn:' + guid,
      title: requiredText(entry, 'title'),
      url: url.href,
      publishedAt: parseDate(requiredText(entry, 'pubDate')),
      ...(imageUrl ? { imageUrl } : {}),
    };
  });
}
export async function fetchZenn(
  monitor: Monitor, fetcher: typeof fetch = fetch,
): Promise<{ items: ContentItem[]; potentiallyTruncated: boolean }> {
  const items = parseZenn(await fetchTextBounded(zennFeedUrl(monitor.query), 'Zenn', fetcher));
  // RSS feeds have no continuation token. Full feeds can conceal older unseen items.
  return { items, potentiallyTruncated: items.length >= 20 };
}
