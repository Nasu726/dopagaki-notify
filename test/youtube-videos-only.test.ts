import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MONITORS, loadRuntimeMonitors, validateMonitors } from '../src/config.ts';
import { fetchYouTube } from '../src/sources/youtube.ts';
import { runSmoke } from '../ops/manual-smoke.mjs';
import { runTick } from '../src/runner.ts';
import { openDatabase, applyMigrations } from '../ops/actions/sqlite.mjs';
import type { Monitor, Env, ContentItem } from '../src/types.ts';

const channelId = 'UCQ_MqAw18jFTlBB-f8BP7dw';
const playlistId = 'UULF' + channelId.slice(2);
const quizknock: Monitor = {
  id: 'youtube-quizknock', source: 'youtube', query: '@QuizKnock',
  youtubeChannelId: channelId, youtubeVideoType: 'videos', enabled: true, intervalMinutes: 60,
};
const normalVideoId = 'Normal12345';
const shortVideoId = 'vLphol5F_SY';
const publishedAt = '2026-10-13T01:00:00Z';
function entry(videoId: string, owner = channelId) {
  return '<entry><yt:videoId>' + videoId + '</yt:videoId>' +
    '<title>Video ' + videoId + '</title><published>' + publishedAt + '</published>' +
    '<yt:channelId>' + owner + '</yt:channelId></entry>';
}
function feed({
  owner = channelId.slice(2), playlist = playlistId, rootPlaylist = playlistId,
  content = entry(normalVideoId),
}: {owner?:string|null;playlist?:string|null;rootPlaylist?:string|null;content?:string} = {}) {
  return '<feed>' +
    (rootPlaylist === null ? '' : '<id>yt:playlist:' + rootPlaylist + '</id>') +
    (playlist === null ? '' : '<yt:playlistId>' + playlist + '</yt:playlistId>') +
    (owner === null ? '' : '<yt:channelId>' + owner + '</yt:channelId>') +
    content + '</feed>';
}
function mock(response = feed(), check?: (url:URL)=>void):typeof fetch {
  return async input => {
    const url = new URL(String(input));
    assert.equal(url.pathname, '/feeds/videos.xml');
    assert.equal(url.searchParams.has('channel_id'), false);
    assert.equal(url.searchParams.get('playlist_id'), playlistId);
    check?.(url);
    return new Response(response);
  };
}

test('QuizKnock opts in without changing other YouTube subscriptions',()=>{
  assert.equal(MONITORS.find(m=>m.id==='youtube-quizknock')?.youtubeVideoType,'videos');
  assert.ok(MONITORS.filter(m=>m.source==='youtube' && m.id!=='youtube-quizknock')
    .every(m=>m.youtubeVideoType===undefined));
  assert.doesNotThrow(()=>validateMonitors(MONITORS));
  const priv = {
    targets:{qiita:[],zenn:[],arxiv:[],youtube:[
      {id:'private-yt',channel:'@QuizKnock',channelId,videoType:'videos',enabled:true},
    ]},
    wikipediaEnabled:false,intervals:{'private-yt':60},
  };
  assert.equal(loadRuntimeMonitors(JSON.stringify(priv))[0]?.youtubeVideoType,'videos');
  for(const invalid of ['shorts','',null,10]) {
    const bad={...priv,targets:{...priv.targets,youtube:[
      {...priv.targets.youtube[0],videoType:invalid},
    ]}};
    assert.throws(()=>loadRuntimeMonitors(JSON.stringify(bad)));
  }
  const unpinned={...priv,targets:{...priv.targets,youtube:[
    {id:'private-yt',channel:'@QuizKnock',videoType:'videos',enabled:true},
  ]}};
  assert.throws(()=>loadRuntimeMonitors(JSON.stringify(unpinned)));
  const defaultType={...priv,targets:{...priv.targets,youtube:[
    {id:'private-yt',channel:'@QuizKnock',enabled:true},
  ]}};
  assert.equal(loadRuntimeMonitors(JSON.stringify(defaultType))[0]?.youtubeVideoType,undefined);
});

test('UULF feed uses one call and retains stable youtube video IDs',async()=>{
  let calls=0;
  const result=await fetchYouTube(quizknock,mock(feed(),()=>{calls++}));
  assert.equal(calls,1);
  assert.deepEqual(result.items,[{
    id:'youtube:'+normalVideoId,title:'Video '+normalVideoId,
    url:'https://www.youtube.com/watch?v='+normalVideoId,
    publishedAt:Date.parse(publishedAt),
  }]);
  for(const xml of [
    feed({rootPlaylist:null}),feed({playlist:null}),
    feed({owner:null}),feed({content:''}),
  ]) {
    await assert.doesNotReject(()=>fetchYouTube(quizknock,mock(xml)));
  }
});

test('videos-only feed fails closed for wrong/missing playlist, owner or entry',async()=>{
  for(const xml of [
    feed({playlist:'UULFpLu0KjNy616-E95gPx7LZg'}),
    feed({rootPlaylist:'UULFpLu0KjNy616-E95gPx7LZg'}),
    feed({rootPlaylist:null,playlist:null}),
    feed({owner:'UCpLu0KjNy616-E95gPx7LZg'}),
    feed({owner:'pLu0KjNy616-E95gPx7LZg'}),
    feed({content:entry(normalVideoId,'UCpLu0KjNy616-E95gPx7LZg')}),
    '<feed><yt:channelId>'+channelId+'</yt:channelId>'+entry(shortVideoId)+'</feed>',
  ]) {
    await assert.rejects(()=>fetchYouTube(quizknock,mock(xml)),/identity|channel mismatch/);
  }
  let calls=0;
  await assert.rejects(()=>fetchYouTube(quizknock,async input=>{
    calls++;
    assert.equal(new URL(String(input)).searchParams.get('playlist_id'),playlistId);
    return new Response('not found',{status:404});
  }),/404/);
  assert.equal(calls,1,'must never fallback to mixed channel feed');
});

test('dry-run with API key still uses UULF RSS, no Discord POST',async()=>{
  let calls=0;
  const result=await runSmoke(quizknock,{YOUTUBE_API_KEY:'unused'},{
    fetcher:mock(feed(),()=>{calls++}),
    sender:async()=>{throw new Error('unexpected Discord send');},
  });
  assert.equal(calls,1);
  assert.equal(result.adapter,'YouTube RSS (UULF videos only)');
  assert.equal(result.videoType,'videos');
  assert.equal(result.fetchedItems,1);
  assert.equal(result.discordTestSent,false);
});

test('switch to videos-only preserves old Shorts receipt and sends normal once',async()=>{
  const {raw,db}=openDatabase(':memory:');
  try{
    applyMigrations(raw);
    const now=Date.parse('2026-10-13T17:05:22Z');
    const prior=now-60_000;
    raw.prepare('INSERT INTO monitor_state (id,initialized_at,last_complete_at,next_due_at,config_identity) VALUES (?,?,?,?,?)')
      .run(quizknock.id,prior,prior,now,JSON.stringify(['youtube','@QuizKnock']));
    raw.prepare("INSERT INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at,sent_at) VALUES (?,?,'sent',?,?,?,?,?)")
      .run(quizknock.id,'youtube:'+shortVideoId,'Previously sent #Shorts',
        'https://www.youtube.com/watch?v='+shortVideoId,prior,prior,prior);
    const env:Env={DB:db,DISCORD_WEBHOOK_YOUTUBE:'https://discord.com/api/webhooks/123/token'};
    const sent:string[]=[];
    let index=0;
    const deps={
      fetchItems:()=>fetchYouTube(quizknock,mock(feed())),
      send:async(_hook:string,_source:string,item:ContentItem)=>{sent.push(item.id)},
      randomId:()=> 'lease-'+ ++index,
      clock:()=>now,
    };
    await runTick(env,[quizknock],now,deps);
    assert.deepEqual(sent,['youtube:'+normalVideoId]);
    await runTick(env,[quizknock],now+60*60_000,deps);
    assert.deepEqual(sent,['youtube:'+normalVideoId]);
    const rows=raw.prepare('SELECT item_id,status FROM deliveries WHERE monitor_id=? ORDER BY item_id').all(quizknock.id);
    assert.deepEqual(rows,[
      {item_id:'youtube:'+shortVideoId,status:'sent'},
      {item_id:'youtube:'+normalVideoId,status:'sent'},
    ]);
    assert.equal(raw.prepare('SELECT config_identity FROM monitor_state WHERE id=?').get(quizknock.id)?.config_identity,JSON.stringify(['youtube','@QuizKnock']));
  } finally {raw.close();}
});
