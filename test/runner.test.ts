import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { runTick } from '../src/runner.ts';
import { HttpStatusError } from '../src/http.ts';
import { isJstNotificationTime, isJstWeekday, nextHourlyJstWeekdayDue } from '../src/schedule.ts';
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
  const now = Date.parse('2026-10-10T00:00:00Z');
  s.setItems([item('old', now - 1000)]);
  await runTick(s.env, [qiita], now, s.deps);
  const seen: Array<string | null | undefined> = [];
  const paging = { ...s.deps, fetchItems: async (_m: Monitor, _e: Env, cursor?: string | null) => {
    seen.push(cursor);
    return cursor == null
      ? { items: [item('new1', now + 1000)], nextCursor: '2', potentiallyTruncated: false }
      : { items: [item('new2', now + 2000)], nextCursor: null, potentiallyTruncated: false };
  } };
  assert.equal(await runTick(s.env, [qiita], now + 60 * 60_000, paging), 'processed');
  assert.deepEqual(seen, [null]);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, '2');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state').get()?.next_due_at, now + 61 * 60_000);
  assert.deepEqual(s.sent, ['qiita:new1']);
  assert.equal(await runTick(s.env, [qiita], now + 61 * 60_000, paging), 'processed');
  assert.deepEqual(seen, [null, '2']);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, '__verify_head__');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state').get()?.next_due_at, now + 62 * 60_000);
  await runTick(s.env, [qiita], now + 62 * 60_000, paging);
  assert.deepEqual(seen, [null, '2', null], 'verification must refetch page 1 exactly once');
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, null);
  assert.equal(s.raw.prepare('SELECT scan_started_at FROM monitor_state').get()?.scan_started_at, null);
  assert.equal(s.raw.prepare('SELECT last_complete_at FROM monitor_state').get()?.last_complete_at, now + 60 * 60_000);
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state').get()?.next_due_at, now + 122 * 60_000);
  assert.deepEqual(s.sent, ['qiita:new1', 'qiita:new2']);
});

test('continuation failure does not lose D1 cursor, or double-notify completed page', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  await runTick(s.env, [qiita], now, s.deps);
  const paging = { ...s.deps, fetchItems: async (_m: Monitor, _e: Env, cursor?: string | null) => {
    if (cursor) throw new Error('page 2 temporarily unavailable');
    return { items: [item('fresh', now + 100)], nextCursor: '2', potentiallyTruncated: false };
  } };
  await runTick(s.env, [qiita], now + 60 * 60_000, paging);
  await assert.rejects(() => runTick(s.env, [qiita], now + 61 * 60_000, paging), /page 2/);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, '2');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state').get()?.next_due_at, now + 66 * 60_000);
  const resumed = { ...paging, fetchItems: async (_m: Monitor, _e: Env, cursor?: string | null) => {
    assert.equal(cursor, '2');
    return { items: [item('fresh2', now + 200)], nextCursor: null, potentiallyTruncated: false };
  } };
  await runTick(s.env, [qiita], now + 66 * 60_000, resumed);
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

test('time-based overlap stops arXiv page scans but not Qiita relevance searches', async () => {
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
  assert.equal(s.raw.prepare("SELECT scan_cursor FROM monitor_state WHERE id='qiita-rust'").get()?.scan_cursor, '2');
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

test('Qiita runner supplies previous complete scan time as a stable filtered window', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  const windows: Array<number | null | undefined> = [];
  const fetch = { ...s.deps, fetchItems: async (_m: Monitor, _e: Env, cursor?: string | null, window?: number | null) => {
    windows.push(window);
    if (windows.length === 1) return { items: [], nextCursor: null, potentiallyTruncated: false };
    if (windows.length === 2) return { items: [item('new1', now + 1)], nextCursor: '2', potentiallyTruncated: false };
    assert.equal(cursor, '2');
    return { items: [item('new2', now + 2)], nextCursor: null, potentiallyTruncated: false };
  }};
  await runTick(s.env, [qiita], now, fetch);
  await runTick(s.env, [qiita], now + 60 * 60_000, fetch);
  await runTick(s.env, [qiita], now + 61 * 60_000, fetch);
  assert.equal(windows[0], null);
  assert.equal(windows[1], now - 48 * 60 * 60_000);
  assert.equal(windows[2], windows[1]);
  assert.deepEqual(s.sent, ['qiita:new1', 'qiita:new2']);
});

test('truncated scan records coverage gap without advancing last successful full-scan time', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  // Initial baseline is silent but, when non-exhaustive, must not be called a complete scan.
  await runTick(s.env, [qiita], now, { ...s.deps, fetchItems: async () => ({
    items: [item('old', now - 1000)], potentiallyTruncated: true, nextCursor: null,
  }) });
  let state = s.raw.prepare('SELECT * FROM monitor_state WHERE id=?').get(qiita.id);
  assert.equal(state?.initialized_at, now);
  assert.equal(state?.last_complete_at, null);
  assert.equal(state?.last_incomplete_at, now);
  assert.equal(state?.incomplete_count, 1);

  const next = now + 60 * 60_000;
  await runTick(s.env, [qiita], next, { ...s.deps, fetchItems: async () => ({
    items: [item('fresh', now + 1000)], potentiallyTruncated: false, nextCursor: null,
  }) });
  state = s.raw.prepare('SELECT * FROM monitor_state WHERE id=?').get(qiita.id);
  assert.equal(state?.last_complete_at, next);
  assert.equal(state?.incomplete_count, 1);
  assert.deepEqual(s.sent, ['qiita:fresh']);

  const overload = next + 60 * 60_000;
  await runTick(s.env, [qiita], overload, { ...s.deps, fetchItems: async () => ({
    items: [item('fresh2', next + 1000)], potentiallyTruncated: true, nextCursor: null,
  }) });
  state = s.raw.prepare('SELECT * FROM monitor_state WHERE id=?').get(qiita.id);
  assert.equal(state?.last_complete_at, next, 'full scan checkpoint must not advance on exhaustion');
  assert.equal(state?.last_incomplete_at, overload);
  assert.equal(state?.incomplete_count, 2);
  assert.deepEqual(s.sent, ['qiita:fresh', 'qiita:fresh2']);
  assert.equal(state?.scan_cursor, null, 'exhausted pagination is not resumable');
});

test('head recheck recovers a new article inserted while offset pagination was in progress', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  await runTick(s.env, [qiita], now, s.deps);
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
  await runTick(s.env, [qiita], now + 60 * 60_000, fetcher);
  await runTick(s.env, [qiita], now + 61 * 60_000, fetcher);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor,
    '__verify_head__');
  await runTick(s.env, [qiita], now + 62 * 60_000, fetcher);
  assert.deepEqual(seen, [null, '2', null]);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, null);
  assert.deepEqual(s.sent, ['qiita:first', 'qiita:late']);
});

test('failed head verification is retried from the head, not marked complete', async () => {
  const s = setup();
  const now = Date.parse('2026-10-10T00:00:00Z');
  await runTick(s.env, [qiita], now, s.deps);
  let attempts = 0;
  const fetcher = { ...s.deps, fetchItems: async (_m: Monitor, _e: Env, cursor?: string | null) => {
    attempts++;
    if (attempts === 1) return { items: [item('a', now + 1)], nextCursor: '2', potentiallyTruncated: false };
    if (attempts === 2) return { items: [], nextCursor: null, potentiallyTruncated: false };
    assert.equal(cursor, null);
    if (attempts === 3) throw new Error('head request unavailable');
    return { items: [item('b', now + 2)], nextCursor: null, potentiallyTruncated: false };
  } };
  await runTick(s.env, [qiita], now + 60 * 60_000, fetcher);
  await runTick(s.env, [qiita], now + 61 * 60_000, fetcher);
  await assert.rejects(() => runTick(s.env, [qiita], now + 62 * 60_000, fetcher), /head request/);
  assert.equal(s.raw.prepare('SELECT scan_cursor FROM monitor_state').get()?.scan_cursor, '__verify_head__');
  await runTick(s.env, [qiita], now + 67 * 60_000, fetcher);
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
    assert.equal(isJstNotificationTime(Date.parse(utc)), allowed, utc);
  }
});

test('night scans still enqueue new articles but do not post or spin; morning drains backlog', async () => {
  const s = setup();
  const day = Date.parse('2026-10-12T10:00:00Z'); // 19:00 JST
  await runTick(s.env, [qiita], day, s.deps); // baseline
  s.setItems([item('after-baseline', day + 30 * 60_000)]);
  const night = day + 60 * 60_000; // 20:00 JST
  assert.equal(await runTick(s.env, [qiita], night, s.deps), 'processed');
  assert.deepEqual(s.sent, [], 'night-time API discoveries must remain queued');
  assert.equal(s.raw.prepare("SELECT status FROM deliveries WHERE item_id='qiita:after-baseline'").get()?.status,
    'pending');
  assert.deepEqual(await getRunnableIds(s.env.DB, night + 60_000, [qiita]), [],
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
  const monitors = MONITORS.filter((m) => m.source === 'youtube');
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
  assert.equal(due, sunday + 60 * 60_000);
  assert.equal(await runTick(s.env, [monitor], Date.parse('2026-10-18T15:00:00Z'), deps), 'processed');
  assert.equal(s.raw.prepare('SELECT next_due_at FROM monitor_state WHERE id=?').get(monitor.id)?.next_due_at,
    Date.parse('2026-10-24T15:00:00Z')); // next Sunday 00:00 JST
});

test('pending YouTube notifications can be sent next morning even outside fetch weekday', async () => {
  const s = setup();
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
