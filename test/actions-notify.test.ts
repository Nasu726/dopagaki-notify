import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { emptyLedger, hmac, latestThree, parseLedger, parseSettings, pollOnce } from '../ops/actions-notify.mjs';
import type { ContentItem, Monitor } from '../src/types.ts';

const key = randomBytes(32);
const make = (source: Monitor['source'], id: string): Monitor => ({
  id, source, query: source === 'zenn' ? 'topic:rust' : source === 'youtube' ? '@example' :
    source === 'arxiv' ? 'cat:cs.DS' : 'tag:Go', intervalMinutes: 60, enabled: true,
});
const article = (id: string, date: number): ContentItem => ({
  id, title: 'Private title for ' + id,
  url: 'https://qiita.com/example/items/' + id, publishedAt: date,
});
const env = { DISCORD_WEBHOOK_QIITA: 'https://discord.com/api/webhooks/123/token',
  DISCORD_WEBHOOK_YOUTUBE: 'https://discord.com/api/webhooks/123/token',
  DISCORD_WEBHOOK_ZENN: 'https://discord.com/api/webhooks/123/token',
  DISCORD_WEBHOOK_ARXIV: 'https://discord.com/api/webhooks/123/token' };

test('ledger contains HMAC digests and no private monitor or article text', async () => {
  const now = Date.parse('2026-10-13T01:00:00Z');
  const monitor = make('qiita', 'private-interest');
  const settings = { key, monitors: [monitor], env };
  const state = emptyLedger(key);
  const items = [article('private-article', now + 1000)];
  const received: string[] = [];
  const deps = {
    fetchItems: async () => items, send: async (_u: string, _s: string, item: ContentItem) => {
      received.push(item.id);
    },
  };
  await pollOnce(settings, state, now, deps);
  assert.deepEqual(received, [], 'initial poll must be silent');
  await pollOnce(settings, state, now + 60 * 60_000, deps);
  assert.deepEqual(received, ['private-article']);
  const json = JSON.stringify(state);
  assert.doesNotMatch(json, /private-interest|private-article|Private title|qiita.com|tag:Go/);
  assert.equal(Object.keys(state.monitors).length, 1);
  assert.deepEqual(parseLedger(json, key), state);
  assert.throws(() => parseLedger(json, randomBytes(32)), /changed HMAC key/);
});

test('newest three only, no refilling past already notified slots', async () => {
  const now = Date.parse('2026-10-13T01:00:00Z');
  const monitor = make('zenn', 'zenn-private');
  const settings = { key, monitors: [monitor], env };
  const ledger = emptyLedger(key);
  const items = ['older', 'third', 'top', 'second'].map((id, i) =>
    article(id, now + (['older', 'third', 'top', 'second'].length - i) * 100));
  assert.equal(latestThree(items).length, 3);
  await pollOnce(settings, ledger, now, { fetchItems: async () => [] });
  const sent: string[] = [];
  const feed = [
    article('old', now + 10), article('new-a', now + 50),
    article('new-c', now + 30), article('new-b', now + 40),
  ];
  await pollOnce(settings, ledger, now + HOUR, {
    fetchItems: async () => feed,
    send: async (_u: string, _s: string, item: ContentItem) => { sent.push(item.id); },
  });
  assert.deepEqual(sent, ['new-a', 'new-b', 'new-c']);
});

const HOUR = 3600_000;

test('nighttime notifications are deferred until JST morning without raw outbox', async () => {
  const now = Date.parse('2026-10-13T13:00:00Z'); // 22 JST
  const monitor = make('youtube', 'video-private');
  const settings = { key, monitors: [monitor], env };
  const ledger = emptyLedger(key);
  const deps = { fetchItems: async () => [] };
  await pollOnce(settings, ledger, now - HOUR, deps);
  const all = [article('video-secret', now - HOUR / 2)];
  const sent: string[] = [];
  await pollOnce(settings, ledger, now, {
    fetchItems: async () => all,
    send: async (_u: string, _s: string, item: ContentItem) => { sent.push(item.id); },
  });
  assert.deepEqual(sent, []);
  await pollOnce(settings, ledger, now + 11 * HOUR, {
    fetchItems: async () => all,
    send: async (_u: string, _s: string, item: ContentItem) => { sent.push(item.id); },
  });
  assert.deepEqual(sent, ['video-secret']);
});

test('bad or missing settings and damaged artifacts fail closed', () => {
  assert.throws(() => parseSettings(undefined), /required/);
  assert.throws(() => parseSettings('{'), /valid JSON/);
  assert.throws(() => parseLedger('{}', key), /Invalid state/);
  assert.throws(() => parseLedger('{', key), /not valid JSON/);
  assert.match(hmac(key, 'item', 'secret'), /^[0-9a-f]{64}$/);
});
