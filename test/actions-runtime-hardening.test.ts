import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, applyMigrations } from '../ops/actions/sqlite.mjs';
import { buildActionsEnv } from '../ops/actions/runtime-config.mjs';
import { runDueMonitorsOnce, ACTIONS_TICK_BUDGET_MS } from '../ops/actions/tick-loop.mjs';
import {
  latestLiveCheckpoint, hasCheckpointHistory, workflowIdOf,
} from '../ops/actions/checkpoint-plan.mjs';
import { fetchOpenAlex } from '../src/sources/openalex.ts';
import type { ContentItem, Env, Monitor } from '../src/types.ts';

const WEBHOOK = 'https://discord.com/api/webhooks/123/test';
const T0 = Date.parse('2026-11-13T00:07:00Z');
const MINUTE = 60_000;

type RawDb = { prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown } };

function withDatabase(run: (db: Env['DB'], raw: RawDb) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'notify-actions-loop-'));
    const { raw, db } = openDatabase(join(dir, 'state.sqlite'));
    try {
      applyMigrations(raw);
      await run(db, raw);
    } finally {
      raw.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const qiita = (id: string): Monitor => ({ id, source: 'qiita', query: 'tag:' + id, enabled: true, intervalMinutes: 60 });

function fakeDeps(clock: { now: number }, feeds: Record<string, () => ContentItem[]>) {
  const fetched: string[] = [];
  const sent: string[] = [];
  let token = 0;
  return {
    fetched, sent,
    deps: {
      fetchItems: async (monitor: Monitor) => {
        fetched.push(monitor.id);
        const feed = feeds[monitor.id];
        if (!feed) throw new Error('upstream down');
        return { items: feed(), potentiallyTruncated: false };
      },
      send: async (_hook: string, _source: string, item: ContentItem) => { sent.push(item.id); },
      randomId: () => 'lease-' + ++token,
      clock: () => clock.now,
    },
  };
}

test('Actions treats unregistered (empty) Secrets and Variables as unset', () => {
  const env = buildActionsEnv({
    GITHUB_REPOSITORY: 'friend/dopagaki-notify',
    WIKIMEDIA_CONTACT_URL: '', NOTIFICATION_WINDOW_JST: '', OPENALEX_API_KEY: '',
    YOUTUBE_API_KEY: '', DISCORD_WEBHOOK_ZENN: '', DISCORD_WEBHOOK_QIITA: WEBHOOK,
  }, undefined);
  assert.equal(env.OPENALEX_API_KEY, undefined);
  assert.equal(env.YOUTUBE_API_KEY, undefined);
  assert.equal(env.NOTIFICATION_WINDOW_JST, undefined);
  assert.equal(env.DISCORD_WEBHOOK_ZENN, undefined);
  assert.equal(env.DISCORD_WEBHOOK_QIITA, WEBHOOK);
  assert.equal(env.WIKIMEDIA_CONTACT_URL, 'https://github.com/friend/dopagaki-notify');
  // Registered values (even malformed ones) still reach strict validation.
  const explicit = buildActionsEnv({ OPENALEX_API_KEY: ' ', WIKIMEDIA_CONTACT_URL: 'https://example.org/c',
    GITHUB_REPOSITORY: 'friend/x', NOTIFICATION_WINDOW_JST: '09:00-20:00' }, '{}');
  assert.equal(explicit.OPENALEX_API_KEY, ' ');
  assert.equal(explicit.WIKIMEDIA_CONTACT_URL, 'https://example.org/c');
  assert.equal(explicit.NOTIFICATION_WINDOW_JST, '09:00-20:00');
  assert.equal(explicit.MONITOR_CONFIG_JSON, '{}');
  assert.equal(buildActionsEnv({ GITHUB_REPOSITORY: '' }, undefined).WIKIMEDIA_CONTACT_URL, undefined);
});

test('OpenAlex without the optional Actions Secret uses keyless access instead of failing', async () => {
  const env = buildActionsEnv({ OPENALEX_API_KEY: '' }, undefined);
  const monitor: Monitor = { id: 'oa', source: 'openalex', query: 'search:graph', enabled: true, intervalMinutes: 60 };
  const headers: Array<Record<string, string>> = [];
  const fetcher = (async (_url: URL, init: { headers: Record<string, string> }) => {
    headers.push(init.headers);
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const result = await fetchOpenAlex(monitor, env.OPENALEX_API_KEY, fetcher, T0);
  assert.deepEqual(result.items, []);
  assert.equal(headers.length, 1);
  assert.equal(headers[0].Authorization, undefined);
});

test('one Actions run visits every due monitor once in Worker priority order', withDatabase(async (db, raw) => {
  const clock = { now: T0 };
  const monitors = [qiita('q-a'), qiita('q-b'), qiita('q-c'),
    // Enabled but without its Discord Secret: dormant, exactly like the Worker.
    { id: 'zenn-dormant', source: 'zenn', query: 'topic:go', enabled: true, intervalMinutes: 60 } as Monitor];
  const env = { DB: db, DISCORD_WEBHOOK_QIITA: WEBHOOK } as Env;
  const run = fakeDeps(clock, { 'q-a': () => [], 'q-b': () => [], 'q-c': () => [] });
  const first = await runDueMonitorsOnce(env, monitors, { clock: () => clock.now, deps: run.deps });
  assert.deepEqual(first, { processed: 3, failed: 0, deferred: 0 });
  assert.deepEqual(run.fetched, ['q-a', 'q-b', 'q-c']);
  assert.deepEqual(raw.prepare('SELECT id FROM monitor_state ORDER BY id').all().map((r) => (r as { id: string }).id),
    ['q-a', 'q-b', 'q-c']);
  // Nothing is due ten minutes later: no extra upstream requests.
  clock.now += 10 * MINUTE;
  const idle = await runDueMonitorsOnce(env, monitors, { clock: () => clock.now, deps: run.deps });
  assert.deepEqual(idle, { processed: 0, failed: 0, deferred: 0 });
  assert.equal(run.fetched.length, 3);
}));

test('Actions run never drains a monitor backlog faster than one batch per run', withDatabase(async (db) => {
  const clock = { now: T0 };
  const arxiv: Monitor = { id: 'arxiv-ai', source: 'arxiv', query: 'cat:cs.AI', enabled: true, intervalMinutes: 60 };
  const env = { DB: db, DISCORD_WEBHOOK_ARXIV: WEBHOOK } as Env;
  let feed: ContentItem[] = [];
  const run = fakeDeps(clock, { 'arxiv-ai': () => feed });
  await runDueMonitorsOnce(env, [arxiv], { clock: () => clock.now, deps: run.deps });
  clock.now += 61 * MINUTE;
  feed = [1, 2, 3, 4, 5].map((n) => ({ id: 'arxiv:' + n, title: 'Paper ' + n,
    url: 'https://arxiv.org/abs/2611.0000' + n, publishedAt: T0 + n * MINUTE }));
  const burst = await runDueMonitorsOnce(env, [arxiv], { clock: () => clock.now, deps: run.deps });
  assert.equal(burst.processed, 1);
  assert.equal(run.sent.length, 3, 'same three-notification batch as one Worker tick');
  clock.now += 10 * MINUTE;
  await runDueMonitorsOnce(env, [arxiv], { clock: () => clock.now, deps: run.deps });
  assert.equal(run.sent.length, 5, 'remaining queue is delivered on the next run');
  assert.equal(run.fetched.length, 2, 'pending-only delivery does not refetch the source');
}));

test('a failing monitor neither blocks others nor loses its retry schedule', withDatabase(async (db, raw) => {
  const clock = { now: T0 };
  const env = { DB: db, DISCORD_WEBHOOK_QIITA: WEBHOOK } as Env;
  const run = fakeDeps(clock, { 'q-a': () => [], 'q-c': () => [] });
  const summary = await runDueMonitorsOnce(env, [qiita('q-a'), qiita('q-bad'), qiita('q-c')],
    { clock: () => clock.now, deps: run.deps });
  assert.deepEqual(summary, { processed: 2, failed: 1, deferred: 0 });
  const bad = raw.prepare("SELECT initialized_at, next_due_at, lease_until FROM monitor_state WHERE id = 'q-bad'")
    .get() as { initialized_at: number | null; next_due_at: number; lease_until: number | null };
  assert.equal(bad.initialized_at, null);
  assert.equal(bad.lease_until, null, 'lease released');
  assert.equal(bad.next_due_at, T0 + 5 * MINUTE, 'normal Worker retry delay persisted');
}));

test('Actions run stops starting monitors after its time budget and keeps them due', withDatabase(async (db, raw) => {
  const clock = { now: T0 };
  const env = { DB: db, DISCORD_WEBHOOK_QIITA: WEBHOOK } as Env;
  const slow = () => { clock.now += 3 * MINUTE; return []; };
  const run = fakeDeps(clock, { 'q-a': slow, 'q-b': slow, 'q-c': slow });
  const summary = await runDueMonitorsOnce(env, [qiita('q-a'), qiita('q-b'), qiita('q-c')],
    { clock: () => clock.now, deps: run.deps });
  assert.equal(ACTIONS_TICK_BUDGET_MS, 4 * MINUTE);
  assert.deepEqual(summary, { processed: 2, failed: 0, deferred: 1 });
  const deferred = raw.prepare("SELECT next_due_at, initialized_at FROM monitor_state WHERE id = 'q-c'")
    .get() as { next_due_at: number; initialized_at: number | null };
  assert.equal(deferred.initialized_at, null);
  assert.ok(deferred.next_due_at <= clock.now, 'deferred monitor stays due for the next run');
}));

test('checkpoint plan restores the newest unexpired artifact only', () => {
  const artifact = (id: number, run: number, expired = false, name = 'notifier-state') =>
    ({ id, name, expired, workflow_run: { id: run } });
  assert.deepEqual(latestLiveCheckpoint({ total_count: 4, artifacts: [
    artifact(10, 100), artifact(30, 300, true), artifact(20, 200), artifact(40, 400, false, 'other'),
  ] }), { artifactId: 20, runId: 200 });
  assert.equal(latestLiveCheckpoint({ total_count: 1, artifacts: [artifact(30, 300, true)] }), null);
  assert.equal(latestLiveCheckpoint({ total_count: 0, artifacts: [] }), null);
  assert.throws(() => latestLiveCheckpoint({ message: 'Bad credentials' }), /artifact list/);
  assert.equal(workflowIdOf({ workflow_id: 77 }), 77);
  assert.throws(() => workflowIdOf({}), /workflow run/);
});

test('checkpoint plan only treats a repository with no saved state as a first baseline', () => {
  const none = { total_count: 0, artifacts: [] };
  assert.equal(hasCheckpointHistory(none, { total_count: 0, workflow_runs: [] }), false);
  // Any evidence of earlier state requires an explicit human reset.
  assert.equal(hasCheckpointHistory(none, { total_count: 2, workflow_runs: [] }), true);
  assert.equal(hasCheckpointHistory({ total_count: 1, artifacts: [
    { id: 5, name: 'notifier-state', expired: true, workflow_run: { id: 9 } }] },
  { total_count: 0, workflow_runs: [] }), true);
  assert.equal(hasCheckpointHistory({ total_count: 3, artifacts: [] }, { total_count: 0 }), true);
  // Unreadable answers fail closed.
  assert.throws(() => hasCheckpointHistory(none, { message: 'Not Found' }), /workflow run list/);
  assert.throws(() => hasCheckpointHistory({}, { total_count: 0 }), /artifact list/);
});

const restoreScript = fileURLToPath(new URL('../ops/actions/restore-state.sh', import.meta.url));
const fakeGh = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DIR/calls.log"
answer() { if [[ "$(cat "$FAKE_DIR/$1")" == FAIL ]]; then echo "HTTP 502" >&2; exit 1; fi; cat "$FAKE_DIR/$1"; }
case "$1" in
  api)
    case "$2" in
      *"/actions/workflows/"*"/runs?status=success"*) answer success.json ;;
      *"/actions/runs/"*) answer run.json ;;
      *"/actions/artifacts?name=notifier-state"*) answer artifacts.json ;;
      *) echo "unexpected api $2" >&2; exit 3 ;;
    esac ;;
  run) dir="\${@: -1}"; printf 'DPNSTATE1-ciphertext' > "$dir/notify-state.enc" ;;
  *) exit 4 ;;
esac
`;

function restore(options: { artifacts: unknown; success?: unknown; runNumber: number; reset?: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'notify-restore-'));
  try {
    const bin = join(dir, 'bin');
    const work = join(dir, 'work');
    mkdirSync(bin);
    mkdirSync(work);
    writeFileSync(join(bin, 'gh'), fakeGh);
    chmodSync(join(bin, 'gh'), 0o755);
    const json = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);
    writeFileSync(join(dir, 'artifacts.json'), json(options.artifacts));
    writeFileSync(join(dir, 'run.json'), json({ id: 999, workflow_id: 77 }));
    writeFileSync(join(dir, 'success.json'), json(options.success ?? { total_count: 0, workflow_runs: [] }));
    writeFileSync(join(dir, 'calls.log'), '');
    writeFileSync(join(dir, 'output.txt'), '');
    const result = spawnSync('bash', [restoreScript], {
      cwd: work, encoding: 'utf8',
      env: {
        PATH: bin + delimiter + (process.env.PATH ?? ''), FAKE_DIR: dir,
        GITHUB_REPOSITORY: 'friend/dopagaki-notify', GH_TOKEN: 'dummy', GITHUB_RUN_ID: '999',
        GITHUB_RUN_NUMBER: String(options.runNumber), GITHUB_OUTPUT: join(dir, 'output.txt'),
        RESET_NOTIFY_STATE: options.reset ? 'true' : 'false',
      },
    });
    return {
      status: result.status, stdout: result.stdout, stderr: result.stderr,
      output: readFileSync(join(dir, 'output.txt'), 'utf8'),
      calls: readFileSync(join(dir, 'calls.log'), 'utf8'),
      restored: existsSync(join(work, '.private', 'notify-state.enc')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const shellTest = process.platform === 'win32' ? test.skip : test;
const live = { total_count: 1, artifacts: [{ id: 42, name: 'notifier-state', expired: false, workflow_run: { id: 4200 } }] };
const empty = { total_count: 0, artifacts: [] };

shellTest('restore step downloads the newest live checkpoint as before', () => {
  const result = restore({ artifacts: live, runNumber: 57 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, 'previous_id=42\n');
  assert.ok(result.restored);
  assert.match(result.calls, /^run download 4200 --repo friend\/dopagaki-notify --name notifier-state --dir \.private$/m);
  assert.doesNotMatch(result.calls, /status=success/, 'normal restores need no extra API calls');
});

shellTest('restore step recovers when run #1 failed before saving any checkpoint', () => {
  const result = restore({ artifacts: empty, runNumber: 3 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No earlier run ever saved a checkpoint/);
  assert.equal(result.output, '');
  assert.ok(!result.restored);
  assert.match(result.calls, /actions\/workflows\/77\/runs\?status=success&per_page=1/);
});

shellTest('restore step still refuses to silently replace lost or expired state', () => {
  const afterSuccess = restore({ artifacts: empty, success: { total_count: 12, workflow_runs: [] }, runNumber: 900 });
  assert.equal(afterSuccess.status, 1);
  assert.match(afterSuccess.stderr, /No saved checkpoint found/);
  const expiredOnly = restore({ artifacts: { total_count: 1, artifacts: [
    { id: 7, name: 'notifier-state', expired: true, workflow_run: { id: 70 } }] }, runNumber: 900 });
  assert.equal(expiredOnly.status, 1);
  assert.match(expiredOnly.stderr, /No saved checkpoint found/);
});

shellTest('restore step fails closed when GitHub API answers cannot be read', () => {
  assert.notEqual(restore({ artifacts: 'FAIL', runNumber: 3 }).status, 0);
  assert.notEqual(restore({ artifacts: empty, success: 'FAIL', runNumber: 3 }).status, 0);
  assert.notEqual(restore({ artifacts: '{"message":"Bad credentials"}', runNumber: 3 }).status, 0);
});

shellTest('explicit reset and run #1 keep their existing behavior', () => {
  const reset = restore({ artifacts: live, runNumber: 80, reset: true });
  assert.equal(reset.status, 0, reset.stderr);
  assert.equal(reset.output, 'previous_id=42\n');
  assert.ok(!reset.restored);
  const first = restore({ artifacts: empty, runNumber: 1 });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /First run or explicitly reset state/);
  assert.doesNotMatch(first.calls, /status=success/);
});
