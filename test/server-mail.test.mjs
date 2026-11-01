import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,lstat,realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGmail,MailServerError,serverError,boundedJSON,parseMessage } from '../gmail.mjs';
import { createServerMail } from '../server-mail.mjs';
import { MAX_BYTES } from '../core.mjs';
const temporary=()=>mkdtemp(join(tmpdir(),'server-mail-test-'));
const profile=(count=3,history='1')=>({emailAddress:'fixture@example.test',messagesTotal:count,historyId:history});
const fixtureCredentials=async()=>({client:{},saved:{access_token:'fixture-only',expiry_date:Date.now()+3600000}});
// Deterministic policy clock: fake sleep advances fake time; no real waiting.
const fakeClock=()=>{let t=1000;return {now:()=>t,sleep:async ms=>{t+=ms;},rand:()=>0};};
test('Gmail lists include spam/trash, token, query; requests are GET only with redirects forbidden',async()=>{
  let seen;
  const api=createGmail({loadCredentials:fixtureCredentials,fetchImpl:async(url,opts)=>{seen={url:new URL(url),opts};return Response.json({messages:[],nextPageToken:'page2'});}});
  await api.list({query:'in:anywhere',page_token:'page1',limit:500});
  assert.equal(seen.url.hostname,'gmail.googleapis.com');
  assert.equal(seen.url.searchParams.get('includeSpamTrash'),'true');
  assert.equal(seen.url.searchParams.get('pageToken'),'page1');
  assert.equal(seen.opts.method,'GET');assert.equal(seen.opts.redirect,'error');
});
test('HTTP and network errors never expose response contents or authorization',async()=>{
  for(const status of [401,403,404,429,500]) {
    const api=createGmail({loadCredentials:fixtureCredentials,fetchImpl:async()=>Response.json({private:'private-response'},{status}),...fakeClock()});
    await assert.rejects(api.profile(),e=>!serverError(e).includes('private') && !serverError(e).includes('fixture-only'));
  }
  const api=createGmail({loadCredentials:fixtureCredentials,fetchImpl:async()=>{throw Error('private-response');},...fakeClock()});
  await assert.rejects(api.profile(),e=>serverError(e)==='GMAIL_NETWORK_FAILED');
  await assert.rejects(boundedJSON(Response.json({large:'payload'}),2),/RESPONSE_TOO_LARGE/);
});
test('resumable inventory deduplicates pages and verifies counts with stable history',async()=>{
  const api={profile:async()=>profile(),list:async({page_token})=>page_token?{messages:[{id:'b'},{id:'c'}]}:{messages:[{id:'a'},{id:'b'}],nextPageToken:'next'}};
  const root=await temporary();
  const first=await createServerMail(api,root).scan({max_pages:1});
  assert.equal(first.status,'scanning');assert.equal(first.unique_message_ids,2);
  const last=await createServerMail(api,root).scan({scan_id:first.scan_id,max_pages:1});
  assert.equal(last.status,'verified_message_inventory');assert.equal(last.unique_message_ids,3);
  assert.equal((await lstat(last.manifest_path)).mode & 0o777,0o600);
});
test('changing history or wrong count never claims complete inventory',async()=>{
  for(const [count,changed,expected] of [[3,true,'changed_during_scan'],[4,false,'count_mismatch']]) {
    let calls=0;
    const api={profile:async()=>profile(count,changed&&calls++?'2':'1'),list:async()=>({messages:[{id:'a'},{id:'b'},{id:'c'}]})};
    const s=await createServerMail(api,await temporary()).scan({});
    assert.equal(s.status,expected);
  }
});
test('interrupted scan retains cursor and can resume with a new service',async()=>{
  let failed=false;
  const api={profile:async()=>profile(2),list:async({page_token})=>{
    if(!page_token)return {messages:[{id:'a'}],nextPageToken:'next'};
    if(!failed){failed=true;throw new MailServerError('GMAIL_RATE_LIMITED');}
    return {messages:[{id:'b'}]};
  }};
  const root=await temporary();
  const first=await createServerMail(api,root).scan({});
  assert.equal(first.status,'interrupted');assert.equal(first.unique_message_ids,1);
  const last=await createServerMail(api,root).scan({scan_id:first.scan_id});
  assert.equal(last.status,'verified_message_inventory');
});
test('repeated page tokens fail explicitly and do not claim completeness',async()=>{
  const api={profile:async()=>profile(99),list:async()=>({messages:[{id:'a'}],nextPageToken:'same'})};
  const s=await createServerMail(api,await temporary()).scan({max_pages:5});
  assert.equal(s.status,'interrupted');assert.equal(s.last_error,'PAGINATION_STALLED');
});
test('nested MIME bodies, external text, HTML and remote attachments are discoverable',async()=>{
  const message={id:'a',labelIds:['UNREAD'],payload:{parts:[{mimeType:'multipart/alternative',parts:[{mimeType:'text/plain',body:{attachmentId:'text',size:5}},{mimeType:'text/html',body:{data:Buffer.from('<p>Hello</p>').toString('base64url')}}]},{filename:'../../demo.txt',mimeType:'text/plain',body:{attachmentId:'file',size:5}}]}};
  assert.equal(parseMessage(message).text_body_external,true);
  const root=await temporary();
  const api={message:async()=>structuredClone(message),attachment:async()=>({data:Buffer.from('hello').toString('base64url'),size:5})};
  const service=createServerMail(api,root);
  const read=await service.read({message_id:'a',max_chars:3});
  assert.equal(read.body,'hel');assert.equal(read.truncated,true);assert.equal(read.text_body_external,false);
  assert.ok(read.parts.some(p=>p.part_key==='0.0.1'));
  const saved=await service.download({message_id:'a',part_key:'0.1'});
  assert.equal(await readFile(saved.path,'utf8'),'hello');
  assert.ok(saved.path.startsWith(await realpath(root)+'/download-'));assert.equal((await lstat(saved.path)).mode & 0o777,0o600);
});
test('server attachment size mismatch and excessive size fail without export',async()=>{
  const api={message:async()=>({id:'a',payload:{filename:'x',body:{attachmentId:'x',size:5}}}),attachment:async()=>({data:'YQ',size:5})};
  await assert.rejects(createServerMail(api,await temporary()).download({message_id:'a',part_key:'0'}),/ATTACHMENT_SIZE_MISMATCH/);
});
test('first sync stores a baseline cursor and claims no deltas',async()=>{
  const api={profile:async()=>profile(3,'500')};
  const root=await temporary();
  const s=await createServerMail(api,root).sync({});
  assert.equal(s.status,'initial_baseline');
  assert.equal(s.last_history_id,'500');assert.equal(s.new_history_id,null);
  const state=JSON.parse(await readFile(join(root,'sync.json'),'utf8'));
  assert.equal(state.last_history_id,'500');
  assert.equal((await lstat(join(root,'sync.json'))).mode & 0o777,0o600);
});
test('sync advances the cursor only after full pagination and resumes cleanly',async()=>{
  const seenHistory=[];
  const api={
    profile:async()=>profile(3,'500'),
    history:async({start_history_id,page_token})=>{
      seenHistory.push({start_history_id,page_token});
      return page_token
        ?{history:[{id:'h2',messagesAdded:[{message:{id:'new'}}]}],historyId:'600'}
        :{history:[{id:'h1',messagesAdded:[{message:{id:'old'}}]}],nextPageToken:'p2',historyId:'600'};
    }
  };
  const root=await temporary();
  const svc=createServerMail(api,root);
  await svc.sync({});
  const partial=await svc.sync({max_pages:1});
  assert.equal(partial.status,'running');
  assert.equal(partial.new_history_id,null);
  let state=JSON.parse(await readFile(join(root,'sync.json'),'utf8'));
  assert.equal(state.last_history_id,'500');assert.equal(state.run.page_token,'p2');
  const done=await svc.sync({max_pages:1});
  assert.equal(done.status,'changed');
  assert.equal(done.new_history_id,'600');assert.equal(done.last_history_id,'500');
  assert.deepEqual([...done.added].sort(),['new','old']);
  assert.equal(done.added_count,2);assert.ok(done.resumed);
  state=JSON.parse(await readFile(join(root,'sync.json'),'utf8'));
  assert.equal(state.last_history_id,'600');assert.equal(state.run,null);
  assert.equal(seenHistory.every(h=>h.start_history_id==='500'),true);
});
test('expired history is a status, not an error, and keeps the cursor',async()=>{
  const api={profile:async()=>profile(3,'500'),history:async()=>{throw new MailServerError('SYNC_HISTORY_EXPIRED');}};
  const root=await temporary();
  const svc=createServerMail(api,root);
  await svc.sync({});
  const s=await svc.sync({});
  assert.equal(s.status,'history_expired');
  assert.match(s.next_action,/server_scan_mailbox/);
  const state=JSON.parse(await readFile(join(root,'sync.json'),'utf8'));
  assert.equal(state.last_history_id,'500');assert.equal(state.run,null);
});
test('hydration fetches bounded metadata only for added messages',async()=>{
  const messages=[];
  const api={
    profile:async()=>profile(3,'500'),
    history:async()=>({history:[{id:'h1',messagesAdded:[1,2,3].map(i=>({message:{id:'m'+i}}))}],historyId:'600'}),
    message:async(id,o)=>{messages.push({id,o});return {id,threadId:'t'+id,labelIds:['INBOX'],snippet:'s'+id,internalDate:'123',payload:{headers:[{name:'Subject',value:'sub '+id},{name:'From',value:'a@b.test'}]}};}
  };
  const svc=createServerMail(api,await temporary());
  await svc.sync({});
  const s=await svc.sync({hydrate_metadata:true,max_hydrate:2});
  assert.equal(s.status,'changed');assert.equal(s.added_count,3);
  assert.equal(messages.length,2);
  assert.equal(messages[0].o.format,'metadata');
  assert.match(messages[0].o.fields,/payload\/headers/);
  assert.equal(s.hydrated.length,2);assert.equal(s.hydrated[0].subject,'sub m1');
});
test('bulk fetch defaults to masked metadata, tolerates 404s and resumes by job_id',async()=>{
  const calls=[];
  const api={
    profile:async()=>profile(3,'1'),
    message:async(id,o)=>{calls.push({id,o});
      if(id==='miss') throw new MailServerError('GMAIL_NOT_FOUND');
      return {id,threadId:'t'+id,labelIds:['INBOX'],snippet:'snip '+id,internalDate:'1700000000000',payload:{headers:[{name:'Subject',value:'sub '+id},{name:'From',value:'x@y.test'}]}};
    }
  };
  const svc=createServerMail(api,await temporary());
  const r=await svc.bulkFetch({message_ids:['a','miss','b']});
  assert.equal(r.status,'complete');assert.equal(r.done_count,2);
  assert.deepEqual(r.failed,[{id:'miss',code:'GMAIL_NOT_FOUND'}]);
  assert.equal(calls[0].o.format,'metadata');assert.match(calls[0].o.fields,/snippet/);
  assert.equal(r.messages[0].subject,'sub a');
  const r2=await svc.bulkFetch({job_id:r.job_id,message_ids:['a','c']});
  assert.deepEqual(calls.map(c=>c.id),['a','miss','b','c']);
  assert.equal(r2.status,'complete');assert.equal(r2.done_count,3);
});
test('bulk fetch aborts after three consecutive real failures with a checkpoint',async()=>{
  let n=0;
  const api={profile:async()=>profile(3,'1'),message:async()=>{n++;throw new MailServerError('GMAIL_RATE_LIMITED');}};
  const r=await createServerMail(api,await temporary()).bulkFetch({message_ids:['a','b','c','d']});
  assert.equal(r.status,'interrupted');assert.equal(r.last_error,'GMAIL_RATE_LIMITED');
  assert.equal(n,3);assert.equal(r.remaining,2);assert.equal(r.failed.length,3);
});
test('bulk download records mixed outcomes and resumes without repeating done items',async()=>{
  const attachments=[];
  const api={
    profile:async()=>profile(3,'1'),
    message:async id=>id==='big'
      ?{id,payload:{filename:'big.bin',body:{attachmentId:'x',size:MAX_BYTES+1}}}
      :{id,payload:{filename:'f'+id,mimeType:'text/plain',body:{attachmentId:'att'+id,size:5}}},
    attachment:async(mid,attId)=>{attachments.push(mid);return {data:Buffer.from('hello'+mid).toString('base64url'),size:6};}
  };
  const svc=createServerMail(api,await temporary());
  const first=await svc.bulkDownload({items:[{message_id:'a',part_key:'0'},{message_id:'big',part_key:'0'}]});
  assert.equal(first.status,'complete');
  assert.deepEqual(first.failed,[{message_id:'big',part_key:'0',code:'ATTACHMENT_TOO_LARGE'}]);
  assert.equal(first.done.length,1);assert.equal(first.done[0].sha256.length,64);
  const second=await svc.bulkDownload({job_id:first.job_id,items:[{message_id:'b',part_key:'0'}]});
  assert.equal(second.status,'complete');assert.equal(second.done.length,2);
  assert.deepEqual(attachments,['a','b']);
});
