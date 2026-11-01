import test from 'node:test';
import assert from 'node:assert/strict';
import { createFetchWithPolicy,PolicyError } from '../policy.mjs';
// Fake clock: sleep advances time so token-bucket refills are deterministic.
function harness(responses,{policy}={}) {
  const sleeps=[];let t=1000;
  const seen=[];
  const fetchImpl=async(url,init)=>{
    seen.push({url,init});
    const r=responses[seen.length-1];
    if(r instanceof Error) throw r;
    return r;
  };
  const api=createFetchWithPolicy({fetchImpl,now:()=>t,sleep:async ms=>{sleeps.push(ms);t+=ms;},rand:()=>0.5,policy});
  return {api,sleeps,seen,clock:()=>t};
}
const ok=()=>new Response('{}',{status:200});
const status=(code,headers)=>new Response('{}',{status:code,headers});
test('429 retries once with backoff+jitter then succeeds',async()=>{
  const h=harness([status(429),ok()]);
  const res=await h.api.fetchWithPolicy('https://x.test/',{},{quotaUnits:5});
  assert.equal(res.status,200);
  assert.equal(h.seen.length,2);
  assert.deepEqual(h.sleeps,[1500]);  // 1000*2^0 + 0.5*1000 jitter
});
test('Retry-After beyond the call budget fails fast without sleeping',async()=>{
  const h=harness([status(429,{'retry-after':'120'})]);
  await assert.rejects(h.api.fetchWithPolicy('https://x.test/'),e=>{
    assert.ok(e instanceof PolicyError);assert.equal(e.kind,'rate_limited');
    assert.equal(e.policy_detail.retry_after_ms,120000);return true;
  });
  assert.deepEqual(h.sleeps,[]);
});
test('persistent 429 gives up after maxAttempts with rate_limited',async()=>{
  const h=harness([status(429),status(429),status(429)]);
  await assert.rejects(h.api.fetchWithPolicy('https://x.test/'),e=>{
    assert.equal(e.kind,'rate_limited');assert.equal(e.policy_detail.attempts,3);return true;
  });
  assert.equal(h.seen.length,3);
});
test('transient 5xx recovers; non-retryable statuses pass through untouched',async()=>{
  const h=harness([status(503),status(503),ok()]);
  assert.equal((await h.api.fetchWithPolicy('https://x.test/')).status,200);
  assert.deepEqual(h.sleeps,[1500,2500]);
  for(const code of [400,403,404,401]) {
    const single=harness([status(code)]);
    assert.equal((await single.api.fetchWithPolicy('https://x.test/')).status,code);
    assert.deepEqual(single.sleeps,[]);
  }
});
test('network errors retry then surface as network; timeouts never retry',async()=>{
  const h=harness([Error('net'),Error('net'),Error('net')]);
  await assert.rejects(h.api.fetchWithPolicy('https://x.test/'),e=>e.kind==='network');
  assert.equal(h.seen.length,3);
  const timed=harness([Object.assign(Object.create(Error.prototype),{name:'TimeoutError'})]);
  await assert.rejects(timed.api.fetchWithPolicy('https://x.test/'),e=>e.kind==='timeout');
  assert.equal(timed.seen.length,1);
  assert.deepEqual(timed.sleeps,[]);
});
test('token bucket paces requests beyond the burst allowance',async()=>{
  const h=harness(Array.from({length:12},ok),{policy:{unitsPerSecond:40,bucketUnits:50}});
  for(let i=0;i<12;i++) await h.api.fetchWithPolicy('https://x.test/',{},{quotaUnits:5});
  assert.deepEqual(h.sleeps,[125,125]);  // 10 paced calls exhaust 50 units; each next waits 5/40s
});
test('quota-free calls never sleep on the bucket',async()=>{
  const h=harness(Array.from({length:20},ok),{policy:{unitsPerSecond:40,bucketUnits:50}});
  for(let i=0;i<20;i++) await h.api.fetchWithPolicy('https://x.test/',{method:'POST'},{quotaUnits:0});
  assert.deepEqual(h.sleeps,[]);
});
