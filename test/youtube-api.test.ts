import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchYouTubeDataApi } from '../src/sources/youtube-api.ts';
import { HttpStatusError } from '../src/http.ts';
import type { Monitor } from '../src/types.ts';

const monitor: Monitor = {
  id: 'youtube-api-test', source: 'youtube', query: '@Example',
  intervalMinutes: 60, enabled: true,
};
const channelId = 'UC1234567890123456789012';
const videoId = 'sLGshNDA5Ko';
const createMock = (observed: URL[], code = 200): typeof fetch => async (input) => {
  const url = new URL(String(input)); observed.push(url);
  if (code !== 200) return new Response('denied', { status: code });
  if (url.pathname.endsWith('/channels')) {
    return Response.json({items: [{id: channelId,
      contentDetails: {relatedPlaylists: {uploads: 'UU1234567890123456789012'}}}]});
  }
  if (url.pathname.endsWith('/playlistItems')) {
    return Response.json({items: [{
      status: {privacyStatus: 'public'},
      snippet: {title: 'New video'},
      contentDetails: {videoId, videoPublishedAt:'2026-10-13T09:00:00Z'},
    }]});
  }
  throw new Error('Unexpected YouTube endpoint');
};

test('official YouTube API resolves @handle then queries uploads playlist using videoPublishedAt', async () => {
  const urls: URL[] = [];
  const response = await fetchYouTubeDataApi(monitor, 'fake-valid-api-key', createMock(urls));
  assert.deepEqual(response, {items: [{
    id: 'youtube:' + videoId, title: 'New video',
    url: 'https://www.youtube.com/watch?v=' + videoId,
    publishedAt: Date.parse('2026-10-13T09:00:00Z'),
  }], potentiallyTruncated: false});
  assert.equal(urls.length, 2);
  assert.equal(urls[0]?.searchParams.get('forHandle'), '@example');
  assert.equal(urls[0]?.searchParams.get('part'), 'contentDetails');
  assert.equal(urls[1]?.searchParams.get('part'), 'snippet,contentDetails,status');
  assert.equal(urls[1]?.searchParams.get('maxResults'), '50');
  assert.equal(urls[0]?.searchParams.get('key'), 'fake-valid-api-key');
  assert.equal(urls[1]?.searchParams.get('key'), 'fake-valid-api-key');
});

test('official API supports raw UC channel IDs and surfaces HTTP errors for retry', async () => {
  const urls: URL[] = [];
  await fetchYouTubeDataApi({...monitor, query: channelId}, 'key', createMock(urls));
  assert.equal(urls[0]?.searchParams.get('id'), channelId);
  assert.equal(urls[0]?.searchParams.has('forHandle'), false);
  await assert.rejects(() => fetchYouTubeDataApi(monitor, 'key', createMock([], 403)),
    (error: unknown) => error instanceof HttpStatusError && error.source === 'YouTube Data API' && error.status === 403);
  await assert.rejects(() => fetchYouTubeDataApi(monitor, ''), /Invalid YOUTUBE_API_KEY/);
});

test('official API respects pinned UC ID instead of resolving @handle', async () => {
  const channel = 'UCmpkIzF3xFzhPez7gXOyhVg';
  let captured = '';
  const testFetch: typeof fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/channels')) {
      captured = u.searchParams.get('id') ?? '';
      assert.equal(u.searchParams.has('forHandle'),false);
      return Response.json({items:[{id:channel,contentDetails:{
        relatedPlaylists:{uploads:'UUmpkIzF3xFzhPez7gXOyhVg'},
      }}]});
    }
    return Response.json({items:[]});
  };
  await fetchYouTubeDataApi({...monitor,query:'@yurugengo',youtubeChannelId:channel},'key',testFetch);
  assert.equal(captured,channel);
});


test('official API refuses a poisoned channels.list result instead of crossing channels',async()=>{
  const pinned={...monitor,query:'@yurugengo',youtubeChannelId:'UCmpkIzF3xFzhPez7gXOyhVg'};
  let requests=0;
  await assert.rejects(()=>fetchYouTubeDataApi(pinned,'key',async(input)=>{
    requests++;
    const url=new URL(String(input));
    assert.ok(url.pathname.endsWith('/channels'));
    assert.equal(url.searchParams.get('id'),pinned.youtubeChannelId);
    return Response.json({items:[{
      id:'UCpLu0KjNy616-E95gPx7LZg',
      contentDetails:{relatedPlaylists:{uploads:'UUpLu0KjNy616-E95gPx7LZg'}},
    }]});
  }),/channel identity mismatch/);
  assert.equal(requests,1,'do not fetch wrong owner uploads after mismatch');
});

test('official API requires an explicit valid channel owner even for @handle',async()=>{
  for(const bogus of [undefined,'Q_MqAw18jFTlBB-f8BP7dw','UCbogus','']) {
    await assert.rejects(()=>fetchYouTubeDataApi(monitor,'key',async()=>Response.json({
      items:[{id:bogus,contentDetails:{relatedPlaylists:{uploads:'UU1234567890123456789012'}}}],
    })),/channel identity mismatch/);
  }
});

test('official API rejects contradictory playlist item owners before staging',async()=>{
  const pinned={...monitor,query:channelId,youtubeChannelId:channelId};
  for(const field of ['channelId','videoOwnerChannelId'] as const){
    let calls=0;
    await assert.rejects(()=>fetchYouTubeDataApi(pinned,'key',async(input)=>{
      calls++;
      const url=new URL(String(input));
      if(url.pathname.endsWith('/channels'))return Response.json({
        items:[{id:channelId,contentDetails:{relatedPlaylists:{uploads:'UU1234567890123456789012'}}}],
      });
      return Response.json({items:[{
        status:{privacyStatus:'public'},
        snippet:{title:'Mismatched video',[field]:'UCpLu0KjNy616-E95gPx7LZg'},
        contentDetails:{videoId,videoPublishedAt:'2026-10-13T09:00:00Z'},
      }]});
    }),/playlist item channel mismatch/);
    assert.equal(calls,2);
  }
});

test('official API allows valid/absent playlist owner IDs, skips nonpublic items',async()=>{
  const pinned={...monitor,query:channelId,youtubeChannelId:channelId};
  const fetched=await fetchYouTubeDataApi(pinned,'key',async(input)=>{
    const url=new URL(String(input));
    if(url.pathname.endsWith('/channels'))return Response.json({
      items:[{id:channelId,contentDetails:{relatedPlaylists:{uploads:'UU1234567890123456789012'}}}],
    });
    return Response.json({items:[
      {status:{privacyStatus:'public'},
        snippet:{title:'Public owner',channelId,videoOwnerChannelId:channelId},
        contentDetails:{videoId,videoPublishedAt:'2026-10-13T09:00:00Z'}},
      {status:{privacyStatus:'private'},
        snippet:{title:'Private video',videoOwnerChannelId:'UCpLu0KjNy616-E95gPx7LZg'},
        contentDetails:{videoId:'private1234',videoPublishedAt:'2026-10-13T09:00:00Z'}},
    ]});
  });
  assert.equal(fetched.items.length,1);
  assert.equal(fetched.items[0]?.id,'youtube:'+videoId);
});
