import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HttpStatusError, isWebhookInvalid, requireSuccess, retryAfterMs } from '../src/http.ts';
import { notifyDiscord } from '../src/discord.ts';
import { fetchQiita } from '../src/sources/qiita.ts';
import { runTick } from '../src/runner.ts';
import type { Database, Env, Monitor, ContentItem } from '../src/types.ts';

const now = Date.parse('2026-10-10T00:00:00Z');
const hook = 'https://discord.com/api/webhooks/123456789/token';
const monitor: Monitor = { id: 'qiita-test', source: 'qiita', query: 'tag:Rust', intervalMinutes: 60, enabled: true };
const make = (id: string, publishedAt = now + 1_000): ContentItem => ({
  id: 'qiita:' + id, title: id, url: 'https://qiita.com/u/items/' + id, publishedAt,
});
function database() {
  const raw = new DatabaseSync(':memory:');
  for (const n of ['0001_init', '0003_catchup', '0004_monitor_identity', '0005_scan_coverage', '0006_webhook_cooldown', '0007_webhook_disabled', '0008_source_webhook_state'])
    raw.exec(readFileSync(new URL('../migrations/' + n + '.sql', import.meta.url), 'utf8'));
  const DB: Database = {
    prepare(sql) {
      const statement = raw.prepare(sql);
      let params: unknown[] = [];
      const bound = {
        bind(...args: unknown[]) { params = args; return bound; },
        async first<T>() { return (statement.get(...params as []) ?? null) as T | null; },
        async all<T>() { return { results: statement.all(...params as []) as T[] }; },
        async run() { return { meta: { changes: Number(statement.run(...params as []).changes) } }; },
      };
      return bound;
    },
  };
  const env: Env = { DB, DISCORD_WEBHOOK_QIITA: hook };
  return { env, raw };
}

test('Retry-After accepts seconds, dates and Discord reset-after; ignores invalid values', () => {
  assert.equal(retryAfterMs(new Response('', { status: 429, headers: { 'Retry-After': '300' } }), now), 300_000);
  assert.equal(retryAfterMs(new Response('', {
    status: 429, headers: { 'Retry-After': new Date(now + 600_000).toUTCString() },
  }), now), 600_000);
  assert.equal(retryAfterMs(new Response('', {
    status: 429, headers: { 'X-RateLimit-Reset-After': '2.75' },
  }), now), 2750);
  assert.equal(retryAfterMs(new Response('', {
    status: 429, headers: { 'Retry-After': 'oops' },
  }), now), null);
  assert.equal(retryAfterMs(new Response('', {
    status: 429, headers: { 'Retry-After': '-99' },
  }), now), null);
  assert.throws(() => requireSuccess(new Response('', {
    status: 429, headers: { 'Retry-After': '450' },
  }), 'Qiita', now), (error: unknown) => {
    assert.ok(error instanceof HttpStatusError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterMs, 450_000);
    return true;
  });
});

test('actual Qiita and Discord HTTP failures produce typed cooldown hints', async () => {
  await assert.rejects(() => fetchQiita(monitor, async () => new Response('', {
    status: 429, headers: { 'Retry-After': '3600' },
  })), (err: unknown) => err instanceof HttpStatusError && err.retryAfterMs === 3_600_000);
  await assert.rejects(() => notifyDiscord(hook, 'qiita', make('a'), async () => new Response('', {
    status: 429, headers: { 'X-RateLimit-Reset-After': '900' },
  })), (err: unknown) => err instanceof HttpStatusError && err.retryAfterMs === 900_000);
});

test('429 from a source preserves the checkpoint and postpones new fetching for Retry-After', async () => {
  const { env, raw } = database();
  const deps = {
    fetchItems: async () => { throw new HttpStatusError('Qiita', 429, 30 * 60_000); },
    send: async () => {},
    randomId: () => 'source-rate-limit',
  };
  await assert.rejects(() => runTick(env, [monitor], now, deps), /Qiita HTTP 429/);
  const stored = raw.prepare('SELECT initialized_at, next_due_at, scan_cursor FROM monitor_state').get();
  assert.equal(stored?.initialized_at, null);
  assert.equal(stored?.scan_cursor, null);
  assert.equal(stored?.next_due_at, now + 30 * 60_000);
  assert.equal(await runTick(env, [monitor], now + 5 * 60_000, deps), 'idle');
});

test('Discord 429 postpones every pending article; no second send is attempted in the same tick', async () => {
  const { env, raw } = database();
  let items: ContentItem[] = [];
  let throttled = false;
  const attempts: string[] = [];
  const deps = {
    fetchItems: async () => ({ items, potentiallyTruncated: false }),
    send: async (_webhook: string, _source: string, item: ContentItem) => {
      attempts.push(item.id);
      if (throttled) throw new HttpStatusError('Discord', 429, 20 * 60_000);
    },
    randomId: () => crypto.randomUUID(),
  };
  await runTick(env, [monitor], now, deps); // silent baseline
  items = [make('a'), make('b', now + 2_000), make('c', now + 3_000)];
  throttled = true;
  await runTick(env, [monitor], now + 60 * 60_000, deps);
  assert.deepEqual(attempts, ['qiita:a']);
  const before = raw.prepare("SELECT item_id, attempts, next_attempt_at FROM deliveries ORDER BY item_id").all() as
    Array<{ item_id: string; attempts: number; next_attempt_at: number }>;
  assert.deepEqual(before.map((row) => row.attempts), [1, 0, 0]);
  assert.deepEqual(before.map((row) => row.next_attempt_at), [now + 80 * 60_000, 0, 0]);
  assert.equal(raw.prepare("SELECT cooldown_until FROM webhook_source_state WHERE source='qiita'").get()?.cooldown_until,
    now + 80 * 60_000);
  assert.equal(await runTick(env, [monitor], now + 61 * 60_000, deps), 'idle');
  throttled = false;
  await runTick(env, [monitor], now + 80 * 60_000, deps);
  assert.deepEqual(attempts, ['qiita:a', 'qiita:a', 'qiita:b', 'qiita:c']);
  assert.equal(raw.prepare("SELECT count(*) AS c FROM deliveries WHERE status='sent'").get()?.c, 3);
});

test('new items discovered while a webhook is cooling down never bypass its 429 barrier', async () => {
  const { env, raw } = database();
  const fast = { ...monitor, intervalMinutes: 5 };
  let items: ContentItem[] = [];
  let shouldLimit = false;
  const sent: string[] = [];
  const deps = {
    fetchItems: async () => ({ items, potentiallyTruncated: false }),
    send: async (_webhook: string, _source: string, item: ContentItem) => {
      sent.push(item.id);
      if (shouldLimit) throw new HttpStatusError('Discord', 429, 20 * 60_000);
    },
    randomId: () => crypto.randomUUID(),
  };
  await runTick(env, [fast], now, deps);
  items = [make('a'), make('b', now + 2_000)];
  shouldLimit = true;
  await runTick(env, [fast], now + 5 * 60_000, deps);
  assert.deepEqual(sent, ['qiita:a']);

  items = [make('c', now + 3_000), ...items];
  shouldLimit = false;
  await runTick(env, [fast], now + 10 * 60_000, deps);
  assert.deepEqual(sent, ['qiita:a'], 'new articles must not be sent before webhook cooldown ends');
  assert.equal(raw.prepare("SELECT count(*) AS n FROM deliveries WHERE status='pending'").get()?.n, 3);
  assert.equal(await runTick(env, [fast], now + 11 * 60_000, deps), 'idle');
  await runTick(env, [fast], now + 25 * 60_000, deps);
  assert.deepEqual(sent, ['qiita:a', 'qiita:a', 'qiita:b', 'qiita:c']);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM deliveries WHERE status='sent'").get()?.n, 3);
});

test('invalid webhook status disables future delivery without dropping pending messages', async () => {
  const { env, raw } = database();
  const attempts: string[] = [];
  let items: ContentItem[] = [];
  let invalid = true;
  const deps = {
    fetchItems: async () => ({ items, potentiallyTruncated: false }),
    send: async (_webhook: string, _source: string, item: ContentItem) => {
      attempts.push(item.id);
      if (invalid) throw new HttpStatusError('Discord', 404, null);
    },
    randomId: () => crypto.randomUUID(),
  };
  await runTick(env, [monitor], now, deps);
  items = [make('a'), make('b', now + 2_000)];
  await runTick(env, [monitor], now + 60 * 60_000, deps);
  assert.deepEqual(attempts, ['qiita:a']);
  assert.equal(raw.prepare("SELECT blocked_status FROM webhook_source_state WHERE source='qiita'").get()?.blocked_status, 404);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM deliveries WHERE status = 'pending'").get()?.n, 2);
  // Another due source scan should stage new items without attempting the dead webhook.
  items = [make('c', now + 3_000), ...items];
  await runTick(env, [monitor], now + 120 * 60_000, deps);
  assert.deepEqual(attempts, ['qiita:a']);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM deliveries WHERE status = 'pending'").get()?.n, 3);
  assert.equal(await runTick(env, [monitor], now + 121 * 60_000, deps), 'idle',
    'blocked-only pending backlog must not create an every-minute hot loop');
  // Operator rotates secret and explicitly clears the blocked marker.
  invalid = false;
  raw.prepare('UPDATE webhook_source_state SET blocked_status = NULL, blocked_at = NULL').run();
  await runTick(env, [monitor], now + 122 * 60_000, deps);
  assert.deepEqual(attempts, ['qiita:a', 'qiita:a', 'qiita:b', 'qiita:c']);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM deliveries WHERE status = 'sent'").get()?.n, 3);
});

test('only unusable Discord webhook statuses trigger permanent suspension', () => {
  for (const status of [401, 403, 404, 410]) {
    assert.equal(isWebhookInvalid(new HttpStatusError('Discord', status, null)), true);
  }
  for (const status of [400, 408, 429, 500, 502]) {
    assert.equal(isWebhookInvalid(new HttpStatusError('Discord', status, null)), false);
  }
  assert.equal(isWebhookInvalid(new Error('network failure')), false);
});

test('same-source monitors share a Discord 429 cooldown; distinct channel source remains independent', async () => {
  const { env, raw } = database();
  env.DISCORD_WEBHOOK_ARXIV = 'https://discord.com/api/webhooks/987654321/another-token';
  const second: Monitor = { ...monitor, id: 'qiita-second', query: 'tag:Python' };
  const other: Monitor = { ...monitor, id: 'arxiv-monitor', source: 'arxiv', query: 'cat:cs.AI' };
  const items = new Map<string, ContentItem[]>();
  const sends: string[] = [];
  let throttle = false;
  const deps = {
    fetchItems: async (m: Monitor) => ({ items: items.get(m.id) ?? [], potentiallyTruncated: false }),
    send: async (_webhook: string, _source: string, item: ContentItem) => {
      sends.push(item.id);
      if (throttle && item.id === 'qiita:first') throw new HttpStatusError('Discord', 429, 20 * 60_000);
    },
    randomId: () => crypto.randomUUID(),
  };
  await runTick(env, [monitor], now, deps);
  await runTick(env, [second], now + 60_000, deps);
  await runTick(env, [other], now + 120_000, deps);
  items.set(monitor.id, [make('first')]);
  items.set(second.id, [make('second')]);
  items.set(other.id, [{ ...make('other'), id: 'arxiv:other' }]);
  throttle = true;
  await runTick(env, [monitor, second, other], now + 60 * 60_000, deps);
  assert.deepEqual(sends, ['qiita:first']);
  assert.equal(raw.prepare("SELECT cooldown_until FROM webhook_source_state WHERE source='qiita'").get()?.cooldown_until,
    now + 80 * 60_000);
  await runTick(env, [monitor, second, other], now + 61 * 60_000, deps);
  assert.deepEqual(sends, ['qiita:first'], 'second Qiita monitor must not send while the shared webhook is throttled');
  assert.equal(raw.prepare("SELECT count(*) AS n FROM deliveries WHERE monitor_id = 'qiita-second' AND status='pending'").get()?.n, 1);
  assert.equal(await runTick(env, [monitor, second], now + 62 * 60_000, deps), 'idle');
  throttle = false;
  await runTick(env, [other], now + 63 * 60_000, deps);
  assert.deepEqual(sends, ['qiita:first', 'arxiv:other'],
    'a separate webhook in another channel/source remains operational');
  await runTick(env, [monitor, second], now + 80 * 60_000, deps);
  await runTick(env, [monitor, second], now + 81 * 60_000, deps);
  assert.deepEqual(sends, ['qiita:first', 'arxiv:other', 'qiita:first', 'qiita:second']);
});

test('a deleted source webhook suspends all its monitors until source-level reset', async () => {
  const { env, raw } = database();
  const second: Monitor = { ...monitor, id: 'qiita-second', query: 'tag:Python' };
  const items = new Map<string, ContentItem[]>();
  let invalid = true;
  const sent: string[] = [];
  const deps = {
    fetchItems: async (m: Monitor) => ({ items: items.get(m.id) ?? [], potentiallyTruncated: false }),
    send: async (_webhook: string, _source: string, item: ContentItem) => {
      sent.push(item.id);
      if (invalid) throw new HttpStatusError('Discord', 404, null);
    },
    randomId: () => crypto.randomUUID(),
  };
  await runTick(env, [monitor], now, deps);
  await runTick(env, [second], now + 60_000, deps);
  items.set(monitor.id, [make('first')]);
  items.set(second.id, [make('second')]);
  await runTick(env, [monitor, second], now + 60 * 60_000, deps);
  assert.deepEqual(sent, ['qiita:first']);
  await runTick(env, [monitor, second], now + 61 * 60_000, deps);
  assert.deepEqual(sent, ['qiita:first']);
  assert.equal(raw.prepare("SELECT blocked_status FROM webhook_source_state WHERE source='qiita'").get()?.blocked_status, 404);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM deliveries WHERE status='pending'").get()?.n, 2);
  invalid = false;
  raw.prepare("UPDATE webhook_source_state SET blocked_status=NULL, blocked_at=NULL WHERE source='qiita'").run();
  await runTick(env, [monitor, second], now + 62 * 60_000, deps);
  await runTick(env, [monitor, second], now + 63 * 60_000, deps);
  assert.deepEqual(sent, ['qiita:first', 'qiita:first', 'qiita:second']);
});
