// Explicit live acceptance: API reads, inventory IDs and one local attachment.
// Never log email bodies, attachments, auth values or raw HTTP errors.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { dependency } from '../runtime.mjs';
const {Client}=await dependency('@modelcontextprotocol/sdk/client/index.js');
const {StdioClientTransport}=await dependency('@modelcontextprotocol/sdk/client/stdio.js');
const client=new Client({name:'server-mail-acceptance',version:'0.3.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../server.mjs',import.meta.url))],stderr:'pipe'});
async function call(name,args={}) {
  const result=await client.callTool({name,arguments:args},undefined,{timeout:60000});
  assert.ok(!result.isError,result.content[0]?.text);
  return JSON.parse(result.content[0].text);
}
try {
  await client.connect(transport);
  const tools=(await client.listTools()).tools;
  assert.equal(tools.length,16);
  assert.ok(tools.every(t=>!/(send|delete|move|mark|execute)/.test(t.name)));
  const status=await call('server_mail_status');
  const first=await call('server_list_messages',{limit:3});
  assert.equal(first.include_spam_trash,true);assert.ok(first.messages.length);
  if(first.next_page_token) {
    const next=await call('server_list_messages',{page_token:first.next_page_token,limit:3});
    assert.ok(!first.messages.some(m=>next.messages.some(n=>m.id===n.id)));
  }
  let readCount=0,exported=0,imageRef=null;
  for(const m of first.messages) {
    const read=await call('server_read_message',{message_id:m.id,max_chars:100});
    assert.ok(read.body.length<=100);readCount++;
    const image=read.parts.find(p=>p.mime_type?.startsWith('image/') && p.size>0 && p.size<1024*1024);
    if(image && !exported) {
      const saved=await call('server_download_attachment',{message_id:m.id,part_key:image.part_key});
      assert.ok(saved.bytes>0);assert.equal(saved.sha256.length,64);exported++;
      imageRef={message_id:m.id,part_key:image.part_key};
    }
    const after=await call('server_read_message',{message_id:m.id,max_chars:1});
    assert.equal(read.label_ids.includes('UNREAD'),after.label_ids.includes('UNREAD'));
  }
  let scan=await call('server_scan_mailbox',{max_pages:5});
  console.log(JSON.stringify({scan_status:scan.status,enumerated:scan.unique_message_ids,pages:scan.pages}));
  for(let round=0;scan.status==='scanning' && round<30;round++) {
    scan=await call('server_scan_mailbox',{scan_id:scan.scan_id,max_pages:5});
    console.log(JSON.stringify({scan_status:scan.status,enumerated:scan.unique_message_ids,pages:scan.pages}));
  }
  const syncFirst=await call('server_sync_mailbox',{});
  assert.ok(['initial_baseline','changed','up_to_date'].includes(syncFirst.status));
  const syncSecond=await call('server_sync_mailbox',{max_pages:1});
  assert.ok(['changed','up_to_date'].includes(syncSecond.status));
  const bulk=await call('server_bulk_fetch_messages',{message_ids:first.messages.map(m=>m.id).slice(0,3)});
  assert.equal(bulk.status,'complete');
  assert.equal(bulk.done_count,Math.min(3,first.messages.length));
  assert.ok(bulk.messages.every(m=>typeof m.id==='string'));
  let bulkDownloaded=0;
  if(imageRef) {
    const bulkDl=await call('server_bulk_download_attachments',{items:[imageRef]});
    assert.equal(bulkDl.status,'complete');assert.equal(bulkDl.done.length,1);
    assert.equal(bulkDl.done[0].sha256.length,64);bulkDownloaded=1;
  }
  // Hotmail/Exchange travels only through the paced Apple Mail bridge.
  let hotmail={tested:0};
  const accounts=await call('list_accounts');
  const exchange=accounts.accounts.find(a=>a.name==='Exchange');
  if(exchange) {
    const boxes=await call('list_mailboxes',{account_id:exchange.id,limit:50});
    const inbox=boxes.mailboxes.find(b=>/^inbox$/i.test(b.name));
    if(inbox) {
      const msgs=await call('list_messages',{account_id:exchange.id,mailbox_path:[inbox.name],limit:3});
      if(msgs.messages.length) {
        const hot=await call('bulk_read_messages',{account_id:exchange.id,mailbox_path:[inbox.name],message_ids:[msgs.messages[0].id],max_chars:100});
        assert.ok(hot.messages.length+hot.failed.length===1);
        hotmail={tested:1,mailboxes:boxes.total,sample_messages:msgs.messages.length,bulk_read_ok:hot.messages.length};
      }
    }
  }
  const report={tested_at:new Date().toISOString(),protocol:'PASS',tools:tools.length,account:status.account,reported_server_messages:status.server_messages,server_bodies_read:readCount,read_status_preserved:readCount,remote_attachment_exports:exported,inventory:scan,sync:{baseline_status:syncFirst.status,delta_status:syncSecond.status,added:syncSecond.added_count,changed:syncSecond.changed_count,deleted:syncSecond.deleted_count},bulk_fetch:{status:bulk.status,done:bulk.done_count,failed:bulk.failed.length},bulk_attachment_exports:bulkDownloaded,hotmail_bridge:hotmail,other_accounts:'NOT_CONNECTED_BY_GMAIL_ADAPTER',desktop_activation:'NOT_TESTED'};
  await writeFile(new URL('../SERVER_VERIFICATION.json',import.meta.url),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify(report));
  assert.ok(scan.exhausted,'inventory did not finish');
} finally {await client.close();}
