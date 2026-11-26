import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readDeletionRequest,submitDeletionRequest} from '../accountDeletion.js';
const owner='test-account',record={requested_at:'2026-11-26T12:00:00Z',status:'requested'};
let stored=null,failInsert=null,reads=0,inserts=0;
const fakeDb={from(table){assert.equal(table,'account_deletion_requests');return {
  select(cols){assert.equal(cols,'requested_at,status');return {eq(field,id){assert.equal(field,'user_id');assert.equal(id,owner);return {async maybeSingle(){reads++;return {data:stored,error:null}}}}}},
  async insert(values){assert.deepEqual(values,{user_id:owner});inserts++;if(failInsert)return {error:failInsert};if(stored)return {error:{code:'23505'}};stored=record;return {error:null}}
}}};
assert.equal(await readDeletionRequest(fakeDb,owner),null);
assert.deepEqual(await submitDeletionRequest(fakeDb,owner),record);
assert.deepEqual(await submitDeletionRequest(fakeDb,owner),record);
assert.equal(inserts,2);assert.equal(reads,3);
await assert.rejects(submitDeletionRequest(fakeDb,null));
failInsert={code:'NETWORK'};await assert.rejects(submitDeletionRequest(fakeDb,owner),e=>e.code==='NETWORK');
const sql=readFileSync(new URL('../supabase/migrations/20261126215100_arkab_account_deletion_requests.sql',import.meta.url),'utf8');
assert.match(sql,/enable row level security/);
assert.match(sql,/grant insert\(user_id\).*to authenticated/);
assert.match(sql,/for insert to authenticated with check \(\(select auth.uid\(\)\) = user_id\)/);
console.log('PASS: deletion request intake, idempotence, missing session, and failure handling (mocked).');
