import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseKey, encryptState, decryptState } from '../ops/actions/state-crypto.mjs';
import { openDatabase, applyMigrations } from '../ops/actions/sqlite.mjs';
import { runTick } from '../src/runner.ts';
import { loadRuntimeMonitors } from '../src/config.ts';
import type { Monitor, Env, ContentItem } from '../src/types.ts';

test('AES-GCM encrypted SQLite snapshots round-trip and reject tampering or wrong keys', () => {
  const key = parseKey(randomBytes(32).toString('hex'));
  const raw = Buffer.from('SQLite content with a private source and notification history');
  const ciphertext = encryptState(raw, key);
  assert.ok(!ciphertext.includes(raw));
  assert.deepEqual(decryptState(ciphertext, key), raw);
  assert.notDeepEqual(encryptState(raw, key), ciphertext, 'new nonce must be random');
  const changed = Buffer.from(ciphertext);
  changed[changed.length - 1] ^= 1;
  assert.throws(() => decryptState(changed, key), /decrypt|authenticate/);
  assert.throws(() => decryptState(ciphertext, randomBytes(32)), /decrypt|authenticate/);
  assert.throws(() => parseKey('short'), /64 hexadecimal/);
  assert.deepEqual(parseKey('  ' + '33'.repeat(32) + '\n'), Buffer.from('33'.repeat(32), 'hex'));
});

test('SQLite port runs real bundled migrations and persists the same scheduler state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-actions-'));
  const path = join(dir, 'state.sqlite');
  try {
    const now = Date.parse('2026-10-13T00:00:00Z');
    const monitor: Monitor = { id: 'qiita-test', source: 'qiita',
      query: 'tag:Go', enabled: true, intervalMinutes: 60 };
    const entry = (id: string, at: number): ContentItem => ({
      id: 'qiita:' + id, title: 'Sample ' + id,
      url: 'https://qiita.com/a/items/' + id, publishedAt: at,
    });
    const sent: string[] = [];
    let count = 0;
    let feed = [entry('old', now - 1000)];
    const deps = {
      fetchItems: async () => ({ items: feed, potentiallyTruncated: false }),
      send: async (_hook: string, _source: string, item: ContentItem) => { sent.push(item.id); },
      randomId: () => 'token-' + ++count,
    };
    let x = openDatabase(path);
    applyMigrations(x.raw);
    applyMigrations(x.raw); // idempotent
    let env = { DB: x.db, DISCORD_WEBHOOK_QIITA: 'https://discord.com/api/webhooks/123/test' } as Env;
    await runTick(env, [monitor], now, deps);
    assert.deepEqual(sent, []);
    x.raw.close();
    // Restore from encrypted artifact into an ephemeral second runner.
    const encrypted = encryptState(readFileSync(path), parseKey('33'.repeat(32)));
    const restored = decryptState(encrypted, parseKey('33'.repeat(32)));
    assert.equal(restored.subarray(0, 15).toString(), 'SQLite format 3');
    const otherPath = join(dir, 'restored.sqlite');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(otherPath, restored);
    x = openDatabase(otherPath);
    applyMigrations(x.raw);
    env = { DB: x.db, DISCORD_WEBHOOK_QIITA: 'https://discord.com/api/webhooks/123/test' } as Env;
    feed = [entry('new', now + 60_000), entry('old', now - 1000)];
    await runTick(env, [monitor], now + 60 * 60_000, deps);
    await runTick(env, [monitor], now + 120 * 60 * 60_000, deps);
    assert.deepEqual(sent, ['qiita:new']);
    assert.equal(x.raw.prepare("SELECT status FROM deliveries WHERE item_id = 'qiita:new'").get()?.status, 'sent');
    x.raw.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Actions private configuration works without public monitored preferences', () => {
  const monitors = loadRuntimeMonitors(JSON.stringify({
    targets: {
      qiita: [{ id: 'qiita-internal', query: 'tag:Go', enabled: true }],
      zenn: [], arxiv: [], youtube: [],
    },
    wikipediaEnabled: false,
    intervals: { 'qiita-internal': 240 },
  }));
  assert.deepEqual(monitors.map((m) => m.id), ['qiita-internal']);
});

test('Actions workflow uploads the exact encrypted file despite hidden .private directory', () => {
  const workflow = readFileSync(new URL('../templates/github-actions/notifier.yml', import.meta.url), 'utf8');
  const checkpoint = workflow.split('name: Save encrypted state even when the source failed')[1]?.split('      - name: Drop previous checkpoint')[0];
  assert.ok(checkpoint, 'checkpoint step must be present');
  assert.match(checkpoint, /uses: actions\/upload-artifact@v4/);
  assert.match(checkpoint, /path: \.private\/notify-state\.enc/);
  assert.doesNotMatch(workflow, /npm install/, 'scheduled runtime must not download Wrangler/TypeScript each tick');
  assert.match(checkpoint, /include-hidden-files: true/);
  assert.match(checkpoint, /if-no-files-found: error/);
  assert.doesNotMatch(checkpoint, /path: \.private\/(?:\*|monitor-config|notify-state-key)/);
});

test('Actions setup generates a generic preference-free sample and private key', () => {
  const setup = readFileSync(new URL('../ops/setup-actions.mjs', import.meta.url), 'utf8');
  assert.match(setup, /randomBytes\(32\)\.toString\('hex'\)/);
  assert.match(setup, /id: 'qiita-example'/);
  assert.match(setup, /wikipediaEnabled: false/);
  assert.doesNotMatch(setup, /readFileSync\(resolve\(root, 'config\/targets\.json'/);
});
