import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {transformSync} from '@babel/core';
const filename='supabase/functions/arkab-ride-push/index.ts';
const {code}=transformSync(fs.readFileSync(new URL('../'+filename,import.meta.url),'utf8'),{filename,configFile:false,babelrc:false,plugins:['@babel/plugin-transform-typescript','@babel/plugin-transform-modules-commonjs']});
let handler,statuses=[],calls=0,delays=[],logs=[];
const mock={Deno:{env:{get:()=>''},serve:fn=>{handler=fn}},Response,Request,TextDecoder,AbortSignal,
  require:()=>({createClient:()=>({rpc:async()=>({data:[{to:'mock-device',title:'test'}],error:null})})}),
  exports:{},console:{info:(...args)=>logs.push(args),error:(...args)=>logs.push(args)},setTimeout:(cb,ms)=>{delays.push(ms);cb()},
  fetch:async()=>{calls++;const status=statuses.shift();return status===200?new Response(JSON.stringify({data:[{status:'ok',id:'mock-ticket'}]}),{status}):new Response(null,{status});}
};
vm.runInNewContext(code,mock);
const call=()=>handler(new Request('https://fake.example',{method:'POST',body:JSON.stringify({notification_id:'00000000-0000-4000-8000-000000000001',nonce:'00000000-0000-4000-8000-000000000002'})}));
statuses=[429,503,200];assert.equal((await call()).status,204);assert.equal(calls,3);assert.deepEqual(delays,[1000,2000]);
statuses=[400];calls=0;delays=[];assert.equal((await call()).status,502);assert.equal(calls,1);assert.deepEqual(delays,[]);
statuses=[503,503,503];calls=0;delays=[];assert.equal((await call()).status,502);assert.equal(calls,3);
console.log('PASS: push service transient retry, bounded backoff, and non-retryable errors (all mocked).');
