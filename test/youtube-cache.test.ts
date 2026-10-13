import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { d1ChannelCache } from '../src/sources/youtube-cache.ts';
import { fetchYouTube } from '../src/sources/youtube.ts';
import type { Database, Monitor } from '../src/types.ts';

const MONITOR: Monitor = { id: 'youtube-test', source: 'youtube', query: '@sample',
  intervalMinutes: 60, enabled: true };
const ID = 'UC1234567890123456789012';
const XML = '<feed><entry><id>yt:video:AbCdEf12345</id>' +
  '<published>2026-10-10T00:00:00Z</published><title>New item</title></entry></feed>';

function createDB(): Database {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../migrations/0002_youtube_channel_cache.sql', import.meta.url), 'utf8'));
  return {
    prepare(query) {
      const statement = raw.prepare(query);
      let parameters: unknown[] = [];
      const dbStatement = {
        bind(...args: unknown[]) { parameters = args; return dbStatement; },
        async first<T>() { return (statement.get(...parameters as []) ?? null) as T | null; },
        async all<T>() { return { results: statement.all(...parameters as []) as T[] }; },
        async run() { return { meta: { changes: Number(statement.run(...parameters as []).changes) } }; },
      };
      return dbStatement;
    },
  };
}
test('YouTube handle resolution uses D1 cache and refreshes only after seven days', async () => {
  const db = createDB();
  const start = Date.parse('2026-10-10T00:00:00Z');
  let channelPageRequests = 0, rssRequests = 0;
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === '/@sample') {
      channelPageRequests++;
      return new Response('<meta itemprop="channelId" content="' + ID + '">');
    }
    assert.equal(url.searchParams.get('channel_id'), ID);
    rssRequests++;
    return new Response(XML);
  };
  assert.equal((await fetchYouTube(MONITOR, fetcher, d1ChannelCache(db, start))).items.length, 1);
  assert.equal((await fetchYouTube(MONITOR, fetcher, d1ChannelCache(db, start + 60_000))).items.length, 1);
  assert.equal(channelPageRequests, 1);
  assert.equal(rssRequests, 2);
  assert.equal((await fetchYouTube(MONITOR, fetcher, d1ChannelCache(db, start + 8 * 24 * 60 * 60_000))).items.length, 1);
  assert.equal(channelPageRequests, 2);
  assert.equal(rssRequests, 3);
});
test('Raw YouTube channel ID bypasses lookup/cache entirely', async () => {
  const db = createDB();
  let seen = 0;
  const result = await fetchYouTube({ ...MONITOR, query: ID }, async (url) => {
    seen++;
    assert.equal(new URL(String(url)).pathname, '/feeds/videos.xml');
    return new Response(XML);
  }, d1ChannelCache(db));
  assert.equal(result.items[0]?.id, 'youtube:AbCdEf12345');
  assert.equal(seen, 1);
});

test('pinned channel ID overrides a poisoned cached @handle mapping', async () => {
  const db = createDB();
  const yurugengo = 'UCmpkIzF3xFzhPez7gXOyhVg';
  const yurucom = 'UCpLu0KjNy616-E95gPx7LZg';
  await d1ChannelCache(db).set('@yurugengo',yurucom);
  let requests = 0;
  const monitor = {...MONITOR,id:'youtube-yurugengo',query:'@yurugengo',youtubeChannelId:yurugengo};
  const items = await fetchYouTube(monitor,async (url) => {
    requests++;
    const source = new URL(String(url));
    assert.equal(source.pathname,'/feeds/videos.xml');
    assert.equal(source.searchParams.get('channel_id'),yurugengo);
    return new Response('<feed><yt:channelId>'+yurugengo+'</yt:channelId><entry>'+
      '<id>yt:video:AbCdEf12345</id><published>2026-10-10T00:00:00Z</published>'+
      '<title>Video</title></entry></feed>');
  },d1ChannelCache(db));
  assert.equal(requests,1,'no metadata fetch or cached wrong ID should be used');
  assert.equal(items.items[0]?.id,'youtube:AbCdEf12345');
  await assert.rejects(() => fetchYouTube(monitor,async ()=>
    new Response('<feed><yt:channelId>'+yurucom+'</yt:channelId></feed>')),
    /YouTube RSS channel mismatch for youtube-yurugengo/);
  await assert.rejects(() => fetchYouTube(monitor,async ()=>
    new Response('<feed><entry><id>yt:video:AbCdEf12345</id></entry></feed>')),
    /YouTube RSS channel identity missing for youtube-yurugengo/);
});

test('channel identity mismatch reports both public channel IDs and the monitor', async () => {
  const monitor = {
    ...MONITOR, id:'youtube-quizknock', query:'@QuizKnock',
    youtubeChannelId:'UCQ_MqAw18jFTlBB-f8BP7dw',
  };
  const another = 'UCpLu0KjNy616-E95gPx7LZg';
  await assert.rejects(
    () => fetchYouTube(monitor, async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.get('channel_id'),monitor.youtubeChannelId);
      return new Response('<feed><yt:channelId>'+another+'</yt:channelId></feed>');
    }),
    /channel mismatch for youtube-quizknock: expected=UCQ_MqAw18jFTlBB-f8BP7dw, received=UCpLu0KjNy616-E95gPx7LZg/,
  );
});

test('nested entry channel IDs cannot masquerade as the feed owner', async () => {
  const pinned = { ...MONITOR, id:'youtube-quizknock', query:'@QuizKnock',
    youtubeChannelId:'UCQ_MqAw18jFTlBB-f8BP7dw' };
  await assert.rejects(() => fetchYouTube(pinned, async () => new Response(
    '<feed><entry><yt:channelId>'+pinned.youtubeChannelId+'</yt:channelId></entry></feed>'
  )), /channel identity missing for youtube-quizknock/);
  const result = await fetchYouTube(pinned, async () => new Response(
    '<feed><yt:channelId>'+pinned.youtubeChannelId+'</yt:channelId>'+
    '<entry><id>yt:video:AbCdEf12345</id><published>2026-10-10T00:00:00Z</published>'+
    '<title>Video</title><yt:channelId>UCpLu0KjNy616-E95gPx7LZg</yt:channelId></entry></feed>'
  ));
  assert.equal(result.items[0]?.id,'youtube:AbCdEf12345');
});

test('RSS header identity never derives from an entry having attributes', async () => {
  const monitor = {...MONITOR,id:'youtube-quizknock',query:'@QuizKnock',
    youtubeChannelId:'UCQ_MqAw18jFTlBB-f8BP7dw'};
  await assert.rejects(() => fetchYouTube(monitor, async () => new Response(
    '<feed><entry xmlns="http://www.w3.org/2005/Atom">'+
    '<yt:channelId>'+monitor.youtubeChannelId+'</yt:channelId></entry></feed>'
  )),/channel identity missing for youtube-quizknock/);
});
