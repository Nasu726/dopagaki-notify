import { requireSuccess } from './http.ts';
import type { ContentItem, Env, Monitor } from './types.ts';
import { fetchArticleThumbnail } from './article-thumbnail.ts';

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


/** Production sender: image metadata is purely best-effort and transient.
 * No outbox change: even pending articles from older deployments gain images.
 */
export async function notifyDiscordWithArticleThumbnails(
  webhook: string, source: string, item: ContentItem, fetcher: typeof fetch = fetch,
): Promise<void> {
  const imageUrl = (source === 'qiita' || source === 'zenn')
    ? await fetchArticleThumbnail(source, item.url, fetcher) : null;
  await notifyDiscord(webhook, source,
    imageUrl ? { ...item, imageUrl } : item, fetcher);
}
