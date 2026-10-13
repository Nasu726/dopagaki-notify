import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadRuntimeMonitors, MONITORS, resolveNotificationWindowJst } from '../src/config.ts';

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

test('notification time preference is optional and can be private or deployment-specific', () => {
  assert.equal(resolveNotificationWindowJst(undefined, undefined), null);
  assert.equal(resolveNotificationWindowJst(JSON.stringify(privateTargets), undefined), null);
  const privateWindow = JSON.stringify({ ...privateTargets, notificationWindowJst: '09:00-20:00' });
  assert.deepEqual(resolveNotificationWindowJst(privateWindow, undefined),
    { startMinutes: 540, endMinutes: 1200 });
  assert.deepEqual(resolveNotificationWindowJst(privateWindow, '22:00-06:00'),
    { startMinutes: 1320, endMinutes: 360 }, 'deployment Secret takes precedence');
  assert.throws(() => resolveNotificationWindowJst(privateWindow, '09:00-09:00'), /start and end/);
});

test('invalid private window fails closed, even when monitor settings are valid', () => {
  const invalid = JSON.stringify({ ...privateTargets, notificationWindowJst: '09:00-09:00' });
  assert.throws(() => resolveNotificationWindowJst(invalid, undefined), /invalid notificationWindowJst/);
  assert.throws(() => resolveNotificationWindowJst(undefined, '00:00-00:00'), /start and end/);
});

test('OpenAlex is opt-in and old private Secrets without openalex key remain valid', () => {
  assert.equal(loadRuntimeMonitors(JSON.stringify(privateTargets)).some(m=>m.source==='openalex'),false);
  const config={...privateTargets,
    targets:{...privateTargets.targets,openalex:[
      {id:'oa-graph',query:'search:graph algorithms',enabled:true},
      {id:'oa-topic',query:'topic:T123',enabled:false},
    ]},
    intervals:{...privateTargets.intervals,'oa-graph':360,'oa-topic':720},
  };
  const monitors=loadRuntimeMonitors(JSON.stringify(config));
  assert.deepEqual(monitors.filter(m=>m.source==='openalex'),[
    {id:'oa-graph',source:'openalex',query:'search:graph algorithms',enabled:true,intervalMinutes:360},
    {id:'oa-topic',source:'openalex',query:'topic:T123',enabled:false,intervalMinutes:720},
  ]);
  assert.throws(()=>loadRuntimeMonitors(JSON.stringify({...config,
    targets:{...config.targets,openalex:[{id:'oa-bad',query:'raw:invalid',enabled:true}]},
    intervals:{...config.intervals,'oa-bad':360}})));
});
