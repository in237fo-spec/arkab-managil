import assert from 'node:assert/strict';
import {createRefreshQueue} from '../refreshQueue.js';
import {readFileSync} from 'node:fs';
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {resolve,promise};};
const next=()=>new Promise(resolve=>setImmediate(resolve));
const queue=createRefreshQueue();
const first=defer();
let count=0, concurrent=0, peak=0;
async function work(){
  const n=++count;
  peak=Math.max(peak,++concurrent);
  if(n===1)await first.promise;
  concurrent--;
}
const pending=queue.request('rider',work);
await next();
assert.equal(queue.isRunning('rider'),true);
assert.equal(queue.isRunning('other'),false);
for(let i=0;i<20;i++)assert.equal(queue.request('rider',work),pending);
first.resolve();
await pending;
assert.equal(count,2);
assert.equal(peak,1);
assert.equal(queue.isRunning('rider'),false);
// Logout drops the queued follow-up; a new account can refresh immediately.
const gate=defer();let oldRuns=0,newRuns=0;
const old=queue.request('old',async()=>{oldRuns++;await gate.promise;});
await next();
queue.request('old',async()=>{oldRuns++;});
queue.reset();
await queue.request('new',async()=>{newRuns++;});
gate.resolve();await old;
assert.equal(oldRuns,1);assert.equal(newRuns,1);
// The queue is not permanently locked after a failed request.
await assert.rejects(queue.request('new',async()=>{throw Error('offline');}),/offline/);
await queue.request('new',async()=>{newRuns++;});
assert.equal(newRuns,2);
const eas=JSON.parse(readFileSync(new URL('../eas.json',import.meta.url),'utf8'));
assert.equal(eas.build.preview.environment,'production');
assert.equal(eas.build.preview.autoIncrement,true);
assert.equal(eas.build.preview.android.buildType,'apk');
assert.equal(eas.build.production.android.buildType,'app-bundle');
console.log('PASS: serialized/coalesced synchronization, account reset, failure recovery, and preview/store profiles.');
