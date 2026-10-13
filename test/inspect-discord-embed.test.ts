import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseDiscordMessageLink,parseOptions,parseWebhook,summarizeMessage,inspectDiscordEmbed} from '../ops/inspect-discord-embed.mjs';

const channelId='123456789012345678';
const messageId='123456789012345679';
const webhook='https://discord.com/api/webhooks/123456789012345677/private-test-token';
const link='https://discord.com/channels/123456789012345676/'+channelId+'/'+messageId;
const id='vLphol5F_SY';
const img='https://i.ytimg.com/vi/'+id+'/hqdefault.jpg';
const sample={id:messageId,channel_id:channelId,flags:0,embeds:[{type:'rich',url:'https://www.youtube.com/watch?v='+id,thumbnail:{url:img,proxy_url:'https://images-ext-1.discordapp.net/external/proxy',width:480,height:360}}]};

test('message link and webhook validation fail closed',()=>{
  assert.deepEqual(parseDiscordMessageLink(link),{channelId,messageId});
  assert.deepEqual(parseOptions(['--message-link='+link]),{help:false,channelId,messageId,probeImage:false});
  assert.deepEqual(parseOptions(['--probe-image','--message-link='+link]),{help:false,channelId,messageId,probeImage:true});
  assert.equal(parseWebhook(webhook).hostname,'discord.com');
  for(const raw of ['http://discord.com/channels/1/2/3','https://evil.com/channels/123456789012345676/'+channelId+'/'+messageId,
    link+'?token=private','https://discord.com/channels/123/123/123','https://discord.com/channels/@me/'+channelId+'/'+messageId+'/extra'])
    assert.throws(()=>parseDiscordMessageLink(raw));
  for(const raw of ['https://discord.com/api/webhooks/123456789012345677/private?bad=1',
    'https://discord.com/api/webhooks/123456789012345677/private#token',
    'https://discord.com.evil.com/api/webhooks/123456789012345677/x'])
    assert.throws(()=>parseWebhook(raw));
});

test('summarizes Discord proxy dimensions without exposing credentials or raw message',()=>{
  const report=summarizeMessage(sample,channelId,messageId);
  assert.deepEqual(report,{ok:true,embedsSuppressed:false,embedCount:1,embeds:[{
    type:'rich',youtubeVideoId:id,
    thumbnail:{present:true,sourceHost:'i.ytimg.com',matchesExpectedYouTubeUrl:true,proxyPresent:true,width:480,height:360},
    image:{present:false},
  }]});
  assert.doesNotMatch(JSON.stringify(report),/private-test-token|external\/proxy|123456789012345679/);
  assert.throws(()=>summarizeMessage(sample,channelId,'123456789012345688'));
});

test('read-only GET inspects existing Discord message with no POST or state writes',async()=>{
  let requests=0;
  const report=await inspectDiscordEmbed({webhook,channelId,messageId,fetcher:async(input,init)=>{
    requests++;
    const u=new URL(String(input));
    assert.equal(u.pathname,'/api/webhooks/123456789012345677/private-test-token/messages/'+messageId);
    assert.equal(init.method,'GET');
    assert.equal(init.redirect,'error');
    return Response.json(sample);
  }});
  assert.equal(requests,1);
  assert.equal(report.embeds[0].thumbnail.proxyPresent,true);
});

test('optional probe checks canonical expected image URL only, does not expose body',async()=>{
  let requests=0;
  const report=await inspectDiscordEmbed({webhook,channelId,messageId,probeImage:true,fetcher:async(input,init)=>{
    requests++;
    if(requests===1)return Response.json(sample);
    assert.equal(String(input),img);
    assert.equal(init.method,'GET');
    assert.equal(init.headers.Range,'bytes=0-0');
    return new Response(new Uint8Array([0xff,0xd8]),{status:206,headers:{'content-type':'image/jpeg','content-range':'bytes 0-1/300'}});
  }});
  assert.equal(requests,2);
  assert.deepEqual(report.sourceImage,{checked:true,status:206,contentType:'image/jpeg',redirected:false});
});

test('suppressed/stripped image is distinguished from client rendering failure',()=>{
  const stripped=summarizeMessage({...sample,flags:4,embeds:[]},channelId,messageId);
  assert.equal(stripped.embedsSuppressed,true);
  assert.equal(stripped.embedCount,0);
  const notProxied=summarizeMessage({...sample,embeds:[{url:'https://www.youtube.com/watch?v='+id,
    thumbnail:{url:img,width:0,height:0}}]},channelId,messageId);
  assert.deepEqual(notProxied.embeds[0].thumbnail,{present:true,sourceHost:'i.ytimg.com',matchesExpectedYouTubeUrl:true,proxyPresent:false,width:0,height:0});
});

test('HTTP failure and response mismatch return sanitized errors',async()=>{
  await assert.rejects(()=>inspectDiscordEmbed({webhook,channelId,messageId,fetcher:async()=>new Response('private',{status:404})}),/Discord message lookup failed \(HTTP 404\)/);
  await assert.rejects(()=>inspectDiscordEmbed({webhook,channelId,messageId,fetcher:async()=>Response.json({...sample,channel_id:'123456789012345680'})}),/does not identify/);
});
