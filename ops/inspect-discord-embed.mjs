// Read-only inspection of an existing Discord webhook message. Never POST,
// mutate production state, or log the webhook credential/message contents.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SNOWFLAKE = /^\d{15,22}$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
export function parseDiscordMessageLink(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Invalid Discord message link'); }
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error('Invalid Discord message link');
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 4 || parts[0] !== 'channels' ||
      !(SNOWFLAKE.test(parts[1]) || parts[1] === '@me') ||
      !SNOWFLAKE.test(parts[2]) || !SNOWFLAKE.test(parts[3])) {
    throw new Error('Expected Discord message link with channel and message IDs');
  }
  return { channelId: parts[2], messageId: parts[3] };
}

export function parseWebhook(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Missing or invalid DISCORD_WEBHOOK_YOUTUBE'); }
  if (url.protocol !== 'https:' || !['discord.com', 'discordapp.com'].includes(url.hostname) ||
      url.username || url.password || url.port || url.search || url.hash ||
      !/^\/api\/webhooks\/\d{15,22}\/[^/]+$/.test(url.pathname)) {
    throw new Error('Missing or invalid DISCORD_WEBHOOK_YOUTUBE');
  }
  return url;
}

export function parseOptions(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  let link = null, probeImage = false, probeProxy = false;
  for (const arg of argv) {
    if (arg.startsWith('--message-link=') && link === null) link = arg.slice('--message-link='.length);
    else if (arg === '--probe-image' && !probeImage) probeImage = true;
    else if (arg === '--probe-proxy' && !probeProxy) probeProxy = true;
    else throw new Error('Invalid or duplicate diagnostic option');
  }
  if (!link) throw new Error('Missing --message-link (run --help)');
  return { help: false, ...parseDiscordMessageLink(link), probeImage, probeProxy };
}

function videoIdFromEmbed(embed) {
  if (typeof embed?.url !== 'string') return null;
  let url;
  try { url = new URL(embed.url); } catch { return null; }
  if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com'].includes(url.hostname) ||
      url.pathname !== '/watch') return null;
  const id = url.searchParams.get('v');
  return id && YOUTUBE_ID.test(id) ? id : null;
}

function mediaSummary(media, expected) {
  if (!media || typeof media !== 'object') return { present: false };
  let hostname = null;
  try { hostname = new URL(media.url).hostname; } catch { /* no echo */ }
  const width = Number.isSafeInteger(media.width) ? media.width : null;
  const height = Number.isSafeInteger(media.height) ? media.height : null;
  return {
    present: true,
    sourceHost: hostname,
    matchesExpectedYouTubeUrl: expected === null ? null : media.url === expected,
    proxyPresent: typeof media.proxy_url === 'string' && media.proxy_url.startsWith('https://'),
    width,
    height,
  };
}

export function summarizeMessage(message, expectedChannelId, expectedMessageId) {
  if (!message || typeof message !== 'object' || message.id !== expectedMessageId ||
      message.channel_id !== expectedChannelId) throw new Error('Discord response does not identify the requested message');
  const embeds = Array.isArray(message.embeds) ? message.embeds : [];
  return {
    ok: true,
    // Bit 2: Discord's documented SUPPRESS_EMBEDS flag.
    embedsSuppressed: Number.isSafeInteger(message.flags) ? Boolean(message.flags & 4) : false,
    embedCount: embeds.length,
    embeds: embeds.slice(0, 5).map(embed => {
      const videoId = videoIdFromEmbed(embed);
      const expected = videoId ? 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg' : null;
      return {
        type: typeof embed?.type === 'string' ? embed.type : null,
        youtubeVideoId: videoId,
        thumbnail: mediaSummary(embed?.thumbnail, expected),
        image: mediaSummary(embed?.image, expected),
      };
    }),
  };
}

/** One read-only GET for a message, optionally one bounded public image GET
 * on the canonical YouTube CDN; no writes to Discord or D1.
 */
function verifiedDiscordImageProxy(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !['images-ext-1.discordapp.net','images-ext-2.discordapp.net','media.discordapp.net'].includes(url.hostname) ||
      !url.pathname.startsWith('/external/')) return null;
  return url;
}

export async function inspectDiscordEmbed({
  webhook, channelId, messageId, probeImage = false, probeProxy = false, fetcher = fetch,
}) {
  if (!SNOWFLAKE.test(channelId) || !SNOWFLAKE.test(messageId))
    throw new Error('Invalid Discord channel/message ID');
  const base = parseWebhook(webhook);
  const endpoint = new URL(base.href);
  endpoint.pathname += '/messages/' + messageId;
  const response = await fetcher(endpoint, {
    method: 'GET', headers: { Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('Discord message lookup failed (HTTP ' + response.status + ')');
  const saved = await response.json();
  const report = summarizeMessage(saved, channelId, messageId);
  if (probeProxy) {
    const media = Array.isArray(saved.embeds) ? saved.embeds.flatMap(
      e => [e?.thumbnail, e?.image]) : [];
    const candidate = media.find(m => verifiedDiscordImageProxy(m?.proxy_url));
    const url = candidate ? verifiedDiscordImageProxy(candidate.proxy_url) : null;
    if (!url) {
      report.discordProxyImage = { checked: false, reason: 'No safe Discord image proxy URL available' };
    } else {
      try {
        const proxy = await fetcher(url, {
          method: 'GET', headers: { Accept: 'image/*', Range: 'bytes=0-0' },
          redirect: 'manual', signal: AbortSignal.timeout(10_000),
        });
        report.discordProxyImage = {
          checked: true, status: proxy.status,
          contentType: (proxy.headers.get('content-type') ?? '').split(';')[0].toLowerCase() || null,
          redirected: proxy.status >= 300 && proxy.status < 400,
        };
        await proxy.body?.cancel().catch(() => {});
      } catch {
        report.discordProxyImage = { checked: true, status: null, error: 'network_or_timeout' };
      }
    }
  }
  if (probeImage) {
    const id = report.embeds.find(x => x.youtubeVideoId)?.youtubeVideoId;
    if (!id) {
      report.sourceImage = { checked: false, reason: 'No YouTube video ID present in the message embed' };
    } else {
      const imageUrl = 'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg';
      try {
        const img = await fetcher(imageUrl, {
          method: 'GET', headers: { Accept: 'image/*', Range: 'bytes=0-0' },
          redirect: 'manual', signal: AbortSignal.timeout(10_000),
        });
        report.sourceImage = {
          checked: true,
          status: img.status,
          contentType: (img.headers.get('content-type') ?? '').split(';')[0].toLowerCase() || null,
          redirected: img.status >= 300 && img.status < 400,
        };
        await img.body?.cancel().catch(() => {});
      } catch {
        report.sourceImage = { checked: true, status: null, error: 'network_or_timeout' };
      }
    }
  }
  return report;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node ops/inspect-discord-embed.mjs --message-link=https://discord.com/channels/GUILD/CHANNEL/MESSAGE [--probe-image] [--probe-proxy]');
    console.log('Requires private DISCORD_WEBHOOK_YOUTUBE. Read-only GET; no Discord messages sent, no D1 access.');
    return;
  }
  const report = await inspectDiscordEmbed({
    webhook: process.env.DISCORD_WEBHOOK_YOUTUBE,
    channelId: options.channelId,
    messageId: options.messageId,
    probeImage: options.probeImage,
    probeProxy: options.probeProxy,
  });
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(); }
  catch (error) {
    const message = error instanceof Error && (/^Discord message lookup failed \(HTTP \d{3}\)$/.test(error.message) ||
      ['Invalid Discord message link','Expected Discord message link with channel and message IDs',
        'Missing --message-link (run --help)','Missing or invalid DISCORD_WEBHOOK_YOUTUBE',
        'Invalid or duplicate diagnostic option', 'Invalid Discord channel/message ID',
        'Discord response does not identify the requested message'].includes(error.message))
      ? error.message : 'Discord diagnostic failed (check network and private webhook configuration)';
    console.error(JSON.stringify({ ok: false, message }));
    process.exitCode = 1;
  }
}
