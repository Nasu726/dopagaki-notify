// Operator-only local diagnostic CLI. It never opens a public Worker route,
// connects to D1, updates receipts, or writes monitor state.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MONITORS, loadRuntimeMonitors } from '../src/config.ts';
import { webhookFor, notifyDiscordWithArticleThumbnails } from '../src/discord.ts';
import { failureDetails } from '../src/observability.ts';
import { fetchQiita } from '../src/sources/qiita.ts';
import { fetchWikipedia, fetchWikipediaDiscovery } from '../src/sources/wikipedia.ts';
import { fetchArxiv } from '../src/sources/arxiv.ts';
import { fetchOpenAlex } from '../src/sources/openalex.ts';
import { fetchZenn } from '../src/sources/zenn.ts';
import { fetchYouTube } from '../src/sources/youtube.ts';
import { fetchYouTubeDataApi } from '../src/sources/youtube-api.ts';

export const HELP = [
  'Usage: node --experimental-strip-types ops/manual-smoke.mjs --monitor=MONITOR_ID',
  '       [--send-test --confirm-send]',
  '',
  'Default: fetch and report only. No D1 access, no Discord POST, no state changes.',
  'Explicit send: sends ONE [TEST] Discord embed; does not alter deduplication.',
  'Supply private MONITOR_CONFIG_JSON / YOUTUBE_API_KEY / DISCORD_WEBHOOK_* only',
  'through your private local environment. Do NOT run this in public CI logs.',
].join('\n');

export function parseSmokeArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  let monitorId = null;
  let sendTest = false;
  let confirmSend = false;
  for (const arg of args) {
    if (arg.startsWith('--monitor=')) {
      if (monitorId !== null) throw new Error('Duplicate --monitor option');
      monitorId = arg.slice('--monitor='.length);
    } else if (arg === '--send-test' && !sendTest) {
      sendTest = true;
    } else if (arg === '--confirm-send' && !confirmSend) {
      confirmSend = true;
    } else {
      throw new Error('Unknown or repeated smoke-test option; use --help');
    }
  }
  if (!monitorId || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(monitorId))
    throw new Error('Specify one valid --monitor=MONITOR_ID');
  if (sendTest !== confirmSend)
    throw new Error('Discord test requires BOTH --send-test and --confirm-send');
  return { help: false, monitorId, sendTest };
}

async function fetchSnapshot(monitor, env, fetcher) {
  switch (monitor.source) {
    case 'qiita': return fetchQiita(monitor, fetcher);
    case 'zenn': return fetchZenn(monitor, fetcher);
    case 'arxiv': return fetchArxiv(monitor, fetcher);
    case 'openalex': return fetchOpenAlex(monitor, env.OPENALEX_API_KEY, fetcher);
    case 'wikipedia':
      return monitor.query.endsWith(':discover')
        ? fetchWikipediaDiscovery(monitor, fetcher, env.WIKIMEDIA_CONTACT_URL)
        : fetchWikipedia(monitor, fetcher, null, env.WIKIMEDIA_CONTACT_URL);
    case 'youtube':
      return env.YOUTUBE_API_KEY
        ? fetchYouTubeDataApi(monitor, env.YOUTUBE_API_KEY, fetcher)
        : fetchYouTube(monitor, fetcher);
    default: throw new Error('Unsupported monitor source');
  }
}

/** Always read-only with respect to persistent state; even optional send-test
 * uses a distinct [TEST] title and never updates D1's production receipts.
 * Inject dependencies to prove no send happens during default dry runs.
 */
export async function runSmoke(monitor, env = {}, options = {}) {
  const fetcher = options.fetcher ?? fetch;
  const sender = options.sender ?? notifyDiscordWithArticleThumbnails;
  const sendTest = options.sendTest === true;
  const result = await fetchSnapshot(monitor, env, fetcher);
  const sorted = [...result.items].sort((a, b) =>
    b.publishedAt - a.publishedAt || a.id.localeCompare(b.id));
  const latest = sorted[0];
  const report = {
    monitorId: monitor.id,
    source: monitor.source,
    configuredEnabled: monitor.enabled,
    intervalMinutes: monitor.intervalMinutes,
    ...(monitor.weeklyJstDay ? { weeklyJstDay: monitor.weeklyJstDay } : {}),
    ...(monitor.source === 'youtube' ? {
      pinnedChannelId: monitor.youtubeChannelId ?? null,
      adapter: env.YOUTUBE_API_KEY ? 'YouTube Data API' : 'YouTube RSS',
    } : {}),
    fetchedItems: result.items.length,
    potentiallyTruncated: result.potentiallyTruncated,
    samples: sorted.slice(0, 10).map((item) => ({
      id: item.id,
      publishedAt: new Date(item.publishedAt).toISOString(),
      image: monitor.source === 'youtube' ? 'youtube-video' :
        item.imageUrl ? 'feed-image' : item.thumbnailUrl ? 'author-thumbnail' : 'none',
    })),
    mode: sendTest ? 'explicit-send-test' : 'dry-run',
    discordTestSent: false,
    productionStateVerified: false,
  };
  if (sendTest) {
    if (!latest) throw new Error('No fetched item available for explicit test send');
    const webhook = webhookFor(monitor, env);
    await sender(webhook, monitor.source,
      { ...latest, title: '[TEST] ' + latest.title }, fetcher);
    report.discordTestSent = true;
  }
  return report;
}

async function main() {
  const args = parseSmokeArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const monitors = process.env.MONITOR_CONFIG_JSON === undefined
    ? MONITORS : loadRuntimeMonitors(process.env.MONITOR_CONFIG_JSON);
  const monitor = monitors.find((m) => m.id === args.monitorId);
  if (!monitor) throw new Error('Selected monitor is not present in the local runtime configuration');
  // Never log the private JSON or credentials.
  const report = await runSmoke(monitor, process.env, { sendTest: args.sendTest });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    const detail = failureDetails(error);
    console.error(JSON.stringify({ ok: false, ...detail }));
    process.exitCode = 1;
  }
}
