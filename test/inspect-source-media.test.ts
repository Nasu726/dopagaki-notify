import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseOptions,inspectSourceMedia,classifyRejectedQueryKeys,classifyImageLocation} from '../ops/inspect-source-media.mjs';
import {openDatabase,applyMigrations} from '../ops/actions/sqlite.mjs';
import {stage,getPending} from '../src/state.ts';
import {parseZenn} from '../src/sources/zenn.ts';

const base='https://zenn.dev/author/articles/';
const date='Fri, 16 Oct 2026 00:00:00 GMT';
const row=(slug,enclosure='')=>'<item><title>Article '+slug+'</title>'+
  '<link>'+base+slug+'</link><guid>'+base+slug+'</guid>'+
  '<pubDate>'+date+'</pubDate>'+enclosure+'</item>';
const valid='https://res.cloudinary.com/zenn/image/upload/article.png';
const tokenUrl='https://res.cloudinary.com/zenn/image/upload/rejected.png?token=private';
const xml='<?xml version="1.0"?><rss><channel>'+
  row('a','<enclosure url="'+valid+'" length="0" type="false"/>')+
  row('b','<enclosure url="'+tokenUrl+'"/>')+
  row('c')+
  row('d','<!-- <enclosure url="https://cdn.example.com/fake.png"/> -->')+
  '</channel></rss>';

test('source media inspector rejects invalid options and unsafe feeds before network',()=>{
  assert.deepEqual(parseOptions(['--source=zenn','--query=topic:typescript']),
    {help:false,source:'zenn',query:'topic:typescript'});
  assert.deepEqual(parseOptions(['--help']),{help:true});
  for(const args of [
    [], ['--source=arxiv','--query=foo'],['--source=zenn','--query=topic:../bad'],
    ['--source=qiita','--query='],['--source=qiita','--query=tag:Go','--query=tag:Rust'],
    ['--source=zenn','--query=topic:rust','--source=qiita'],
  ]) assert.throws(()=>parseOptions(args));
});

test('Zenn inspection counts raw enclosures, safe parsed URLs, and persistence rejections',async()=>{
  let count=0;
  const report=await inspectSourceMedia('zenn','topic:typescript',async(input,init)=>{
    count++;
    assert.equal(String(input),'https://zenn.dev/topics/typescript/feed');
    assert.equal(init.headers.Accept.includes('application/rss+xml'),true);
    return new Response(xml,{headers:{'content-type':'text/xml'}});
  });
  assert.equal(count,1);
  assert.deepEqual(report,{
    ok:true,source:'zenn',items:4,potentiallyTruncated:false,
    entriesWithEnclosureTag:2,imageUrlsParsed:2,imageUrlsPersistable:1,
    imageUrlsRejectedForPersistence:1,thumbnailUrlsParsed:0,
    thumbnailUrlsPersistable:0,thumbnailUrlsRejectedForPersistence:0,
    rejectionReasons:{unapproved_query_key:1},rejectedQueryKeys:{'[redacted]':1},
    rejectedKeyCategories:{credential_or_signature_like:1},
    rejectedImageLocationTypes:{zenn_cloudinary_upload:1},
    enclosuresWithoutParsedImage:0,
  });
  assert.doesNotMatch(JSON.stringify(report),/private|res\.cloudinary\.com|author|Article|typescript/);
});

test('Qiita inspection uses first API page and counts public avatars without reporting URLs',async()=>{
  let count=0;
  const payload=[
    {id:'one',title:'Private-title',url:'https://qiita.com/author/items/one',
      created_at:'2026-10-16T00:00:00Z',
      user:{profile_image_url:'https://images.example.com/avatar.png?v=4'}},
    {id:'two',title:'Other',url:'https://qiita.com/author/items/two',
      created_at:'2026-10-16T00:00:00Z',user:{profile_image_url:'https://images.example.com/other.png?token=secret'}},
    {id:'three',title:'No avatar',url:'https://qiita.com/author/items/three',
      created_at:'2026-10-16T00:00:00Z'},
  ];
  const report=await inspectSourceMedia('qiita','tag:Rust',async(input,init)=>{
    count++;
    const url=new URL(String(input));
    assert.equal(url.hostname,'qiita.com');
    assert.equal(url.searchParams.get('query'),'tag:Rust');
    assert.equal(init.headers.Accept,'application/json');
    return Response.json(payload);
  });
  assert.equal(count,1);
  assert.deepEqual(report,{
    ok:true,source:'qiita',items:3,potentiallyTruncated:false,
    imageUrlsParsed:0,imageUrlsPersistable:0,imageUrlsRejectedForPersistence:0,
    thumbnailUrlsParsed:2,thumbnailUrlsPersistable:1,thumbnailUrlsRejectedForPersistence:1,
    rejectionReasons:{unapproved_query_key:1},rejectedQueryKeys:{'[redacted]':1},
    rejectedKeyCategories:{credential_or_signature_like:1},
    rejectedImageLocationTypes:{},
  });
  assert.doesNotMatch(JSON.stringify(report),/Private-title|secret|author|images.example/);
});

test('Zenn parsed RSS image survives real D1 stage/getPending across invocations',async()=>{
  const {raw,db}=openDatabase(':memory:');
  try {
    applyMigrations(raw);
    const [entry]=parseZenn(xml);
    assert.ok(entry);
    const now=Date.parse('2026-10-16T01:00:00Z');
    await stage(db,'zenn-integration',[entry],Date.parse('2026-10-15T00:00:00Z'),now,
      {imageSource:'zenn'});
    const pending=await getPending(db,'zenn-integration',now,3,undefined,'zenn');
    assert.equal(pending.length,1);
    assert.equal(pending[0]?.image_url,valid);
    assert.equal(raw.prepare('SELECT image_url FROM deliveries WHERE item_id=?')
      .get(entry.id)?.image_url,valid);
  } finally {raw.close();}
});

test('query-key classes and media locations are fixed enums and do not expose upstream bytes',()=>{
  const keyClasses=classifyRejectedQueryKeys(
    'https://res.cloudinary.com/zenn/image/upload/a.png?token=secret&' +
    'abcdefghijklmnopqrstuvwxy=long&co%3Alor=odd&cache=1&quality=80');
  assert.deepEqual(keyClasses,{
    credential_or_signature_like:1,
    long_parameter_name:1,
    nonstandard_parameter_name:1,
    ordinary_unapproved_name:1,
  });
  for (const [url,kind] of [
    ['https://res.cloudinary.com/zenn/image/upload/a.png?private=x','zenn_cloudinary_upload'],
    ['https://res.cloudinary.com/zenn/image/fetch/a.png?private=x','zenn_cloudinary_fetch'],
    ['https://res.cloudinary.com/other/image/upload/a.png?private=x','other_cloudinary_path'],
    ['https://other.example.com/image.jpg?private=x','other_host'],
    ['INVALID','other_or_invalid'],
  ]) assert.equal(classifyImageLocation(url),kind);
  assert.doesNotMatch(JSON.stringify(keyClasses),/secret|abcdefghijklmnop|co%3A|cache/);
});
