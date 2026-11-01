import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createFetchWithPolicy,PolicyError } from './policy.mjs';

export class MailServerError extends Error {
  constructor(code) { super(code); this.code=code; }
}
const fail=code=>{throw new MailServerError(code);};
export function serverError(error) {
  return error instanceof MailServerError ? error.code : 'SERVER_MAIL_FAILED';
}
// Credentials remain inside the process; they are never tool arguments/results or logs.
async function credentials() {
  try {
    const root=join(homedir(),'.gmail-readonly-mcp');
    const keys=JSON.parse(await readFile(join(root,'gcp-oauth.keys.json'),'utf8'));
    const saved=JSON.parse(await readFile(join(root,'token.json'),'utf8'));
    return {client:keys.installed||keys.web,saved};
  } catch {fail('GMAIL_AUTH_NOT_CONFIGURED');}
}
export async function boundedJSON(response,maxBytes=40*1024*1024) {
  if(Number(response.headers.get('content-length'))>maxBytes) fail('RESPONSE_TOO_LARGE');
  const chunks=[];let total=0;
  for await(const chunk of response.body) {
    total+=chunk.length;
    if(total>maxBytes) fail('RESPONSE_TOO_LARGE');
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch {fail('INVALID_SERVER_RESPONSE');}
}
export function createGmail({loadCredentials=credentials,fetchImpl=fetch,now=Date.now,sleep,rand}={}) {
  // Every outbound request goes through the shared policy layer: paced, timed,
  // retried with bounded backoff. There is no unpaced code path.
  const http=createFetchWithPolicy({fetchImpl,now,sleep,rand});
  let access,expiry=0,refreshing;
  async function token(force=false) {
    if(!force && access && expiry>Date.now()+60000) return access;
    if(refreshing) return refreshing;
    refreshing=(async()=>{
      const {client,saved}=await loadCredentials();
      // Legacy token files may omit scope metadata. Do not infer their grant scope;
      // enforce read-only operations through this adapter's fixed GET-only API.
      if(!force && saved.access_token && saved.expiry_date>Date.now()+60000) {
        access=saved.access_token;expiry=saved.expiry_date;return access;
      }
      if(!saved.refresh_token || !client?.client_id || !client?.client_secret) fail('GMAIL_REAUTH_REQUIRED');
      let response;
      try {
        response=await http.fetchWithPolicy('https://oauth2.googleapis.com/token',{
          method:'POST',redirect:'error',
          headers:{'content-type':'application/x-www-form-urlencoded'},
          body:new URLSearchParams({grant_type:'refresh_token',refresh_token:saved.refresh_token,client_id:client.client_id,client_secret:client.client_secret})
        },{quotaUnits:0,maxAttempts:2,timeoutMs:15000});
      } catch {fail('GMAIL_AUTH_NETWORK_FAILED');}
      if(!response.ok) fail('GMAIL_REAUTH_REQUIRED');
      const data=await boundedJSON(response,64000);
      if(typeof data.access_token!=='string' || !Number.isFinite(data.expires_in)) fail('GMAIL_REAUTH_REQUIRED');
      access=data.access_token;expiry=Date.now()+data.expires_in*1000;
      return access;
    })();
    try {return await refreshing;} finally {refreshing=null;}
  }
  async function get(path,params={},opts={}) {
    // This private GET-only helper is never exposed as a general URL-fetch tool.
    const url=new URL('https://gmail.googleapis.com/gmail/v1/users/me/'+path);
    for(const [k,v] of Object.entries(params)) {
      if(v===undefined || v===null || v==='') continue;
      if(Array.isArray(v)) {for(const item of v) url.searchParams.append(k,String(item));}
      else url.searchParams.set(k,String(v));
    }
    for(let attempt=0;attempt<2;attempt++) {
      const bearer=await token(attempt===1);
      let response;
      try {
        response=await http.fetchWithPolicy(url,{method:'GET',redirect:'error',headers:{Authorization:`Bearer ${bearer}`}},opts);
      } catch(error) {
        if(error instanceof PolicyError) {
          const codes={rate_limited:'GMAIL_RATE_LIMITED',server:'GMAIL_SERVER_ERROR',timeout:'GMAIL_TIMEOUT'};
          fail(codes[error.kind]||'GMAIL_NETWORK_FAILED');
        }
        fail('GMAIL_NETWORK_FAILED');
      }
      if(response.status===401 && attempt===0) continue;
      if(!response.ok) {
        if(opts.inspect_error) await opts.inspect_error(response);
        const codes={401:'GMAIL_REAUTH_REQUIRED',403:'GMAIL_ACCESS_DENIED',404:'GMAIL_NOT_FOUND',429:'GMAIL_RATE_LIMITED'};
        fail(codes[response.status]||'GMAIL_SERVER_ERROR');
      }
      return boundedJSON(response);
    }
  }
  const id=value=>encodeURIComponent(value);
  return {
    profile:()=>get('profile',{},{quotaUnits:1}),
    list:({page_token,query,limit=100}={})=>get('messages',{includeSpamTrash:true,maxResults:limit,pageToken:page_token,q:query},{quotaUnits:5}),
    message:(messageId,o={})=>get('messages/'+id(messageId),{format:o.format||'full',fields:o.fields,metadataHeaders:o.metadataHeaders},{quotaUnits:5}),
    attachment:(messageId,attachmentId)=>get('messages/'+id(messageId)+'/attachments/'+id(attachmentId),{},{quotaUnits:5}),
    history:({start_history_id,page_token,max_results}={})=>get('history',{startHistoryId:start_history_id,pageToken:page_token,maxResults:max_results},{quotaUnits:2,inspect_error:async response=>{
      // Google signals an expired history cursor as 404/410 with a machine
      // reason. Inspect internally only; the body never reaches thrown errors.
      if(response.status!==404 && response.status!==410) return;
      try {
        const body=await boundedJSON(response,65536);
        if(Array.isArray(body?.error?.errors) && body.error.errors.some(e=>e?.reason==='invalidStartHistoryId')) fail('SYNC_HISTORY_EXPIRED');
      } catch(error) {
        if(error instanceof MailServerError && error.code==='SYNC_HISTORY_EXPIRED') throw error;
      }
    }})
  };
}

export function flattenParts(payload) {
  const parts=[];
  function walk(p,key) {
    if(!p) return;
    parts.push({...p,part_key:key});
    (p.parts||[]).forEach((child,i)=>walk(child,key+'.'+i));
  }
  walk(payload,'0');return parts;
}
export function parseMessage(message,maxChars=20000) {
  const parts=flattenParts(message.payload);
  const text=parts.filter(p=>p.mimeType==='text/plain' && !p.filename).map(p=>p.body?.data ? Buffer.from(p.body.data,'base64url').toString('utf8') : '').join('\n');
  const externalText=parts.some(p=>p.mimeType==='text/plain' && !p.filename && p.body?.attachmentId && !p.body?.data);
  return {
    id:message.id,thread_id:message.threadId,label_ids:message.labelIds||[],
    headers:message.payload?.headers||[],body:text.slice(0,maxChars),truncated:text.length>maxChars,
    text_body_external:externalText,plain_text_available:parts.some(p=>p.mimeType==='text/plain' && !p.filename),
    parts:parts.filter(p=>p.filename || p.body?.attachmentId || p.body?.data!==undefined).map(p=>({part_key:p.part_key,name:p.filename||'message-part',mime_type:p.mimeType,size:p.body?.size||0,inline:!p.body?.attachmentId}))
  };
}
