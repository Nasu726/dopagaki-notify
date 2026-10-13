import assert from 'node:assert/strict';
import { test } from 'node:test';
import { articleOgImage, fetchArticleThumbnail } from '../src/article-thumbnail.ts';
import { notifyDiscordWithArticleThumbnails } from '../src/discord.ts';
import type { ContentItem } from '../src/types.ts';

const qiita = 'https://qiita.com/tester/items/abc123';
const zenn = 'https://zenn.dev/tester/articles/test-article';
const webhook = 'https://discord.com/api/webhooks/123456789/token';

function page(html: string): Response {
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

test('Qiita and Zenn Open Graph image extraction handles attributes in either order and HTML entities', () => {
  assert.equal(articleOgImage('<html><head><meta content="https://images.example.com/og.png?x=1&amp;y=2" property="og:image"></head><body></body></html>', new URL(qiita)),
    'https://images.example.com/og.png?x=1&y=2');
  assert.equal(articleOgImage('<head><meta name=\'twitter:image\' content=\'https://cdn.example.com/t.png\'></head>', new URL(zenn)),
    'https://cdn.example.com/t.png');
  assert.equal(articleOgImage('<head><meta property="og:image" content="//cdn.example.com/og.jpg"><meta property="og:image:secure_url" content="https://cdn.example.com/secure.jpg"></head>', new URL(qiita)),
    'https://cdn.example.com/secure.jpg');
  assert.equal(articleOgImage('<head><meta property="og:image" content="/og/article.png"></head>', new URL(qiita)),
    'https://qiita.com/og/article.png');
});

test('Open Graph images reject unsafe URL schemes, private hosts and spoofed metadata in body', () => {
  for (const href of ['http://other.example.com/og.png', 'data:image/png;base64,xxx',
    'https://localhost/x.png', 'https://127.0.0.1/x.png', 'https://user:pass@example.com/img',
    'https://example.com:8443/x.png']) {
    const html = '<head><meta property="og:image" content="' + href + '"></head>';
    assert.equal(articleOgImage(html, new URL(qiita)), null, href);
  }
  assert.equal(articleOgImage('<head></head><body><meta property="og:image" content="https://example.com/forged.jpg"></body>', new URL(zenn)), null);
});

test('Qiita thumbnail request stays on the provider host, accepts only HTML, and does not follow redirects', async () => {
  const seen: string[] = [];
  const mock: typeof fetch = async (input, init) => {
    const uri = new URL(String(input));
    seen.push(uri.href);
    assert.equal(uri.href, qiita);
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal);
    return page('<head><meta property="og:image" content="https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/example.png"></head>');
  };
  assert.equal(await fetchArticleThumbnail('qiita', qiita, mock),
    'https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/example.png');
  assert.deepEqual(seen, [qiita]);
  assert.equal(await fetchArticleThumbnail('qiita', 'https://evil.example.com/items/x', mock), null);
  assert.equal(await fetchArticleThumbnail('qiita', 'https://qiita.com.evil.example.com/items/x', mock), null);
  assert.equal(await fetchArticleThumbnail('zenn', qiita, mock), null);
  assert.equal(await fetchArticleThumbnail('arxiv', qiita, mock), null);
  assert.equal(seen.length, 1, 'invalid sources and hosts must not issue fetch requests');

  const redirect: typeof fetch = async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } });
  assert.equal(await fetchArticleThumbnail('qiita', qiita, redirect), null);
  const notHtml: typeof fetch = async () => new Response('image', { headers: { 'content-type': 'image/png' } });
  assert.equal(await fetchArticleThumbnail('qiita', qiita, notHtml), null);
});

test('article thumbnail fetch reads only bounded metadata, not the entire page', async () => {
  const html = '<head>' + 'a'.repeat(300_000) +
    '<meta property="og:image" content="https://example.com/too-late.png"></head>';
  const fetched = await fetchArticleThumbnail('zenn', zenn, async () => page(html));
  assert.equal(fetched, null);
});

test('production Discord notifications enrich Qiita and Zenn while retaining safe fallback', async () => {
  const posted: any[] = [];
  const seen: string[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push(url.hostname);
    if (url.hostname === 'discord.com') {
      assert.equal(init?.method, 'POST');
      posted.push(JSON.parse(String(init?.body)));
      return Response.json({ id: 'sent' });
    }
    if (url.hostname === 'qiita.com') {
      return page('<head><meta property="og:image" content="https://images.example.net/qiita.png"></head>');
    }
    if (url.hostname === 'zenn.dev') {
      return page('<head><meta property="og:image" content="https://res.cloudinary.com/zenn/image/upload/cover.png"></head>');
    }
    throw new Error('Unexpected network request');
  };
  const item = (url: string): ContentItem => ({
    id: 'article-id', url, title: 'Article', publishedAt: Date.parse('2026-10-10T00:00:00Z'),
  });
  await notifyDiscordWithArticleThumbnails(webhook, 'qiita', item(qiita), fake);
  await notifyDiscordWithArticleThumbnails(webhook, 'zenn', item(zenn), fake);
  assert.deepEqual(seen, ['qiita.com','discord.com','zenn.dev','discord.com']);
  assert.equal(posted[0]?.embeds[0]?.image?.url, 'https://images.example.net/qiita.png');
  assert.equal(posted[1]?.embeds[0]?.image?.url, 'https://res.cloudinary.com/zenn/image/upload/cover.png');
  assert.deepEqual(posted[0]?.allowed_mentions, { parse: [] });

  // Image metadata failure is best effort: Discord delivery still goes ahead.
  let calls = 0;
  const broken: typeof fetch = async (input, init) => {
    calls++;
    if (new URL(String(input)).hostname === 'qiita.com') throw new Error('blocked');
    posted.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 'sent' });
  };
  await notifyDiscordWithArticleThumbnails(webhook, 'qiita', item(qiita), broken);
  assert.equal(calls, 2);
  assert.equal(posted[2]?.embeds[0]?.image, undefined);
});

test('other sources are not given extra HTTP requests', async () => {
  let calls = 0;
  const fake: typeof fetch = async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.embeds[0].image, undefined);
    return Response.json({ id: 'sent' });
  };
  await notifyDiscordWithArticleThumbnails(webhook, 'arxiv', {
    id: 'arxiv:2601.00001', url: 'https://arxiv.org/abs/2601.00001',
    title: 'Paper', publishedAt: Date.now(),
  }, fake);
  assert.equal(calls, 1);
});
