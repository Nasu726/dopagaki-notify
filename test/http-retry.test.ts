import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HttpStatusError, requireSuccess, retryAfterMs } from '../src/http.ts';
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
  for (const n of ['0001_init', '0003_catchup', '0004_monitor_identity', '0005_scan_coverage', '0006_webhook_cooldown'])
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
  assert.equal(raw.prepare('SELECT webhook_cooldown_until FROM monitor_state').get()?.webhook_cooldown_until,
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
