import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase, applyMigrations } from '../ops/actions/sqlite.mjs';
import { stage } from '../src/state.ts';
import { pruneSentDeliveries, receiptRetentionDays, PRUNE_BATCH_SIZE } from '../src/maintenance.ts';
import { loadRuntimeMonitors, withIntervals, validateMonitors } from '../src/config.ts';
import { runTick } from '../src/runner.ts';
import type { ContentItem, Monitor, Env } from '../src/types.ts';

const DAY = 86400_000;
const now = Date.parse('2026-10-14T00:00:00Z');
const monitor = (id: string, source: Monitor['source'], retentionDays?: number | null): Monitor => ({
  id, source, query: source === 'youtube' ? '@sample' : 'tag:Go', intervalMinutes: 60, enabled: true,
  ...(retentionDays !== undefined ? {retentionDays} : {}),
});

test('per-monitor retention validates, preserves unchanged defaults and accepts null forever',()=>{
  const youtube = monitor('yt','youtube');
  const qiita = monitor('qiita','qiita');
  assert.equal(receiptRetentionDays(youtube),null);
  assert.equal(receiptRetentionDays(qiita),10);
  assert.equal(receiptRetentionDays(monitor('yt','youtube',365)),365);
  assert.equal(receiptRetentionDays(monitor('qiita','qiita',null)),null);
  const ds=[{id:'yt',source:'youtube' as const,query:'@sample',enabled:true}];
  assert.equal(withIntervals(ds,{yt:7},{yt:365})[0]?.retentionDays,365);
  assert.equal(withIntervals(ds,{yt:7},{yt:null})[0]?.retentionDays,null);
  for(const bad of [0,-1,1.5,36501,'10',false,NaN])assert.throws(
    ()=>withIntervals(ds,{yt:7},{yt:bad}),/retentionDays/);
  assert.throws(()=>withIntervals(ds,{yt:7},{notpresent:365}),/Unknown retention/);
  assert.throws(()=>validateMonitors([{...youtube,retentionDays:0}]),/retentionDays/);
  const privateJson=JSON.stringify({targets:{qiita:[],zenn:[],arxiv:[],youtube:[{
    id:'yt',channel:'@sample',enabled:true,
  }],openalex:[]},intervals:{yt:120},retentionDays:{yt:730},wikipediaEnabled:false});
  assert.equal(loadRuntimeMonitors(privateJson)[0]?.retentionDays,730);
  assert.throws(()=>loadRuntimeMonitors(privateJson.replace('"retentionDays":{"yt":730}','"retentionDays":{"unknown":730}')),
    /invalid target values/);
});

test('hourly retention respects independent monitor cutoffs and never deletes pending or ignored',async()=>{
  const {raw,db}=openDatabase(':memory:');
  try{
    applyMigrations(raw);
    const monitors=[
      monitor('normal','qiita'),monitor('older','qiita',365),
      monitor('forever','zenn',null),monitor('rare','youtube',500),
      monitor('yt-default','youtube'),
    ];
    const record=(monitorId:string,id:string,status:string,sentDaysAgo:number)=>{
      raw.prepare("INSERT INTO deliveries(monitor_id,item_id,status,title,url,published_at,discovered_at,sent_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(monitorId,id,status,'test','https://example.com',now-600*DAY,now-600*DAY,
          status==='sent'?now-sentDaysAgo*DAY:null);
    };
    record('normal','normal-expired','sent',11);
    record('normal','normal-fresh','sent',9);
    record('older','older-fresh','sent',300);
    record('older','older-expired','sent',366);
    record('forever','forever-old','sent',1000);
    record('rare','youtube:rare-old','sent',501);
    record('rare','youtube:rare-fresh','sent',450);
    record('yt-default','youtube:default-old','sent',900);
    record('normal','still-pending','pending',1000);
    record('normal','still-ignored','ignored',1000);
    assert.equal(await pruneSentDeliveries(db,now,monitors),3);
    const remain=raw.prepare('SELECT item_id FROM deliveries ORDER BY item_id').all().map((x:any)=>x.item_id);
    assert.deepEqual(remain,[
      'forever-old','normal-fresh','older-fresh','still-ignored','still-pending',
      'youtube:default-old','youtube:rare-fresh',
    ]);
    assert.equal(await pruneSentDeliveries(db,now,monitors),0);
  }finally{raw.close();}
});

test('retention pruning remains one bounded statement with many overrides, no 100-bind overflow',async()=>{
  const {raw,db:backing}=openDatabase(':memory:');
  try{
    applyMigrations(raw);
    let count=0,maxBinds=0;
    const db={prepare(sql:string){
      count++;
      const stmt=backing.prepare(sql);
      return {bind(...args:unknown[]){maxBinds=Math.max(maxBinds,args.length);return stmt.bind(...args);}};
    }} as import('../src/types.ts').Database;
    const monitors=Array.from({length:260},(_,i)=>monitor('m'+i,'qiita',i%3===0?null:30));
    assert.equal(await pruneSentDeliveries(db,now,monitors),0);
    assert.equal(count,1);
    assert.ok(maxBinds<=100);
    assert.equal(PRUNE_BATCH_SIZE,20);
  }finally{raw.close();}
});

test('finite YouTube retention cannot reannounce an old latest upload after receipt deletion',async()=>{
  const {raw,db}=openDatabase(':memory:');
  try{
    applyMigrations(raw);
    const m=monitor('youtube-rare','youtube',2);
    const video:ContentItem={id:'youtube:AbCdEf12345',title:'Latest',url:'https://www.youtube.com/watch?v=AbCdEf12345',
      publishedAt:now-60*60_000};
    const env:Env={DB:db,DISCORD_WEBHOOK_YOUTUBE:'https://discord.com/api/webhooks/123456789/test'};
    const sent:string[]=[];let seq=0;
    const deps={fetchItems:async()=>({items:[video],potentiallyTruncated:false}),
      send:async(_h:string,_s:string,i:ContentItem)=>{sent.push(i.id)},
      randomId:()=> 'tok-'+(++seq)};
    await runTick(env,[m],now,deps);
    assert.deepEqual(sent,[video.id]);
    assert.equal(await pruneSentDeliveries(db,now+3*DAY,[m]),1);
    await runTick(env,[m],now+3*DAY,deps);
    assert.deepEqual(sent,[video.id],'expired old latest is never a repeat notification');
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM deliveries').get()?.n,0);
  }finally{raw.close();}
});

test('infinite YouTube retention still allows ancient first latest video',async()=>{
  const {raw,db}=openDatabase(':memory:');
  try{
    applyMigrations(raw);
    const m=monitor('youtube-yearly','youtube');
    const old:ContentItem={id:'youtube:AbCdEf12345',title:'Old latest',
      url:'https://www.youtube.com/watch?v=AbCdEf12345',publishedAt:now-700*DAY};
    const env:Env={DB:db,DISCORD_WEBHOOK_YOUTUBE:'https://discord.com/api/webhooks/123456789/test'};
    const sent:string[]=[];let seq=0;
    await runTick(env,[m],now,{fetchItems:async()=>({items:[old],potentiallyTruncated:false}),
      send:async(_h:string,_s:string,i:ContentItem)=>{sent.push(i.id)},
      randomId:()=> 'tok-'+(++seq)});
    assert.deepEqual(sent,[old.id]);
    assert.equal(await pruneSentDeliveries(db,now+900*DAY,[m]),0);
  }finally{raw.close();}
});
