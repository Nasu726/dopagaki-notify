import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSmokeArgs, runSmoke } from '../ops/manual-smoke.mjs';

const channelId = 'UCQ_MqAw18jFTlBB-f8BP7dw';
const monitor = { id: 'youtube-quizknock', query: '@QuizKnock',
  source: 'youtube', enabled: true, intervalMinutes: 60, youtubeChannelId: channelId };
const xml = '<feed><yt:channelId>' + channelId.slice(2) + '</yt:channelId>' +
  '<entry><yt:videoId>AbCdEf12345</yt:videoId><published>2026-10-13T00:00:00Z</published>' +
  '<title>QuizKnock video</title><yt:channelId>' + channelId + '</yt:channelId></entry></feed>';

test('manual smoke requires explicit destination and two independent send flags', () => {
  assert.deepEqual(parseSmokeArgs(['--monitor=youtube-quizknock']),
    { help: false, monitorId: 'youtube-quizknock', sendTest: false });
  assert.deepEqual(parseSmokeArgs(['--monitor=youtube-quizknock', '--send-test', '--confirm-send']),
    { help: false, monitorId: 'youtube-quizknock', sendTest: true });
  for (const args of [[], ['--send-test'], ['--confirm-send', '--monitor=youtube-quizknock'],
    ['--monitor=youtube-quizknock', '--send-test'],
    ['--monitor=youtube-quizknock', '--confirm-send'],
    ['--monitor=../private'], ['--monitor=youtube-quizknock', '--monitor=qiita-rust'],
    ['--monitor=youtube-quizknock', '--bogus']]) {
    assert.throws(() => parseSmokeArgs(args));
  }
  assert.deepEqual(parseSmokeArgs(['--help']), {help: true});
});

test('manual dry-run fetches and reports identity but never sends or writes state', async () => {
  let fetchCount = 0;
  let sendCount = 0;
  const result = await runSmoke(monitor, {}, {
    fetcher: async (url) => {
      fetchCount++;
      assert.equal(new URL(String(url)).searchParams.get('channel_id'), channelId);
      return new Response(xml);
    },
    sender: async () => {sendCount++;},
  });
  assert.equal(fetchCount, 1);
  assert.equal(sendCount, 0);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.discordTestSent, false);
  assert.equal(result.productionStateVerified, false);
  assert.equal(result.pinnedChannelId, channelId);
  assert.equal(result.fetchedItems, 1);
  assert.deepEqual(result.samples, [{
    id: 'youtube:AbCdEf12345',
    publishedAt: '2026-10-13T00:00:00.000Z',
    image: 'youtube-video',
  }]);
});

test('explicit smoke send is visibly marked and does not modify receipts', async () => {
  let sent = 0;
  const response = await runSmoke(monitor, {
    DISCORD_WEBHOOK_YOUTUBE: 'https://discord.com/api/webhooks/123/test',
  }, {
    fetcher: async () => new Response(xml),
    sendTest: true,
    sender: async (url, source, item) => {
      sent++;
      assert.equal(url, 'https://discord.com/api/webhooks/123/test');
      assert.equal(source, 'youtube');
      assert.equal(item.id, 'youtube:AbCdEf12345');
      assert.equal(item.title, '[TEST] QuizKnock video');
    },
  });
  assert.equal(sent, 1);
  assert.equal(response.discordTestSent, true);
  assert.equal(response.productionStateVerified, false);
});

test('wrong upstream channel aborts before even explicitly requested Discord send', async () => {
  let sends = 0;
  await assert.rejects(() => runSmoke(monitor, {
    DISCORD_WEBHOOK_YOUTUBE: 'https://discord.com/api/webhooks/123/test',
  }, {
    fetcher: async () => new Response(
      '<feed><yt:channelId>pLu0KjNy616-E95gPx7LZg</yt:channelId></feed>'),
    sendTest: true,
    sender: async () => { sends++; },
  }), /YouTube RSS channel mismatch/);
  assert.equal(sends, 0);
});

test('dry-run does not require a Discord webhook; explicit send must have one', async () => {
  await assert.rejects(() => runSmoke(monitor, {}, {
    fetcher: async () => new Response(xml), sendTest: true,
  }), /Missing Discord webhook secret/);
});
