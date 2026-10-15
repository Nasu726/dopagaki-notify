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
  assert.deepEqual(parseOptions(['--message-link='+link]),{help:false,channelId,messageId,probeImage:false,probeProxy:false});
  assert.deepEqual(parseOptions(['--probe-image','--message-link='+link]),{help:false,channelId,messageId,probeImage:true,probeProxy:false});
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


test('optional Discord proxy probe uses an allowlisted host and never posts, redirects or reveals URL',async()=>{
  const requests=[];
  const result=await inspectDiscordEmbed({webhook,channelId,messageId,probeProxy:true,fetcher:async(input,init)=>{
    requests.push({url:String(input),method:init?.method,redirect:init?.redirect});
    if(requests.length===1)return Response.json(sample);
    assert.equal(new URL(String(input)).hostname,'images-ext-1.discordapp.net');
    assert.equal(init.method,'GET');
    assert.equal(init.redirect,'manual');
    assert.equal(init.headers.Range,'bytes=0-0');
    return new Response(new Uint8Array([0xff,0xd8]),{
      status:206,headers:{'content-type':'image/jpeg'},
    });
  }});
  assert.equal(requests.length,2);
  assert.deepEqual(result.discordProxyImage,{checked:true,status:206,contentType:'image/jpeg',redirected:false});
  assert.doesNotMatch(JSON.stringify(result),/private-test-token|images-ext-1\.discordapp\.net\/external/);
});

test('invalid Discord proxy host is never fetched, even if forged in a saved message',async()=>{
  for(const raw of ['http://127.0.0.1/internal','https://169.254.169.254/latest/meta-data',
    'https://images-ext-1.discordapp.net.evil.com/external/test',
    'https://images-ext-1.discordapp.net@evil.com/external/test',
    'https://images-ext-1.discordapp.net/notexternal/test',
    'https://images-ext-1.discordapp.net:123/external/test']) {
    let calls=0;
    const bad={...sample,embeds:[{...sample.embeds[0],thumbnail:{
      ...sample.embeds[0].thumbnail,proxy_url:raw}}]};
    const r=await inspectDiscordEmbed({webhook,channelId,messageId,probeProxy:true,fetcher:async()=>{
      calls++;if(calls>1)throw new Error('Unexpected external request');return Response.json(bad);
    }});
    assert.equal(calls,1);
    assert.equal(r.discordProxyImage.checked,false);
  }
});

test('proxy and source probes report distinct read-only HTTP failures',async()=>{
  let count=0;
  const r=await inspectDiscordEmbed({webhook,channelId,messageId,probeImage:true,probeProxy:true,fetcher:async(input,init)=>{
    count++;
    assert.equal(init.method,'GET');
    if(count===1)return Response.json(sample);
    if(new URL(String(input)).hostname==='images-ext-1.discordapp.net')
      return new Response('not found',{status:404,headers:{'content-type':'text/html'}});
    assert.equal(String(input),img);
    return new Response(new Uint8Array([0xff,0xd8]),{status:206,headers:{'content-type':'image/jpeg'}});
  }});
  assert.equal(count,3);
  assert.equal(r.discordProxyImage.status,404);
  assert.equal(r.sourceImage.status,206);
});

test('Qiita and Zenn diagnostics inspect existing Discord image and proxy with no untrusted source fetch',async()=>{
  for(const [source,host] of [['qiita','qiita.com'],['zenn','zenn.dev']]){
    const opts=parseOptions(['--message-link='+link,'--source='+source,'--probe-proxy']);
    assert.equal(opts.source,source);
    const existing={id:messageId,channel_id:channelId,embeds:[{
      type:'rich',url:'https://'+host+'/user/articles/secret-title',
      image:{url:'https://images.example.org/test.png?token=private',
        proxy_url:'https://images-ext-1.discordapp.net/external/test',width:720,height:360},
    }]};
    let calls=0;
    const report=await inspectDiscordEmbed({webhook,channelId,messageId,source,probeProxy:true,probeImage:true,
      fetcher:async(input,init)=>{
        calls++;assert.equal(init.method,'GET');
        if(calls===1)return Response.json(existing);
        assert.equal(new URL(String(input)).hostname,'images-ext-1.discordapp.net');
        return new Response(new Uint8Array([0xff]),{status:206,headers:{'content-type':'image/png'}});
      },
    });
    assert.equal(calls,2);
    assert.equal(report.embeds[0].articleHost,host);
    assert.equal(report.embeds[0].matchesExpectedArticleHost,true);
    assert.equal(report.embeds[0].image.present,true);
    assert.equal(report.sourceImage.checked,false);
    assert.equal(report.discordProxyImage.status,206);
    assert.doesNotMatch(JSON.stringify(report),/private|secret-title|external\/test/);
  }
  assert.throws(()=>parseOptions(['--message-link='+link,'--source=arxiv']));
  assert.throws(()=>parseOptions(['--message-link='+link,'--source=qiita','--source=zenn']));
});
