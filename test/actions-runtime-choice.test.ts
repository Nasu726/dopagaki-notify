import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {selectActionsConfig} from '../ops/actions/runtime-config.mjs';

const example=JSON.stringify({
  targets:{qiita:[{id:'qiita-private-setup',query:'tag:Go',enabled:true}],
    zenn:[],arxiv:[],openalex:[],youtube:[]},
  intervals:{'qiita-private-setup':60},
  wikipediaEnabled:false,
  retentionDays:{'qiita-private-setup':300},
  notificationWindowJst:'08:00-20:00',
});

test('Actions private mode by default uses only encrypted-secret subscriptions',()=>{
  const selected=selectActionsConfig(undefined,example);
  assert.equal(selected.mode,'private');
  assert.equal(selected.monitors.length,1);
  assert.equal(selected.monitors[0].id,'qiita-private-setup');
  assert.equal(selected.monitors[0].retentionDays,300);
  assert.equal(selected.configJson,example);
  assert.ok(!selected.monitors.some(m=>m.id==='youtube-quizknock'),
    'public repo owner subscriptions must not be loaded in private mode');
});

test('Actions public mode is explicit and reuses checked-in Cloudflare sources',()=>{
  const selected=selectActionsConfig('public','');
  assert.equal(selected.mode,'public');
  assert.equal(selected.configJson,undefined);
  assert.ok(selected.monitors.length>0);
  assert.ok(selected.monitors.some(m=>m.source==='youtube'));
  assert.ok(selected.monitors.some(m=>m.source==='wikipedia'));
  assert.ok(selected.monitors.every(m=>m.retentionDays === undefined || m.retentionDays === null ||
    Number.isSafeInteger(m.retentionDays)));
});

test('ambiguous or missing Actions config fails closed',()=>{
  for(const mode of [undefined,'','private']){
    assert.throws(()=>selectActionsConfig(mode,''),/requires MONITOR_CONFIG_JSON/);
    assert.throws(()=>selectActionsConfig(mode,undefined),/requires MONITOR_CONFIG_JSON/);
  }
  for(const mode of ['PUBLIC','auto','cloudflare','  public ','',123,false]){
    if(mode==='')continue;
    assert.throws(()=>selectActionsConfig(mode,example),/MONITOR_CONFIG_MODE/);
  }
  assert.throws(()=>selectActionsConfig('public',example),/conflicts/);
  assert.throws(()=>selectActionsConfig('private','{invalid'),/invalid JSON/);
});

test('Actions workflow wires explicit visibility mode and includes all source/API Secrets',()=>{
  const template=readFileSync(new URL('../templates/github-actions/notifier.yml',import.meta.url),'utf8');
  assert.match(template,/MONITOR_CONFIG_MODE:\s*\$\{\{ vars\.MONITOR_CONFIG_MODE \}\}/);
  assert.match(template,/MONITOR_CONFIG_JSON:\s*\$\{\{ secrets\.MONITOR_CONFIG_JSON \}\}/);
  assert.match(template,/NOTIFICATION_WINDOW_JST:\s*\$\{\{ secrets\.NOTIFICATION_WINDOW_JST \}\}/);
  for(const secret of ['DISCORD_WEBHOOK_QIITA','DISCORD_WEBHOOK_ZENN','DISCORD_WEBHOOK_ARXIV',
    'DISCORD_WEBHOOK_OPENALEX','DISCORD_WEBHOOK_YOUTUBE','DISCORD_WEBHOOK_WIKIPEDIA',
    'YOUTUBE_API_KEY','OPENALEX_API_KEY']){
    assert.match(template,new RegExp(secret+':'));
  }
  const setup=readFileSync(new URL('../ops/setup-actions.mjs',import.meta.url),'utf8');
  assert.match(setup,/--config-mode=private/);
  assert.match(setup,/--config-mode=public/);
  assert.match(setup,/Existing workflow copies are preserved/);
});
