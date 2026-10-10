import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { stage, ensureMonitors } from '../src/state.ts';
import type { ContentItem, Database } from '../src/types.ts';

test('stage batches content into bounded multi-row D1 operations and deduplicates retries', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  let inserts = 0;
  let existingLookups = 0;
  const db: Database = {
    prepare(sql) {
      if (sql.startsWith('INSERT OR IGNORE INTO deliveries')) inserts++;
      if (sql.startsWith('SELECT item_id FROM deliveries')) existingLookups++;
      const statement = raw.prepare(sql);
      let values: unknown[] = [];
      const bindable = {
        bind(...args: unknown[]) { values = args; return bindable; },
        async run() { return { meta: { changes: Number(statement.run(...values as []).changes) } }; },
        async first<T>() { return (statement.get(...values as []) ?? null) as T | null; },
        async all<T>() { return { results: statement.all(...values as []) as T[] }; },
      };
      return bindable;
    },
  };
  const now = Date.parse('2026-10-10T00:00:00Z');
  const items: ContentItem[] = Array.from({ length: 45 }, (_, n) => ({
    id: 'test:' + n,
    title: 'Item ' + n,
    url: 'https://example.com/items/' + n,
    publishedAt: now + n * 1000,
  }));
  await stage(db, 'm', items, now, now + 60_000);
  assert.equal(inserts, 3, '45 rows => exactly three database writes (20+20+5)');
  assert.equal(raw.prepare("SELECT count(*) AS c FROM deliveries").get()?.c, 44);
  assert.equal(raw.prepare("SELECT count(*) AS c FROM deliveries WHERE status='pending'").get()?.c, 44);
  assert.equal(raw.prepare("SELECT count(*) AS c FROM deliveries WHERE status='ignored'").get()?.c, 0);
  await stage(db, 'm', items, now, now + 120_000);
  assert.equal(inserts, 3, 'known IDs must not be written again');
  assert.equal(existingLookups, 6, 'a bounded lookup replaces repeat writes');
  assert.equal(raw.prepare('SELECT count(*) AS c FROM deliveries').get()?.c, 44,
    'retry must not duplicate or change sent/ignored state');
});

test('an empty source page incurs no D1 outbox writes', async () => {
  const db: Database = {
    prepare() { throw new Error('empty page must not issue a statement'); },
  };
  await stage(db, 'm', [], null, Date.now());
});
test('initial baseline and historical backfill do not touch the D1 outbox', async () => {
  const db: Database = {
    prepare() { throw new Error('no old content should be written or queried'); },
  };
  const old = [{ id: 'legacy', title: 'Old', url: 'https://example.com/old', publishedAt: 10 }];
  await stage(db, 'm', old, null, 100);
  await stage(db, 'm', old, 100, 200);
});

test('multiple monitors bootstrap through a single bounded D1 statement', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  let statements = 0;
  const db: Database = {
    prepare(sql) {
      statements++;
      const statement = raw.prepare(sql);
      const p = {
        bind(...args: unknown[]) {
          const prepared = {
            async run() { return { meta: { changes: Number(statement.run(...args as []).changes) } }; },
            async first<T>() { return (statement.get(...args as []) ?? null) as T | null; },
            async all<T>() { return { results: statement.all(...args as []) as T[] }; },
            bind: p.bind,
          };
          return prepared;
        },
        async run() { return { meta: { changes: Number(statement.run().changes) } }; },
        async first<T>() { return (statement.get() ?? null) as T | null; },
        async all<T>() { return { results: statement.all() as T[] }; },
      };
      return p;
    },
  };
  await ensureMonitors(db, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(statements, 1, 'five monitors need just one D1 insert');
  assert.equal(raw.prepare('SELECT count(*) AS c FROM monitor_state').get()?.c, 5);
  await ensureMonitors(db, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(raw.prepare('SELECT count(*) AS c FROM monitor_state').get()?.c, 5);
});
