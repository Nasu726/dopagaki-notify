import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArxiv, stableArxivId, fetchArxiv } from '../src/sources/arxiv.ts';
import { parseZenn, zennFeedUrl, fetchZenn } from '../src/sources/zenn.ts';
import { parseYouTube, normalizeChannelReference, extractChannelId, fetchYouTube } from '../src/sources/youtube.ts';
import { entries, fetchTextBounded, tagText } from '../src/sources/xml.ts';
import { MONITORS } from '../src/config.ts';
import { webhookFor } from '../src/discord.ts';
import type { Env, Monitor } from '../src/types.ts';

const base = (source: Monitor['source'], query: string): Monitor => ({
  source, query, id: 'test-source', enabled: true, intervalMinutes: 7,
});
const arxivXml = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry>' +
  '<id>http://arxiv.org/abs/2501.12345v2</id><published>2025-01-01T00:00:00Z</published>' +
  '<updated>2026-10-10T00:00:00Z</updated><title>  Graph &amp;   Paths </title>' +
  '</entry></feed>';
const zennXml = '<?xml version="1.0"?><rss version="2.0"><channel><item>' +
  '<title><![CDATA[TypeScript & Rust]]></title><link>https://zenn.dev/a/articles/abc</link>' +
  '<guid>https://zenn.dev/a/articles/abc</guid><pubDate>Sat, 10 Oct 2026 00:00:00 GMT</pubDate>' +
  '</item></channel></rss>';
const youtubeXml = '<?xml version="1.0"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">' +
  '<entry><id>yt:video:AbCdEf12345</id><yt:videoId>AbCdEf12345</yt:videoId>' +
  '<published>2026-10-10T00:00:00Z</published><updated>2026-10-10T01:00:00Z</updated>' +
  '<title> New video </title></entry></feed>';

test('arXiv creation time, stable ID and decoded Atom title survive version updates', async () => {
  const items = parseArxiv(arxivXml);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    id: 'arxiv:2501.12345', title: 'Graph & Paths', url: 'https://arxiv.org/abs/2501.12345',
    publishedAt: Date.parse('2025-01-01T00:00:00Z'),
  });
  assert.equal(stableArxivId('http://arxiv.org/abs/hep-ex/0307015v4'), 'hep-ex/0307015');
  assert.throws(() => stableArxivId('https://attacker.invalid/path'));
  let url = '';
  const response = await fetchArxiv(base('arxiv', 'cat:cs.AI'), async (input) => {
    url = String(input);
    return new Response(arxivXml);
  });
  assert.equal(response.items.length, 1);
  const params = new URL(url).searchParams;
  assert.equal(params.get('sortBy'), 'submittedDate');
  assert.equal(params.get('sortOrder'), 'descending');
  assert.equal(params.get('search_query'), 'cat:cs.AI');
});

test('Zenn handles chronological user/topic RSS, GUID and publication time', async () => {
  assert.equal(zennFeedUrl('user:nasu').href, 'https://zenn.dev/nasu/feed');
  assert.equal(zennFeedUrl('topic:typescript').href, 'https://zenn.dev/topics/typescript/feed');
  for (const value of ['trend', '../x', 'topic:../../evil', 'user:', 'topic:']) {
    assert.throws(() => zennFeedUrl(value));
  }
  const parsed = parseZenn(zennXml);
  assert.equal(parsed[0]?.id, 'zenn:https://zenn.dev/a/articles/abc');
  assert.equal(parsed[0]?.title, 'TypeScript & Rust');
  assert.equal(parsed[0]?.publishedAt, Date.parse('2026-10-10T00:00:00Z'));
  const result = await fetchZenn(base('zenn', 'user:nasu'), async (input) => {
    assert.equal(String(input), 'https://zenn.dev/nasu/feed');
    return new Response(zennXml);
  });
  assert.equal(result.items.length, 1);
  assert.throws(() => parseZenn(zennXml.replace('https://zenn.dev/a/articles/abc',
    'https://malicious.example/a/articles/abc')));
});

test('YouTube preserves video identity and published timestamp despite updates', async () => {
  const ids = parseYouTube(youtubeXml);
  assert.equal(ids[0]?.id, 'youtube:AbCdEf12345');
  assert.equal(ids[0]?.publishedAt, Date.parse('2026-10-10T00:00:00Z'));
  assert.equal(normalizeChannelReference('https://www.youtube.com/@Example/videos'), '@example');
  assert.equal(normalizeChannelReference('UC1234567890123456789012'), 'UC1234567890123456789012');
  assert.throws(() => normalizeChannelReference('https://evil.example/@example'));
  assert.throws(() => normalizeChannelReference('https://youtube.com.evil.example/@example'));
  const feed = await fetchYouTube(base('youtube', 'UC1234567890123456789012'), async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('channel_id'), 'UC1234567890123456789012');
    return new Response(youtubeXml);
  });
  assert.equal(feed.items[0]?.id, 'youtube:AbCdEf12345');
});

test('YouTube @handle resolves through public channel page before RSS fetch', async () => {
  assert.equal(extractChannelId('{"channelId":"UC1234567890123456789012"}'), 'UC1234567890123456789012');
  let count = 0;
  await fetchYouTube(base('youtube', '@example'), async (input) => {
    count++;
    if (count === 1) {
      assert.equal(String(input), 'https://www.youtube.com/@example');
      return new Response('{"channelId":"UC1234567890123456789012"}');
    }
    assert.equal(new URL(String(input)).searchParams.get('channel_id'), 'UC1234567890123456789012');
    return new Response(youtubeXml);
  });
  assert.equal(count, 2);
});

test('XML reader decodes numeric entities, bounds response sizes and refuses bad roots', async () => {
  assert.equal(tagText('<title>x &#38; &#x03BB;</title>', 'title'), 'x & λ');
  assert.deepEqual(entries('<feed></feed>', 'entry'), []);
  assert.throws(() => entries('<notafeed/>', 'entry'), /root/);
  await assert.rejects(() => fetchTextBounded(new URL('https://zenn.dev/feed'), 'test',
    async () => new Response('x'.repeat(1200)), 1000), /too large/);
});

test('all five monitors have individual minute intervals and separate webhook secret keys', () => {
  assert.deepEqual(new Set(MONITORS.map((m) => m.source)),
    new Set(['qiita', 'wikipedia', 'arxiv', 'zenn', 'youtube']));
  assert.ok(MONITORS.every((m) => !m.enabled && Number.isInteger(m.intervalMinutes)));
  for (const source of ['arxiv', 'zenn', 'youtube'] as const) {
    const key = 'DISCORD_WEBHOOK_' + source.toUpperCase();
    const env = { [key]: 'https://discord.com/api/webhooks/1234/token' } as Env;
    assert.equal(webhookFor(base(source, 'test'), env), env[key as keyof Env]);
  }
});
