// Short-lived, no-secret investigation. Read only public Zenn RSS + Cloudinary images.
// Output is restricted to fixed counters/status and comparisons; never URL or query data.
import { createHash } from 'node:crypto';
import { parseZenn, zennFeedUrl } from '../src/sources/zenn.ts';
import { fetchTextBounded } from '../src/sources/xml.ts';

const results = {rssCount:0, rejectedQueryShape:{}, keyLength:{}, firstCharacter:{}, imageLocation:{}, comparisons:{sampled:0,matching:0,failed:0}};
function bucket(k){
  if (!k.length) return 'empty';
  if (/[^a-z0-9_-]/i.test(k)) return 'punctuation_or_unicode';
  if (k.length > 24) return 'long';
  if (!/^[a-z]/i.test(k)) return 'nonalpha_start';
  return 'other';
}
function add(map,key){map[key]=(map[key]??0)+1;}
async function digestImage(u){
  try {
    const r=await fetch(u,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(12000)});
    const ct=(r.headers.get('content-type')||'').split(';')[0].toLowerCase();
    if(r.status!==200 || !['image/png','image/jpeg','image/webp'].includes(ct))
      return {ok:false,status:r.status,ctype:ct.startsWith('image/')?'image':'other'};
    if(Number(r.headers.get('content-length'))>5_000_000)return {ok:false,status:200,reason:'too_large'};
    const reader=r.body?.getReader();if(!reader)return {ok:false,reason:'no_body'};
    const hash=createHash('sha256');let n=0;
    while(true){
      const {value,done}=await reader.read();if(done)break;
      n+=value.length;
      if(n>5_000_000){await reader.cancel();return {ok:false,reason:'too_large'};}
      hash.update(value);
    }
    return {ok:true,status:200,ctype:ct,bytes:n,hash:hash.digest('hex')};
  }catch{return {ok:false,reason:'request_failed'};}
}
try {
  const xml=await fetchTextBounded(zennFeedUrl('topic:typescript'),'Zenn');
  const items=parseZenn(xml);
  results.rssCount=items.length;
  const safe=[];
  for (const i of items){
    if(!i.imageUrl)continue;
    const u=new URL(i.imageUrl);
    const loc=u.hostname==='res.cloudinary.com'&&u.pathname.startsWith('/zenn/image/upload/')?'zenn_cloudinary_upload':'other';
    add(results.imageLocation,loc);
    if(u.search){
      for(const [key] of u.searchParams){
        add(results.rejectedQueryShape,bucket(key));
        add(results.keyLength,key.length===1?'length_1':key.length<=4?'length_2_to_4':key.length<=12?'length_5_to_12':'length_13_plus');
        add(results.firstCharacter,key[0]==='_'?'underscore':/^[0-9]$/.test(key[0]||'')?'digit':key[0]==='-'?'hyphen':'other');
      }
    }
    if(loc==='zenn_cloudinary_upload'&&u.search && safe.length<20)safe.push(u);
  }
  for(const u of safe){
    const stripped=new URL(u);stripped.search='';
    const a=await digestImage(u),b=await digestImage(stripped);
    results.comparisons.sampled++;
    if(a.ok&&b.ok&&a.hash===b.hash&&a.ctype===b.ctype)results.comparisons.matching++;
    else results.comparisons.failed++;
  }
  console.log(JSON.stringify(results));
}catch{
  console.log(JSON.stringify({error:'Public RSS probe failed (no URLs exposed)'}));
  process.exitCode=1;
}
