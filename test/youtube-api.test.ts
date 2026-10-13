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
