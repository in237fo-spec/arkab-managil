// Isolated PGlite test, never calls an actual network or production database.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {PGlite}=await import(process.env.ARKAB_PGLITE_MODULE||'@electric-sql/pglite');
const db=new PGlite();
const id=n=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000000`;
const passenger=id(1),driver=id(2),distant=id(3),offline=id(4),ride=id(5);
const migration=(name)=>readFileSync(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const original=migration('20261125190612_arkab_ride_features.sql');
try {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema arkab_private; create schema auth; create schema net;
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create table profiles(id uuid primary key);
    create table drivers(id uuid primary key,approved boolean,online boolean);
    create table driver_locations(driver_id uuid primary key,latitude float,longitude float,updated_at timestamptz);
    create table vehicles(driver_id uuid,approved boolean,kind text);
    create table rides(id uuid primary key,passenger_id uuid,driver_id uuid,status text,pickup_lat float,pickup_lng float,vehicle_kind text);
    create table ride_offers(ride_id uuid,driver_id uuid);
    create table notifications(id uuid primary key default gen_random_uuid(),user_id uuid,ride_id uuid,title text,body text,created_at timestamptz default now());
    create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds int) returns bigint language sql as $$ select 1::bigint $$;
    grant select on notifications to service_role;
    insert into profiles values ('${passenger}'),('${driver}'),('${distant}'),('${offline}');
    insert into drivers values ('${driver}',true,true),('${distant}',true,true),('${offline}',true,false);
    insert into driver_locations values ('${driver}',14.23,32.99,now()),('${distant}',15,33,now()),('${offline}',14.23,32.99,now());
    insert into vehicles values ('${driver}',true,'rickshaw'),('${distant}',true,'rickshaw'),('${offline}',true,'rickshaw');
  `);
  await db.exec(original.slice(original.indexOf('create table arkab_private.push_devices')));
  await db.exec(migration('20261126160500_arkab_v09_phone_push.sql'));
  await db.exec(`insert into arkab_private.push_devices(token,user_id) values ('ExpoPushToken[fixture_only_rider]','${passenger}'),('ExpoPushToken[fixture_only_driver]','${driver}');`);
  await db.exec(`insert into rides values ('${ride}','${passenger}',null,'requested',14.23,32.99,'rickshaw');`);
  const rows=async(title)=>(await db.query('select user_id from notifications where title=$1 order by user_id',[title])).rows.map(r=>r.user_id);
  assert.deepEqual(await rows('طلب مشوار قريب'),[driver]);
  const dispatch=(await db.query("select notification_id,nonce from arkab_private.push_dispatch")).rows[0];
  await db.exec('set role service_role');
  const payload=async()=>(await db.query('select claim_ride_push($1,$2) as value',[dispatch.notification_id,dispatch.nonce])).rows[0].value;
  const messages=await payload();
  assert.equal(messages.length,1);assert.equal(messages[0].to,'ExpoPushToken[fixture_only_driver]');
  assert.equal(messages[0].priority,'high');assert.equal(messages[0].channelId,'rides');assert.equal(messages[0].sound,'default');
  assert.equal(messages[0].ttl,180);assert.equal(messages[0].data.rideId,ride);assert.equal(messages[0].data.event,'new_request');
  assert.equal(await payload(),null);
  await db.exec('reset role');
  await db.exec(`update rides set driver_id='${driver}', status='accepted' where id='${ride}';`);
  assert.deepEqual(await rows('الكابتن في الطريق إليك'),[passenger]);
  assert.deepEqual(await rows('الراكب وافق على عرضك'),[driver]);
  for(const [status,title] of [['arrived','الكابتن وصل'],['in_progress','الرحلة بدأت'],['completed','انتهت الرحلة']]){
    await db.query('update rides set status=$1 where id=$2',[status,ride]);
    await db.query('update rides set status=$1 where id=$2',[status,ride]);
    assert.deepEqual(await rows(title),[passenger,driver]);
  }
  await db.exec('set role authenticated');
  await assert.rejects(()=>payload());
  await db.exec('reset role');
  console.log('PASS: nearby eligibility, remote payload, one claim, participant delivery, status deduplication, restricted claim.');
} finally {await db.close();}
