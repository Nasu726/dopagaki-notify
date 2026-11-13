// GitHub Actions entrypoint. No Cloudflare APIs are called; the same Worker
// scheduler and source adapters run against a local SQLite adapter.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseKey, encryptState, decryptState } from './state-crypto.mjs';
import { openDatabase, applyMigrations } from './sqlite.mjs';
import { pruneSentDeliveries } from '../../src/maintenance.ts';
import { selectActionsConfig, buildActionsEnv } from './runtime-config.mjs';
import { runDueMonitorsOnce } from './tick-loop.mjs';

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
  const config = selectActionsConfig(process.env.MONITOR_CONFIG_MODE,
    process.env.MONITOR_CONFIG_JSON);
  const monitors = config.monitors;
  if (!monitors.some((m) => m.enabled)) {
    throw new Error('Configured monitor roster has no enabled targets');
  }
  // Unregistered Secrets/Variables arrive as '' and are treated as unset.
  // Wikimedia contact defaults to the fork's own GITHUB_REPOSITORY URL.
  const env = buildActionsEnv(process.env, config.configJson);
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
      // Visits every monitor that is due at the start of this run once, with
      // the same per-monitor tick and Discord send policy as the Worker.
      const summary = await runDueMonitorsOnce(env, monitors);
      if (summary.failed) failed = true;
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
