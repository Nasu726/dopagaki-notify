import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runTick } from '../src/runner.ts';
import { HttpStatusError } from '../src/http.ts';
import { isJstNotificationTime, isJstWeekday, nextHourlyJstWeekdayDue, parseNotificationWindowJst } from '../src/schedule.ts';
import { DELIVERY_RETENTION_MS, PRUNE_BATCH_SIZE, pruneSentDeliveries } from '../src/maintenance.ts';
import Worker from '../src/index.ts';
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
  raw.exec(readFileSync(new URL('../migrations/0003_catchup.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/0004_monitor_identity.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/0005_scan_coverage.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/0006_webhook_cooldown.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/0007_webhook_disabled.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/0008_source_webhook_state.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/0009_delivery_retention.sql', import.meta.url), 'utf8'));

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
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='qiita:backfill'").get(), undefined);
});


test('Wikipedia samples three newest pages once per two hours, without catch-up pagination', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_WIKIPEDIA = webhook;
  const wikipedia: Monitor = {
    id: 'wikipedia-ja', source: 'wikipedia', query: 'ja', enabled: true, intervalMinutes: 120,
  };
  const now = Date.parse('2026-10-10T00:00:00Z'); // 09:00 JST
  const page = (id: number, publishedAt: number): ContentItem => ({
    id: 'wikipedia:ja:' + id, title: 'Page ' + id,
    url: 'https://ja.wikipedia.org/?curid=' + id, publishedAt,
  });
  let feed = [page(1, now - 60_000)];
  let fetches = 0;
  const deps = { ...s.deps, fetchItems: async () => {
    fetches++;
    return { items: feed, potentiallyTruncated: false, nextCursor: 'obsolete-cursor' };
  } };
  await runTick(s.env, [wikipedia], now, deps);
  assert.deepEqual(s.sent, [], 'first scan creates a silent baseline');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state').get()?.next_due_at,
    now + 120 * 60_000);
  feed = Array.from({ length: 12 }, (_, i) => page(i + 2, now + (i + 1) * 60_000));
  await runTick(s.env, [wikipedia], now + 120 * 60_000, deps);
  assert.deepEqual(s.sent, ['wikipedia:ja:13', 'wikipedia:ja:12', 'wikipedia:ja:11']);
  assert.equal(s.raw.prepare('SELECT COUNT(*) AS n FROM deliveries').get()?.n, 3);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, null);
  assert.equal(await runTick(s.env, [wikipedia], now + 125 * 60_000, deps), 'idle');
  assert.equal(await runTick(s.env, [wikipedia], now + 239 * 60_000, deps), 'idle');
  assert.equal(fetches, 2);
});

test('Wikipedia stale pending backlog does not wake the five-minute dispatcher', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_WIKIPEDIA = webhook;
  const wikipedia: Monitor = {
    id: 'wikipedia-ja', source: 'wikipedia', query: 'ja', enabled: true, intervalMinutes: 120,
  };
  const now = Date.parse('2026-10-10T00:00:00Z');
  await runTick(s.env, [wikipedia], now, s.deps);
  s.raw.prepare(
    "INSERT INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at) " +
    "VALUES (?,?,'pending',?,?,?,?)"
  ).run(wikipedia.id, 'wikipedia:ja:999', 'Stale',
    'https://ja.wikipedia.org/?curid=999', now - 60_000, now);
  assert.equal(await runTick(s.env, [wikipedia], now + 5 * 60_000, s.deps), 'idle');
  await runTick(s.env, [wikipedia], now + 120 * 60_000, s.deps);
  assert.equal(s.raw.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status='pending'").get()?.n, 0);
  assert.deepEqual(s.sent, []);
});

test('missing Discord Secret disables only that monitor with zero D1 writes', async () => {
  const s = setup();
  const monitor: Monitor = {
    id: 'arxiv-cs-ai', source: 'arxiv', query: 'cat:cs.AI',
    enabled: true, intervalMinutes: 120,
  };
  assert.equal(await runTick(s.env, [monitor], Date.parse('2026-10-10T00:00:00Z'), s.deps), 'idle');
  assert.equal(s.raw.prepare('SELECT COUNT(*) AS n FROM monitor_state').get()?.n, 0);
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
  assert.equal(await claim(s.env.DB, qiita.id, qiita.source, 'first', 1_000), true);
  assert.equal(await claim(s.env.DB, qiita.id, qiita.source, 'second', 1_000), false);
  assert.deepEqual(await getRunnableIds(s.env.DB, 1_000, [qiita]), []);
  assert.equal(await claim(s.env.DB, qiita.id, qiita.source, 'third', 122_000), true);
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
    assert.equal(u.searchParams.get('rclimit'), '3');
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

test('pagination checkpoint survives the next Cron invocation and completes with correct due time', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_ARXIV = webhook;
  const paged: Monitor = { ...qiita, id: 'arxiv-test', source: 'arxiv' };
  const now = Date.parse('2026-10-10T00:00:00Z');
  s.setItems([item('old', now - 1000)]);
  await runTick(s.env, [paged], now, s.deps);
  const seen: Array<string | null | undefined> = [];
  const paging = { ...s.deps, fetchItems: async (_m: Monitor, _e: Env, cursor?: string | null) => {
    seen.push(cursor);
    return cursor == null
      ? { items: [item('new1', now + 1000)], nextCursor: '2', potentiallyTruncated: false }
      : { items: [item('new2', now + 2000)], nextCursor: null, potentiallyTruncated: false };
  } };
  assert.equal(await runTick(s.env, [paged], now + 60 * 60_000, paging), 'processed');
  assert.deepEqual(seen, [null]);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, '2');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state').get()?.next_due_at, now + 61 * 60_000);
  assert.deepEqual(s.sent, ['qiita:new1']);
  assert.equal(await runTick(s.env, [paged], now + 61 * 60_000, paging), 'processed');
  assert.deepEqual(seen, [null, '2']);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, '__verify_head__');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state').get()?.next_due_at, now + 62 * 60_000);
  await runTick(s.env, [paged], now + 62 * 60_000, paging);
  assert.deepEqual(seen, [null, '2', null], 'verification must refetch page 1 exactly once');
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, null);
  assert.equal(s.raw.prepare('SELECT scan_started_at FROM monitor_state').get()?.scan_started_at, null);
  assert.equal(s.raw.prepare('SELECT last_complete_at FROM monitor_state').get()?.last_complete_at, now + 60 * 60_000);
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state').get()?.next_due_at, now + 122 * 60_000);
  assert.deepEqual(s.sent, ['qiita:new1', 'qiita:new2']);
});

test('continuation failure does not lose D1 cursor, or double-notify completed page', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_ARXIV = webhook;
  const paged: Monitor = { ...qiita, id: 'arxiv-test', source: 'arxiv' };
  const now = Date.parse('2026-10-10T00:00:00Z');
  await runTick(s.env, [paged], now, s.deps);
  const paging = { ...s.deps, fetchItems: async (_m: Monitor, _e: Env, cursor?: string | null) => {
    if (cursor) throw new Error('page 2 temporarily unavailable');
    return { items: [item('fresh', now + 100)], nextCursor: '2', potentiallyTruncated: false };
  } };
  await runTick(s.env, [paged], now + 60 * 60_000, paging);
  await assert.rejects(() => runTick(s.env, [paged], now + 61 * 60_000, paging), /page 2/);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, '2');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state').get()?.next_due_at, now + 66 * 60_000);
  const resumed = { ...paging, fetchItems: async (_m: Monitor, _e: Env, cursor?: string | null) => {
    assert.equal(cursor, '2');
    return { items: [item('fresh2', now + 200)], nextCursor: null, potentiallyTruncated: false };
  } };
  await runTick(s.env, [paged], now + 66 * 60_000, resumed);
  assert.deepEqual(s.sent, ['qiita:fresh', 'qiita:fresh2']);
});

test('initialization observes first page only and never floods old content', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  const paging = { ...s.deps, fetchItems: async (_m: Monitor, _e: Env, cursor?: string | null) => {
    assert.equal(cursor, null);
    return { items: [item('old', now - 100)], nextCursor: '2', potentiallyTruncated: false };
  } };
  await runTick(s.env, [qiita], now, paging);
  assert.deepEqual(s.sent, []);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, null);
  assert.equal(s.raw.prepare('SELECT initialized_at FROM monitor_state').get()?.initialized_at, now);
});

test('arXiv uses the overlap to end paging while Qiita ignores continuation', async () => {
  const now = Date.parse('2026-10-10T00:00:00Z');
  const old = item('old', now - 4 * 24 * 60 * 60_000);
  const s = setup();
  s.env.DISCORD_WEBHOOK_ARXIV = webhook;
  const arxiv = { ...qiita, id: 'arxiv-test', source: 'arxiv' as const };
  await runTick(s.env, [arxiv], now, { ...s.deps, fetchItems: async () => ({
    items: [old], nextCursor: '20', potentiallyTruncated: false,
  }) });
  await runTick(s.env, [arxiv], now + 60 * 60_000, { ...s.deps, fetchItems: async () => ({
    items: [old], nextCursor: '20', potentiallyTruncated: false,
  }) });
  assert.equal(s.raw.prepare("SELECT scan_cursor FROM monitor_state WHERE id='arxiv-test'").get()?.scan_cursor, null);
  await runTick(s.env, [qiita], now, { ...s.deps, fetchItems: async () => ({
    items: [old], nextCursor: '2', potentiallyTruncated: false,
  }) });
  await runTick(s.env, [qiita], now + 60 * 60_000, { ...s.deps, fetchItems: async () => ({
    items: [old], nextCursor: '2', potentiallyTruncated: false,
  }) });
  assert.equal(s.raw.prepare("SELECT scan_cursor FROM monitor_state WHERE id='qiita-rust'").get()?.scan_cursor, null);
});

test('fetch errors do not starve pending Discord deliveries', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  s.setItems([item('old', now - 1000)]);
  await runTick(s.env, [qiita], now, s.deps);
  s.setItems([item('fresh', now + 1000)]);
  s.fail(true);
  await runTick(s.env, [qiita], now + 60 * 60_000, s.deps);
  s.fail(false);
  // A fresh fetch fails, but an earlier pending Discord notification is due.
  await assert.rejects(() => runTick(s.env, [qiita], now + 120 * 60_000, {
    ...s.deps, fetchItems: async () => { throw new Error('source 503'); },
  }), /source 503/);
  assert.deepEqual(s.sent, ['qiita:fresh']);
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='qiita:fresh'").get()?.status, 'sent');
  assert.equal(s.raw.prepare("SELECT next_due_at FROM monitor_state WHERE id='qiita-rust'").get()?.next_due_at,
    now + 125 * 60_000);
});

test('quiet Cron performs no D1 initialization write; newly enabled monitor bootstraps once', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  const originalPrepare = s.env.DB.prepare.bind(s.env.DB);
  let bootstrapStatements = 0;
  s.env.DB.prepare = (sql: string) => {
    if (sql.startsWith('INSERT OR IGNORE INTO monitor_state')) bootstrapStatements++;
    return originalPrepare(sql);
  };
  assert.equal(await runTick(s.env, [qiita], now, s.deps), 'processed');
  assert.equal(bootstrapStatements, 1);
  assert.equal(await runTick(s.env, [qiita], now + 60_000, s.deps), 'idle');
  assert.equal(bootstrapStatements, 1, 'idle tick must issue zero bootstrap writes');
  const second: Monitor = { ...qiita, id: 'qiita-second' };
  assert.equal(await runTick(s.env, [qiita, second], now + 120_000, s.deps), 'processed');
  assert.equal(bootstrapStatements, 2, 'a newly added monitor bootstraps one time');
  assert.equal(await runTick(s.env, [qiita, second], now + 180_000, s.deps), 'idle');
  assert.equal(bootstrapStatements, 2);
});

test('changing a source or query with the same monitor ID fails closed; changing interval is allowed', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  s.setItems([item('old', now - 1000)]);
  await runTick(s.env, [qiita], now, s.deps);
  const initialIdentity = s.raw.prepare('SELECT config_identity FROM monitor_state WHERE id = ?')
    .get(qiita.id)?.config_identity;
  assert.equal(initialIdentity, JSON.stringify(['qiita', 'tag:Rust']));
  const due = now + 60 * 60_000;
  await assert.rejects(() => runTick(s.env, [{ ...qiita, query: 'tag:Python' }], due, s.deps),
    /changed source\/query/);
  assert.equal(s.raw.prepare('SELECT config_identity FROM monitor_state WHERE id = ?')
    .get(qiita.id)?.config_identity, initialIdentity);
  // A failed identity check must release its lease, allowing the original monitor to recover.
  assert.equal(await runTick(s.env, [{ ...qiita, intervalMinutes: 7 }], due, s.deps), 'processed');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state WHERE id = ?')
    .get(qiita.id)?.next_due_at, due + 7 * 60_000);
  // New semantic monitoring conditions get a separate silent baseline under a different ID.
  assert.equal(await runTick(s.env, [{ ...qiita, id: 'python', query: 'tag:Python' }], due + 1000, s.deps), 'processed');
  assert.equal(s.raw.prepare('SELECT config_identity FROM monitor_state WHERE id = ?')
    .get('python')?.config_identity, JSON.stringify(['qiita', 'tag:Python']));
});

test('legacy initialized rows without a semantic identity cannot be silently claimed', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  s.raw.prepare('INSERT INTO monitor_state (id,initialized_at,next_due_at) VALUES (?,?,?)')
    .run(qiita.id, now - 1000, 0);
  await assert.rejects(() => runTick(s.env, [qiita], now, s.deps), /no stored source\/query identity/);
  assert.equal(s.raw.prepare('SELECT lease_token FROM monitor_state WHERE id = ?').get(qiita.id)?.lease_token, null);
});

test('Qiita polls only the first search page, even with an old continuation cursor', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  const cursors: Array<string | null | undefined> = [];
  const windows: Array<number | null | undefined> = [];
  const fetcher = { ...s.deps, fetchItems: async (_m: Monitor, _e: Env,
    cursor?: string | null, windowStart?: number | null) => {
    cursors.push(cursor);
    windows.push(windowStart);
    return { items: [item('fresh', now + 1000)], nextCursor: '2', potentiallyTruncated: true };
  }};
  await runTick(s.env, [qiita], now, fetcher); // silent baseline
  s.raw.prepare("UPDATE monitor_state SET scan_cursor='17' WHERE id=?").run(qiita.id);
  await runTick(s.env, [qiita], now + 60 * 60_000, fetcher);
  assert.deepEqual(cursors, [null, null]);
  assert.deepEqual(windows, [null, null]);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state WHERE id=?')
    .get(qiita.id)?.scan_cursor, null);
  assert.equal(s.raw.prepare('SELECT last_complete_at FROM monitor_state WHERE id=?')
    .get(qiita.id)?.last_complete_at, now + 60 * 60_000);
  assert.equal(s.raw.prepare('SELECT incomplete_count FROM monitor_state WHERE id=?')
    .get(qiita.id)?.incomplete_count, 0);
  assert.deepEqual(s.sent, ['qiita:fresh']);
});

test('truncated scan records coverage gap without advancing last successful full-scan time', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_ARXIV = webhook;
  const paged: Monitor = { ...qiita, id: 'arxiv-test', source: 'arxiv' };
  const now = Date.parse('2026-10-10T00:00:00Z');
  // Initial baseline is silent but, when non-exhaustive, must not be called a complete scan.
  await runTick(s.env, [paged], now, { ...s.deps, fetchItems: async () => ({
    items: [item('old', now - 1000)], potentiallyTruncated: true, nextCursor: null,
  }) });
  let state = s.raw.prepare('SELECT * FROM monitor_state WHERE id=?').get(paged.id);
  assert.equal(state?.initialized_at, now);
  assert.equal(state?.last_complete_at, null);
  assert.equal(state?.last_incomplete_at, now);
  assert.equal(state?.incomplete_count, 1);

  const next = now + 60 * 60_000;
  await runTick(s.env, [paged], next, { ...s.deps, fetchItems: async () => ({
    items: [item('fresh', now + 1000)], potentiallyTruncated: false, nextCursor: null,
  }) });
  state = s.raw.prepare('SELECT * FROM monitor_state WHERE id=?').get(paged.id);
  assert.equal(state?.last_complete_at, next);
  assert.equal(state?.incomplete_count, 1);
  assert.deepEqual(s.sent, ['qiita:fresh']);

  const overload = next + 60 * 60_000;
  await runTick(s.env, [paged], overload, { ...s.deps, fetchItems: async () => ({
    items: [item('fresh2', next + 1000)], potentiallyTruncated: true, nextCursor: null,
  }) });
  state = s.raw.prepare('SELECT * FROM monitor_state WHERE id=?').get(paged.id);
  assert.equal(state?.last_complete_at, next, 'full scan checkpoint must not advance on exhaustion');
  assert.equal(state?.last_incomplete_at, overload);
  assert.equal(state?.incomplete_count, 2);
  assert.deepEqual(s.sent, ['qiita:fresh', 'qiita:fresh2']);
  assert.equal(state?.scan_cursor, null, 'exhausted pagination is not resumable');
});

test('head recheck recovers a new article inserted while offset pagination was in progress', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_ARXIV = webhook;
  const paged: Monitor = { ...qiita, id: 'arxiv-test', source: 'arxiv' };
  const now = Date.parse('2026-10-10T00:00:00Z');
  await runTick(s.env, [paged], now, s.deps);
  const seen: Array<string | null | undefined> = [];
  const fetcher = { ...s.deps, fetchItems: async (_m: Monitor, _e: Env, cursor?: string | null) => {
    seen.push(cursor);
    if (seen.length === 1) return {
      items: [item('first', now + 100)], nextCursor: '2', potentiallyTruncated: false,
    };
    if (seen.length === 2) return {
      // A newly inserted top article pushes first onto page 2; ordinary offset
      // pagination would entirely miss it until a new scan begins.
      items: [item('first', now + 100), item('old', now - 100)],
      nextCursor: null, potentiallyTruncated: false,
    };
    return {
      items: [item('late', now + 200), item('first', now + 100)],
      nextCursor: '2', potentiallyTruncated: false,
    };
  } };
  await runTick(s.env, [paged], now + 60 * 60_000, fetcher);
  await runTick(s.env, [paged], now + 61 * 60_000, fetcher);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor,
    '__verify_head__');
  await runTick(s.env, [paged], now + 62 * 60_000, fetcher);
  assert.deepEqual(seen, [null, '2', null]);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, null);
  assert.deepEqual(s.sent, ['qiita:first', 'qiita:late']);
});

test('failed head verification is retried from the head, not marked complete', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_ARXIV = webhook;
  const paged: Monitor = { ...qiita, id: 'arxiv-test', source: 'arxiv' };
  const now = Date.parse('2026-10-10T00:00:00Z');
  await runTick(s.env, [paged], now, s.deps);
  let attempts = 0;
  const fetcher = { ...s.deps, fetchItems: async (_m: Monitor, _e: Env, cursor?: string | null) => {
    attempts++;
    if (attempts === 1) return { items: [item('a', now + 1)], nextCursor: '2', potentiallyTruncated: false };
    if (attempts === 2) return { items: [], nextCursor: null, potentiallyTruncated: false };
    assert.equal(cursor, null);
    if (attempts === 3) throw new Error('head request unavailable');
    return { items: [item('b', now + 2)], nextCursor: null, potentiallyTruncated: false };
  } };
  await runTick(s.env, [paged], now + 60 * 60_000, fetcher);
  await runTick(s.env, [paged], now + 61 * 60_000, fetcher);
  await assert.rejects(() => runTick(s.env, [paged], now + 62 * 60_000, fetcher), /head request/);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, '__verify_head__');
  await runTick(s.env, [paged], now + 67 * 60_000, fetcher);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, null);
  assert.deepEqual(s.sent, ['qiita:a', 'qiita:b']);
});

test('more than 49 configured monitors are selected in D1-safe batches with global due ordering', async () => {
  const s = setup();
  const now = 100_000;
  const monitors: Monitor[] = Array.from({ length: 75 }, (_, n) => ({
    ...qiita, id: 'm-' + String(n).padStart(3, '0'),
  }));
  const insert = s.raw.prepare('INSERT INTO monitor_state (id, next_due_at) VALUES (?,?)');
  for (let i = 0; i < monitors.length; i++) {
    // Interleave idle and due monitors across both batches.
    const deadline = i % 2 ? now - i * 100 : now + 100_000;
    insert.run(monitors[i]!.id, deadline);
  }
  const original = s.env.DB.prepare.bind(s.env.DB);
  let maxParams = 0, dueQueries = 0;
  s.env.DB.prepare = (sql: string) => {
    if (sql.startsWith('WITH enabled(id, source)')) dueQueries++;
    const prepared = original(sql);
    return {
      ...prepared,
      bind(...args: unknown[]) {
        maxParams = Math.max(maxParams, args.length);
        assert.ok(args.length <= 100, 'Cloudflare D1 SQL binding cap');
        return prepared.bind(...args);
      },
    };
  };
  const ids = await getRunnableIds(s.env.DB, now, monitors);
  const expected = monitors.filter((_, n) => n % 2 === 1).reverse().map((m) => m.id);
  assert.deepEqual(ids, expected, 'oldest deadline must take precedence across chunk boundaries');
  assert.equal(dueQueries, 2);
  assert.equal(maxParams, 83);
});

test('atomic lease claim follows shared webhook state, not legacy monitor flags', async () => {
  const s = setup();
  const now = 60_000;
  await ensureMonitor(s.env.DB, qiita.id);
  s.raw.prepare(
    'UPDATE monitor_state SET next_due_at=?, webhook_cooldown_until=?, webhook_blocked_status=? WHERE id=?'
  ).run(now + 60_000, now + 3_600_000, 404, qiita.id);
  s.raw.prepare(
    'INSERT INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at) ' +
    "VALUES (?,?,'pending',?,?,?,?)"
  ).run(qiita.id, 'qiita:new', 'New item', 'https://qiita.com/example/items/new', now, now);
  s.raw.prepare("INSERT INTO webhook_source_state(source,cooldown_until) VALUES ('qiita',?)").run(now + 10_000);
  assert.equal(await claim(s.env.DB, qiita.id, 'qiita', 'a', now), false,
    'active source-level 429 must block pending-only claims');
  s.raw.prepare("UPDATE webhook_source_state SET cooldown_until=0,blocked_status=404 WHERE source='qiita'").run();
  assert.equal(await claim(s.env.DB, qiita.id, 'qiita', 'b', now), false,
    'source-level invalid webhook must block pending-only claims');
  s.raw.prepare("UPDATE webhook_source_state SET blocked_status=NULL WHERE source='qiita'").run();
  assert.equal(await claim(s.env.DB, qiita.id, 'qiita', 'c', now), true,
    'legacy monitor-level cooldown/block must not suppress recovered source state');
  s.raw.prepare('UPDATE monitor_state SET lease_token=NULL,lease_until=NULL,next_due_at=0 WHERE id=?')
    .run(qiita.id);
  s.raw.prepare("UPDATE webhook_source_state SET blocked_status=404 WHERE source='qiita'").run();
  assert.equal(await claim(s.env.DB, qiita.id, 'qiita', 'd', now), true,
    'an ordinary due source fetch must still run while the Webhook is blocked');
});

test('one-shot remote D1 smoke SQL requires an initialized monitor with matching identity', () => {
  const s = setup();
  const probe = readFileSync(new URL('../ops/qiita-one-shot-smoke.sql', import.meta.url), 'utf8');
  const rowCount = () => Number(s.raw.prepare(
    "SELECT COUNT(*) AS n FROM deliveries WHERE item_id='smoke:qiita:discord-outbox:2026-10-12'"
  ).get()?.n);
  s.raw.exec(probe);
  assert.equal(rowCount(), 0, 'must never create a phantom monitor or queue entry');
  s.raw.prepare('INSERT INTO monitor_state (id, config_identity) VALUES (?,?)')
    .run('qiita-rust', '["qiita","tag:Rust"]');
  s.raw.exec(probe);
  assert.equal(rowCount(), 0, 'no live notification without a completed silent baseline');
  s.raw.prepare('UPDATE monitor_state SET initialized_at=1,config_identity=? WHERE id=?')
    .run('["qiita","tag:Python"]', 'qiita-rust');
  s.raw.exec(probe);
  assert.equal(rowCount(), 0, 'no injection into a monitor whose query changed');
  s.raw.prepare('UPDATE monitor_state SET config_identity=? WHERE id=?')
    .run('["qiita","tag:Rust"]', 'qiita-rust');
  s.raw.exec(probe);
  s.raw.exec(probe);
  assert.equal(rowCount(), 1, 're-running the SQL must be idempotent');
  const row = s.raw.prepare("SELECT * FROM deliveries WHERE item_id='smoke:qiita:discord-outbox:2026-10-12'").get();
  assert.equal(row?.status, 'pending');
  assert.equal(row?.monitor_id, 'qiita-rust');
  assert.match(String(row?.title), /\[TEST\]/);
  assert.equal(s.raw.prepare('SELECT initialized_at FROM monitor_state WHERE id=?')
    .get('qiita-rust')?.initialized_at, 1);
});

test('the normal Cron sends the SQL-inserted probe and marks it sent without an API fetch', async () => {
  const s = setup();
  const now = Date.parse('2026-10-12T03:00:00Z'); // noon JST, inside delivery hours
  s.raw.prepare(
    'INSERT INTO monitor_state (id,initialized_at,next_due_at,config_identity) VALUES (?,?,?,?)'
  ).run('qiita-rust', now - 7_200_000, now + 3_600_000, '["qiita","tag:Rust"]');
  const original = s.raw.prepare('SELECT initialized_at,next_due_at FROM monitor_state WHERE id=?')
    .get('qiita-rust');
  const probe = readFileSync(new URL('../ops/qiita-one-shot-smoke.sql', import.meta.url), 'utf8');
  s.raw.exec(probe);
  let upstreamFetches = 0;
  const deps = {
    ...s.deps,
    fetchItems: async () => { upstreamFetches++; throw new Error('not due'); },
  };
  assert.equal(await runTick(s.env, [qiita], now, deps), 'processed');
  assert.equal(upstreamFetches, 0);
  assert.deepEqual(s.sent, ['smoke:qiita:discord-outbox:2026-10-12']);
  const row = s.raw.prepare(
    "SELECT status,sent_at,attempts FROM deliveries WHERE item_id='smoke:qiita:discord-outbox:2026-10-12'"
  ).get();
  assert.equal(row?.status, 'sent');
  assert.equal(row?.sent_at, now);
  assert.equal(row?.attempts, 0);
  assert.deepEqual(s.raw.prepare('SELECT initialized_at,next_due_at FROM monitor_state WHERE id=?')
    .get('qiita-rust'), original, 'outbox-only sending must not alter fetch checkpoints');
  s.raw.exec(probe);
  assert.equal(await runTick(s.env, [qiita], now + 60_000, deps), 'idle');
  assert.equal(s.sent.length, 1, 'probe must not send again after ACK');
});

test('JST notification window is 09:00 inclusive and 20:00 exclusive', () => {
  for (const [utc, allowed] of [
    ['2026-10-12T23:59:59Z', false], // 08:59 JST
    ['2026-10-13T00:00:00Z', true],  // 09:00 JST
    ['2026-10-13T10:59:59Z', true],  // 19:59 JST
    ['2026-10-13T11:00:00Z', false], // 20:00 JST
  ] as const) {
    assert.equal(isJstNotificationTime(Date.parse(utc), parseNotificationWindowJst('09:00-20:00')), allowed, utc);
  }
});

test('night scans still enqueue new articles but do not post or spin; morning drains backlog', async () => {
  const s = setup();
  s.env.NOTIFICATION_WINDOW_JST = '09:00-20:00';
  const day = Date.parse('2026-10-12T10:00:00Z'); // 19:00 JST
  await runTick(s.env, [qiita], day, s.deps); // baseline
  s.setItems([item('after-baseline', day + 30 * 60_000)]);
  const night = day + 60 * 60_000; // 20:00 JST
  assert.equal(await runTick(s.env, [qiita], night, s.deps), 'processed');
  assert.deepEqual(s.sent, [], 'night-time API discoveries must remain queued');
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='qiita:after-baseline'").get()?.status,
    'pending');
  assert.deepEqual(await getRunnableIds(s.env.DB, night + 60_000, [qiita], parseNotificationWindowJst('09:00-20:00')), [],
    'pending-only deliveries should not cause an every-minute night-time loop');
  const morning = Date.parse('2026-10-13T00:00:00Z'); // 09:00 JST
  assert.equal(await runTick(s.env, [qiita], morning, s.deps), 'processed');
  assert.deepEqual(s.sent, ['qiita:after-baseline']);
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='qiita:after-baseline'").get()?.status,
    'sent');
});

test('deduplication horizon blocks rediscovery after old sent receipts are physically pruned', async () => {
  const s = setup();
  const now = Date.parse('2026-10-12T03:00:00Z');
  const baseline = now - 30 * 24 * 60 * 60_000;
  await (await import('../src/state.ts')).stage(s.env.DB, qiita.id,
    [item('ancient', now - DELIVERY_RETENTION_MS - 1000),
     item('recent', now - DELIVERY_RETENTION_MS + 1000)], baseline, now);
  assert.equal(s.raw.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE item_id='qiita:ancient'").get()?.n, 0);
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='qiita:recent'").get()?.status,
    'pending');
});

test('retention Cron deletes only 20 expired sent receipts per invocation', async () => {
  const s = setup();
  const now = Date.now();
  for (let i = 0; i < PRUNE_BATCH_SIZE + 1; i++) {
    s.raw.prepare(
      "INSERT INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at,sent_at) " +
      "VALUES ('qiita-rust',?,'sent','old','https://example.com',?,?,?)"
    ).run('old-' + i, now - DELIVERY_RETENTION_MS - 2000,
      now - DELIVERY_RETENTION_MS - 2000, now - DELIVERY_RETENTION_MS - 1000);
  }
  s.raw.prepare(
    "INSERT INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at) " +
    "VALUES ('qiita-rust','pending-old','pending','retry','https://example.com',?,?)"
  ).run(now - DELIVERY_RETENTION_MS - 2000, now - DELIVERY_RETENTION_MS - 2000);
  s.raw.prepare(
    "INSERT INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at,sent_at) " +
    "VALUES ('qiita-rust','new-sent','sent','new','https://example.com',?,?,?)"
  ).run(now, now, now);
  assert.equal(await pruneSentDeliveries(s.env.DB, now), PRUNE_BATCH_SIZE);
  assert.equal(s.raw.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE item_id LIKE 'old-%'").get()?.n, 1);
  assert.equal(await pruneSentDeliveries(s.env.DB, now), 1);
  assert.equal(await pruneSentDeliveries(s.env.DB, now), 0);
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='pending-old'").get()?.status,
    'pending');
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='new-sent'").get()?.status,
    'sent');
  // No notification runner is involved in the dedicated maintenance schedule.
  await Worker.scheduled({ cron: '10 * * * *' }, s.env);
  assert.equal(s.sent.length, 0);
});

test('a long fetch crossing 20:00 JST never initiates a Discord POST', async () => {
  const s = setup();
  s.env.NOTIFICATION_WINDOW_JST = '09:00-20:00';
  const baseline = Date.parse('2026-10-12T09:59:00Z'); // 18:59 JST
  await runTick(s.env, [qiita], baseline, s.deps);
  s.setItems([item('crossing', baseline + 60_000)]);
  const tick = baseline + 60 * 60_000; // 19:59 JST
  const afterWindow = Date.parse('2026-10-12T11:00:01Z'); // 20:00 JST
  assert.equal(await runTick(s.env, [qiita], tick, {
    ...s.deps,
    clock: () => afterWindow,
  }), 'processed');
  assert.deepEqual(s.sent, []);
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='qiita:crossing'").get()?.status,
    'pending');
  await runTick(s.env, [qiita], Date.parse('2026-10-13T00:00:00Z'), s.deps);
  assert.deepEqual(s.sent, ['qiita:crossing']);
});

test('only the configured hourly schedule prunes and it differs from the polling Cron', async () => {
  const s = setup();
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.triggers.crons, ['*/5 * * * *', '10 * * * *']);
  const old = Date.now() - DELIVERY_RETENTION_MS - 60_000;
  s.raw.prepare(
    "INSERT INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at,sent_at) " +
    "VALUES ('qiita-rust','hourly-old','sent','old','https://example.com',?,?,?)"
  ).run(old, old, old);
  const hasOld = () => Number(s.raw.prepare(
    "SELECT count(*) AS n FROM deliveries WHERE item_id='hourly-old'"
  ).get()?.n);
  // Historical five-minute trigger must not dispatch maintenance anymore.
  await Worker.scheduled({ cron: '*/5 * * * *' }, s.env);
  assert.equal(hasOld(), 1);
  await Worker.scheduled({ cron: '10 * * * *' }, s.env);
  assert.equal(hasOld(), 0, 'hourly trigger runs the bounded maintenance deletion');
});

test('MediaWiki 403 holds its API retry for at least an hour without clearing baseline state', async () => {
  const s = setup();
  const now = Date.parse('2026-10-12T00:00:00Z');
  const wiki: Monitor = { ...qiita, id: 'wikipedia-ja', query: 'ja', source: 'wikipedia' };
  s.env.DISCORD_WEBHOOK_WIKIPEDIA = webhook;
  await assert.rejects(() => runTick(s.env, [wiki], now, {
    ...s.deps,
    fetchItems: async () => { throw new HttpStatusError('MediaWiki', 403, null); },
  }), /MediaWiki HTTP 403/);
  const state = s.raw.prepare('SELECT initialized_at,next_due_at FROM monitor_state WHERE id=?')
    .get(wiki.id);
  assert.equal(state?.initialized_at, null);
  assert.equal(state?.next_due_at, now + 60 * 60_000);
});

test('five-minute global tick is independent of per-monitor hourly source intervals', async () => {
  const s = setup();
  const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.deepEqual(config.triggers.crons, ['*/5 * * * *', '10 * * * *']);
  const minute = 60_000;
  const now = Date.now();
  for (const monitor of MONITORS.filter((m) => m.source === 'youtube')) {
    assert.equal(monitor.intervalMinutes, 60);
    assert.equal(monitor.enabled, true);
  }
  // Prepare every enabled monitor as already initialized and next due in an hour.
  for (const monitor of MONITORS.filter((m) => m.enabled)) {
    s.raw.prepare(
      'INSERT INTO monitor_state (id,initialized_at,next_due_at,config_identity) VALUES (?,?,?,?)'
    ).run(monitor.id, now - minute, now + 60 * minute,
      JSON.stringify([monitor.source, monitor.query.trim()]));
  }
  await Worker.scheduled({ cron: '* * * * *' }, s.env);
  assert.deepEqual(s.sent, [], 'old per-minute Cron must not process monitors');
  await Worker.scheduled({ cron: '*/5 * * * *' }, s.env);
  assert.deepEqual(s.sent, [], 'five-minute scheduler does not fetch before individual deadline');
});


test('selected JST weekday is checked hourly across midnight and year boundaries', () => {
  const examples = [
    ['2026-10-12T14:59:59Z', 'tuesday', '2026-10-12T15:00:00Z'], // Mon 23:59 JST -> Tue 00:00
    ['2026-10-12T15:01:00Z', 'tuesday', '2026-10-12T16:00:00Z'], // Tue 00:01 JST -> Tue 01:00
    ['2026-10-13T00:00:00Z', 'tuesday', '2026-10-13T01:00:00Z'], // Tue 09:00 -> Tue 10:00
    ['2026-10-13T14:00:00Z', 'tuesday', '2026-10-19T15:00:00Z'], // Tue 23:00 -> next Tue 00:00
    ['2026-10-14T04:00:00Z', 'sunday', '2026-10-17T15:00:00Z'], // Wed 13:00 -> Sun 00:00
    ['2026-10-17T23:59:59Z', 'sunday', '2026-10-18T00:00:00Z'], // Sun 08:59 -> 09:00
    ['2026-10-18T00:00:00Z', 'sunday', '2026-10-18T01:00:00Z'], // Sun 09:00 -> 10:00
    ['2026-10-18T14:00:00Z', 'sunday', '2026-10-24T15:00:00Z'], // Sun 23:00 -> next Sun 00:00
    ['2026-12-31T14:00:00Z', 'sunday', '2027-01-02T15:00:00Z'], // next-year Sun 00:00
  ] as const;
  for (const [now, day, expected] of examples) {
    const timestamp = Date.parse(now);
    assert.equal(nextHourlyJstWeekdayDue(timestamp, day), Date.parse(expected), now);
  }
  assert.equal(isJstWeekday(Date.parse('2026-10-12T15:00:00Z'), 'tuesday'), true);
  assert.equal(isJstWeekday(Date.parse('2026-10-13T15:00:00Z'), 'tuesday'), false);
  assert.throws(() => nextHourlyJstWeekdayDue(Date.now(), 'noday'), /Invalid weekly JST schedule/);
});

test('off-day YouTube initialization is deferred until specified day, with no upstream fetch', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_YOUTUBE = webhook;
  const monitor = MONITORS.find((m) => m.id === 'youtube-yurucom')!;
  const tuesday = Date.parse('2026-10-13T03:00:00Z'); // Tue 12:00 JST, not Sunday's slot
  let fetches = 0;
  const deps = {
    ...s.deps,
    fetchItems: async () => { fetches++; return { items: [], potentiallyTruncated: false }; },
  };
  assert.equal(await runTick(s.env, [monitor], tuesday, deps), 'processed');
  assert.equal(fetches, 0);
  let state = s.raw.prepare(
    'SELECT initialized_at, next_due_at, config_identity FROM monitor_state WHERE id=?'
  ).get(monitor.id);
  assert.equal(state?.initialized_at, null);
  assert.equal(state?.config_identity, JSON.stringify(['youtube', monitor.query.trim()]));
  const sunday = Date.parse('2026-10-17T15:00:00Z'); // Sun 00:00 JST
  assert.equal(state?.next_due_at, sunday);
  assert.equal(await runTick(s.env, [monitor], sunday - 5 * 60_000, deps), 'idle');
  assert.equal(await runTick(s.env, [monitor], sunday, deps), 'processed');
  assert.equal(fetches, 1);
  state = s.raw.prepare('SELECT initialized_at,next_due_at FROM monitor_state WHERE id=?').get(monitor.id);
  assert.equal(state?.initialized_at, sunday);
  assert.equal(state?.next_due_at, sunday + 60 * 60_000);
});

test('all three YouTube monitors use independent Tuesday/Sunday hourly schedules', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_YOUTUBE = webhook;
  const monitors = MONITORS.filter((m) => m.source === 'youtube' && m.weeklyJstDay !== undefined);
  for (const monitor of monitors) {
    const base = monitor.weeklyJstDay === 'tuesday'
      ? Date.parse('2026-10-13T03:00:00Z')
      : Date.parse('2026-10-18T03:00:00Z'); // each selected day at noon JST
    assert.equal(await runTick(s.env, [monitor], base, s.deps), 'processed');
    const state = s.raw.prepare(
      'SELECT initialized_at, next_due_at, config_identity FROM monitor_state WHERE id=?'
    ).get(monitor.id);
    assert.equal(state?.initialized_at, base, 'first on-day scan is a silent baseline');
    assert.equal(state?.config_identity, JSON.stringify(['youtube', monitor.query.trim()]));
    assert.equal(state?.next_due_at, base + 60 * 60_000);
    assert.equal(s.sent.length, 0);
    assert.equal(await runTick(s.env, [monitor], base + 60 * 60_000, s.deps), 'processed');
    assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state WHERE id=?')
      .get(monitor.id)?.next_due_at, base + 120 * 60_000);
    // An overdue weekly target seen on a different day advances its stored
    // deadline, without fetching upstream.
    assert.equal(await runTick(s.env, [monitor], base + 24 * 60 * 60_000, s.deps), 'processed');
    assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state WHERE id=?')
      .get(monitor.id)?.next_due_at,
      nextHourlyJstWeekdayDue(base + 24 * 60 * 60_000, monitor.weeklyJstDay!));
  }
});

test('Sunday YouTube API failure retries on Sunday then resumes hourly; off-day retries defer', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_YOUTUBE = webhook;
  const monitor = MONITORS.find((m) => m.id === 'youtube-yurucom')!;
  const sunday = Date.parse('2026-10-17T15:00:00Z'); // Sun 00:00 JST
  let denied = true;
  const deps = {
    ...s.deps,
    fetchItems: async () => {
      if (denied) throw new Error('temporary outage');
      return { items: [], potentiallyTruncated: false };
    },
  };
  await assert.rejects(() => runTick(s.env, [monitor], sunday, deps), /temporary outage/);
  let due = s.raw.prepare('SELECT next_due_at FROM monitor_state WHERE id=?').get(monitor.id)?.next_due_at;
  assert.equal(due, sunday + 5 * 60_000);
  denied = false;
  const retry = sunday + 5 * 60_000;
  assert.equal(await runTick(s.env, [monitor], retry, deps), 'processed');
  due = s.raw.prepare('SELECT next_due_at FROM monitor_state WHERE id=?').get(monitor.id)?.next_due_at;
  assert.equal(due, retry + 60 * 60_000, 'successful retry starts the configured interval from actual fetch');
  assert.equal(await runTick(s.env, [monitor], Date.parse('2026-10-18T15:00:00Z'), deps), 'processed');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state WHERE id=?').get(monitor.id)?.next_due_at,
    Date.parse('2026-10-24T15:00:00Z')); // next Sunday 00:00 JST
});

test('pending YouTube notifications can be sent next morning even outside fetch weekday', async () => {
  const s = setup();
  s.env.NOTIFICATION_WINDOW_JST = '09:00-20:00';
  s.env.DISCORD_WEBHOOK_YOUTUBE = webhook;
  const monitor = MONITORS.find((m) => m.id === 'youtube-yurugengo')!;
  const tuesday = Date.parse('2026-10-13T10:00:00Z'); // Tue 19:00 JST
  await runTick(s.env, [monitor], tuesday, s.deps); // silent baseline
  s.setItems([{ id: 'youtube:AbCdEf12345', title: 'New upload',
    url: 'https://www.youtube.com/watch?v=AbCdEf12345',
    publishedAt: tuesday + 20 * 60_000 }]);
  const night = tuesday + 60 * 60_000; // Tue 20:00 JST
  assert.equal(await runTick(s.env, [monitor], night, s.deps), 'processed');
  assert.deepEqual(s.sent, []);
  assert.equal(s.raw.prepare(
    "SELECT status FROM deliveries WHERE item_id='youtube:AbCdEf12345'"
  ).get()?.status, 'pending');
  const morning = Date.parse('2026-10-14T00:00:00Z'); // Wed 09:00 JST
  assert.equal(await runTick(s.env, [monitor], morning, s.deps), 'processed');
  assert.deepEqual(s.sent, ['youtube:AbCdEf12345']);
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='youtube:AbCdEf12345'")
    .get()?.status, 'sent');
});

test('Wikipedia discovery recommends one new featured and one random article each 2h with bounded D1', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_WIKIPEDIA = webhook;
  const wikipedia: Monitor = {
    id: 'wikipedia-ja-discovery', source: 'wikipedia', query: 'ja:discover',
    enabled: true, intervalMinutes: 120,
  };
  const now = Date.parse('2026-10-10T00:00:00Z'); // 09:00 JST
  const candidate = (id: number, discoveryKind: 'featured' | 'random'): ContentItem => ({
    id: 'wikipedia:ja:' + id, title: 'Discover ' + id,
    url: 'https://ja.wikipedia.org/?curid=' + id, publishedAt: 0, discoveryKind,
  });
  let items = [
    candidate(1, 'featured'), candidate(2, 'featured'), candidate(3, 'featured'),
    candidate(1, 'random'), candidate(4, 'random'), candidate(5, 'random'),
  ];
  let fetches = 0;
  const deps = { ...s.deps, fetchItems: async () => {
    fetches++;
    return { items, potentiallyTruncated: false, nextCursor: null };
  } };
  await runTick(s.env, [wikipedia], now, deps);
  assert.deepEqual(s.sent, [], 'silent initialization must not recommend historical articles');
  await runTick(s.env, [wikipedia], now + 120 * 60_000, deps);
  assert.deepEqual([...s.sent].sort(), ['wikipedia:ja:1', 'wikipedia:ja:4']);
  assert.equal(s.raw.prepare('SELECT COUNT(*) AS n FROM deliveries').get()?.n, 2);
  assert.equal(s.raw.prepare('SELECT MIN(published_at) AS at FROM deliveries').get()?.at, now + 120 * 60_000,
    'recommendation time must replace article creation time');
  assert.equal(await runTick(s.env, [wikipedia], now + 125 * 60_000, deps), 'idle');
  // Existing picks are rejected, and another random candidate must be used.
  items = [candidate(1, 'featured'), candidate(2, 'featured'),
    candidate(4, 'random'), candidate(5, 'random'), candidate(2, 'random')];
  await runTick(s.env, [wikipedia], now + 240 * 60_000, deps);
  assert.deepEqual([...s.sent].sort(), ['wikipedia:ja:1', 'wikipedia:ja:2',
    'wikipedia:ja:4', 'wikipedia:ja:5']);
  assert.equal(s.raw.prepare('SELECT COUNT(*) AS n FROM deliveries').get()?.n, 4);
  assert.equal(fetches, 3);
  assert.equal(await runTick(s.env, [wikipedia], now + 245 * 60_000, deps), 'idle');
});

test('Wikipedia discovery never sends repeats or more than two items at a successful poll', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_WIKIPEDIA = webhook;
  const m: Monitor = { id: 'wikipedia-ja-discovery', source: 'wikipedia',
    query: 'ja:discover', enabled: true, intervalMinutes: 120 };
  const now = Date.parse('2026-10-10T00:00:00Z');
  const known = [
    { id: 'wikipedia:ja:8', title: 'A', url: 'https://ja.wikipedia.org/?curid=8',
      publishedAt: 0, discoveryKind: 'featured' as const },
    { id: 'wikipedia:ja:8', title: 'A', url: 'https://ja.wikipedia.org/?curid=8',
      publishedAt: 0, discoveryKind: 'random' as const },
  ];
  const deps = { ...s.deps, fetchItems: async () => ({
    items: known, potentiallyTruncated: false, nextCursor: null,
  }) };
  await runTick(s.env, [m], now, deps);
  await runTick(s.env, [m], now + 120 * 60_000, deps);
  assert.deepEqual(s.sent, ['wikipedia:ja:8'], 'overlapping pools must send an article once');
  await runTick(s.env, [m], now + 240 * 60_000, deps);
  assert.deepEqual(s.sent, ['wikipedia:ja:8'], 'sent receipts suppress repeat recommendations');
  assert.equal(s.raw.prepare('SELECT COUNT(*) AS n FROM deliveries').get()?.n, 1);
});

test('failed YouTube RSS logs the monitor ID, source, fetch phase, HTTP status and retry time', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_YOUTUBE = webhook;
  const m: Monitor = { id: 'youtube-diagnostic-test', source: 'youtube',
    query: '@example', enabled: true, intervalMinutes: 60 };
  const now = Date.parse('2026-10-13T00:00:00Z');
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
  try {
    await assert.rejects(() => runTick(s.env, [m], now, {
      ...s.deps,
      fetchItems: async () => { throw new HttpStatusError('YouTube RSS', 404, null); },
    }), /YouTube RSS HTTP 404/);
  } finally {
    console.error = original;
  }
  const row = messages.map((m) => JSON.parse(m) as Record<string, unknown>)
    .find((r) => r.event === 'monitor_failure');
  assert.ok(row);
  assert.equal(row.monitorId, m.id);
  assert.equal(row.source, 'youtube');
  assert.equal(row.phase, 'fetch_and_parse');
  assert.equal(row.httpStatus, 404);
  assert.equal(row.upstream, 'YouTube RSS');
  assert.equal(row.retryAt, new Date(now + 60 * 60_000).toISOString());
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state WHERE id=?')
    .get(m.id)?.next_due_at, now + 60 * 60_000);
  // The five-minute dispatcher must not refetch the same failing YouTube RSS.
  assert.equal(await runTick(s.env, [m], now + 5 * 60_000, {
    ...s.deps,
    fetchItems: async () => { throw new Error('Unexpected early retry'); },
  }), 'idle');
});

test('YouTube RSS 404 respects Retry-After longer than one hour; other 404s are unchanged', async () => {
  const now = Date.parse('2026-10-13T00:00:00Z');
  for (const scenario of [
    { source: 'YouTube RSS', status: 404, hint: 2 * 60 * 60_000, expected: 2 * 60 * 60_000 },
    { source: 'YouTube channel', status: 404, hint: null, expected: 5 * 60_000 },
    { source: 'YouTube RSS', status: 500, hint: null, expected: 5 * 60_000 },
  ]) {
    const s = setup();
    s.env.DISCORD_WEBHOOK_YOUTUBE = webhook;
    const m: Monitor = { id: 'youtube-retry-' + scenario.status + '-' +
      (scenario.source === 'YouTube RSS' ? 'rss' : 'channel'),
      source: 'youtube', query: '@example', enabled: true, intervalMinutes: 60 };
    const original = console.error;
    console.error = () => {};
    try {
      await assert.rejects(() => runTick(s.env, [m], now, {
        ...s.deps,
        fetchItems: async () => {
          throw new HttpStatusError(scenario.source, scenario.status, scenario.hint);
        },
      }));
    } finally {
      console.error = original;
    }
    assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state WHERE id=?')
      .get(m.id)?.next_due_at, now + scenario.expected);
  }
});

test('Qiita and Zenn select only the newest three candidates without backfilling sent slots', async () => {
  for (const source of ['qiita', 'zenn'] as const) {
    const s = setup();
    if (source === 'zenn') s.env.DISCORD_WEBHOOK_ZENN = webhook;
    const monitor: Monitor = { id: source + '-latest', source,
      query: source === 'qiita' ? 'tag:Rust' : 'topic:typescript',
      enabled: true, intervalMinutes: 60 };
    const now = Date.parse('2026-10-10T00:00:00Z');
    await runTick(s.env, [monitor], now, s.deps);
    const rows = [
      item('older', now + 1_000), item('top1', now + 5_000),
      item('top2', now + 4_000), item('top3', now + 3_000),
      item('outside', now + 2_000),
    ];
    s.setItems(rows);
    const fresh = now + 60 * 60_000;
    await runTick(s.env, [monitor], fresh, s.deps);
    assert.deepEqual([...s.sent].sort(), ['qiita:top1', 'qiita:top2', 'qiita:top3']);
    assert.equal(s.raw.prepare('SELECT COUNT(*) AS count FROM deliveries WHERE monitor_id=?')
      .get(monitor.id)?.count, 3);
    // Repeat exactly these candidates: already-sent articles cannot cause
    // older rows to be promoted to the notification list.
    await runTick(s.env, [monitor], fresh + 60 * 60_000, s.deps);
    assert.equal(s.sent.length, 3);
  }
});

test('Qiita drops obsolete pending alerts but keeps the current fresh window', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  await runTick(s.env, [qiita], now, s.deps);
  s.setItems([item('old', now + 1000), item('older', now + 900)]);
  s.fail(true);
  const original = console.error;
  console.error = () => {};
  try {
    await runTick(s.env, [qiita], now + 60 * 60_000, s.deps);
  } finally { console.error = original; }
  assert.equal(s.raw.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status='pending'").get()?.n, 2);
  s.fail(false);
  s.setItems([item('new3', now + 4000), item('new1', now + 6000),
    item('new2', now + 5000), item('old', now + 1000)]);
  await runTick(s.env, [qiita], now + 120 * 60_000, s.deps);
  assert.deepEqual([...s.sent].sort(), ['qiita:new1', 'qiita:new2', 'qiita:new3']);
  assert.equal(s.raw.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE item_id IN ('qiita:old','qiita:older')").get()?.n, 0);
});

test('YouTube stages all fifteen feed videos, then drains the durable queue in batches', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_YOUTUBE = webhook;
  const monitor: Monitor = { id: 'youtube-fifteen', source: 'youtube',
    query: '@example', enabled: true, intervalMinutes: 60 };
  const now = Date.parse('2026-10-10T00:00:00Z'); // 09:00 JST
  await runTick(s.env, [monitor], now, s.deps);
  s.setItems(Array.from({ length: 15 }, (_, i) =>
    item('video-' + i, now + 1000 + i * 1000)));
  const snap = { ...s.deps, fetchItems: async () => ({
    items: Array.from({ length: 15 }, (_, i) =>
      item('video-' + i, now + 1000 + i * 1000)),
    potentiallyTruncated: true,
    nextCursor: 'ignored',
  }) };
  await runTick(s.env, [monitor], now + 60 * 60_000, snap);
  assert.equal(s.sent.length, 3);
  assert.equal(s.raw.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE monitor_id=?")
    .get(monitor.id)?.n, 15);
  assert.equal(s.raw.prepare("SELECT last_complete_at FROM monitor_state WHERE id=?")
    .get(monitor.id)?.last_complete_at, now + 60 * 60_000);
  assert.equal(s.raw.prepare("SELECT incomplete_count FROM monitor_state WHERE id=?")
    .get(monitor.id)?.incomplete_count, 0);
  for (let i = 1; i <= 4; i++) {
    await runTick(s.env, [monitor], now + 60 * 60_000 + i * 5 * 60_000, snap);
  }
  assert.equal(s.sent.length, 15);
  assert.equal(new Set(s.sent).size, 15);
});

test('notification hours default to unrestricted, support overnight windows and reject invalid windows', () => {
  const jst = (time: string) => Date.parse(time);
  const overnight = parseNotificationWindowJst('22:00-06:00');
  const daytime = parseNotificationWindowJst('09:00-20:00');
  assert.equal(isJstNotificationTime(jst('2026-10-13T14:00:00Z')), true, 'no window -> 24h');
  assert.equal(isJstNotificationTime(jst('2026-10-13T14:00:00Z'), overnight), true); // 23 JST
  assert.equal(isJstNotificationTime(jst('2026-10-13T20:59:59Z'), overnight), true); // 05:59 JST
  assert.equal(isJstNotificationTime(jst('2026-10-13T21:00:00Z'), overnight), false); // 06:00 JST
  assert.equal(isJstNotificationTime(jst('2026-10-13T12:59:59Z'), overnight), false); // 21:59 JST
  assert.equal(isJstNotificationTime(jst('2026-10-13T13:00:00Z'), overnight), true); // 22:00 JST
  assert.equal(isJstNotificationTime(jst('2026-10-13T11:00:00Z'), daytime), false);
  assert.equal(parseNotificationWindowJst(null), null);
  assert.equal(parseNotificationWindowJst(undefined), null);
  assert.deepEqual(parseNotificationWindowJst(' 09:00-20:00\n'), daytime);
  for (const invalid of ['', '09:00', '24:00-01:00', '09:60-20:00',
    '09:00-09:00', 'foo', 100, {}, '9:00-20:00']) {
    assert.throws(() => parseNotificationWindowJst(invalid), undefined, String(invalid));
  }
});

test('without a delivery window, a new item is sent at night immediately', async () => {
  const s = setup();
  const start = Date.parse('2026-10-13T11:00:00Z'); // 20:00 JST
  await runTick(s.env, [qiita], start, s.deps);
  s.setItems([item('night-unrestricted', start + 120_000)]);
  assert.equal(await runTick(s.env, [qiita], start + 60 * 60_000, s.deps), 'processed');
  assert.deepEqual(s.sent, ['qiita:night-unrestricted']);
});

test('optional private delivery window suppresses nightly sends and keeps pending for later', async () => {
  const s = setup();
  s.env.NOTIFICATION_WINDOW_JST = '22:00-06:00';
  const start = Date.parse('2026-10-13T10:00:00Z'); // 19:00 JST
  await runTick(s.env, [qiita], start, s.deps);
  s.setItems([item('overnight-only', start + 60_000)]);
  const outside = start + 60 * 60_000; // 20 JST, not inside 22-06
  await runTick(s.env, [qiita], outside, s.deps);
  assert.deepEqual(s.sent, []);
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='qiita:overnight-only'").get()?.status, 'pending');
  assert.deepEqual(await getRunnableIds(s.env.DB, outside + 60_000, [qiita], parseNotificationWindowJst('22:00-06:00')), []);
  const inside = Date.parse('2026-10-13T13:00:00Z'); // 22 JST
  assert.equal(await runTick(s.env, [qiita], inside, s.deps), 'processed');
  assert.deepEqual(s.sent, ['qiita:overnight-only']);
});

test('YouTube announces only the newest video on the very first successful poll, even if years old', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_YOUTUBE = webhook;
  const monitor: Monitor = { id: 'youtube-first', source: 'youtube', query: '@example',
    intervalMinutes: 60, enabled: true, retentionDays: null };
  const now = Date.parse('2026-10-13T03:00:00Z');
  s.setItems([
    { id: 'youtube:veryOld0001', title: 'Old video',
      url: 'https://www.youtube.com/watch?v=veryOld0001',
      publishedAt: now - 400 * 86400_000 },
    { id: 'youtube:oldNewest01', title: 'Latest old video',
      url: 'https://www.youtube.com/watch?v=oldNewest01',
      publishedAt: now - 200 * 86400_000 },
  ]);
  assert.equal(await runTick(s.env, [monitor], now, s.deps), 'processed');
  assert.deepEqual(s.sent, ['youtube:oldNewest01']);
  assert.equal(s.raw.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE monitor_id=?")
    .get(monitor.id)?.c, 1, 'only the newest old video must be staged');
  await runTick(s.env, [monitor], now + 60 * 60_000, s.deps);
  assert.deepEqual(s.sent, ['youtube:oldNewest01'], 'same video must not be delivered twice');
  const afterRetention = now + 11 * 86400_000;
  await pruneSentDeliveries(s.env.DB, afterRetention, [monitor]);
  assert.equal(s.raw.prepare("SELECT COUNT(*) AS c FROM deliveries WHERE monitor_id=?")
    .get(monitor.id)?.c, 1, 'YouTube sent receipts must be retained permanently');
  await runTick(s.env, [monitor], afterRetention, s.deps);
  assert.deepEqual(s.sent, ['youtube:oldNewest01'],
    'once the initial baseline is recorded, pruning must not resend an ancient latest video');
});

test('existing YouTube monitor can deliver latest recently published video even if older than initialization', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_YOUTUBE = webhook;
  const monitor: Monitor = { id: 'youtube-existing', source: 'youtube', query: '@example',
    intervalMinutes: 60, enabled: true };
  const now = Date.parse('2026-10-13T03:00:00Z');
  await runTick(s.env, [monitor], now, s.deps);
  const newest = { id: 'youtube:sLGshNDA5Ko', title: 'Latest published video',
    url: 'https://www.youtube.com/watch?v=sLGshNDA5Ko',
    publishedAt: now - 3 * 60 * 60_000 };
  const old = { id: 'youtube:older000001', title: 'Older video',
    url: 'https://www.youtube.com/watch?v=older000001',
    publishedAt: now - 6 * 86400_000 };
  s.setItems([old, newest]); // deliberately not in chronological order
  await runTick(s.env, [monitor], now + 60 * 60_000, s.deps);
  assert.deepEqual(s.sent, [newest.id]);
  await runTick(s.env, [monitor], now + 120 * 60_000, s.deps);
  assert.deepEqual(s.sent, [newest.id]);
  assert.equal(s.raw.prepare("SELECT item_id FROM deliveries WHERE monitor_id=? AND item_id=?")
    .get(monitor.id, old.id), undefined, 'older historical videos must not create a backlog');
});

test('YouTube initial notification honors optional send hours and delivers queued item later', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_YOUTUBE = webhook;
  s.env.NOTIFICATION_WINDOW_JST = '09:00-20:00';
  const monitor: Monitor = { id: 'youtube-queued-initial', source: 'youtube', query: '@example',
    intervalMinutes: 60, enabled: true };
  const night = Date.parse('2026-10-13T11:00:00Z'); // 20:00 JST
  const latest = { id: 'youtube:latest00001', title: 'Existing video',
    url: 'https://www.youtube.com/watch?v=latest00001',
    publishedAt: night - 2 * 86400_000 };
  s.setItems([latest]);
  await runTick(s.env, [monitor], night, s.deps);
  assert.deepEqual(s.sent, []);
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id=?")
    .get(latest.id)?.status, 'pending');
  const nextMorning = Date.parse('2026-10-14T00:00:00Z');
  await runTick(s.env, [monitor], nextMorning, s.deps);
  assert.deepEqual(s.sent, [latest.id]);
});

test('a very old YouTube latest upload can notify an already initialized monitor once', async () => {
  const s = setup();
  s.env.DISCORD_WEBHOOK_YOUTUBE = webhook;
  const monitor: Monitor = { id: 'youtube-oldest-latest', source: 'youtube', query: '@example',
    intervalMinutes: 60, enabled: true, retentionDays: null };
  const now = Date.parse('2026-10-13T02:00:00Z');
  // An empty initial feed successfully initializes the monitor.
  await runTick(s.env, [monitor], now, s.deps);
  const ancient: ContentItem = { id: 'youtube:veryOld0001', title: 'Old latest',
    url: 'https://www.youtube.com/watch?v=veryOld0001', publishedAt: now - 400 * 86400_000 };
  s.setItems([ancient]);
  await runTick(s.env, [monitor], now + 60 * 60_000, s.deps);
  assert.deepEqual(s.sent, [ancient.id]);
  await runTick(s.env, [monitor], now + 90 * 86400_000, s.deps);
  assert.deepEqual(s.sent, [ancient.id], 'ancient newest video must never repeat');
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id=?")
    .get(ancient.id)?.status, 'sent');
});

test('YouTube sent ID receipts use the same ten-day cleanup as other sources by default', async () => {
  const s = setup();
  const now = Date.parse('2026-10-13T03:00:00Z');
  s.raw.prepare(
    "INSERT INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at,sent_at) "+
    "VALUES ('youtube-example','youtube:abc123DEF00','sent','Video','https://youtube.com/watch?v=abc123DEF00',?,?,?)"
  ).run(now-400*86400_000, now-20*86400_000, now-20*86400_000);
  s.raw.prepare(
    "INSERT INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at,sent_at) "+
    "VALUES ('qiita-rust','qiita:oldreceipt','sent','Article','https://qiita.com/a',?,?,?)"
  ).run(now-400*86400_000, now-20*86400_000, now-20*86400_000);
  assert.equal(await pruneSentDeliveries(s.env.DB, now), 2);
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='youtube:abc123DEF00'")
    .get(), undefined);
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='qiita:oldreceipt'")
    .get(), undefined);
});

test('OpenAlex initializes silently by storing initial IDs and detects later same-day additions', async () => {
  const s=setup();
  s.env.DISCORD_WEBHOOK_OPENALEX=webhook;
  const monitor: Monitor={id:'openalex-graphs',source:'openalex',query:'search:graph algorithms',
    enabled:true,intervalMinutes:60};
  const now=Date.parse('2026-10-13T03:00:00Z');
  const work=(id:string,publicationAt=Date.parse('2026-10-13T00:00:00Z')): ContentItem=>({
    id:'openalex:'+id,title:'Work '+id,url:'https://openalex.org/'+id,publishedAt:publicationAt,
  });
  s.setItems([work('W123'),work('W124')]);
  assert.equal(await runTick(s.env,[monitor],now,s.deps),'processed');
  assert.deepEqual(s.sent,[]);
  assert.equal(s.raw.prepare("SELECT count(*) AS n FROM deliveries WHERE status='ignored'").get()?.n,2);
  // Same publication_date as baseline, but a NEW OpenAlex work ID.
  s.setItems([work('W123'),work('W124'),work('W125')]);
  assert.equal(await runTick(s.env,[monitor],now+60*60_000,s.deps),'processed');
  assert.deepEqual(s.sent,['openalex:W125']);
  await runTick(s.env,[monitor],now+120*60_000,s.deps);
  assert.deepEqual(s.sent,['openalex:W125'],'sent and ignored records must prevent duplicates');
});

test('OpenAlex ignores works outside its seven-day eligibility horizon', async () => {
  const s=setup();
  s.env.DISCORD_WEBHOOK_OPENALEX=webhook;
  const monitor: Monitor={id:'openalex-old',source:'openalex',query:'author:A123',
    enabled:true,intervalMinutes:60};
  const now=Date.parse('2026-10-13T04:00:00Z');
  await runTick(s.env,[monitor],now,s.deps);
  s.setItems([{id:'openalex:W999',title:'Old paper',url:'https://openalex.org/W999',
    publishedAt:now-30*86400_000}]);
  await runTick(s.env,[monitor],now+60*60_000,s.deps);
  assert.deepEqual(s.sent,[]);
});


test('Zenn sends a freshly fetched RSS enclosure without waiting for a second HTML request', async () => {
  const s=setup();
  s.env.DISCORD_WEBHOOK_ZENN=webhook;
  const monitor:Monitor={id:'zenn-live-image',source:'zenn',query:'topic:algorithm',
    enabled:true,intervalMinutes:60};
  const now=Date.parse('2026-10-13T00:00:00Z');
  await runTick(s.env,[monitor],now,s.deps);
  s.setItems([{
    id:'zenn:https://zenn.dev/tester/articles/graph',
    title:'Graph',url:'https://zenn.dev/tester/articles/graph',
    publishedAt:now+30_000,
    imageUrl:'https://res.cloudinary.com/zenn/image/upload/graph.png',
  }]);
  const received: ContentItem[]=[];
  await runTick(s.env,[monitor],now+60*60_000,{
    ...s.deps,
    send:async(_hook,_source,item)=>{received.push(item);},
  });
  assert.equal(received.length,1);
  assert.equal(received[0]?.imageUrl,'https://res.cloudinary.com/zenn/image/upload/graph.png');
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE monitor_id=?")
    .get(monitor.id)?.status,'sent');
});


test('Qiita API author icon is forwarded to Discord in the same polling tick', async () => {
  const s=setup();
  const monitor:Monitor={id:'qiita-avatar-test',source:'qiita',query:'tag:Rust',
    intervalMinutes:60,enabled:true};
  const now=Date.parse('2026-10-13T00:00:00Z');
  await runTick(s.env,[monitor],now,s.deps);
  s.setItems([{
    id:'qiita:new-icon',title:'New Rust',url:'https://qiita.com/test/items/new',
    publishedAt:now+1_000,thumbnailUrl:'https://image.example.org/qiita-user.png',
  }]);
  const notified:ContentItem[]=[];
  await runTick(s.env,[monitor],now+60*60_000,{
    ...s.deps,send:async(_hook,_source,article)=>{notified.push(article);},
  });
  assert.equal(notified.length,1);
  assert.equal(notified[0]?.thumbnailUrl,'https://image.example.org/qiita-user.png');
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE monitor_id=?")
    .get(monitor.id)?.status,'sent');
});


test('weekday-constrained YouTube accepts independent positive-minute intervals', async()=>{
  const { nextAllowedJstWeekdayDue } = await import('../src/schedule.ts');
  const now=Date.parse('2026-10-13T03:00:00Z'); // Tue 12:00 JST
  const monitor:Monitor={id:'youtube-custom-weekly',source:'youtube',query:'@example',
    enabled:true,intervalMinutes:135,weeklyJstDay:'tuesday'};
  assert.doesNotThrow(()=>validateMonitors([monitor]));
  assert.equal(nextAllowedJstWeekdayDue(now,'tuesday',135),now+135*60_000);
  assert.equal(nextAllowedJstWeekdayDue(now,'tuesday',10080),now+10080*60_000);
  assert.equal(nextAllowedJstWeekdayDue(Date.parse('2026-10-13T13:00:00Z'),'tuesday',180),
    Date.parse('2026-10-19T15:00:00Z'),'interval crossing midnight moves to next selected weekday');
  assert.equal(nextAllowedJstWeekdayDue(Date.parse('2026-10-14T03:00:00Z'),'tuesday',0),
    Date.parse('2026-10-19T15:00:00Z'));
  assert.throws(()=>nextAllowedJstWeekdayDue(now,'tuesday',-2));
  const s=setup();s.env.DISCORD_WEBHOOK_YOUTUBE=webhook;
  assert.equal(await runTick(s.env,[monitor],now,s.deps),'processed');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state WHERE id=?')
    .get(monitor.id)?.next_due_at,now+135*60_000);
  assert.equal(await runTick(s.env,[monitor],now+120*60_000,s.deps),'idle');
  assert.equal(await runTick(s.env,[monitor],now+135*60_000,s.deps),'processed');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state WHERE id=?')
    .get(monitor.id)?.next_due_at,now+270*60_000);
});
