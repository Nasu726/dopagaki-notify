// Opt-in production D1 scheduling request. This does NOT invoke the Worker,
// contact providers, send Discord messages or bypass its Cron schedule.
// By default, print the guarded SQL (no network). Remote execution requires
// --confirm-remote, wrangler authentication, and the configured D1 database.
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const ID=/^[a-z0-9][a-z0-9-]{0,63}$/;
const DB=/^[A-Za-z0-9_-]{1,64}$/;

export function parsePollRequestArgs(args) {
  if (args.length===1 && args[0]==='--help')return {help:true};
  let monitorId=null, database='dopagaki-notify', selectedDatabase=false, confirm=false;
  for(const arg of args) {
    if(arg.startsWith('--monitor=') && monitorId===null)monitorId=arg.slice(10);
    else if(arg.startsWith('--database=') && !selectedDatabase) {
      database=arg.slice(11);selectedDatabase=true;
    } else if(arg==='--confirm-remote' && !confirm)confirm=true;
    else throw new Error('Unexpected/duplicate option; use --help');
  }
  if(!ID.test(monitorId??''))throw new Error('Invalid or missing --monitor=ID');
  if(!DB.test(database))throw new Error('Invalid --database=NAME');
  return {help:false,monitorId,database,confirm};
}

export function pollRequestSQL(monitorId) {
  if(!ID.test(monitorId))throw new Error('Invalid monitor ID');
  // Never override an active lease or reset deduplication, retry queue,
  // initialization or the recorded source/query identity. No upsert.
  return "UPDATE monitor_state SET next_due_at = 0 WHERE id = '" + monitorId +
    "' AND lease_token IS NULL AND initialized_at IS NOT NULL;";
}

export function requestPoll(options, exec = spawnSync) {
  if(options.help)throw new Error('Cannot execute --help');
  const sql=pollRequestSQL(options.monitorId);
  if(!options.confirm)return {ok:true,mode:'dry-run',sql,remoteExecuted:false};
  const program=process.platform==='win32'?'npx.cmd':'npx';
  const args=['wrangler','d1','execute',options.database,'--remote','--command',sql];
  const result=exec(program,args,{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],shell:false,timeout:45_000,
  });
  if(result.error || result.status!==0)
    throw new Error('Remote D1 request failed; check Wrangler authentication/database and Cloudflare D1 status');
  return {ok:true,mode:'remote-requested',remoteExecuted:true,
    note:'Guarded UPDATE completed; confirm a row was updated and check the next Cron. The Worker did not run immediately.'};
}

async function main() {
  const args=parsePollRequestArgs(process.argv.slice(2));
  if(args.help) {
    console.log('Usage: npm run poll:request -- --monitor=ID [--database=NAME] [--confirm-remote]');
    console.log('Default: print guarded SQL only. --confirm-remote performs ONE D1 UPDATE; no Discord send or state reset.');
    console.log('After approval, next Cron may poll the monitor, subject to Worker scheduling and delivery-window rules.');
    return;
  }
  console.log(JSON.stringify(requestPoll(args),null,2));
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try{await main()}catch(e) {
    const reason=e instanceof Error && /^(Invalid |Unexpected|Remote D1 request failed)/.test(e.message)
      ? e.message:'Production polling request failed';
    console.error(JSON.stringify({ok:false,message:reason}));process.exitCode=1;
  }
}
