// Shared request policy for the Gmail adapter: token-bucket pacing, per-attempt
// timeout, and bounded retry with truncated exponential backoff + jitter.
// Retry-After is honored but clipped to the call budget — MCP calls must stay
// short; sustained throttling is absorbed by resumable chunked tools, not by
// long in-call sleeps. Provider-agnostic: no Gmail specifics live here.
const envInt=(name,def)=>{const v=Number(process.env[name]);return Number.isFinite(v)&&v>0?Math.floor(v):def;};
const RETRYABLE=new Set([429,500,502,503,504]);
export class PolicyError extends Error {
  constructor(kind,detail={}) {super(kind);this.kind=kind;this.policy_detail=detail;}
}
function retryAfterMs(value,nowMs) {
  if(value==null) return null;
  const seconds=Number(value);
  if(Number.isFinite(seconds)&&seconds>=0) return seconds*1000;
  const at=Date.parse(value);
  return Number.isNaN(at)?null:Math.max(0,at-nowMs);
}
export function createFetchWithPolicy({fetchImpl=fetch,now=Date.now,sleep,rand=Math.random,policy={}}={}) {
  const p={
    timeoutMs:envInt('GMAIL_TIMEOUT_MS',policy.timeoutMs??20000),
    maxAttempts:envInt('GMAIL_MAX_ATTEMPTS',policy.maxAttempts??3),
    backoffBaseMs:policy.backoffBaseMs??1000,
    backoffCapMs:policy.backoffCapMs??8000,
    jitterMs:policy.jitterMs??1000,
    unitsPerSecond:envInt('GMAIL_UNITS_PER_SECOND',policy.unitsPerSecond??40),
    bucketUnits:policy.bucketUnits??50
  };
  const rest=sleep??((ms)=>new Promise(resolve=>setTimeout(resolve,ms)));
  let bucket=p.bucketUnits,lastRefill=now();
  async function take(units) {
    for(;;) {
      const t=now();
      bucket=Math.min(p.bucketUnits,bucket+(t-lastRefill)/1000*p.unitsPerSecond);
      lastRefill=t;
      if(bucket>=units) {bucket-=units;return;}
      await rest(Math.ceil((units-bucket)/p.unitsPerSecond*1000));
    }
  }
  async function pause(attempt,retryAfter,started,budgetMs) {
    let ms=Math.min(p.backoffCapMs,p.backoffBaseMs*2**(attempt-1))+rand()*p.jitterMs;
    const honored=retryAfterMs(retryAfter,now());
    if(honored!=null&&honored>ms) ms=honored;
    if(ms>budgetMs-(now()-started)) {
      throw new PolicyError('rate_limited',{attempts:attempt,retry_after_ms:Math.round(honored??ms)});
    }
    await rest(ms);
  }
  async function fetchWithPolicy(url,init={},opts={}) {
    const quotaUnits=opts.quotaUnits??5;
    const maxAttempts=opts.maxAttempts??p.maxAttempts;
    const timeoutMs=opts.timeoutMs??p.timeoutMs;
    const budgetMs=opts.budgetMs??10000;
    const started=now();
    let attempt=0;
    for(;;) {
      await take(quotaUnits);
      let response;
      try {
        response=await fetchImpl(url,{...init,signal:AbortSignal.timeout(timeoutMs)});
      } catch(error) {
        // A timeout is not retried: bounded latency beats another long attempt.
        if(error?.name==='TimeoutError'||error?.name==='AbortError') throw new PolicyError('timeout',{attempts:attempt+1});
        if(++attempt>=maxAttempts) throw new PolicyError('network',{attempts:attempt});
        await pause(attempt,null,started,budgetMs);
        continue;
      }
      if(!RETRYABLE.has(response.status)) return response;
      if(++attempt>=maxAttempts) throw new PolicyError(response.status===429?'rate_limited':'server',{attempts:attempt});
      await pause(attempt,response.headers.get('retry-after'),started,budgetMs);
    }
  }
  return {fetchWithPolicy};
}
