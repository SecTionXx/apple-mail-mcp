import { mkdir, mkdtemp, readFile, writeFile, rename, realpath, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID,createHash } from 'node:crypto';
import { createGmail, MailServerError, flattenParts, parseMessage, serverError } from './gmail.mjs';
import { safeName,MAX_BYTES } from './core.mjs';

// Atomic 0600 state files shared by scan/sync/bulk jobs.
async function saveState(dir,file,state) {
  const tmp=join(dir,file+'.'+randomUUID()+'.tmp');
  await writeFile(tmp,JSON.stringify(state),{mode:0o600,flag:'wx'});
  await rename(tmp,join(dir,file));
}
async function loadState(dir,file) {
  try {return JSON.parse(await readFile(join(dir,file),'utf8'));}
  catch {return null;}
}
const CAP=10000;
const JOB_ID=/^[0-9a-f-]{36}$/;
const METADATA_FIELDS='id,threadId,labelIds,snippet,internalDate,payload/headers';
function metaRow(m) {
  const headers=Object.fromEntries((m.payload?.headers||[]).map(h=>[String(h.name||'').toLowerCase(),h.value]));
  return {id:m.id,thread_id:m.threadId,labels:m.labelIds||[],snippet:m.snippet??null,internal_date:m.internalDate??null,subject:headers.subject??null,from:headers.from??null,date:headers.date??null};
}
export function createServerMail(api=createGmail(),root=fileURLToPath(new URL('./server-data',import.meta.url))) {
  let scanQueue=Promise.resolve();
  async function privateRoot() {
    await mkdir(root,{recursive:true,mode:0o700});
    await chmod(root,0o700);
    return realpath(root);
  }
  async function status() {
    const p=await api.profile();
    return {provider:'gmail',account:p.emailAddress,server_messages:p.messagesTotal,server_threads:p.threadsTotal,history_id:p.historyId,coverage:'all_current_messages_in_this_authorized_gmail_mailbox_including_spam_trash',other_accounts:'not_connected_by_this_adapter',inventory_verified:false};
  }
  async function list(args) {
    const p=await api.list(args);
    return {provider:'gmail',messages:p.messages||[],next_page_token:p.nextPageToken||null,result_size_estimate:p.resultSizeEstimate,exhausted:!p.nextPageToken,include_spam_trash:true,query:args.query||null};
  }
  async function read(args) {
    const m=await api.message(args.message_id);
    // Gmail may store large plain text bodies in the attachment endpoint.
    const parts=flattenParts(m.payload);
    const external=parts.filter(p=>p.mimeType==='text/plain' && !p.filename && p.body?.attachmentId && !p.body?.data);
    let hydratedBytes=0;
    const hydrate=new Map();
    for(const p of external.slice(0,4)) {
      if((p.body.size||0)+hydratedBytes>MAX_BYTES) continue;
      const body=await api.attachment(m.id,p.body.attachmentId);
      if(Buffer.byteLength(body.data||'','base64url')+hydratedBytes>MAX_BYTES) throw new MailServerError('ATTACHMENT_TOO_LARGE');
      hydrate.set(p.part_key,body.data);hydratedBytes+=Buffer.byteLength(body.data||'','base64url');
    }
    function apply(p,key='0') {
      if(hydrate.has(key)) p.body={...p.body,data:hydrate.get(key)};
      (p.parts||[]).forEach((child,i)=>apply(child,key+'.'+i));
    }
    if(m.payload) apply(m.payload);
    return {provider:'gmail',...parseMessage(m,args.max_chars)};
  }
  async function download(args) {
    const m=await api.message(args.message_id);
    const part=flattenParts(m.payload).find(p=>p.part_key===args.part_key);
    if(!part?.body || (!part.body.attachmentId && part.body.data===undefined)) throw new MailServerError('ATTACHMENT_NOT_FOUND');
    if(part.body.size>MAX_BYTES) throw new MailServerError('ATTACHMENT_TOO_LARGE');
    const b=part.body.attachmentId ? await api.attachment(m.id,part.body.attachmentId) : part.body;
    if(typeof b.data!=='string') throw new MailServerError('ATTACHMENT_DATA_MISSING');
    const bytes=Buffer.from(b.data,'base64url');
    if(bytes.length>MAX_BYTES) throw new MailServerError('ATTACHMENT_TOO_LARGE');
    if(Number.isFinite(b.size) && b.size!==bytes.length) throw new MailServerError('ATTACHMENT_SIZE_MISMATCH');
    const dir=await mkdtemp(join(await privateRoot(),'download-'));
    const path=join(dir,safeName(part.filename||'message-part.txt'));
    await writeFile(path,bytes,{mode:0o600,flag:'wx'});
    return {provider:'gmail',path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),source:'gmail_server_api'};
  }
  async function scan({scan_id,max_pages=5}) {
    const dir=await privateRoot();
    let s;
    if(scan_id) {
      if(!/^[0-9a-f-]{36}$/.test(scan_id)) throw new MailServerError('INVALID_SCAN_ID');
      try {s=JSON.parse(await readFile(join(dir,scan_id+'.json'),'utf8'));}
      catch {throw new MailServerError('SCAN_NOT_FOUND');}
      const current=await api.profile();
      if(current.emailAddress!==s.before.emailAddress) throw new MailServerError('SCAN_ACCOUNT_CHANGED');
    } else {
      s={scan_id:randomUUID(),before:await api.profile(),ids:[],pages:0,next_page_token:null,exhausted:false,status:'scanning',started_at:new Date().toISOString()};
    }
    s.status=s.exhausted?s.status:'scanning';
    delete s.last_error;
    const checkpoint=()=>saveState(dir,s.scan_id+'.json',s);
    await checkpoint();
    const deadline=Date.now()+20000;
    const seen=new Set(s.ids);
    const tokens=new Set();
    try {
    for(let n=0;n<max_pages && !s.exhausted && Date.now()<deadline;n++) {
      const page=await api.list({page_token:s.next_page_token,limit:500});
      for(const m of page.messages||[]) seen.add(m.id);
      s.pages++;
      const next=page.nextPageToken||null;
      if(next && (next===s.next_page_token || tokens.has(next))) throw new MailServerError('PAGINATION_STALLED');
      if(next) tokens.add(next);
      s.next_page_token=next;s.exhausted=!next;s.ids=[...seen];
      // Atomic checkpoint after each successfully enumerated page.
      await checkpoint();
    }
    if(s.exhausted) {
      s.after=await api.profile();
      if(s.after.emailAddress!==s.before.emailAddress) throw new MailServerError('SCAN_ACCOUNT_CHANGED');
      s.status=s.before.historyId!==s.after.historyId ? 'changed_during_scan' : (s.ids.length===s.after.messagesTotal && s.ids.length===s.before.messagesTotal ? 'verified_message_inventory' : 'count_mismatch');
      s.finished_at=new Date().toISOString();
      await checkpoint();
    }
    } catch(error) {
      s.status='interrupted';s.last_error=serverError(error);await checkpoint();
    }
    return {scan_id:s.scan_id,account:s.before.emailAddress,status:s.status,last_error:s.last_error,unique_message_ids:s.ids.length,pages:s.pages,expected_before:s.before.messagesTotal,expected_after:s.after?.messagesTotal,exhausted:s.exhausted,include_spam_trash:true,manifest_path:join(dir,s.scan_id+'.json'),note:'Inventory of IDs only, not a full content or attachment backup. API-visible current messages only; excludes permanently deleted and admin-only retention archives.'};
  }
  // Incremental sync via the History API. The stored cursor advances only
  // after pagination is fully consumed; a partial run stays resumable.
  async function sync({max_pages=5,hydrate_metadata=false,max_hydrate=10}={}) {
    const dir=await privateRoot();
    const current=await api.profile();
    let st=await loadState(dir,'sync.json');
    if(st&&st.account!==current.emailAddress) throw new MailServerError('SYNC_ACCOUNT_CHANGED');
    if(!st||!st.last_history_id) {
      st={version:1,account:current.emailAddress,last_history_id:String(current.historyId),updated_at:new Date().toISOString(),run:null,last_report:null};
      await saveState(dir,'sync.json',st);
      return {provider:'gmail',account:st.account,status:'initial_baseline',last_history_id:st.last_history_id,new_history_id:null,resumed:false,pages:0,added_count:0,changed_count:0,deleted_count:0,added:[],changed:[],deleted:[],counts_truncated:false,hydrated:[],next_action:'Baseline cursor stored. Pair with server_scan_mailbox for a full ID inventory; later sync calls return deltas.'};
    }
    const previousCursor=st.last_history_id;
    const resumed=Boolean(st.run);
    const run=st.run||{start_history_id:st.last_history_id,page_token:null,pages:0,added:[],changed:[],deleted:[]};
    const sets={added:new Set(run.added),changed:new Set(run.changed),deleted:new Set(run.deleted)};
    const persist=async()=>{
      run.added=[...sets.added];run.changed=[...sets.changed];run.deleted=[...sets.deleted];
      await saveState(dir,'sync.json',{...st,run,updated_at:new Date().toISOString()});
    };
    const deadline=Date.now()+20000;
    let newHistoryId=null,status='running',lastError=null;
    try {
      let exhausted=false;
      for(let n=0;n<max_pages&&!exhausted&&Date.now()<deadline;n++) {
        const page=await api.history({start_history_id:run.start_history_id,page_token:run.page_token,max_results:500});
        for(const record of page.history||[]) {
          const deleted=(record.messagesDeleted||[]).map(x=>x?.message?.id).filter(Boolean);
          const added=(record.messagesAdded||[]).map(x=>x?.message?.id).filter(Boolean);
          for(const id of deleted) {sets.deleted.add(id);sets.added.delete(id);sets.changed.delete(id);}
          for(const id of added) {sets.added.add(id);sets.deleted.delete(id);sets.changed.delete(id);}
          for(const m of record.messages||[]) {
            if(m?.id&&!added.includes(m.id)&&!deleted.includes(m.id)&&!sets.added.has(m.id)&&!sets.deleted.has(m.id)) sets.changed.add(m.id);
          }
        }
        run.pages++;
        run.page_token=page.nextPageToken||null;
        if(!run.page_token) {exhausted=true;newHistoryId=String(page.historyId||run.start_history_id);}
        else await persist();
      }
      if(!newHistoryId) await persist();
    } catch(error) {
      if(error instanceof MailServerError&&error.code==='SYNC_HISTORY_EXPIRED') {
        return {provider:'gmail',account:st.account,status:'history_expired',last_history_id:st.last_history_id,new_history_id:null,resumed,pages:run.pages,added_count:0,changed_count:0,deleted_count:0,added:[],changed:[],deleted:[],counts_truncated:false,hydrated:[],next_action:'Gmail no longer retains history from the stored cursor. Run server_scan_mailbox to rebuild the ID inventory, then server_sync_mailbox to store a fresh cursor.'};
      }
      status='interrupted';lastError=serverError(error);
      await persist();
    }
    const snap={added:[...sets.added],changed:[...sets.changed],deleted:[...sets.deleted]};
    if(newHistoryId===null) {
      return {provider:'gmail',account:st.account,status,last_error:lastError,resumed,pages:run.pages,last_history_id:st.last_history_id,new_history_id:null,
        added_count:snap.added.length,changed_count:snap.changed.length,deleted_count:snap.deleted.length,
        added:snap.added.slice(0,CAP),changed:snap.changed.slice(0,CAP),deleted:snap.deleted.slice(0,CAP),
        counts_truncated:snap.added.length>CAP||snap.changed.length>CAP||snap.deleted.length>CAP,hydrated:[],
        next_action:'Call server_sync_mailbox again with the same arguments to resume; the cursor only advances after enumeration completes.'};
    }
    status=snap.added.length||snap.changed.length||snap.deleted.length?'changed':'up_to_date';
    await saveState(dir,'sync.json',{...st,last_history_id:newHistoryId,run:null,updated_at:new Date().toISOString(),
      last_report:{added_count:snap.added.length,changed_count:snap.changed.length,deleted_count:snap.deleted.length,finished_at:new Date().toISOString()}});
    const hydrated=[];
    if(hydrate_metadata) {
      for(const id of snap.added.slice(0,max_hydrate)) {
        if(Date.now()>=deadline) break;
        try {hydrated.push(metaRow(await api.message(id,{format:'metadata',fields:METADATA_FIELDS})));}
        catch(error) {hydrated.push({id,metadata_error:serverError(error)});}
      }
    }
    return {provider:'gmail',account:st.account,status,resumed,pages:run.pages,last_history_id:previousCursor,new_history_id:newHistoryId,
      added_count:snap.added.length,changed_count:snap.changed.length,deleted_count:snap.deleted.length,
      added:snap.added.slice(0,CAP),changed:snap.changed.slice(0,CAP),deleted:snap.deleted.slice(0,CAP),
      counts_truncated:snap.added.length>CAP||snap.changed.length>CAP||snap.deleted.length>CAP,hydrated,
      next_action:null};
  }
  async function loadOrCreateJob(dir,current,{job_id,kind,seed,message_ids,items}) {
    if(job_id) {
      if(!JOB_ID.test(job_id)) throw new MailServerError('INVALID_JOB_ID');
      const job=await loadState(dir,'bulk-'+job_id+'.json');
      if(!job) throw new MailServerError('JOB_NOT_FOUND');
      if(job.kind!==kind) throw new MailServerError('JOB_KIND_MISMATCH');
      if(job.account!==current.emailAddress) throw new MailServerError('JOB_ACCOUNT_CHANGED');
      return job;
    }
    return seed();
  }
  // Bulk metadata/content fetch in short resumable calls. State files keep IDs
  // and status codes only — never message bodies or attachments.
  async function bulkFetch({message_ids,job_id,format='metadata',max_chars=1000}={}) {
    const dir=await privateRoot();
    const current=await api.profile();
    const job=await loadOrCreateJob(dir,current,{job_id,kind:'fetch',seed:()=>{
      const ids=[...new Set(message_ids||[])];
      if(!ids.length) throw new MailServerError('NO_MESSAGE_IDS');
      return {version:1,job_id:randomUUID(),kind:'fetch',account:current.emailAddress,mode:format,created_at:new Date().toISOString(),pending:ids,done:[],failed:[],status:'running'};
    }});
    if(Array.isArray(message_ids)) {
      const known=new Set([...job.done,...job.failed.map(f=>f.id),...job.pending]);
      for(const id of message_ids) if(!known.has(id)) job.pending.push(id);
    }
    const deadline=Date.now()+20000;
    const rows=[];let consecutive=0;
    while(job.pending.length&&Date.now()<deadline) {
      const id=job.pending[0];
      try {
        const m=await api.message(id,job.mode==='full'?{format:'full'}:{format:'metadata',fields:METADATA_FIELDS});
        rows.push(job.mode==='full'?parseMessage(m,max_chars):metaRow(m));
        job.done.push(id);consecutive=0;
      } catch(error) {
        const code=serverError(error);
        job.failed.push({id,code});
        if(code!=='GMAIL_NOT_FOUND'&&code!=='ATTACHMENT_NOT_FOUND'&&++consecutive>=3) {job.status='interrupted';job.last_error=code;break;}
      }
      job.pending=job.pending.slice(1);
      if(job.done.length%10===0||!job.pending.length) await saveState(dir,'bulk-'+job.job_id+'.json',job);
    }
    if(!job.pending.length) job.status='complete';
    else if(job.status!=='interrupted') job.status='running';
    await saveState(dir,'bulk-'+job.job_id+'.json',job);
    return {job_id:job.job_id,status:job.status,requested:job.done.length+job.failed.length+job.pending.length,done_count:job.done.length,failed:job.failed,remaining:job.pending.length,last_error:job.last_error,messages:rows,next_action:job.status==='complete'?null:'Call again with job_id to continue; already-fetched IDs are skipped.'};
  }
  async function bulkDownload({items,job_id}={}) {
    const dir=await privateRoot();
    const current=await api.profile();
    const job=await loadOrCreateJob(dir,current,{job_id,kind:'download',seed:()=>{
      const seen=new Set();const queue=[];
      for(const item of items||[]) {
        const key=item.message_id+'#'+item.part_key;
        if(!seen.has(key)) {seen.add(key);queue.push({message_id:item.message_id,part_key:item.part_key});}
      }
      if(!queue.length) throw new MailServerError('NO_ITEMS');
      return {version:1,job_id:randomUUID(),kind:'download',account:current.emailAddress,created_at:new Date().toISOString(),pending:queue,done:[],failed:[],status:'running'};
    }});
    if(Array.isArray(items)) {
      const known=new Set(job.done.map(d=>d.message_id+'#'+d.part_key).concat(job.failed.map(f=>f.message_id+'#'+f.part_key),job.pending.map(p=>p.message_id+'#'+p.part_key)));
      for(const item of items) {
        const key=item.message_id+'#'+item.part_key;
        if(!known.has(key)) {known.add(key);job.pending.push({message_id:item.message_id,part_key:item.part_key});}
      }
    }
    const deadline=Date.now()+20000;
    let consecutive=0;
    while(job.pending.length&&Date.now()<deadline) {
      const item=job.pending[0];
      try {
        const saved=await download(item);
        job.done.push({...item,path:saved.path,bytes:saved.bytes,sha256:saved.sha256});
        consecutive=0;
      } catch(error) {
        const code=serverError(error);
        job.failed.push({...item,code});
        if(code!=='GMAIL_NOT_FOUND'&&code!=='ATTACHMENT_NOT_FOUND'&&++consecutive>=3) {job.status='interrupted';job.last_error=code;break;}
      }
      job.pending=job.pending.slice(1);
      await saveState(dir,'bulk-'+job.job_id+'.json',job);
    }
    if(!job.pending.length) job.status='complete';
    else if(job.status!=='interrupted') job.status='running';
    await saveState(dir,'bulk-'+job.job_id+'.json',job);
    return {job_id:job.job_id,status:job.status,requested:job.done.length+job.failed.length+job.pending.length,done_count:job.done.length,done:job.done,failed:job.failed,remaining:job.pending.length,total_bytes:job.done.reduce((sum,d)=>sum+d.bytes,0),last_error:job.last_error,next_action:job.status==='complete'?null:'Call again with job_id to continue; exported items are skipped.'};
  }
  const queued=fn=>args=>{
    const result=scanQueue.then(()=>fn(args));scanQueue=result.catch(()=>{});return result;
  };
  return {status,list,read,download,scan:queued(scan),sync:queued(sync),bulkFetch:queued(bulkFetch),bulkDownload:queued(bulkDownload)};
}
