import type { ContentItem, Monitor } from '../types.ts';
import { entries, fetchTextBounded, parseDate, requiredText, tagText } from './xml.ts';

export function zennFeedUrl(query: string): URL {
  const match = /^(user|topic):([a-zA-Z0-9_-]{1,80})$/.exec(query.trim());
  if (!match) throw new Error('Zenn requires user:<slug> or topic:<slug>; trend feeds are not chronological');
  const path = match[1] === 'user' ? match[2] : 'topics/' + match[2];
  return new URL('https://zenn.dev/' + path + '/feed');
}
export function parseZenn(xml: string): ContentItem[] {
  return entries(xml, 'item').map((entry) => {
    const url = new URL(requiredText(entry, 'link'));
    if (url.protocol !== 'https:' || url.hostname !== 'zenn.dev') throw new Error('Invalid Zenn article URL');
    const guid = tagText(entry, 'guid') || url.href;
    return {
      id: 'zenn:' + guid,
      title: requiredText(entry, 'title'),
      url: url.href,
      publishedAt: parseDate(requiredText(entry, 'pubDate')),
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
