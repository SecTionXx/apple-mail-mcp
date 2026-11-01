// Runs against real Mail, prints only counts/status, never email contents.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dependency } from '../runtime.mjs';
const {Client}=await dependency('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=await dependency('@modelcontextprotocol/sdk/client/stdio.js');
const client=new Client({name:'apple-mail-acceptance',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../server.mjs',import.meta.url))],stderr:'pipe'});
async function call(name,args={}) {
  const r=await client.callTool({name,arguments:args});
  assert.ok(!r.isError, r.content[0]?.text);
  return JSON.parse(r.content[0].text);
}
try {
  await client.connect(transport);
  const tools=(await client.listTools()).tools;
  assert.equal(tools.length,16);
  assert.ok(tools.every(t=>!/(send|delete|move|mark|execute)/.test(t.name)));
  assert.equal(tools.find(t=>t.name==='download_attachment').annotations.readOnlyHint,false);
  const invalid=await client.callTool({name:'list_messages',arguments:{account_id:'x',mailbox_path:['INBOX'],limit:999}});
  assert.ok(invalid.isError);
  const accounts=(await call('list_accounts')).accounts;
  assert.ok(accounts.length>0);
  let boxCount=0,readCount=0,attachmentCount=0,exportCount=0,unreadChecked=0,exercised=0;
  const skipped=[];
  for(const account of accounts.filter(a=>a.enabled)) {
    const first=await call('list_mailboxes',{account_id:account.id,limit:2});
    boxCount+=first.total;
    if(first.next_offset!==null) {
      const next=await call('list_mailboxes',{account_id:account.id,offset:first.next_offset,limit:2});
      assert.notEqual(first.mailboxes[0].name,next.mailboxes[0].name);
    }
    const folders=await call('list_mailboxes',{account_id:account.id,limit:50});
    const inbox=folders.mailboxes.find(x=>x.name==='INBOX'||x.name==='Inbox');
    if(!inbox) {skipped.push({account:account.name,reason:'NO_INBOX'});continue;}
    const base={account_id:account.id,mailbox_path:inbox.path};
    let page;
    try { page=await call('list_messages',{...base,limit:5}); }
    catch { skipped.push({account:account.name,reason:'INBOX_LIST_FAILED'});continue; }
    // An empty or stalled account is reported, not a protocol failure.
    if(!page.messages.length) {skipped.push({account:account.name,reason:'EMPTY_INBOX'});continue;}
    // since=วันที่ไกลมาก ต้องได้ผลเหมือนหน้าปกติ (plumbing ของ since ทำงาน)
    const sinceTry=await call('list_messages',{...base,limit:5,since:'2000-01-01T00:00:00.000Z'});
    assert.equal(sinceTry.since_stop,null);
    assert.deepEqual(sinceTry.messages.map(m=>m.id),page.messages.map(m=>m.id));
    if(page.next_offset!==null) {
      const next=await call('list_messages',{...base,offset:page.next_offset,limit:1});
      assert.ok(!page.messages.some(m=>m.id===next.messages[0]?.id));
    }
    const match=await call('search_messages',{...base,limit:5,query:page.messages[0].subject.slice(0,20)||page.messages[0].sender.slice(0,20)});
    assert.ok(match.messages.some(m=>m.id===page.messages[0].id));
    const target=page.messages.find(m=>!m.read)||page.messages[0];
    const read=await call('read_message',{...base,message_id:target.id,max_chars:80});
    assert.ok(read.body.length<=80);
    assert.equal(read.read_status_before,read.read_status_after);
    if(!read.read_status_before) unreadChecked++;
    readCount++;exercised++;
    for(const m of page.messages) {
      const items=(await call('list_attachments',{...base,message_id:m.id})).attachments;
      attachmentCount+=items.length;
      const candidate=items.find(a=>a.downloaded && a.size>0 && a.size<1024*1024 && ((a.mime_type||'').startsWith('image/') || /\.(png|jpe?g|gif)$/i.test(a.name)));
      if(candidate && !exportCount) {
        const saved=await call('download_attachment',{...base,message_id:m.id,attachment_index:candidate.index});
        assert.ok(saved.bytes>0);assert.equal(saved.sha256.length,64);exportCount++;
      }
    }
  }
  assert.ok(exercised>0,'no account was fully exercised');
  console.log(JSON.stringify({protocol:'PASS',tools:tools.length,accounts:accounts.length,root_mailboxes:boxCount,exercised_accounts:exercised,skipped,message_bodies_checked:readCount,unread_preserved_checks:unreadChecked,attachments_listed:attachmentCount,exports_verified:exportCount,remote_completeness:'UNVERIFIED'}));
} finally {await client.close();}
