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
  raw.exec(readFileSync(new URL('../migrations/0003_catchup.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/0004_monitor_identity.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/0005_scan_coverage.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/0006_webhook_cooldown.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/0007_webhook_disabled.sql', import.meta.url), 'utf8'));

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
  assert.deepEqual(await getRunnableIds(s.env.DB, 1_000, [qiita.id]), []);
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
