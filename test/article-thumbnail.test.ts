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
      if (url.pathname === '/tester/feed') {
        return new Response('<rss><channel><item><title>Article</title>' +
          '<link>https://zenn.dev/tester/articles/test-article</link>' +
          '<pubDate>Tue, 13 Oct 2026 01:00:00 GMT</pubDate>' +
          '<enclosure type="false" length="0" url="https://res.cloudinary.com/zenn/image/upload/from-rss.png"/>' +
          '</item></channel></rss>');
      }
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
  assert.equal(posted[1]?.embeds[0]?.image?.url, 'https://res.cloudinary.com/zenn/image/upload/from-rss.png');
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


test('RSS-derived Zenn image avoids extra fetch and wins over HTML', async () => {
  const url = 'https://zenn.dev/nasu/articles/from-tick';
  let calls = 0;
  const mock: typeof fetch = async (input, options) => {
    calls++;
    assert.equal(new URL(String(input)).hostname, 'discord.com',
      'image already acquired during polling: only Discord POST is necessary');
    const payload = JSON.parse(String(options?.body));
    assert.equal(payload.embeds[0].image.url,
      'https://res.cloudinary.com/zenn/image/upload/next.png');
    return Response.json({id: 'sent'});
  };
  await notifyDiscordWithArticleThumbnails(webhook,'zenn',{
    id:'zenn:'+url, title:'Next',url,publishedAt:Date.now(),
    imageUrl:'https://res.cloudinary.com/zenn/image/upload/next.png',
  },mock);
  assert.equal(calls,1);
});

test('Zenn RSS-unavailable fallback still uses article HTML OG image and sends', async () => {
  const image = 'https://res.cloudinary.com/zenn/image/upload/fallback.png';
  const sent: any[]=[];
  const requested: string[]=[];
  const mock: typeof fetch=async(input,options)=>{
    const url=new URL(String(input));
    requested.push(url.pathname);
    if(url.hostname==='discord.com'){
      sent.push(JSON.parse(String(options?.body)));
      return Response.json({id:'sent'});
    }
    if(url.pathname==='/tester/feed')
      return new Response('rate limited',{status:429});
    return page('<head><meta property="og:image" content="'+image+'"></head>');
  };
  await notifyDiscordWithArticleThumbnails(webhook,'zenn',{
    id:'zenn:'+zenn,title:'Fallback',url:zenn,publishedAt:Date.now(),
  },mock);
  assert.deepEqual(requested,['/tester/feed','/tester/articles/test-article','/api/webhooks/123456789/token']);
  assert.equal(sent[0]?.embeds[0]?.image?.url,image);
});


test('Qiita author avatar appears as small thumbnail when HTML OGP is blocked', async () => {
  const avatar='https://s3-ap-northeast-1.amazonaws.com/qiita-image-store/0/photo.png';
  const article={id:'qiita:abc',url:qiita,title:'Rust on Qiita',publishedAt:Date.now(),
    thumbnailUrl:avatar};
  let posted: any=null;
  await notifyDiscordWithArticleThumbnails(webhook,'qiita',article,async(input,init)=>{
    const url=new URL(String(input));
    if(url.hostname==='qiita.com')return new Response('forbidden',{status:403});
    posted=JSON.parse(String(init?.body));
    return Response.json({id:'sent'});
  });
  assert.equal(posted.embeds[0].image,undefined);
  assert.equal(posted.embeds[0].thumbnail.url,avatar);
  assert.equal(posted.embeds[0].url,qiita);
});

test('Qiita OGP takes precedence over fallback avatar if image metadata is available', async () => {
  const avatar='https://s3-ap-northeast-1.amazonaws.com/qiita-image-store/0/photo.png';
  const main='https://qiita-user-contents.imgix.net/sample.png';
  const article={id:'qiita:abc',url:qiita,title:'Rust on Qiita',publishedAt:Date.now(),
    thumbnailUrl:avatar};
  let posted: any=null;
  await notifyDiscordWithArticleThumbnails(webhook,'qiita',article,async(input,init)=>{
    const url=new URL(String(input));
    if(url.hostname==='qiita.com')return page('<head><meta property="og:image" content="'+main+'"></head>');
    posted=JSON.parse(String(init?.body));
    return Response.json({id:'sent'});
  });
  assert.equal(posted.embeds[0].image.url,main);
  assert.equal(posted.embeds[0].thumbnail,undefined);
});

test('Qiita oversized OGP falls back to avatar instead of posting broken Discord image', async () => {
  const avatar='https://s3-ap-northeast-1.amazonaws.com/qiita-image-store/0/photo.png';
  const tooLong='https://qiita-user-contents.imgix.net/img.png?t='+('a'.repeat(2300));
  const article={id:'qiita:abc',url:qiita,title:'Rust on Qiita',publishedAt:Date.now(),
    thumbnailUrl:avatar};
  let posted:any=null;
  await notifyDiscordWithArticleThumbnails(webhook,'qiita',article,async(input,init)=>{
    const url=new URL(String(input));
    if(url.hostname==='qiita.com')return page('<head><meta property="og:image" content="'+tooLong+'"></head>');
    posted=JSON.parse(String(init?.body));
    return Response.json({id:'sent'});
  });
  assert.equal(posted.embeds[0].image,undefined);
  assert.equal(posted.embeds[0].thumbnail.url,avatar);
});
