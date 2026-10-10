import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { stage } from '../src/state.ts';
import type { ContentItem, Database } from '../src/types.ts';

test('stage batches content into bounded multi-row D1 operations and deduplicates retries', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8'));
  let inserts = 0;
  const db: Database = {
    prepare(sql) {
      if (sql.startsWith('INSERT OR IGNORE INTO deliveries')) inserts++;
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
  assert.equal(raw.prepare("SELECT count(*) AS c FROM deliveries").get()?.c, 45);
  assert.equal(raw.prepare("SELECT count(*) AS c FROM deliveries WHERE status='pending'").get()?.c, 44);
  assert.equal(raw.prepare("SELECT count(*) AS c FROM deliveries WHERE status='ignored'").get()?.c, 1);
  await stage(db, 'm', items, now, now + 120_000);
  assert.equal(inserts, 6);
  assert.equal(raw.prepare('SELECT count(*) AS c FROM deliveries').get()?.c, 45,
    'retry must not duplicate or change sent/ignored state');
});

test('an empty source page incurs no D1 outbox writes', async () => {
  const db: Database = {
    prepare() { throw new Error('empty page must not issue a statement'); },
  };
  await stage(db, 'm', [], null, Date.now());
});