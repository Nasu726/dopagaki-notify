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
  assert.deepEqual(parsePreflightArgs([]), {help:false,configFile:null,windowFile:null});
  assert.deepEqual(parsePreflightArgs(['--private-config-file=.private/config.json']),
    {help:false,configFile:'.private/config.json',windowFile:null});
  assert.deepEqual(parsePreflightArgs(['--help']),{help:true});
  for(const args of [['--bad'],['--notification-window-file='],
    ['--private-config-file='],['--private-config-file=a','--private-config-file=b']]) {
    assert.throws(()=>parsePreflightArgs(args));
  }
});
