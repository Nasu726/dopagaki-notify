import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parsePollRequestArgs,pollRequestSQL,requestPoll} from '../ops/request-production-poll.mjs';

test('production polling request defaults to a no-network SQL preview',()=>{
  const opts=parsePollRequestArgs(['--monitor=youtube-quizknock']);
  let called=0;
  const r=requestPoll(opts,()=>{called++;throw new Error('network called')});
  assert.equal(r.mode,'dry-run');
  assert.equal(r.remoteExecuted,false);
  assert.equal(called,0);
  assert.equal(r.sql,"UPDATE monitor_state SET next_due_at = 0 WHERE id = 'youtube-quizknock' AND lease_token IS NULL AND initialized_at IS NOT NULL;");
  assert.equal(parsePollRequestArgs(['--help']).help,true);
});

test('confirmed production request executes only a lease-guarded UPDATE remotely',()=>{
  const opts=parsePollRequestArgs(['--monitor=youtube-quizknock','--database=my-database','--confirm-remote']);
  let seen=null;
  const r=requestPoll(opts,(command,args,params)=>{
    seen={command,args,params};return {status:0};
  });
  assert.equal(r.mode,'remote-requested');
  assert.equal(r.remoteExecuted,true);
  assert.deepEqual(seen.args.slice(0,5),['wrangler','d1','execute','my-database','--remote']);
  assert.equal(seen.args[5],'--command');
  assert.equal(seen.args[6],pollRequestSQL('youtube-quizknock'));
  assert.equal(seen.params.shell,false);
  assert.deepEqual(seen.params.stdio,['ignore','pipe','pipe']);
});

test('invalid and malicious inputs rejected before shell or SQL',()=>{
  for(const inputs of [
    [],['--monitor='],['--monitor=YOUTUBE'],['--monitor=x;DROP TABLE deliveries'],
    ['--monitor=youtube-quizknock','--monitor=other'],
    ['--monitor=yt','--database=bad name'],['--monitor=yt','--database=../../x'],
    ['--monitor=yt','--confirm-remote','--confirm-remote'],['--monitor=yt','--force'],
  ])assert.throws(()=>parsePollRequestArgs(inputs));
  assert.throws(()=>pollRequestSQL("x';DELETE FROM deliveries;--"));
  assert.throws(()=>requestPoll(parsePollRequestArgs(['--monitor=yt','--confirm-remote']),
    ()=>({status:1,stderr:'private'})),/Remote D1 request failed/);
});
