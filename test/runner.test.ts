import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runTick } from '../src/runner.ts';
import { MONITORS, validateMonitors, withIntervals } from '../src/config.ts';
import { claim, ensureMonitor, getRunnableIds } from '../src/state.ts';
import { parseQiita } from '../src/sources/qiita.ts';
import { parseNewPages, fetchWikipedia } from '../src/sources/wikipedia.ts';
import { webhookFor, notifyDiscord } from '../src/discord.ts';
import type { Database, Env, Monitor, ContentItem } from '../src/types.ts';

const webhook = 'https://discord.com/api/webhooks/123456789/a-secure-token';
const qiita: Monitor = { id: 'qiita-rust', source: 'qiita', query: 'tag:Rust', intervalMinutes: 60, enabled: true };
const item = (id: string, at: number): ContentItem => ({
  id: 'qiita:' + id, title: 'Article ' + id, url: 'https://qiita.com/example/items/' + id, publishedAt: at,
});
function setup() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  const db: Database = {
    prepare(sql) {
      const statement = raw.prepare(sql);
      let values: unknown[] = [];
      const facade = {
        bind(...args: unknown[]) { values = args; return facade; },
        async first<T>() { return (statement.get(...values as []) ?? null) as T | null; },
        async all<T>() { return { results: statement.all(...values as []) as T[] }; },
        async run() { return { meta: { changes: Number(statement.run(...values as []).changes) } }; },
      };
      return facade;
    },
  };
  const env: Env = { DB: db, DISCORD_WEBHOOK_QIITA: webhook };
  let articles: ContentItem[] = [];
  let failure = false;
  let token = 0;
  const sent: string[] = [];
  const deps = {
    fetchItems: async () => ({ items: articles, potentiallyTruncated: false }),
    send: async (_hook: string, _source: string, entry: ContentItem) => {
      if (failure) throw new Error('send failed');
      sent.push(entry.id);
    },
    randomId: () => 'token-' + ++token,
  };
  return {
    raw, env, sent, deps,
    setItems(value: ContentItem[]) { articles = value; },
    fail(value: boolean) { failure = value; },
  };
}

test('monitor durations come solely from integer minute config', () => {
  const definition = [{ id: 'm', source: 'qiita' as const, query: '', enabled: true }];
  assert.equal(withIntervals(definition, { m: 1 })[0]?.intervalMinutes, 1);
  assert.equal(withIntervals(definition, { m: 7 })[0]?.intervalMinutes, 7);
  for (const invalid of [0, -1, 1.5, '1', null, NaN, Infinity]) {
    assert.throws(() => withIntervals(definition, { m: invalid }));
  }
  assert.throws(() => withIntervals(definition, {}));
  assert.throws(() => withIntervals(definition, { m: 1, extra: 3 }));
  assert.doesNotThrow(() => validateMonitors(MONITORS));
});

test('first observation creates silent baseline; subsequent article sends once', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  s.setItems([item('old', now - 1_000)]);
  assert.equal(await runTick(s.env, [qiita], now, s.deps), 'processed');
  assert.deepEqual(s.sent, []);
  s.setItems([item('new', now + 1_000), item('old', now - 1_000), item('backfill', now - 5_000)]);
  assert.equal(await runTick(s.env, [qiita], now + 60 * 60_000, s.deps), 'processed');
  assert.deepEqual(s.sent, ['qiita:new']);
  await runTick(s.env, [qiita], now + 120 * 60_000, s.deps);
  assert.deepEqual(s.sent, ['qiita:new']);
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='qiita:backfill'").get()?.status, 'ignored');
});

test('a configured seven-minute interval determines next due and rejects early checks', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  s.setItems([item('old', now - 1000)]);
  const seven = { ...qiita, intervalMinutes: 7 };
  await runTick(s.env, [seven], now, s.deps);
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state').get()?.next_due_at, now + 7 * 60_000);
  assert.equal(await runTick(s.env, [seven], now + 6 * 60_000, s.deps), 'idle');
  assert.equal(await runTick(s.env, [seven], now + 7 * 60_000, s.deps), 'processed');
});

test('failed Discord delivery remains pending and is retried', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  s.setItems([item('old', now - 1_000)]);
  await runTick(s.env, [qiita], now, s.deps);
  s.setItems([item('fresh', now + 1_000)]);
  s.fail(true);
  await runTick(s.env, [qiita], now + 60 * 60_000, s.deps);
  assert.deepEqual(s.sent, []);
  s.fail(false);
  await runTick(s.env, [qiita], now + 65 * 60_000, s.deps);
  assert.deepEqual(s.sent, ['qiita:fresh']);
  assert.equal(s.raw.prepare("SELECT attempts FROM deliveries WHERE item_id='qiita:fresh'").get()?.attempts, 1);
});

test('source error preserves uninitialized state and schedules a retry', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  await assert.rejects(() => runTick(s.env, [qiita], now, {
    ...s.deps, fetchItems: async () => { throw new Error('simulated 503'); },
  }), /503/);
  assert.equal(s.raw.prepare('SELECT initialized_at FROM monitor_state').get()?.initialized_at, null);
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state').get()?.next_due_at, now + 5 * 60_000);
});

test('lease excludes concurrent monitor claims', async () => {
  const s = setup();
  await ensureMonitor(s.env.DB, qiita.id);
  assert.equal(await claim(s.env.DB, qiita.id, 'first', 1_000), true);
  assert.equal(await claim(s.env.DB, qiita.id, 'second', 1_000), false);
  assert.deepEqual(await getRunnableIds(s.env.DB, 1_000), []);
  assert.equal(await claim(s.env.DB, qiita.id, 'third', 122_000), true);
});

test('Qiita uses original creation time and stable ID', () => {
  const parsed = parseQiita([{
    id: 'abc123', title: 'Rust', url: 'https://qiita.com/example/items/abc123',
    created_at: '2026-09-01T00:00:00+09:00', updated_at: '2026-10-10T00:00:00+09:00',
  }]);
  assert.equal(parsed[0]?.id, 'qiita:abc123');
  assert.equal(parsed[0]?.publishedAt, Date.parse('2026-09-01T00:00:00+09:00'));
  assert.throws(() => parseQiita([{ id: 'a', title: 'x', url: 'http://evil.example/', created_at: '2026-01-01' }]));
});

test('Wikipedia selects only newly created pages, never edits', async () => {
  const raw = { query: { recentchanges: [{
    type: 'new', ns: 0, pageid: 123, title: 'New page', timestamp: '2026-10-10T01:00:00Z',
  }] } };
  assert.equal(parseNewPages(raw, 'ja')[0]?.id, 'wikipedia:ja:123');
  assert.throws(() => parseNewPages({ query: { recentchanges: [{ ...raw.query.recentchanges[0], type: 'edit' }] } }, 'ja'));
  const result = await fetchWikipedia({ ...qiita, source: 'wikipedia', query: 'ja' }, async (url) => {
    const u = new URL(String(url));
    assert.equal(u.searchParams.get('rctype'), 'new');
    assert.equal(u.searchParams.get('rcnamespace'), '0');
    return Response.json(raw);
  });
  assert.equal(result.items.length, 1);
});

test('Discord allows only webhook host and suppresses mentions', async () => {
  const s = setup();
  assert.equal(webhookFor(qiita, s.env), webhook);
  assert.throws(() => webhookFor(qiita, { ...s.env, DISCORD_WEBHOOK_QIITA: 'https://example.com/a' }));
  let body: any = null;
  let waited = false;
  await notifyDiscord(webhook, 'qiita', item('a', 1234), async (url, init) => {
    waited = new URL(String(url)).searchParams.get('wait') === 'true';
    body = JSON.parse(String(init?.body));
    return Response.json({ id: '1' });
  });
  assert.equal(waited, true);
  assert.deepEqual(body?.allowed_mentions, { parse: [] });
});
