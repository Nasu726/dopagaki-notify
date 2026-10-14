import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {loadRuntimeMonitors} from '../src/config.ts';

test('private export is a valid complete override, hoisting top-level controls',()=>{
  const content=execFileSync(process.execPath,['ops/export-monitor-config.mjs'],{encoding:'utf8'});
  const parsed=JSON.parse(content);
  assert.ok(parsed.targets.qiita);
  assert.ok(parsed.targets.youtube);
  assert.equal(parsed.targets.retentionDays,undefined);
  assert.equal(parsed.targets.notificationWindowJst,undefined);
  assert.deepEqual(parsed.retentionDays,{});
  assert.equal(parsed.notificationWindowJst,null);
  const loaded=loadRuntimeMonitors(content);
  assert.ok(loaded.length>0);
});
