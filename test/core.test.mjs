import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, lstat, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { makeService, safeName, publicError, bulkRead, MAX_BYTES } from '../core.mjs';

test('filenames cannot traverse folders; Unicode preserved',()=>{
  assert.equal(safeName('../../report.pdf'),'_.._report.pdf');
  assert.equal(safeName('แบบ.pdf'),'แบบ.pdf');
  assert.equal(safeName('...'),'attachment.bin');
  assert.ok(!safeName('a\u0000b\\c/d').includes('/'));
  assert.ok(Buffer.byteLength(safeName('ก'.repeat(200)))<=180);
});
test('error output never includes message bodies or raw command arguments',()=>{
  assert.match(publicError(new Error('private content')),/^MAIL_READ_FAILED/);
  assert.equal(publicError({stderr:'Mail error -1743'}),'AUTOMATION_PERMISSION_REQUIRED');
  assert.match(publicError({killed:true}),/^MAIL_TIMEOUT/);
});
test('export uses unique private directories and verifies bytes',async()=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'mail-mcp-test-')));
  const bridge=async p=>{
    if(p.action==='attachments') return {attachments:[{id:'a',name:'../../sample.txt',downloaded:true,size:5}]};
    assert.equal(p.expected_attachment_id,'a');
    assert.ok(dirname(p.destination).startsWith(root+'/attachment-'));
    await writeFile(p.destination,'hello');
    return {saved:true};
  };
  const service=makeService(bridge,root);
  const a=await service('export',{attachment_index:0});
  const b=await service('export',{attachment_index:0});
  assert.notEqual(a.path,b.path);
  assert.equal(await readFile(a.path,'utf8'),'hello');
  assert.equal(a.sha256,'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal((await lstat(a.path)).mode & 0o777,0o600);
});
test('uncached, oversized and invalid attachments cannot reach save',async()=>{
  for(const [attachments,index,expected] of [
    [[{downloaded:false,size:1}],0,'ATTACHMENT_NOT_DOWNLOADED'],
    [[{downloaded:true,size:MAX_BYTES+1}],0,'ATTACHMENT_TOO_LARGE'],
    [[],0,'ATTACHMENT_NOT_FOUND']
  ]) {
    let calls=0;
    const service=makeService(async()=>{calls++;return {attachments};});
    await assert.rejects(service('export',{attachment_index:index}),new RegExp(expected));
    assert.equal(calls,1);
  }
});
test('bridge calls are serialized and queue recovers after failure',async()=>{
  let active=0,max=0;
  const service=makeService(async p=>{
    active++;max=Math.max(max,active);
    await new Promise(r=>setTimeout(r,5));active--;
    if(p.action==='bad') throw Error('expected');
    return p.action;
  });
  const r=await Promise.allSettled([service('bad'),service('accounts'),service('mailboxes')]);
  assert.equal(max,1);assert.equal(r[1].value,'accounts');assert.equal(r[2].value,'mailboxes');
});
test('queue depth is bounded: excess calls reject with MAIL_BUSY without queueing',async()=>{
  let release;const gate=new Promise(r=>release=r);
  const calls=[];
  const bridge=async p=>{calls.push(p.action);return p.action==='hang'?gate:p.action;};
  const service=makeService(bridge,undefined,{now:()=>1000,delay:async()=>{},maxPending:1,minIntervalMs:1});
  const hanging=service('hang');
  await assert.rejects(service('accounts'),/MAIL_BUSY/);
  assert.deepEqual(calls,['hang']);
  release('done');
  assert.equal(await hanging,'done');
  assert.equal(await service('accounts'),'accounts');
});
test('pacing enforces a minimum interval between bridge launches',async()=>{
  const waits=[];
  const service=makeService(async p=>p.action,undefined,{now:()=>1000,delay:async ms=>{waits.push(ms);},minIntervalMs:250,cooldownMs:5000});
  await service('accounts');
  await service('mailboxes');
  assert.ok(waits.length>=1&&waits[0]>=250);
});
test('after a timeout the next bridge call waits out the cooldown',async()=>{
  const waits=[];
  const killed=Object.assign(Error('killed'),{killed:true});
  const service=makeService(async()=>{throw killed;},undefined,{now:()=>1000,delay:async ms=>{waits.push(ms);},minIntervalMs:250,cooldownMs:5000});
  await assert.rejects(service('accounts'),e=>e===killed);
  const next=service('accounts');
  await assert.rejects(next,e=>e===killed);
  assert.ok(waits.includes(5000));
  assert.match(publicError(killed),/^MAIL_TIMEOUT/);
});
test('bulkRead reports per-message failures and continues',async()=>{
  const service=makeService(async p=>{
    if(p.message_id===2) throw Error('MESSAGE_NOT_FOUND');
    return {message_id:p.message_id,body:'ok'};
  },undefined,{now:()=>1000,delay:async()=>{},minIntervalMs:1});
  const out=await bulkRead(service,{account_id:'a',mailbox_path:['INBOX'],message_ids:[1,2,3],max_chars:100});
  assert.deepEqual(out.messages.map(m=>m.message_id),[1,3]);
  assert.deepEqual(out.failed,[{message_id:2,code:'MESSAGE_NOT_FOUND'}]);
});
