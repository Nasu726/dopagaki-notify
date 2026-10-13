import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRuntimeMonitors } from '../src/config.ts';
import { isJstNotificationTime, isJstWeekday, nextHourlyJstWeekdayDue } from '../src/schedule.ts';
import { fetchQiita } from '../src/sources/qiita.ts';
import { fetchZenn } from '../src/sources/zenn.ts';
import { fetchArxiv } from '../src/sources/arxiv.ts';
import { fetchYouTube } from '../src/sources/youtube.ts';
import { fetchWikipediaDiscovery } from '../src/sources/wikipedia.ts';
import { notifyDiscord, webhookFor } from '../src/discord.ts';
import { HttpStatusError } from '../src/http.ts';

// The artifact is readable by others on public repositories. Store HMACs
// only, never raw subscription IDs, article titles, URLs, or webhook tokens.
const STATE_PATH = '.private/gha-ledger.json';
const TEN_DAYS = 10 * 86400_000;
const MAX_ARXIV_PAGES = 10;
const FIVE_MINUTES = 300_000;
const HOUR = 3600_000;
const HASH_RE = /^[0-9a-f]{64}$/;

export function hmac(key, label, value) {
  return createHmac('sha256', key).update(label + '\0' + value).digest('hex');
}

export function parseSettings(input) {
  if (!input) throw new Error('NOTIFY_SETTINGS_JSON is required');
  let raw;
  try { raw = JSON.parse(input); }
  catch { throw new Error('NOTIFY_SETTINGS_JSON is not valid JSON'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      typeof raw.stateKey !== 'string' || !raw.webhooks ||
      typeof raw.webhooks !== 'object' || Array.isArray(raw.webhooks)) {
    throw new Error('NOTIFY_SETTINGS_JSON must include stateKey, webhooks, targets and intervals');
  }
  const key = Buffer.from(raw.stateKey, 'base64');
  if (key.length < 32 || key.toString('base64') !== raw.stateKey.trim()) {
    throw new Error('NOTIFY_SETTINGS_JSON stateKey must be at least 32 random base64-encoded bytes');
  }
  // Reuse the same schema validation as the Cloudflare private configuration.
  let monitors;
  try {
    monitors = loadRuntimeMonitors(JSON.stringify({
      targets: raw.targets, intervals: raw.intervals,
      wikipediaEnabled: raw.wikipediaEnabled,
    }));
  } catch {
    throw new Error('NOTIFY_SETTINGS_JSON has invalid monitor configuration');
  }
  const env = {
    DISCORD_WEBHOOK_QIITA: raw.webhooks.qiita,
    DISCORD_WEBHOOK_ZENN: raw.webhooks.zenn,
    DISCORD_WEBHOOK_ARXIV: raw.webhooks.arxiv,
    DISCORD_WEBHOOK_YOUTUBE: raw.webhooks.youtube,
    DISCORD_WEBHOOK_WIKIPEDIA: raw.webhooks.wikipedia,
  };
  for (const monitor of monitors.filter((m) => m.enabled)) {
    try { webhookFor(monitor, env); }
    catch { throw new Error('NOTIFY_SETTINGS_JSON has a missing or invalid webhook for an enabled source'); }
  }
  return { key, monitors: monitors.filter((m) => m.enabled), env };
}

export function emptyLedger(key) {
  return { version: 1, keyCheck: hmac(key, 'schema', 'gha-ledger-v1'), monitors: {} };
}

export function parseLedger(content, key) {
  if (content === null) return emptyLedger(key);
  let raw;
  try { raw = JSON.parse(content); }
  catch { throw new Error('State artifact is not valid JSON: refusing to reset deduplication'); }
  if (!raw || raw.version !== 1 || raw.keyCheck !== hmac(key, 'schema', 'gha-ledger-v1') ||
      !raw.monitors || typeof raw.monitors !== 'object' || Array.isArray(raw.monitors)) {
    throw new Error('Invalid state artifact or changed HMAC key: refusing to reset silently');
  }
  for (const [monitorKey, state] of Object.entries(raw.monitors)) {
    if (!HASH_RE.test(monitorKey) || !state || typeof state !== 'object' ||
        !Number.isFinite(state.baselineAt) || !Number.isFinite(state.nextDueAt) ||
        !Number.isFinite(state.lastPollAt) || typeof state.needsMorningDelivery !== 'boolean' ||
        !state.sent || typeof state.sent !== 'object' || Array.isArray(state.sent)) {
      throw new Error('Invalid state artifact entry');
    }
    if (Object.entries(state.sent).some(([digest, timestamp]) =>
      !HASH_RE.test(digest) || !Number.isFinite(timestamp))) {
      throw new Error('Invalid HMAC receipt in state artifact');
    }
  }
  return raw;
}

export function latestThree(items) {
  const unique = new Set();
  return [...items].sort((a, b) => b.publishedAt - a.publishedAt ||
    a.id.localeCompare(b.id)).filter((item) => {
    if (unique.has(item.id)) return false;
    unique.add(item.id);
    return true;
  }).slice(0, 3);
}

async function fetchForMonitor(monitor, priorPoll, fetcher) {
  switch (monitor.source) {
    case 'qiita':
      return (await fetchQiita(monitor, fetcher)).items;
    case 'zenn':
      return (await fetchZenn(monitor, fetcher)).items;
    case 'youtube':
      return (await fetchYouTube(monitor, fetcher)).items;
    case 'wikipedia':
      return (await fetchWikipediaDiscovery(monitor, fetcher)).items;
    case 'arxiv': {
      const found = [];
      let cursor = null;
      const overlap = priorPoll === null ? null : priorPoll - 48 * HOUR;
      for (let page = 0; page < MAX_ARXIV_PAGES; page++) {
        const result = await fetchArxiv(monitor, fetcher, cursor);
        found.push(...result.items);
        if (!result.nextCursor || result.items.some((item) =>
          overlap !== null && item.publishedAt <= overlap)) return found;
        cursor = result.nextCursor;
      }
      // If a single source has >200 recent papers, don't silently call it
      // an exhaustive scan. Next scheduled check will try from the head.
      console.warn('arXiv hit its 10-page Actions polling limit');
      return found;
    }
    default:
      throw new Error('Unknown monitor source');
  }
}

function chooseCandidates(monitor, items, state, key, now) {
  if (monitor.source === 'wikipedia') {
    const selected = [];
    for (const kind of ['featured', 'random']) {
      const candidate = items.find((item) => item.discoveryKind === kind &&
        state.sent[hmac(key, 'item', monitor.source + '\0' + monitor.query + '\0' + item.id)] === undefined);
      if (candidate) selected.push({ ...candidate, publishedAt: now });
    }
    return selected;
  }
  const pool = monitor.source === 'qiita' || monitor.source === 'zenn'
    ? latestThree(items) : items;
  return pool.filter((item) =>
    item.publishedAt > state.baselineAt &&
    item.publishedAt <= now &&
    item.publishedAt > now - TEN_DAYS);
}

function persist(file, ledger) {
  mkdirSync('.private', { recursive: true });
  writeFileSync(file, JSON.stringify(ledger) + '\n', { mode: 0o600 });
}

export async function pollOnce(settings, ledger, now, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const send = dependencies.send ?? notifyDiscord;
  const fetchItems = dependencies.fetchItems ?? fetchForMonitor;
  const save = dependencies.save ?? (() => {});
  let errors = 0;
  let delivered = 0;
  for (const monitor of settings.monitors) {
    const key = hmac(settings.key, 'monitor',
      monitor.source + '\0' + monitor.id + '\0' + monitor.query);
    let state = ledger.monitors[key];
    if (state && state.nextDueAt > now &&
        !(state.needsMorningDelivery && isJstNotificationTime(now))) continue;
    if (monitor.weeklyJstDay && !isJstWeekday(now, monitor.weeklyJstDay) &&
        !(state?.needsMorningDelivery && isJstNotificationTime(now))) {
      if (state) {
        state.nextDueAt = nextHourlyJstWeekdayDue(now, monitor.weeklyJstDay);
        save(ledger);
      }
      continue;
    }
    const nextDue = monitor.weeklyJstDay
      ? nextHourlyJstWeekdayDue(now, monitor.weeklyJstDay)
      : now + monitor.intervalMinutes * 60_000;
    const isFirst = !state;
    try {
      const previous = state?.lastPollAt ?? null;
      const items = await fetchItems(monitor, previous, fetcher);
      if (!state) {
        state = { baselineAt: now, lastPollAt: now, nextDueAt: nextDue,
          needsMorningDelivery: false, sent: {} };
        ledger.monitors[key] = state;
        save(ledger);
        console.log('Initial silent baseline completed for ' + monitor.source);
        continue;
      }
      for (const [id, sentAt] of Object.entries(state.sent)) {
        if (sentAt < now - TEN_DAYS) delete state.sent[id];
      }
      const selected = chooseCandidates(monitor, items, state, settings.key, now);
      let retryNeeded = false;
      let morningNeeded = false;
      for (const item of selected) {
        const receipt = hmac(settings.key, 'item',
          monitor.source + '\0' + monitor.query + '\0' + item.id);
        if (state.sent[receipt] !== undefined) continue;
        if (!isJstNotificationTime(now)) {
          morningNeeded = true;
          continue;
        }
        try {
          const webhook = webhookFor(monitor, settings.env);
          await send(webhook, monitor.source, item, fetcher);
          state.sent[receipt] = now;
          delivered++;
          save(ledger);
        } catch (error) {
          retryNeeded = true;
          errors++;
          const status = error instanceof HttpStatusError ? error.status : 'network';
          console.error('Discord delivery failed for ' + monitor.source + ': ' + status);
          // One source shares one webhook: avoid flooding it after an error.
          break;
        }
      }
      state.lastPollAt = now;
      state.nextDueAt = retryNeeded ? now + FIVE_MINUTES : nextDue;
      state.needsMorningDelivery = morningNeeded;
      save(ledger);
    } catch (error) {
      errors++;
      const status = error instanceof HttpStatusError ? error.status : 'network/parser';
      console.error('Source fetch failed for ' + monitor.source + ': ' + status);
      if (state) {
        state.nextDueAt = now +
          (monitor.source === 'youtube' && status === 404 ? HOUR : FIVE_MINUTES);
        save(ledger);
      }
    }
  }
  return { delivered, errors };
}

export async function main() {
  const settings = parseSettings(process.env.NOTIFY_SETTINGS_JSON);
  const content = existsSync(STATE_PATH) ? readFileSync(STATE_PATH, 'utf8') : null;
  const ledger = parseLedger(content, settings.key);
  persist(STATE_PATH, ledger);
  const result = await pollOnce(settings, ledger, Date.now(), {
    save: (current) => persist(STATE_PATH, current),
  });
  console.log('Actions notifier finished; delivered=' + result.delivered +
    ', failures=' + result.errors);
  if (result.errors) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
