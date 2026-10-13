import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArxiv, stableArxivId, fetchArxiv } from '../src/sources/arxiv.ts';
import { parseZenn, zennFeedUrl, fetchZenn } from '../src/sources/zenn.ts';
import { parseYouTube, normalizeChannelReference, extractChannelId, fetchYouTube } from '../src/sources/youtube.ts';
import { entries, fetchTextBounded, tagText } from '../src/sources/xml.ts';
import { MONITORS, arxivCategoryQuery, queryMonitorsFromTargets, youtubeMonitorsFromTargets, withIntervals, validateMonitors } from '../src/config.ts';
import { webhookFor, notifyDiscord } from '../src/discord.ts';
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
  assert.equal(extractChannelId('<meta itemprop="channelId" content="UC1234567890123456789012">'), 'UC1234567890123456789012');
  let count = 0;
  await fetchYouTube(base('youtube', '@example'), async (input) => {
    count++;
    if (count === 1) {
      assert.equal(String(input), 'https://www.youtube.com/@example');
      return new Response('<meta itemprop="channelId" content="UC1234567890123456789012">');
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
  assert.ok(MONITORS.every((m) => Number.isInteger(m.intervalMinutes)));
  assert.deepEqual(MONITORS.filter((m) => m.enabled).map((m) => m.id),
    ['qiita-rust', 'qiita-algorithms', 'qiita-design', 'wikipedia-ja-discovery',
      'arxiv-cs-ai', 'arxiv-cs-ds', 'zenn-topic-typescript', 'zenn-topic-algorithm', 'zenn-topic-architecture',
      'youtube-yurugengo', 'youtube-yurucom', 'youtube-3blue1brown-japan',
      'youtube-quizknock'],
    'Qiita/Zenn/arXiv targets and selected YouTube channels are enabled');
  for (const source of ['arxiv', 'zenn', 'youtube'] as const) {
    const key = 'DISCORD_WEBHOOK_' + source.toUpperCase();
    const env = { [key]: 'https://discord.com/api/webhooks/1234/token' } as Env;
    assert.equal(webhookFor(base(source, 'test'), env), env[key as keyof Env]);
  }
});

test('malformed and incomplete RSS/Atom are not mistaken for empty feeds', () => {
  for (const broken of [
    '<feed><entry><title>incomplete</title></feed>',
    '<feed><entry><title>incomplete</title></entry>',
    '<rss><channel><item><title>half</title></channel></rss>',
    '<rss><channel><item><title>A</title></item><item><title>B</title></channel></rss>',
  ]) {
    assert.throws(() => entries(broken, broken.startsWith('<rss') ? 'item' : 'entry'),
      /Malformed|Truncated/);
  }
  assert.deepEqual(entries('<feed><title>No new entries</title></feed>', 'entry'), []);
  assert.deepEqual(entries('<rss><channel></channel></rss>', 'item'), []);
  // A tag-shaped phrase within a comment is not an actual entry.
  assert.deepEqual(entries('<feed><!-- <entry>an example</entry> --></feed>', 'entry'), []);
});

test('RSS CDATA and comments cannot fabricate or hide article boundaries', () => {
  const rss = '<rss version="2.0"><channel>' +
    '<!-- <item><title>not a real article</title></item> -->' +
    '<item><title><![CDATA[The <item> syntax &amp; </item> literals]]></title>' +
    '<link>https://zenn.dev/a/articles/cdata</link>' +
    '<guid>https://zenn.dev/a/articles/cdata</guid>' +
    '<pubDate>Sat, 10 Oct 2026 00:00:00 GMT</pubDate></item>' +
    '</channel></rss>';
  assert.equal(entries(rss, 'item').length, 1,
    'literal XML-like text in CDATA must not count as article tags');
  const [article] = parseZenn(rss);
  assert.equal(article?.title, 'The <item> syntax &amp; </item> literals',
    'literal CDATA text must keep brackets and ampersand entity syntax');
  assert.equal(article?.id, 'zenn:https://zenn.dev/a/articles/cdata');
});

test('mixed XML entities and CDATA are decoded only outside CDATA', () => {
  const source = '<title>Head &amp; <![CDATA[A &amp; <entry>]]> tail &lt;end&gt;</title>';
  assert.equal(tagText(source, 'title'), 'Head & A &amp; <entry> tail <end>');
  assert.equal(entries('<feed><!-- <entry><id>fake</id></entry> --></feed>', 'entry').length, 0);
});

test('arXiv category query config and dormant YouTube reference are explicit', () => {
  assert.equal(arxivCategoryQuery(['cs.AI']), 'cat:cs.AI');
  assert.equal(arxivCategoryQuery(['cs.AI', 'math.CO']), 'cat:cs.AI OR cat:math.CO');
  for (const invalid of [[], ['cat:cs.AI'], ['cs.AI OR cat:evil'], ['../oops']]) {
    assert.throws(() => arxivCategoryQuery(invalid));
  }
  const expected = [
    { id: 'youtube-yurugengo', query: '@yurugengo', weekday: 'tuesday' },
    { id: 'youtube-yurucom', query: '@yurucom', weekday: 'sunday' },
    { id: 'youtube-3blue1brown-japan', query: '@3Blue1BrownJapan', weekday: 'sunday' },
  ];
  for (const target of expected) {
    const monitor = MONITORS.find((m) => m.id === target.id);
    assert.equal(monitor?.query, target.query);
    assert.equal(monitor?.weeklyJstDay, target.weekday);
    assert.equal(monitor?.intervalMinutes, 60);
    assert.equal(monitor?.enabled, true);
  }
  assert.ok(!MONITORS.some((m) => m.id === 'youtube-example'));
  assert.throws(() => validateMonitors(withIntervals(
    youtubeMonitorsFromTargets([{ id: 'weekly-invalid', channel: '@valid', enabled: true, weekdayJst: 'not-a-day' }]),
    { 'weekly-invalid': 60 },
  )), /weeklyJstDay/);
  assert.throws(() => validateMonitors(withIntervals(
    youtubeMonitorsFromTargets([{ id: 'weekly-mismatch', channel: '@valid', enabled: true, weekdayJst: 'sunday' }]),
    { 'weekly-mismatch': 10080 },
  )), /weeklyJstDay/);
});


test('Qiita and Zenn targets support independent IDs, queries, intervals and enabled flags', () => {
  const definitions = [
    ...queryMonitorsFromTargets('qiita', [
      { id: 'qiita-rust', query: '  tag:Rust ', enabled: true },
      { id: 'qiita-algorithm', query: 'tag:Algorithm', enabled: true },
      { id: 'qiita-paused', query: 'tag:Python', enabled: false },
    ]),
    ...queryMonitorsFromTargets('zenn', [
      { id: 'zenn-topic-typescript', query: 'topic:typescript', enabled: true },
      { id: 'zenn-user', query: 'user:nasu', enabled: true },
      { id: 'zenn-paused', query: '', enabled: false },
    ]),
  ];
  const intervals = {
    'qiita-rust': 60, 'qiita-algorithm': 180, 'qiita-paused': 1440,
    'zenn-topic-typescript': 120, 'zenn-user': 300, 'zenn-paused': 60,
  };
  const monitors = withIntervals(definitions, intervals);
  assert.doesNotThrow(() => validateMonitors(monitors));
  assert.deepEqual(monitors.map(({ id, query, intervalMinutes, enabled }) =>
    ({ id, query, intervalMinutes, enabled })), [
    { id: 'qiita-rust', query: 'tag:Rust', intervalMinutes: 60, enabled: true },
    { id: 'qiita-algorithm', query: 'tag:Algorithm', intervalMinutes: 180, enabled: true },
    { id: 'qiita-paused', query: 'tag:Python', intervalMinutes: 1440, enabled: false },
    { id: 'zenn-topic-typescript', query: 'topic:typescript', intervalMinutes: 120, enabled: true },
    { id: 'zenn-user', query: 'user:nasu', intervalMinutes: 300, enabled: true },
    { id: 'zenn-paused', query: '', intervalMinutes: 60, enabled: false },
  ]);
  assert.throws(() => withIntervals(definitions,
    { ...intervals, 'qiita-extra': 30 }), /Unknown interval setting/);
  const { 'qiita-algorithm': _omitted, ...incomplete } = intervals;
  assert.throws(() => withIntervals(definitions, incomplete), /interval must be a positive integer/);
  assert.throws(() => validateMonitors(withIntervals([
    ...definitions, { ...definitions[0]! },
  ], intervals)), /Duplicate monitor id/);
  assert.throws(() => validateMonitors(withIntervals(queryMonitorsFromTargets('zenn', [
    { id: 'zenn-invalid', query: 'topic:../bad', enabled: true },
  ]), { 'zenn-invalid': 60 })), /invalid user\/topic feed/);
  assert.throws(() => validateMonitors(withIntervals(queryMonitorsFromTargets('qiita', [
    { id: 'qiita-empty', query: '  ', enabled: true },
  ]), { 'qiita-empty': 60 })), /requires a configured query/);
});

test('arXiv keeps the original cs.AI monitor ID and adds independently tracked cs.DS', () => {
  const ai = MONITORS.find((monitor) => monitor.id === 'arxiv-cs-ai');
  const ds = MONITORS.find((monitor) => monitor.id === 'arxiv-cs-ds');
  assert.deepEqual(
    [ai && { source: ai.source, query: ai.query, interval: ai.intervalMinutes, enabled: ai.enabled },
     ds && { source: ds.source, query: ds.query, interval: ds.intervalMinutes, enabled: ds.enabled }],
    [{ source: 'arxiv', query: 'cat:cs.AI', interval: 120, enabled: true },
     { source: 'arxiv', query: 'cat:cs.DS', interval: 120, enabled: true }],
  );
  assert.equal(MONITORS.find((m) => m.id === 'qiita-rust')?.query, 'tag:Rust');
  assert.equal(MONITORS.find((m) => m.id === 'zenn-topic-typescript')?.query, 'topic:typescript');
});

test('multiple YouTube channels have independently configured intervals and flags', () => {
  const definitions = youtubeMonitorsFromTargets([
    { id: 'youtube-fast', channel: '@fast', enabled: true },
    { id: 'youtube-weekly', channel: 'UC1234567890123456789012', enabled: true },
    { id: 'youtube-paused', channel: '', enabled: false },
  ]);
  const monitors = withIntervals(definitions, {
    'youtube-fast': 60,
    'youtube-weekly': 10080,
    'youtube-paused': 720,
  });
  assert.doesNotThrow(() => validateMonitors(monitors));
  assert.deepEqual(monitors.map(({id, query, intervalMinutes, enabled}) =>
    ({id, query, intervalMinutes, enabled})), [
      { id: 'youtube-fast', query: '@fast', intervalMinutes: 60, enabled: true },
      { id: 'youtube-weekly', query: 'UC1234567890123456789012', intervalMinutes: 10080, enabled: true },
      { id: 'youtube-paused', query: '', intervalMinutes: 720, enabled: false },
    ]);
  assert.throws(() => withIntervals(definitions, {
    'youtube-fast': 60, 'youtube-weekly': 10080,
  }), /interval must be a positive integer/);
  assert.throws(() => validateMonitors(withIntervals([
    ...definitions, definitions[0]!,
  ], {'youtube-fast': 60, 'youtube-weekly': 10080, 'youtube-paused': 720})), /Duplicate monitor id/);
  assert.throws(() => validateMonitors(withIntervals(youtubeMonitorsFromTargets([
    { id: 'youtube-invalid', channel: 'https://evil.example/x', enabled: true },
  ]), { 'youtube-invalid': 60 })), /invalid channel reference/);
});

test('YouTube handle lookup refuses incidental IDs from related channels', () => {
  const yurucom = 'UCpLu0KjNy616-E95gPx7LZg';
  const yurugengo = 'UCmpkIzF3xFzhPez7gXOyhVg';
  const page = '<script>{"channelId":"' + yurucom +
    '","externalId":"' + yurucom + '"}</script>' +
    '<a href="/channel/' + yurucom + '">related</a>' +
    '<meta content="' + yurugengo + '" itemprop="channelId">';
  assert.equal(extractChannelId(page), yurugengo,
    'only owner metadata may resolve a channel, even if content precedes itemprop');
  assert.throws(() => extractChannelId(
    '<script>{"channelId":"' + yurucom + '"}</script><a href="/channel/' + yurucom + '">sister</a>'
  ), /Could not identify YouTube channel owner/);
});

test('pinned YouTube targets retain handle monitor identity but bypass unreliable channel page/cache', () => {
  const target = youtubeMonitorsFromTargets([{
    id:'youtube-yurugengo', channel:'@yurugengo', channelId:'UCmpkIzF3xFzhPez7gXOyhVg',
    weekdayJst:'tuesday', enabled:true,
  }])[0]!;
  const monitor = withIntervals([target],{'youtube-yurugengo':60})[0]!;
  assert.equal(monitor.query, '@yurugengo');
  assert.equal(monitor.youtubeChannelId,'UCmpkIzF3xFzhPez7gXOyhVg');
  assert.doesNotThrow(() => validateMonitors([monitor]));
  assert.throws(() => validateMonitors([{
    ...monitor,youtubeChannelId:'UCpLu0KjNy616-E95gPx7LZg', query:'UCmpkIzF3xFzhPez7gXOyhVg',
  }]),/Pinned YouTube channel ID does not match query/);
});

test('Discord YouTube embeds include a video thumbnail while other sources remain unchanged', async () => {
  const payloads: unknown[] = [];
  const post: typeof fetch = async (_url, options) => {
    payloads.push(JSON.parse(String(options?.body)));
    return Response.json({id:'ok'});
  };
  const discordWebhook='https://discord.com/api/webhooks/1234/token';
  const video = { id: 'youtube:XkD2XZSerCg', title: 'Video',
    url:'https://www.youtube.com/watch?v=XkD2XZSerCg',publishedAt:Date.now() };
  await notifyDiscord(discordWebhook,'youtube',video,post);
  await notifyDiscord(discordWebhook,'qiita',{...video,id:'qiita:abcd'},post);
  const yt = payloads[0] as {embeds: {image?:{url:string}}[]};
  const qiita = payloads[1] as {embeds:{image?:{url:string}}[]};
  assert.equal(yt.embeds[0]?.image?.url,'https://i.ytimg.com/vi/XkD2XZSerCg/hqdefault.jpg');
  assert.equal(qiita.embeds[0]?.image,undefined);
});

test('QuizKnock runs every day hourly with a pinned immutable channel ID', () => {
  const monitor=MONITORS.find((m)=>m.id==='youtube-quizknock');
  assert.ok(monitor);
  assert.equal(monitor.source,'youtube');
  assert.equal(monitor.query,'@QuizKnock');
  assert.equal(monitor.youtubeChannelId,'UCQ_MqAw18jFTlBB-f8BP7dw');
  assert.equal(monitor.intervalMinutes,60);
  assert.equal(monitor.enabled,true);
  assert.equal(monitor.weeklyJstDay,undefined,
    'QuizKnock must not be restricted to a particular weekday');
});

test('Zenn RSS enclosure URL is used as a validated article thumbnail', () => {
  const prefix = '<?xml version="1.0"?><rss><channel><item><title>Graph algorithms</title>' +
    '<link>https://zenn.dev/nasu/articles/test-graph</link>' +
    '<guid>https://zenn.dev/nasu/articles/test-graph</guid>' +
    '<pubDate>Tue, 13 Oct 2026 01:00:00 GMT</pubDate>';
  const finish = '</item></channel></rss>';
  const original = prefix +
    '<enclosure url="https://res.cloudinary.com/zenn/image/upload/graph.png?x=1&amp;y=2" length="0" type="false"/>' +
    finish;
  const works = parseZenn(original);
  assert.equal(works.length, 1);
  assert.equal(works[0]?.imageUrl,
    'https://res.cloudinary.com/zenn/image/upload/graph.png?x=1&y=2');

  const otherOrder = prefix +
    '<enclosure type="false" length="0" url="//res.cloudinary.com/zenn/image/upload/other.png"/>' + finish;
  assert.equal(parseZenn(otherOrder)[0]?.imageUrl,
    'https://res.cloudinary.com/zenn/image/upload/other.png');

  for (const bad of [
    'http://localhost/evil', 'https://127.0.0.1/evil', 'javascript:alert(1)',
  ]) {
    assert.equal(parseZenn(prefix + '<enclosure url="' + bad + '" />' + finish)[0]?.imageUrl,
      undefined, bad);
  }
  const fake = prefix +
    '<!-- <enclosure url="https://example.com/false.png" /> -->' + finish;
  assert.equal(parseZenn(fake)[0]?.imageUrl, undefined);
});
