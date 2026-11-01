import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, chmod, lstat, readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const exec = promisify(execFile);
const script=fileURLToPath(new URL('./mail-bridge.js',import.meta.url));
export const MAX_BYTES=25*1024*1024;
export function safeName(name) {
  let cleaned=String(name).normalize('NFC').replace(/[\x00-\x1f\x7f/\\:]/g,'_').replace(/^\.+/,'');
  while(Buffer.byteLength(cleaned,'utf8')>180) cleaned=Array.from(cleaned).slice(0,-1).join('');
  return cleaned || 'attachment.bin';
}
export function publicError(error) {
  const text=String(error?.stderr || error?.message || '');
  for(const code of ['MAIL_BUSY','ACCOUNT_NOT_FOUND','MAILBOX_NOT_FOUND','MESSAGE_NOT_FOUND','ATTACHMENT_NOT_FOUND','ATTACHMENT_CHANGED','ATTACHMENT_NOT_DOWNLOADED','ATTACHMENT_TOO_LARGE','EXPORT_UNVERIFIED']) if(text.includes(code)) return code;
  if(text.includes('-1743')) return 'AUTOMATION_PERMISSION_REQUIRED';
  if(error?.killed || error?.code==='ETIMEDOUT') return 'MAIL_TIMEOUT: Mail may still be processing; no automatic retry.';
  return 'MAIL_READ_FAILED: Check Mail availability and macOS Automation permission.';
}
export async function runBridge(payload) {
  const {stdout}=await exec('/usr/bin/osascript',['-l','JavaScript',script,JSON.stringify(payload)],{timeout:20000,killSignal:'SIGKILL',maxBuffer:8*1024*1024,encoding:'utf8'});
  return JSON.parse(stdout);
}
const envInt=(name,def)=>{const v=Number(process.env[name]);return Number.isFinite(v)&&v>0?Math.floor(v):def;};
// Pacing protects Mail.app from bulk callers: a bounded queue, a minimum gap
// between osascript launches, and a cooldown after timeouts (the killed Apple
// Event may still be processing inside Mail). This is pacing only — never retry.
export function makeService(bridge=runBridge, downloadRoot=fileURLToPath(new URL('./downloads',import.meta.url)), options={}) {
  const pace={
    now:options.now??Date.now,
    delay:options.delay??((ms)=>new Promise(resolve=>setTimeout(resolve,ms))),
    maxPending:envInt('MAIL_MCP_MAX_PENDING',options.maxPending??8),
    minIntervalMs:envInt('MAIL_MCP_MIN_INTERVAL_MS',options.minIntervalMs??250),
    cooldownMs:envInt('MAIL_MCP_COOLDOWN_MS',options.cooldownMs??5000)
  };
  let queue=Promise.resolve(),pending=0,nextSlotAt=0,lastTimeoutAt=null;
  async function perform(action,args) {
    if(lastTimeoutAt!==null) {
      const wait=lastTimeoutAt+pace.cooldownMs-pace.now();
      lastTimeoutAt=null;
      if(wait>0) await pace.delay(wait);
    }
    const gap=nextSlotAt-pace.now();
    if(gap>0) await pace.delay(gap);
    nextSlotAt=pace.now()+pace.minIntervalMs;
    try {
      return await run(action,args);
    } catch(error) {
      if(error?.killed||error?.code==='ETIMEDOUT') lastTimeoutAt=pace.now();
      throw error;
    }
  }
  async function run(action,args) {
    if(action!=='export') return bridge({...args,action});
    const listing=await bridge({...args,action:'attachments'});
    const a=listing.attachments[args.attachment_index];
    if(!a) throw Error('ATTACHMENT_NOT_FOUND');
    if(!a.downloaded) throw Error('ATTACHMENT_NOT_DOWNLOADED');
    if(a.size>MAX_BYTES) throw Error('ATTACHMENT_TOO_LARGE');
    await mkdir(downloadRoot,{recursive:true,mode:0o700});
    const root=await realpath(downloadRoot);
    if(root!==resolve(downloadRoot)) throw Error('EXPORT_UNVERIFIED');
    const dir=await mkdtemp(join(root,'attachment-'));
    await chmod(dir,0o700);
    const destination=join(dir,safeName(a.name));
    await bridge({...args,action:'export',expected_attachment_id:a.id,destination,max_bytes:MAX_BYTES});
    const st=await lstat(destination);
    if(!st.isFile() || st.isSymbolicLink() || st.size>MAX_BYTES || (a.size>0 && st.size===0)) throw Error('EXPORT_UNVERIFIED');
    await chmod(destination,0o600);
    const sha256=createHash('sha256').update(await readFile(destination)).digest('hex');
    return {path:destination,bytes:st.size,sha256,original_name:a.name};
  }
  return (action,args={})=>{
    if(pending>=pace.maxPending) return Promise.reject(Error('MAIL_BUSY'));
    pending++;
    const task=queue.then(()=>perform(action,args));
    queue=task.catch(()=>{});
    task.then(()=>{pending--;},()=>{pending--;});
    return task;
  };
}
// Bulk body reads for accounts without a server API (e.g. Hotmail): each read
// is its own paced bridge call, failures are reported per message and skipped.
export async function bulkRead(service,{account_id,mailbox_path,message_ids,max_chars}) {
  const messages=[],failed=[];
  for(const message_id of message_ids) {
    try {messages.push(await service('read',{account_id,mailbox_path,message_id,max_chars}));}
    catch(error) {failed.push({message_id,code:publicError(error).split(':')[0]});}
  }
  return {messages,failed};
}
