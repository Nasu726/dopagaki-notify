import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchOpenAlex, openAlexQuery, parseOpenAlexWorks, OPENALEX_PER_PAGE } from '../src/sources/openalex.ts';
import { HttpStatusError } from '../src/http.ts';
import type { Monitor } from '../src/types.ts';

const now = Date.parse('2026-10-13T12:00:00Z');
const mon: Monitor = {source:'openalex', id:'oa-test', query:'search:graph algorithms',
  intervalMinutes: 360, enabled:true};
const body = { results: [
  { id:'https://openalex.org/W123', display_name:'Graph Theory', publication_date:'2026-10-13' },
  { id:'https://openalex.org/W124', display_name:'An older work', publication_date:'2026-10-12' },
]};
test('OpenAlex parses immutable work IDs, title and date-only publication', () => {
  assert.deepEqual(parseOpenAlexWorks(body, now), [
    {id:'openalex:W123', title:'Graph Theory', url:'https://openalex.org/W123',
      publishedAt:Date.parse('2026-10-13T00:00:00Z')},
    {id:'openalex:W124', title:'An older work', url:'https://openalex.org/W124',
      publishedAt:Date.parse('2026-10-12T00:00:00Z')},
  ]);
  assert.throws(()=>parseOpenAlexWorks({results:[{...body.results[0],id:'https://bad.site/W123'}]},now));
  assert.throws(()=>parseOpenAlexWorks({results:[{...body.results[0],publication_date:'2026-02-31'}]},now));
});

test('OpenAlex supports safe search, topic and author selectors', () => {
  assert.deepEqual(openAlexQuery('search:graph algorithms'),{search:'graph algorithms'});
  assert.deepEqual(openAlexQuery('topic:T123'),{filter:'topics.id:T123'});
  assert.deepEqual(openAlexQuery('author:A123'),{filter:'authorships.author.id:A123'});
  for(const q of ['unknown:any','topic:ABC','author:-1','search:','search:\nkey','topic:T1,api_key:X']) {
    assert.throws(()=>openAlexQuery(q));
  }
});

test('OpenAlex HTTP request uses stable bounded public endpoints and optional Bearer key', async () => {
  const called: {url:URL;auth:string|null}[] = [];
  const fake: typeof fetch = async (url,init) => {
    called.push({url:new URL(String(url)),auth:new Headers(init?.headers).get('Authorization')});
    return Response.json(body);
  };
  const response=await fetchOpenAlex(mon,'mock-key',fake,now);
  assert.equal(response.items.length,2);
  assert.equal(response.potentiallyTruncated,false);
  assert.equal(called[0]?.url.hostname,'api.openalex.org');
  assert.equal(called[0]?.url.pathname,'/works');
  assert.equal(called[0]?.url.searchParams.get('per_page'),String(OPENALEX_PER_PAGE));
  assert.equal(called[0]?.url.searchParams.get('sort'),'publication_date:desc');
  assert.match(called[0]?.url.searchParams.get('filter')??'',/from_publication_date:2026-10-06/);
  assert.equal(called[0]?.url.searchParams.get('search'),'graph algorithms');
  assert.equal(called[0]?.auth,'Bearer mock-key');
  called.length=0;
  await fetchOpenAlex({...mon,query:'topic:T123'},undefined,fake,now);
  assert.match(called[0]?.url.searchParams.get('filter')??'',/topics.id:T123/);
  assert.equal(called[0]?.auth,null);
  assert.equal(called[0]?.url.searchParams.has('api_key'),false);
});

test('OpenAlex upstream errors preserve typed retry hints', async () => {
  await assert.rejects(
    ()=>fetchOpenAlex(mon,undefined,async()=>new Response('busy',
      {status:429,headers:{'Retry-After':'20'}}),now),
    (e:unknown)=>e instanceof HttpStatusError && e.status===429 && e.retryAfterMs===20000
  );
});
