import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchQiita, qiitaQueryWithWindow } from '../src/sources/qiita.ts';
import { fetchWikipedia } from '../src/sources/wikipedia.ts';
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

test('Wikipedia persists both rccontinue and continue tokens', async () => {
  let attempts = 0;
  const fetcher: typeof fetch = async (input) => {
    const req = new URL(String(input));
    attempts++;
    if (attempts === 1) {
      assert.equal(req.searchParams.get('rccontinue'), null);
      return Response.json({
        continue: { continue: '-||', rccontinue: '20261010000000|1234' },
        query: { recentchanges: [{ type: 'new', ns: 0, pageid: 12,
          title: 'First', timestamp: '2026-10-10T00:00:00Z' }] },
      });
    }
    assert.equal(req.searchParams.get('continue'), '-||');
    assert.equal(req.searchParams.get('rccontinue'), '20261010000000|1234');
    return Response.json({
      query: { recentchanges: [{ type: 'new', ns: 0, pageid: 11,
        title: 'Second', timestamp: '2026-10-09T23:00:00Z' }] },
    });
  };
  const monitor = makeMonitor('wikipedia', 'ja');
  const first = await fetchWikipedia(monitor, fetcher);
  assert.ok(first.nextCursor);
  const second = await fetchWikipedia(monitor, fetcher, first.nextCursor);
  assert.equal(second.items[0]?.id, 'wikipedia:ja:11');
  assert.equal(second.nextCursor, null);
  await assert.rejects(() => fetchWikipedia(monitor, fetcher, '{"continue":{}}'),
    /Invalid MediaWiki cursor/);
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
