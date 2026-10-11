import { requireSuccess } from './http.ts';
import type { ContentItem, Env, Monitor } from './types.ts';

export function webhookFor(monitor: Monitor, env: Env): string {
  const webhook = monitor.source === 'qiita' ? env.DISCORD_WEBHOOK_QIITA :
    monitor.source === 'wikipedia' ? env.DISCORD_WEBHOOK_WIKIPEDIA :
    monitor.source === 'arxiv' ? env.DISCORD_WEBHOOK_ARXIV :
    monitor.source === 'zenn' ? env.DISCORD_WEBHOOK_ZENN :
    monitor.source === 'youtube' ? env.DISCORD_WEBHOOK_YOUTUBE : undefined;
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
  const payload = {
    embeds: [{
      title: item.title.slice(0, 256),
      url: item.url,
      description: source + ' · ' + new Date(item.publishedAt).toISOString(),
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
