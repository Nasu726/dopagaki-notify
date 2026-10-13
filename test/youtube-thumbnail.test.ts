import assert from 'node:assert/strict';
import { test } from 'node:test';
import { notifyDiscordWithArticleThumbnails } from '../src/discord.ts';
import type { ContentItem } from '../src/types.ts';

const webhook = 'https://discord.com/api/webhooks/123456789/placeholder-token';
const date = Date.parse('2026-10-14T00:05:22Z');

test('YouTube Shorts and ordinary video messages carry compact preview thumbnails', async () => {
  const ids = ['vLphol5F_SY', 'Normal12345'];
  let requests = 0;
  for (const id of ids) {
    const item: ContentItem = {
      id: 'youtube:' + id,
      url: 'https://www.youtube.com/watch?v=' + id,
      title: id === 'vLphol5F_SY' ? '【10本指スマ】絶対に負けられない戦い #Shorts' : 'Normal video',
      publishedAt: date,
    };
    await notifyDiscordWithArticleThumbnails(webhook, 'youtube', item,
      async (input, init) => {
        requests++;
        const url = new URL(String(input));
        assert.equal(url.origin, 'https://discord.com');
        assert.equal(url.searchParams.get('wait'), 'true');
        assert.equal(init?.method, 'POST');
        const data = JSON.parse(String(init?.body));
        assert.equal(data.embeds.length, 1);
        assert.equal(data.embeds[0].url, item.url);
        assert.equal(data.embeds[0].title, item.title);
        assert.equal(data.embeds[0].thumbnail?.url,
          'https://i.ytimg.com/vi/' + id + '/hqdefault.jpg');
        assert.equal(data.embeds[0].image, undefined,
          'YouTube preview belongs in thumbnail instead of full-size image');
        assert.deepEqual(data.allowed_mentions, { parse: [] });
        return Response.json({ id: 'accepted' });
      });
  }
  assert.equal(requests, 2, 'no request to YouTube CDN or unexpected extra Discord POST');
});

test('non-YouTube embeds and malformed YouTube content IDs stay unmodified', async () => {
  for (const [source, id, expectedImage] of [
    ['qiita', 'qiita:abc123', 'https://images.example.net/qiita.png'],
    ['youtube', 'youtube:short', undefined],
    ['arxiv', 'arxiv:2601.00001', undefined],
  ] as const) {
    const item: ContentItem = {
      id, title: 'Sample', publishedAt: date,
      url: source === 'youtube' ? 'https://www.youtube.com/watch?v=short'
        : source === 'qiita' ? 'https://qiita.com/user/items/abc123'
          : 'https://arxiv.org/abs/2601.00001',
      ...(expectedImage ? { imageUrl: expectedImage } : {}),
    };
    const calls: string[] = [];
    await notifyDiscordWithArticleThumbnails(webhook, source, item,
      async (input, init) => {
        const url = new URL(String(input));
        calls.push(url.hostname);
        if (url.hostname === 'qiita.com')
          return new Response('blocked', { status: 403 });
        const data = JSON.parse(String(init?.body));
        if (source === 'qiita')
          assert.equal(data.embeds[0].image?.url, expectedImage);
        else {
          assert.equal(data.embeds[0].image, undefined);
          assert.equal(data.embeds[0].thumbnail, undefined);
        }
        return Response.json({ id: 'accepted' });
      });
    assert.equal(calls[calls.length - 1], 'discord.com');
  }
});
