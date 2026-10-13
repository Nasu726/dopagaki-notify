import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import {
  WIKIMEDIA_USER_AGENT, wikimediaUserAgent, fetchWikipedia, fetchWikipediaDiscovery,
} from '../src/sources/wikipedia.ts';
import type { Monitor } from '../src/types.ts';

const monitor: Monitor = {
  id: 'wikipedia-ja-discovery', source: 'wikipedia', query: 'ja:discover',
  intervalMinutes: 120, enabled: true,
};
const contact = 'https://github.com/fork-owner/dopagaki-notify';
const agent = 'dopagaki-notify/0.1 (' + contact + ')';

test('Wikimedia client identification uses the configured fork operator URL', () => {
  assert.equal(wikimediaUserAgent(contact), agent);
  assert.equal(wikimediaUserAgent(), WIKIMEDIA_USER_AGENT,
    'existing maintainer deployment must retain its original contact');
  assert.ok(!agent.includes('Nasu726'));
});

test('Wikimedia contact rejects missing scheme, unsafe schemes, credentials, and header injection', () => {
  for (const value of [
    'github.com/other/repo', 'http://example.com', 'javascript:alert(1)',
    'https://user:password@example.com', 'https://example.com/?key=123',
    'https://example.com/#frag', 'https://example.com/ok\r\nX-Hijacked: yes',
    'https://example.com/(bad)', 'https://example.com/\\header',
    'https://example.com/' + 'a'.repeat(300),
  ]) {
    assert.throws(() => wikimediaUserAgent(value), /Invalid WIKIMEDIA_CONTACT_URL/);
  }
});

test('legacy Wikipedia recent changes sends both Wikimedia identity headers', async () => {
  const captured: string[] = [];
  const target = { ...monitor, query: 'ja' };
  const mock: typeof fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    captured.push(headers.get('User-Agent') ?? '', headers.get('Api-User-Agent') ?? '');
    return Response.json({ query: { recentchanges: [] } });
  };
  const result = await fetchWikipedia(target, mock, null, contact);
  assert.deepEqual(result.items, []);
  assert.deepEqual(captured, [agent, agent]);
});

test('Wikipedia discovery sends the fork operator identity on BOTH API requests', async () => {
  const captured: string[] = [];
  const mock: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    captured.push(headers.get('User-Agent') ?? '', headers.get('Api-User-Agent') ?? '');
    const list = new URL(String(url)).searchParams.get('list');
    if (list === 'categorymembers') return Response.json({
      query: { categorymembers: [{ ns: 0, pageid: 5, title: 'Featured' }] },
    });
    if (list === 'random') return Response.json({
      query: { random: [{ ns: 0, id: 6, title: 'Random' }] },
    });
    throw new Error('Unexpected MediaWiki API');
  };
  const result = await fetchWikipediaDiscovery(monitor, mock, contact);
  assert.equal(result.items.length, 2);
  assert.deepEqual(captured, [agent, agent, agent, agent]);
});

test('GitHub Actions passes custom Wikimedia Variable and infers fork URL by default', () => {
  const workflow = readFileSync(new URL('../templates/github-actions/notifier.yml', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../ops/actions/run-once.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /WIKIMEDIA_CONTACT_URL: \$\{\{ vars\.WIKIMEDIA_CONTACT_URL \}\}/);
  assert.match(runner, /process\.env\.GITHUB_REPOSITORY/);
});
