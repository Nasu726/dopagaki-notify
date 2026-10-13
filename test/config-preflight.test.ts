import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePreflightArgs, validateRuntimeConfiguration } from '../ops/config-preflight.mjs';

const privateConfig = JSON.stringify({
  targets: {
    qiita: [{id:'private-interest',query:'tag:SensitiveInterest',enabled:true}],
    zenn: [], youtube: [], arxiv: [], openalex: [],
  },
  wikipediaEnabled: false,
  intervals: {'private-interest':60},
});

test('preflight accepts public defaults and reports 24-hour sending', () => {
  const result=validateRuntimeConfiguration(undefined,undefined);
  assert.equal(result.ok,true);
  assert.ok(result.monitorCount>0);
  assert.equal(result.notificationWindow,'unrestricted-24h');
});

test('preflight honors private config and notification-window precedence', () => {
  const privateWithWindow=JSON.stringify({
    ...JSON.parse(privateConfig), notificationWindowJst:'09:00-20:00',
  });
  assert.deepEqual(validateRuntimeConfiguration(privateWithWindow,undefined), {
    ok:true, monitorCount:1, enabledCount:1, notificationWindow:'restricted-JST',
  });
  assert.equal(validateRuntimeConfiguration(privateWithWindow,'22:00-06:00').notificationWindow,
    'restricted-JST');
  assert.equal(validateRuntimeConfiguration(privateConfig,undefined).notificationWindow,
    'unrestricted-24h');
});

test('preflight rejects 24:00 and zero-length intervals instead of allowing unsafe 24h', () => {
  for (const value of ['00:00-24:00','09:00-09:00','invalid','23:59-24:00','']) {
    assert.throws(() => validateRuntimeConfiguration(privateConfig,value),
      /Delivery window invalid/);
  }
  const badPrivate=JSON.stringify({
    ...JSON.parse(privateConfig), notificationWindowJst:'00:00-24:00',
  });
  assert.throws(() => validateRuntimeConfiguration(badPrivate,undefined),
    /Delivery window invalid/);
  const badIntervals=JSON.stringify({
    ...JSON.parse(privateConfig), intervals:{'private-interest':0},
  });
  assert.throws(() => validateRuntimeConfiguration(badIntervals,undefined),
    /Monitor config invalid/);
});

test('preflight never repeats private queries in any validation error', () => {
  const broken=privateConfig.replace('"private-interest":60','"private-interest":-1');
  const secret='SensitiveInterest';
  assert.throws(()=>validateRuntimeConfiguration(broken,undefined),(err)=>{
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes(secret));
    return true;
  });
  assert.throws(()=>validateRuntimeConfiguration(privateConfig,'00:00-24:00'),(err)=>{
    assert.ok(err instanceof Error);
    assert.ok(!err.message.includes(secret));
    return true;
  });
});

test('file-based private preflight rejects duplicate flags and empty values', () => {
  assert.deepEqual(parsePreflightArgs([]), {help:false,configFile:null,windowFile:null,windowValue:null});
  assert.deepEqual(parsePreflightArgs(['--private-config-file=.private/config.json']),
    {help:false,configFile:'.private/config.json',windowFile:null,windowValue:null});
  assert.deepEqual(parsePreflightArgs(['--help']),{help:true});
  assert.deepEqual(parsePreflightArgs(['--notification-window=08:00-20:00']),
    {help:false,configFile:null,windowFile:null,windowValue:'08:00-20:00'});
  assert.equal(validateRuntimeConfiguration(undefined,parsePreflightArgs([
    '--notification-window=08:00-20:00',
  ]).windowValue).notificationWindow,'restricted-JST');
  assert.throws(() => validateRuntimeConfiguration(undefined, '00:00-24:00'), /Delivery window invalid/);
  for(const args of [['--bad'],['--notification-window-file='],
    ['--private-config-file='],['--private-config-file=a','--private-config-file=b'],
    ['--notification-window='],['--notification-window=08:00-20:00','--notification-window=09:00-20:00'],
    ['--notification-window-file=x','--notification-window=08:00-20:00']]) {
    assert.throws(()=>parsePreflightArgs(args));
  }
});

test('Worker scheduled handler classifies invalid private delivery time before D1 access', async () => {
  const { default: worker } = await import('../src/index.ts');
  let dbCalls = 0;
  const env = {
    DB: { prepare() { dbCalls++; throw new Error('D1 should not be touched'); } },
    NOTIFICATION_WINDOW_JST: '00:00-24:00',
  } as unknown as import('../src/types.ts').Env;
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    await assert.rejects(() => worker.scheduled({cron:'*/5 * * * *'},env),
      /Invalid runtime configuration/);
  } finally { console.error = original; }
  assert.equal(dbCalls,0);
  assert.equal(logs.length,1,'one structured config error, not repeated nested monitor failures');
  const entry=JSON.parse(logs[0]!);
  assert.equal(entry.event,'runtime_config_failure');
  assert.equal(entry.phase,'delivery_window_config');
  assert.ok(entry.errorMessage.includes('npm run config:check'));
  assert.ok(!JSON.stringify(entry).includes('00:00-24:00'));
});

test('Worker scheduled handler classifies malformed private monitors without exposing queries', async () => {
  const { default: worker } = await import('../src/index.ts');
  const secret='SECRET-SUBSCRIPTION-DO-NOT-LOG';
  const env = {
    DB: { prepare() { throw new Error('unexpected D1'); } },
    MONITOR_CONFIG_JSON: JSON.stringify({targets:{youtube:[{
      id:'private-video',channel:secret,enabled:true,
    }]},intervals:{'private-video':60}}),
  } as unknown as import('../src/types.ts').Env;
  const logs:string[]=[];
  const original=console.error;
  console.error=(...args:unknown[])=>{logs.push(args.map(String).join(' '))};
  try {await assert.rejects(()=>worker.scheduled({cron:'*/5 * * * *'},env),/Invalid runtime configuration/)}
  finally {console.error=original}
  assert.equal(logs.length,1);
  assert.equal(JSON.parse(logs[0]!).phase,'monitor_config');
  assert.ok(!logs[0]!.includes(secret));
});
