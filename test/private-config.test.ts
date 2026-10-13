import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRuntimeMonitors, MONITORS } from '../src/config.ts';

const privateTargets = {
  targets: {
    qiita: [
      { id: 'qiita-private-interest', query: 'tag:Go', enabled: true },
    ],
    zenn: [
      { id: 'zenn-example', query: 'topic:rust', enabled: false },
    ],
    arxiv: [
      { id: 'arxiv-sample', categories: ['cs.DS'], enabled: true },
    ],
    youtube: [
      { id: 'youtube-sample', channel: '@example', enabled: true, weekdayJst: 'sunday' },
    ],
  },
  intervals: {
    'qiita-private-interest': 240,
    'zenn-example': 360,
    'arxiv-sample': 120,
    'youtube-sample': 60,
  },
  wikipediaEnabled: false,
};

test('no private override preserves shipped monitors and identities', () => {
  assert.equal(loadRuntimeMonitors(undefined), MONITORS);
  assert.ok(MONITORS.some((m) => m.id === 'qiita-rust'));
});

test('private configuration completely replaces public preferences', () => {
  const monitors = loadRuntimeMonitors(JSON.stringify(privateTargets));
  assert.equal(monitors.length, 4);
  assert.deepEqual(monitors.map((m) => m.id), [
    'qiita-private-interest', 'arxiv-sample', 'zenn-example', 'youtube-sample',
  ]);
  assert.ok(!monitors.some((m) => m.id === 'qiita-rust' || m.id.startsWith('wikipedia-')));
  assert.deepEqual(monitors.find((m) => m.id === 'youtube-sample'), {
    id: 'youtube-sample', source: 'youtube', query: '@example',
    enabled: true, intervalMinutes: 60, weeklyJstDay: 'sunday',
  });
  assert.equal(monitors.find((m) => m.id === 'arxiv-sample')?.query, 'cat:cs.DS');
});

test('Wikipedia discovery can be deliberately enabled in a private configuration', () => {
  const config = {
    ...privateTargets, wikipediaEnabled: true,
    intervals: { ...privateTargets.intervals, 'wikipedia-ja-discovery': 120 },
  };
  const monitors = loadRuntimeMonitors(JSON.stringify(config));
  assert.equal(monitors.find((m) => m.id === 'wikipedia-ja-discovery')?.intervalMinutes, 120);
});

test('an empty private monitor roster does not enable public defaults', () => {
  const config = {
    targets: { qiita: [], zenn: [], arxiv: [], youtube: [] },
    intervals: {}, wikipediaEnabled: false,
  };
  assert.deepEqual(loadRuntimeMonitors(JSON.stringify(config)), []);
});

test('bad Secret fails closed without leaking the provided configuration', () => {
  const invalid = [
    '', 'not-json', '{}', '[]',
    JSON.stringify({ ...privateTargets, targets: { qiita: [] } }),
    JSON.stringify({ ...privateTargets, intervals: {} }),
    JSON.stringify({ ...privateTargets, wikipediaEnabled: 'false' }),
    JSON.stringify({ ...privateTargets, targets: { ...privateTargets.targets, youtube: [
      { id: 'private-handle', channel: 100, enabled: true },
    ] } }),
    JSON.stringify({ ...privateTargets, targets: { ...privateTargets.targets, arxiv: [
      { id: 'arxiv-sample', categories: 'cs.DS', enabled: true },
    ] } }),
    JSON.stringify({ ...privateTargets, intervals: {
      ...privateTargets.intervals, unknown: 60,
    } }),
  ];
  for (const value of invalid) {
    assert.throws(() => loadRuntimeMonitors(value), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes('private-interest'));
      assert.ok(!error.message.includes('private-handle'));
      return true;
    });
  }
});
