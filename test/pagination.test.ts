import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchQiita, qiitaQueryWithWindow } from '../src/sources/qiita.ts';
import { fetchWikipedia, fetchWikipediaDiscovery, WIKIMEDIA_USER_AGENT } from '../src/sources/wikipedia.ts';
import { fetchArxiv } from '../src/sources/arxiv.ts';
import type { Monitor } from '../src/types.ts';

const makeMonitor = (source: Monitor['source'], query: string): Monitor => ({
  id: 'page-test', source, query, intervalMinutes: 60, enabled: true,
});

test('Qiita uses a bounded page cursor, not an entire feed in a single invocation', async () => {
  const page = Array.from({ length: 20 }, (_, n) => ({
    id: 'item' + n, title: 'Post ' + n,
    url: 'https://qiita.com/example/items/item' + n,
    created_at: '2026-10-10T00:00:00Z',
  }));
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    urls.push(String(input));
    const request = new URL(String(input));
    assert.equal(request.searchParams.get('per_page'), '20');
    return Response.json(request.searchParams.get('page') === '1' ? page : page.slice(0, 1));
  };
  const monitor = makeMonitor('qiita', 'tag:Rust');
  const first = await fetchQiita(monitor, fetcher);
  assert.equal(first.items.length, 20);
  assert.equal(first.nextCursor, '2');
  const second = await fetchQiita(monitor, fetcher, first.nextCursor);
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(new URL(urls[1]!).searchParams.get('page'), '2');
  await assert.rejects(() => fetchQiita(monitor, fetcher, '-1'), /Invalid Qiita/);
  await assert.rejects(() => fetchQiita(monitor, fetcher, '101'), /Invalid Qiita/);
});

test('Wikipedia samples at most three newest pages, ignoring old continuation cursors', async () => {
  let attempts = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const req = new URL(String(input));
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('User-Agent'), WIKIMEDIA_USER_AGENT);
    assert.equal(headers.get('Api-User-Agent'), WIKIMEDIA_USER_AGENT);
    assert.match(WIKIMEDIA_USER_AGENT, /dopagaki-notify\/0\.1 \(https:\/\/github\.com\/Nasu726\/dopagaki-notify\)/);
    assert.equal(req.searchParams.get('rclimit'), '3');
    assert.equal(req.searchParams.get('rccontinue'), null);
    assert.equal(req.searchParams.get('continue'), null);
    attempts++;
    return Response.json({
      continue: { continue: '-||', rccontinue: '20261010000000|1234' },
      query: { recentchanges: Array.from({ length: 5 }, (_, i) => ({
        type: 'new', ns: 0, pageid: 12-i, title: 'Page ' + (12-i),
        timestamp: '2026-10-10T00:00:00Z',
      })) },
    });
  };
  const monitor = makeMonitor('wikipedia', 'ja');
  const first = await fetchWikipedia(monitor, fetcher);
  assert.equal(first.items.length, 3);
  assert.deepEqual(first.items.map((entry) => entry.id),
    ['wikipedia:ja:12', 'wikipedia:ja:11', 'wikipedia:ja:10']);
  assert.equal(first.nextCursor, null);
  assert.equal(first.potentiallyTruncated, false);
  await fetchWikipedia(monitor, fetcher, '{"continue":"-||","rccontinue":"legacy"}');
  assert.equal(attempts, 2, 'an old D1 cursor must never cause an extra page read');
});

test('arXiv uses submittedDate offset pages and rejects unbounded offsets', async () => {
  const makeFeed = (size: number) => '<feed>' +
    Array.from({ length: size }, (_, n) =>
      '<entry><id>http://arxiv.org/abs/2501.' + String(n + 1).padStart(5, '0') + 'v2</id>' +
      '<title>Paper ' + n + '</title><published>2025-01-01T00:00:00Z</published></entry>'
    ).join('') + '</feed>';
  const requestedOffsets: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requestedOffsets.push(url.searchParams.get('start') ?? '');
    return new Response(makeFeed(requestedOffsets.length === 1 ? 20 : 1));
  };
  const monitor = makeMonitor('arxiv', 'cat:cs.AI');
  const first = await fetchArxiv(monitor, fetcher);
  assert.equal(first.nextCursor, '20');
  const second = await fetchArxiv(monitor, fetcher, first.nextCursor);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(requestedOffsets, ['0', '20']);
  await assert.rejects(() => fetchArxiv(monitor, fetcher, '999999'), /Invalid arXiv offset/);
});
test('Qiita respects a creation-date window but never relies on result sorting', async () => {
  const monitor = makeMonitor('qiita', 'tag:Rust');
  const base = Date.parse('2026-10-10T10:00:00Z');
  assert.equal(qiitaQueryWithWindow('tag:Rust', null), 'tag:Rust');
  assert.equal(qiitaQueryWithWindow('tag:Rust', base), 'tag:Rust created:>=2026-10-09');
  assert.equal(qiitaQueryWithWindow('', base), 'created:>=2026-10-09');
  assert.throws(() => qiitaQueryWithWindow('tag:Rust', NaN), /Invalid Qiita creation/);
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requested.push(url.searchParams.get('query') ?? '');
    const page = url.searchParams.get('page');
    const rows = Array.from({ length: page === '1' ? 20 : 1 }, (_, i) => ({
      id: 'qiita_' + i, title: 'Post', url: 'https://qiita.com/example/items/abc',
      created_at: '2026-10-10T00:00:00Z',
    }));
    return Response.json(rows);
  };
  const first = await fetchQiita(monitor, fetcher, null, base);
  assert.equal(first.nextCursor, '2');
  const second = await fetchQiita(monitor, fetcher, first.nextCursor, base);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(requested, ['tag:Rust created:>=2026-10-09', 'tag:Rust created:>=2026-10-09'],
    'all pages in a scan must share the same historical lower bound');
});

test('Wikimedia HTTP 403 surfaces as explicit denial even with descriptive identification', async () => {
  const monitor = makeMonitor('wikipedia', 'ja');
  await assert.rejects(() => fetchWikipedia(monitor, async (_url, init) => {
    assert.ok(new Headers(init?.headers).get('User-Agent')?.includes('dopagaki-notify'));
    return new Response('blocked', { status: 403 });
  }), /MediaWiki HTTP 403/);
});

test('Wikipedia discovery requests a bounded featured pool and substantial random articles', async () => {
  const requested: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requested.push(url.searchParams.get('list') ?? '');
    assert.equal(new Headers(init?.headers).get('User-Agent'), WIKIMEDIA_USER_AGENT);
    assert.equal(url.hostname, 'ja.wikipedia.org');
    assert.equal(url.searchParams.get('format'), 'json');
    if (url.searchParams.get('list') === 'categorymembers') {
      assert.equal(url.searchParams.get('cmtitle'), 'Category:秀逸な記事');
      assert.equal(url.searchParams.get('cmnamespace'), '0');
      assert.equal(url.searchParams.get('cmtype'), 'page');
      assert.equal(url.searchParams.get('cmlimit'), '500');
      return Response.json({ query: { categorymembers: Array.from({ length: 12 }, (_, i) => ({
        ns: 0, pageid: i + 1, title: 'Featured ' + i,
      })) } });
    }
    assert.equal(url.searchParams.get('list'), 'random');
    assert.equal(url.searchParams.get('rnnamespace'), '0');
    assert.equal(url.searchParams.get('rnfilterredir'), 'nonredirects');
    assert.equal(url.searchParams.get('rnminsize'), '10000');
    assert.equal(url.searchParams.get('rnlimit'), '8');
    return Response.json({ query: { random: Array.from({ length: 8 }, (_, i) => ({
      ns: 0, pageid: i + 1, title: 'Random ' + i,
    })) } });
  };
  const monitor = makeMonitor('wikipedia', 'ja:discover');
  const result = await fetchWikipediaDiscovery(monitor, fetcher);
  assert.deepEqual(requested.sort(), ['categorymembers', 'random']);
  assert.equal(result.items.length, 16);
  assert.equal(result.items.filter((entry) => entry.discoveryKind === 'featured').length, 8);
  assert.equal(result.items.filter((entry) => entry.discoveryKind === 'random').length, 8);
  assert.equal(new Set(result.items.filter((entry) => entry.discoveryKind === 'featured').map((entry) => entry.id)).size, 8);
  assert.equal(result.nextCursor, null);
  assert.equal(result.potentiallyTruncated, false);
  await assert.rejects(() => fetchWikipediaDiscovery(
    makeMonitor('wikipedia', 'ja:../bad'), fetcher), /Invalid Wikipedia discovery query/);
  await assert.rejects(() => fetchWikipediaDiscovery(monitor, async () =>
    Response.json({ error: { code: 'denied' } })), /API error/);
});

test('Wikipedia discovery rejects empty and malformed curated/random results, not silently succeeding', async () => {
  const m = makeMonitor('wikipedia', 'ja:discover');
  await assert.rejects(() => fetchWikipediaDiscovery(m, async () =>
    Response.json({ query: { categorymembers: [], random: [] } })), /empty/);
  await assert.rejects(() => fetchWikipediaDiscovery(m, async (input) =>
    Response.json(new URL(String(input)).searchParams.get('list') === 'random'
      ? { query: { random: [{ ns: 6, pageid: 8, title: 'File' }] } }
      : { query: { categorymembers: [{ ns: 0, pageid: 1, title: 'Featured' }] } })), /Malformed/);
});
