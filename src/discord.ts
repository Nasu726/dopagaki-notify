import { requireSuccess } from './http.ts';
import type { ContentItem, Env, Monitor } from './types.ts';
import { fetchArticleThumbnail } from './article-thumbnail.ts';
import { fetchZenn } from './sources/zenn.ts';

function webhookSecretValue(monitor: Monitor, env: Env): string | undefined {
  return monitor.source === 'qiita' ? env.DISCORD_WEBHOOK_QIITA :
    monitor.source === 'wikipedia' ? env.DISCORD_WEBHOOK_WIKIPEDIA :
    monitor.source === 'arxiv' ? env.DISCORD_WEBHOOK_ARXIV :
    monitor.source === 'openalex' ? env.DISCORD_WEBHOOK_OPENALEX :
    monitor.source === 'zenn' ? env.DISCORD_WEBHOOK_ZENN :
    monitor.source === 'youtube' ? env.DISCORD_WEBHOOK_YOUTUBE : undefined;
}

// Missing Secrets must not trigger repeated failed leases or D1 writes.
export function hasWebhookSecret(monitor: Monitor, env: Env): boolean {
  return !!webhookSecretValue(monitor, env);
}

export function webhookFor(monitor: Monitor, env: Env): string {
  const webhook = webhookSecretValue(monitor, env);
  if (!webhook) throw new Error('Missing Discord webhook secret for ' + monitor.source);
  const url = new URL(webhook);
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(url.hostname) ||
      !/^\/api\/webhooks\/\d+\/[^/]+$/.test(url.pathname)) {
    throw new Error('Invalid Discord webhook URL for ' + monitor.source);
  }
  return webhook;
}

export async function notifyDiscord(
  webhook: string, source: string, item: ContentItem, fetcher: typeof fetch = fetch,
): Promise<void> {
  const url = new URL(webhook);
  url.searchParams.set('wait', 'true');
  const youtubeId = source === 'youtube'
    ? /^youtube:([A-Za-z0-9_-]{11})$/.exec(item.id)?.[1] : undefined;
  const articleImage = (source === 'qiita' || source === 'zenn') ? item.imageUrl : undefined;
  const payload = {
    embeds: [{
      title: item.title.slice(0, 256),
      url: item.url,
      description: source + ' · ' + new Date(item.publishedAt).toISOString(),
      ...(youtubeId
        ? { image: { url: 'https://i.ytimg.com/vi/' + youtubeId + '/hqdefault.jpg' } }
        : articleImage ? { image: { url: articleImage } } : {}),
    }],
    allowed_mentions: { parse: [] },
  };
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });
  requireSuccess(response, 'Discord');
}


/** For older pending deliveries, recover the OGP from Zenn's author RSS.
 * Its <enclosure> provides images even when Zenn HTML blocks scraping.
 */
async function zennRssThumbnail(item: ContentItem, fetcher: typeof fetch): Promise<string | null> {
  let url: URL;
  try { url = new URL(item.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'zenn.dev') return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(segments[0] ?? '') ||
      !['articles', 'books'].includes(segments[1] ?? '')) return null;
  try {
    const monitor: Monitor = {
      id: 'zenn-thumbnail', source: 'zenn', enabled: true, intervalMinutes: 60,
      query: 'user:' + segments[0]!,
    };
    const result = await fetchZenn(monitor, fetcher);
    return result.items.find((entry) => entry.id === item.id || entry.url === item.url)?.imageUrl ?? null;
  } catch {
    return null;
  }
}

/** Production sender: image metadata is best-effort and transient.
 * RSS images are preferred. No outbox migration: queued articles can obtain
 * them from the author's feed, then fall back to HTML Open Graph metadata.
 */
export async function notifyDiscordWithArticleThumbnails(
  webhook: string, source: string, item: ContentItem, fetcher: typeof fetch = fetch,
): Promise<void> {
  let imageUrl = item.imageUrl ?? null;
  if (!imageUrl && source === 'zenn')
    imageUrl = await zennRssThumbnail(item, fetcher);
  if (!imageUrl && (source === 'qiita' || source === 'zenn'))
    imageUrl = await fetchArticleThumbnail(source, item.url, fetcher);
  await notifyDiscord(webhook, source,
    imageUrl ? { ...item, imageUrl } : item, fetcher);
}
