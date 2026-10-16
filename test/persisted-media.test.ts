import assert from 'node:assert/strict';
import {test} from 'node:test';
import {openDatabase,applyMigrations} from '../ops/actions/sqlite.mjs';
import {stage,getPending} from '../src/state.ts';
import {runTick} from '../src/runner.ts';
import {persistentMediaUrl,inspectPersistentMediaUrl,missingDeliveryMediaColumns} from '../src/persisted-media.ts';
import type {Monitor,Env,ContentItem} from '../src/types.ts';

const date=Date.parse('2026-10-13T00:00:00Z');
const deliveryWindow='07:00-08:00';
const nextMorning=Date.parse('2026-10-13T22:30:00Z');
const qiitaUrl='https://qiita.com/author/items/example';
const zennUrl='https://zenn.dev/author/articles/example';

test('persisted media only accepts public HTTPS URLs with innocuous image parameters',()=>{
  assert.equal(persistentMediaUrl('zenn',zennUrl,'https://res.cloudinary.com/zenn/image/upload/cover.png'),
    'https://res.cloudinary.com/zenn/image/upload/cover.png');
  assert.equal(persistentMediaUrl('qiita',qiitaUrl,'https://avatars.example.com/u.png?v=4'),
    'https://avatars.example.com/u.png?v=4');
  assert.equal(persistentMediaUrl('zenn',zennUrl,'https://res.cloudinary.com/zenn/image/upload/a.png?x=1&y=2'),
    'https://res.cloudinary.com/zenn/image/upload/a.png?x=1&y=2');
  for(const value of [
    'http://example.com/a.png','https://127.0.0.1/private.png',
    'https://localhost/og.png','https://user:pass@example.com/cover.png',
    'https://cdn.example.com/photo.png?token=private',
    'https://cdn.example.com/photo.png?X-Amz-Signature=verysecret',
    'https://cdn.example.com/photo.png#secret',
    'data:image/png;base64,xyz',
    'https://cdn.example.com:8443/image.png',
  ])assert.equal(persistentMediaUrl('zenn',zennUrl,value),null,value);
  assert.equal(persistentMediaUrl('youtube','https://www.youtube.com/watch?v=x',
    'https://cdn.example.com/thumb.png'),null);
  assert.equal(persistentMediaUrl('qiita',zennUrl,'https://cdn.example.com/avatar.png'),null);
  assert.equal(missingDeliveryMediaColumns(new Error('D1_ERROR: table deliveries has no column named image_url: SQLITE_ERROR')),true);
  assert.equal(missingDeliveryMediaColumns(new Error('no such column: thumbnail_url')),true);
  assert.equal(missingDeliveryMediaColumns(new Error('database is locked')),false);
});

test('migration adds nullable media columns, preserves existing pending rows and is idempotent',()=>{
  const {raw}=openDatabase(':memory:');
  try{
    applyMigrations(raw);
    applyMigrations(raw);
    const cols=raw.prepare("PRAGMA table_info(deliveries)").all().map((r:any)=>r.name);
    assert.ok(cols.includes('image_url'));
    assert.ok(cols.includes('thumbnail_url'));
    raw.prepare("INSERT INTO deliveries (monitor_id,item_id,status,title,url,published_at,discovered_at) VALUES (?,?,?,?,?,?,?)")
      .run('qiita-test','qiita:legacy','pending','Old',qiitaUrl,date,date);
    const row=raw.prepare("SELECT image_url,thumbnail_url,status FROM deliveries WHERE item_id='qiita:legacy'").get();
    assert.equal(row?.image_url,null);
    assert.equal(row?.thumbnail_url,null);
    assert.equal(row?.status,'pending');
  } finally {raw.close();}
});

for(const source of ['qiita','zenn'] as const){
  test(source+' queued image survives next Cron, even if RSS no longer contains an image',async()=>{
    const {raw,db}=openDatabase(':memory:');
    try{
      applyMigrations(raw);
      const monitor:Monitor={id:source+'-persistent-media',source,query:source==='qiita'?'tag:Go':'user:author',enabled:true,intervalMinutes:60};
      const mediaUrl=source==='qiita'?'https://avatar.example.com/author.png':'https://res.cloudinary.com/zenn/image/upload/cover.png';
      const item:ContentItem={
        id:source+':new',title:'New article',publishedAt:date+60_000,
        url:source==='qiita'?qiitaUrl:zennUrl,
        ...(source==='qiita'?{thumbnailUrl:mediaUrl}:{imageUrl:mediaUrl}),
      };
      const env:Env={DB:db,NOTIFICATION_WINDOW_JST:deliveryWindow,
        ...(source==='qiita'?{DISCORD_WEBHOOK_QIITA:'https://discord.com/api/webhooks/123/token'}:
          {DISCORD_WEBHOOK_ZENN:'https://discord.com/api/webhooks/123/token'})};
      let feed:ContentItem[]=[];
      const sent:ContentItem[]=[];
      let seq=0;
      const deps={
        fetchItems:async()=>({items:feed,potentiallyTruncated:false}),
        send:async(_hook:string,_source:string,i:ContentItem)=>{sent.push(i);},
        randomId:()=> 'lease-'+(++seq),
        clock:()=>nextMorning,
      };
      await runTick(env,[monitor],date,{...deps,clock:()=>date});
      feed=[item];
      await runTick(env,[monitor],date+60*60_000,{...deps,clock:()=>date+60*60_000});
      assert.equal(sent.length,0,'delivery must be queued outside allowed window');
      const stored=raw.prepare('SELECT status,image_url,thumbnail_url FROM deliveries WHERE monitor_id=? AND item_id=?')
        .get(monitor.id,item.id);
      assert.equal(stored?.status,'pending');
      assert.equal(stored?.[source==='zenn'?'image_url':'thumbnail_url'],mediaUrl);
      // Simulate publisher RSS dropping the original enclosure/avatar across polls.
      feed=[{id:item.id,title:item.title,url:item.url,publishedAt:item.publishedAt}];
      await runTick(env,[monitor],nextMorning,deps);
      assert.equal(sent.length,1);
      assert.equal(sent[0]?.[source==='zenn'?'imageUrl':'thumbnailUrl'],mediaUrl);
      assert.equal(raw.prepare('SELECT status FROM deliveries WHERE item_id=?').get(item.id)?.status,'sent');
      // No repeat delivery after a later scan.
      await runTick(env,[monitor],nextMorning+60*60_000,{...deps,clock:()=>nextMorning+60*60_000});
      assert.equal(sent.length,1);
    } finally {raw.close();}
  });
}

test('pre-migration schema safely sends text and links while ignoring media columns',async()=>{
  const {raw,db}=openDatabase(':memory:');
  try{
    applyMigrations(raw);
    raw.exec('ALTER TABLE deliveries DROP COLUMN image_url');
    raw.exec('ALTER TABLE deliveries DROP COLUMN thumbnail_url');
    const item:ContentItem={
      id:'qiita:new',title:'New',url:qiitaUrl,publishedAt:date+60_000,
      thumbnailUrl:'https://images.example.com/avatar.png',
    };
    const monitor:Monitor={id:'qiita-legacy',source:'qiita',query:'tag:Go',enabled:true,intervalMinutes:60};
    const env:Env={DB:db,NOTIFICATION_WINDOW_JST:deliveryWindow,
      DISCORD_WEBHOOK_QIITA:'https://discord.com/api/webhooks/123/token'};
    let feed:ContentItem[]=[];
    let seq=0;
    const sent:ContentItem[]=[];
    const deps={fetchItems:async()=>({items:feed,potentiallyTruncated:false}),
      send:async(_h:string,_s:string,i:ContentItem)=>{sent.push(i)},
      randomId:()=> 'lease-'+(++seq),clock:()=>date};
    await runTick(env,[monitor],date,deps);
    feed=[item];
    await runTick(env,[monitor],date+60*60_000,{...deps,clock:()=>date+60*60_000});
    assert.equal(raw.prepare('SELECT status FROM deliveries WHERE item_id=?').get(item.id)?.status,'pending');
    feed=[{id:item.id,title:item.title,url:item.url,publishedAt:item.publishedAt}];
    await runTick(env,[monitor],nextMorning,{...deps,clock:()=>nextMorning});
    assert.equal(sent.length,1,'missing media columns must not prevent normal Discord notifications');
    assert.equal(sent[0]?.id,item.id);
  } finally {raw.close();}
});

test('image-persisting inserts honor D1 100-parameter cap, no repeat writes',async()=>{
  const {raw,db:original}=openDatabase(':memory:');
  try{
    applyMigrations(raw);
    let max=0,insertCount=0;
    const db= {prepare(sql:string){
      if(sql.startsWith('INSERT OR IGNORE INTO deliveries'))insertCount++;
      const statement=original.prepare(sql);
      return {
        bind(...params:unknown[]){
          max=Math.max(max,params.length);
          return statement.bind(...params);
        },
        first:()=>statement.first(),
        all:()=>statement.all(),
        run:()=>statement.run(),
      };
    }} as import('../src/types.ts').Database;
    const items:ContentItem[]=Array.from({length:35},(_,n)=>({
      id:'zenn:test'+n,title:'Item '+n,url:zennUrl,
      publishedAt:date+1000+n, imageUrl:'https://res.cloudinary.com/zenn/image/upload/'+n+'.png',
    }));
    await stage(db,'zenn-test',items,date-1000,date+60*60_000,{imageSource:'zenn'});
    assert.ok(max<=100,'D1 has 100 bind parameters max');
    assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM deliveries').get()?.n,35);
    const originalInserts=insertCount;
    await stage(db,'zenn-test',items,date-1000,date+60*60_000,{imageSource:'zenn'});
    assert.equal(insertCount,originalInserts,'known IDs should not be inserted again');
    const pending=await getPending(db,'zenn-test',date+60*60_000,40,undefined,'zenn');
    assert.equal(pending.length,35);
    assert.equal(pending[0]?.image_url,'https://res.cloudinary.com/zenn/image/upload/0.png');
  }finally{raw.close()}
});


test('rejection inspection follows exact runtime URL policy without exposing query values',()=>{
  const allowed='https://res.cloudinary.com/zenn/image/upload/example.png?format=png';
  assert.deepEqual(inspectPersistentMediaUrl('zenn',zennUrl,allowed),
    {url:allowed,reason:null,rejectedKeys:[]});
  const unknown=inspectPersistentMediaUrl('zenn',zennUrl,
    'https://res.cloudinary.com/zenn/image/upload/example.png?cache=1&token=secret');
  assert.equal(unknown.url,null);
  assert.equal(unknown.reason,'unapproved_query_key');
  assert.deepEqual(unknown.rejectedKeys,['[redacted]','cache']);
  const badValue=inspectPersistentMediaUrl('zenn',zennUrl,
    'https://res.cloudinary.com/zenn/image/upload/example.png?format=png%2Fjpeg');
  assert.equal(badValue.reason,'unapproved_query_value');
  assert.deepEqual(badValue.rejectedKeys,[]);
  const badFragment=inspectPersistentMediaUrl('zenn',zennUrl,
    'https://res.cloudinary.com/zenn/image/upload/example.png#private');
  assert.equal(badFragment.reason,'image_fragment');
  const invalid=inspectPersistentMediaUrl('zenn',zennUrl,'http://localhost/secret.png');
  assert.equal(invalid.reason,'unsafe_image_url');
  for(const [url,result] of [[allowed,allowed],['https://cdn.test/og.png?token=x',null],
    ['http://localhost/secret.png',null]]){
    assert.equal(persistentMediaUrl('zenn',zennUrl,url),result);
  }
});


test('Zenn RSS Cloudinary opaque cache parameter is DROPPED, never persisted or sent',()=>{
  const publicPath='https://res.cloudinary.com/zenn/image/upload/s--sigpath--/v1234/default/og-base.png';
  const safe=persistentMediaUrl('zenn',zennUrl,publicPath+'?_rv=opaque-value');
  assert.equal(safe,publicPath);
  assert.deepEqual(inspectPersistentMediaUrl('zenn',zennUrl,publicPath+'?_rv=sensitive-value'),
    {url:publicPath,reason:null,rejectedKeys:[]});
  for(const [u,reason] of [
    [publicPath+'?token=secret','unapproved_query_key'],
    [publicPath+'?__token=private','unapproved_query_key'],
    [publicPath+'?_rv=one&unknown=two','unapproved_query_key'],
    [publicPath+'?_rv=one&_vs=two','unapproved_query_key'],
    [publicPath+'?_rv=one#secret','image_fragment'],
    ['https://other.example.com/image/upload/image.png?_rv=x','unapproved_query_key'],
    ['https://res.cloudinary.com/another/image/upload/default/a.png?_rv=x','unapproved_query_key'],
    ['https://res.cloudinary.com/zenn/image/fetch/example.png?_rv=x','unapproved_query_key'],
  ]) {
    assert.equal(inspectPersistentMediaUrl('zenn',zennUrl,u).reason,reason,u);
    assert.equal(persistentMediaUrl('zenn',zennUrl,u),null,u);
  }
  assert.equal(persistentMediaUrl('qiita',qiitaUrl,publicPath+'?_rv=x'),null,
    'never normalize a Qiita source URL');
});

test('Zenn Cloudinary query canonicalization persists across queued Cron delivery',async()=>{
  const {raw,db}=openDatabase(':memory:');
  try {
    applyMigrations(raw);
    const publicPath='https://res.cloudinary.com/zenn/image/upload/v1234/default/og.png';
    const item:ContentItem={id:'zenn:canonical',title:'Canonical',url:zennUrl,publishedAt:date+1,
      imageUrl:publicPath+'?_rv=cache'};
    await stage(db,'zenn-canonical-test',[item],date-10,date+60_000,{imageSource:'zenn'});
    const rows=await getPending(db,'zenn-canonical-test',date+60_000,3,undefined,'zenn');
    assert.equal(rows[0]?.image_url,publicPath);
    assert.equal(raw.prepare("SELECT image_url FROM deliveries WHERE item_id='zenn:canonical'")
      .get()?.image_url,publicPath);
  } finally {raw.close();}
});
