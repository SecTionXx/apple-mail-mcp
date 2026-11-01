// Exchange/Hotmail bulk load test: heavy metadata walk + batched body reads +
// a concurrent burst against the paced bridge. Prints counts/status/timing only,
// never message content. PASS criteria: zero MAIL_TIMEOUT, zero unexpected
// failures, burst rejections are only MAIL_BUSY, and Mail still answers after.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dependency } from '../runtime.mjs';
const {Client}=await dependency('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=await dependency('@modelcontextprotocol/sdk/client/stdio.js');
const client=new Client({name:'exchange-load-acceptance',version:'0.3.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../server.mjs',import.meta.url))],stderr:'pipe'});
const TIMEOUT=90000;
async function call(name,args={}) {
  const started=Date.now();
  const result=await client.callTool({name,arguments:args},undefined,{timeout:TIMEOUT});
  const text=result.content[0].text;
  let body;
  try {body=JSON.parse(text);} catch {body=text;}  // e.g. bare 'MAIL_BUSY'
  return {elapsed:Date.now()-started,isError:Boolean(result.isError),body};
}
const stats=[];
const track=p=>{stats.push(p.elapsed);return p;};
const classify=p=>p.isError?String(p.body).includes('MAIL_BUSY')?'busy':String(p.body).includes('MAIL_TIMEOUT')?'timeout':'error':'ok';
const median=values=>{const s=[...values].sort((a,b)=>a-b);return s[Math.floor(s.length/2)];};
try {
  await client.connect(transport);
  const accounts=(await call('list_accounts')).body.accounts;
  const exchange=accounts.find(a=>a.name==='Exchange');
  assert.ok(exchange,'Exchange account not found');
  const boxes=(await call('list_mailboxes',{account_id:exchange.id,limit:50})).body.mailboxes;
  const inbox=boxes.find(b=>/^inbox$/i.test(b.name));
  assert.ok(inbox,'Inbox not found');
  const base={account_id:exchange.id,mailbox_path:inbox.path};
  // Phase 1: heavy metadata walk, 6 pages x 50 rows.
  const ids=[];let total=null,offset=0,walkCalls=0;
  for(let page=0;page<6&&offset!==null;page++) {
    const p=track(await call('list_messages',{...base,offset,limit:50}));
    assert.equal(classify(p),'ok',`metadata page failed: ${JSON.stringify(p.body).slice(0,200)}`);
    total=p.body.total;ids.push(...p.body.messages.map(m=>m.id));
    offset=p.body.next_offset;walkCalls++;
  }
  assert.ok(ids.length>=50,'walk returned too few rows to prove load');
  // Phase 2: batched body reads through bulk_read_messages (10 per call).
  let bodies=0,readFailures=0,readCalls=0;
  for(let batch=0;batch<3&&batch*10<ids.length;batch++) {
    const slice=ids.slice(batch*10,batch*10+10);
    const p=track(await call('bulk_read_messages',{...base,message_ids:slice,max_chars:2000}));
    assert.equal(classify(p),'ok',`bulk read failed: ${JSON.stringify(p.body).slice(0,200)}`);
    bodies+=p.body.messages.length;readFailures+=p.body.failed.length;readCalls++;
  }
  assert.ok(bodies>0,'no bodies read');
  // Phase 3: burst — 12 concurrent calls must never hang or timeout; the queue
  // bounds in-flight work by rejecting the excess with MAIL_BUSY.
  const burstStart=Date.now();
  const burst=await Promise.all(Array.from({length:12},()=>call('list_messages',{...base,limit:1})));
  const burstMs=Date.now()-burstStart;
  const outcomes=burst.map(classify);
  const busy=outcomes.filter(o=>o==='busy').length;
  const timeouts=outcomes.filter(o=>o==='timeout').length;
  const errors=outcomes.filter(o=>o==='error').length;
  const ok=outcomes.filter(o=>o==='ok').length;
  assert.equal(timeouts,0,'burst produced MAIL_TIMEOUT');
  assert.equal(errors,0,'burst produced unexpected errors');
  assert.ok(ok>0&&busy>0,'burst should mix successes with MAIL_BUSY rejections');
  // Phase 4: Mail still answers promptly after the load.
  const health=track(await call('list_messages',{...base,limit:1}));
  assert.equal(classify(health),'ok','Mail stopped answering after load');
  const report={protocol:'PASS',account:exchange.name,inbox_total:total,
    metadata_walk:{calls:walkCalls,rows:ids.length},
    bulk_reads:{calls:readCalls,bodies,per_message_failures:readFailures},
    burst:{concurrent:12,ok,busy_rejected:busy,timeouts,errors,wall_ms:burstMs},
    timing_ms:{calls:stats.length,min:Math.min(...stats),median:median(stats),max:Math.max(...stats)},
    hang_or_timeout:false,mail_responsive_after_load:true};
  console.log(JSON.stringify(report));
} finally {await client.close();}
