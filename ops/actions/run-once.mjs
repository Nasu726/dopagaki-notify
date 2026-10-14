// GitHub Actions entrypoint. No Cloudflare APIs are called; the same Worker
// scheduler and source adapters run against a local SQLite adapter.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseKey, encryptState, decryptState } from './state-crypto.mjs';
import { openDatabase, applyMigrations } from './sqlite.mjs';
import Worker from '../../src/index.ts';
import { pruneSentDeliveries } from '../../src/maintenance.ts';
import { loadRuntimeMonitors } from '../../src/config.ts';

const stateDir = join(process.cwd(), '.private');
const encryptedPath = join(stateDir, 'notify-state.enc');
const databasePath = join(stateDir, 'notify-state.sqlite');

// Public Actions logs are readable, including monitor IDs. Never forward
// provider errors, source/monitor names or stack traces to public workflow logs.
// Use a private repository for detailed operational debugging.
function silenceInternalLogs() {
  const saved = [console.log, console.warn, console.error];
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  return () => {
    [console.log, console.warn, console.error] = saved;
  };
}

async function main() {
  const key = parseKey(process.env.NOTIFY_STATE_KEY);
  if (!process.env.MONITOR_CONFIG_JSON) {
    throw new Error('MONITOR_CONFIG_JSON must be configured as a GitHub Actions Secret');
  }
  const monitors = loadRuntimeMonitors(process.env.MONITOR_CONFIG_JSON);
  if (!monitors.some((m) => m.enabled)) {
    throw new Error('Private monitoring configuration has no enabled targets');
  }
  const env = {
    MONITOR_CONFIG_JSON: process.env.MONITOR_CONFIG_JSON,
    NOTIFICATION_WINDOW_JST: process.env.NOTIFICATION_WINDOW_JST || undefined,
    WIKIMEDIA_CONTACT_URL: process.env.WIKIMEDIA_CONTACT_URL ||
      (process.env.GITHUB_REPOSITORY ? 'https://github.com/' + process.env.GITHUB_REPOSITORY : undefined),
    DISCORD_WEBHOOK_QIITA: process.env.DISCORD_WEBHOOK_QIITA,
    DISCORD_WEBHOOK_ZENN: process.env.DISCORD_WEBHOOK_ZENN,
    DISCORD_WEBHOOK_ARXIV: process.env.DISCORD_WEBHOOK_ARXIV,
    DISCORD_WEBHOOK_OPENALEX: process.env.DISCORD_WEBHOOK_OPENALEX,
    OPENALEX_API_KEY: process.env.OPENALEX_API_KEY,
    DISCORD_WEBHOOK_YOUTUBE: process.env.DISCORD_WEBHOOK_YOUTUBE,
    YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY,
    DISCORD_WEBHOOK_WIKIPEDIA: process.env.DISCORD_WEBHOOK_WIKIPEDIA,
  };
  if (!monitors.some((m) => m.enabled && (
    (m.source === 'qiita' && env.DISCORD_WEBHOOK_QIITA) ||
    (m.source === 'zenn' && env.DISCORD_WEBHOOK_ZENN) ||
    (m.source === 'arxiv' && env.DISCORD_WEBHOOK_ARXIV) ||
    (m.source === 'openalex' && env.DISCORD_WEBHOOK_OPENALEX) ||
    (m.source === 'youtube' && env.DISCORD_WEBHOOK_YOUTUBE) ||
    (m.source === 'wikipedia' && env.DISCORD_WEBHOOK_WIKIPEDIA)
  ))) throw new Error('No enabled monitor has a corresponding Discord Webhook Secret');

  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (existsSync(encryptedPath)) {
    const plaintext = decryptState(readFileSync(encryptedPath), key);
    writeFileSync(databasePath, plaintext, { mode: 0o600 });
  }
  const { raw, db } = openDatabase(databasePath);
  let failed = false;
  try {
    applyMigrations(raw);
    env.DB = db;
    const restore = silenceInternalLogs();
    try {
      // Executes exactly one due monitor and the same Discord send policy.
      await Worker.scheduled({ cron: '*/5 * * * *' }, env);
      // Idempotent, bounded retention; no second workflow Cron is needed.
      await pruneSentDeliveries(db, Date.now(), monitors);
    } catch {
      failed = true;
    } finally {
      restore();
    }
  } finally {
    raw.close();
    // Even if source fetch fails, persist its retry deadline and pending queue.
    writeFileSync(encryptedPath, encryptState(readFileSync(databasePath), key), { mode: 0o600 });
  }
  if (failed) throw new Error('One notification tick failed; encrypted state was saved');
  console.log('Notification tick finished; encrypted state saved');
}

try {
  await main();
} catch (error) {
  // Suppress dynamic exceptions: raw private queries, channel IDs and URLs
  // must not appear in public Actions logs.
  if (error?.message === 'One notification tick failed; encrypted state was saved') {
    console.error(error.message);
  } else {
    console.error('Notification task could not complete. Check Secrets, artifact recovery and configuration.');
  }
  process.exitCode = 1;
}
