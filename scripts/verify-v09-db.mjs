// Run only against an isolated ephemeral PGlite instance, never production.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const modulePath=process.env.ARKAB_PGLITE_MODULE||'@electric-sql/pglite';
const {PGlite}=await import(modulePath);
const db=new PGlite();
const rider='11111111-1111-4111-8111-111111111111';
const driver='22222222-2222-4222-8222-222222222222';
const outsider='33333333-3333-4333-8333-333333333333';
const staff='44444444-4444-4444-8444-444444444444';
const ride='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const oldRide='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherRide='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ticket='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
await db.exec(`
create role anon;create role authenticated;create role service_role bypassrls;
create schema auth;create schema arkab_private;
grant usage on schema auth,public,arkab_private to authenticated,service_role;
grant usage on schema auth,public to anon;
create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table auth.users(id uuid primary key);
create table public.profiles(id uuid primary key references auth.users);
create table public.drivers(id uuid primary key references public.profiles);
create table public.rides(id uuid primary key,passenger_id uuid not null references public.profiles,driver_id uuid references public.drivers,
 status text not null,agreed_fare numeric,created_at timestamptz not null default now());
create table public.commissions(ride_id uuid primary key references public.rides,amount numeric not null);
create table public.complaints(id uuid primary key default gen_random_uuid(),user_id uuid not null references public.profiles,ride_id uuid references public.rides,
 body text not null,created_at timestamptz default now());
alter table public.rides enable row level security;alter table public.commissions enable row level security;alter table public.complaints enable row level security;alter table public.drivers enable row level security;
grant select on public.drivers,public.rides,public.commissions,public.complaints to authenticated;
grant insert on public.complaints to authenticated;
create policy own_ride on public.rides for select to authenticated using(passenger_id=auth.uid() or driver_id=auth.uid());
create policy own_driver on public.drivers for select to authenticated using(id=auth.uid());
create policy own_commission on public.commissions for select to authenticated using(exists(select 1 from public.rides r where r.id=ride_id and r.driver_id=auth.uid()));
create policy own_complaint on public.complaints for select to authenticated using(user_id=auth.uid());
create policy add_complaint on public.complaints for insert to authenticated with check(user_id=auth.uid() and (ride_id is null or exists(select 1 from public.rides r where r.id=ride_id and (r.passenger_id=auth.uid() or r.driver_id=auth.uid()))));
insert into auth.users values('${rider}'),('${driver}'),('${outsider}'),('${staff}');
insert into public.profiles select id from auth.users;
insert into public.drivers values('${driver}');
insert into public.rides(id,passenger_id,driver_id,status,agreed_fare) values
 ('${ride}','${rider}','${driver}','accepted',4000),('${oldRide}','${rider}','${driver}','completed',2000),
 ('${otherRide}','${outsider}','${driver}','cancelled',5000);
`);
await db.exec(readFileSync(new URL('../supabase/migrations/20261126111559_arkab_v09_services.sql',import.meta.url),'utf8'));
await db.exec(`insert into arkab_private.support_staff_v09 values('${staff}')`);
async function role(name,id=''){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[id]);await db.exec('set role '+name);}
async function scalar(sql,args=[]){const res=await db.query(sql,args);return res.rows[0].value;}
async function denied(fn){await assert.rejects(fn);}
try{
 await role('anon');
 await denied(()=>db.query('select public.arkab_share_read_v09($1)', ['a'.repeat(64)]));
 await denied(()=>db.query('select * from public.complaints'));
 await role('authenticated',outsider);
 await denied(()=>db.query('select public.arkab_share_create_v09($1)',[ride]));
 await denied(()=>db.query('select public.arkab_driver_earnings_v09($1)', ['day']));
 await denied(()=>db.query('select * from public.arkab_support_queue_v09()'));
 await denied(()=>db.query('insert into public.complaints(user_id,ride_id,body,category) values($1,$2,$3,$4)',[outsider,ride,'Unauthorized complaint','ride']));
 await role('authenticated',rider);
 for(let n=0;n<12;n++)assert.equal(await scalar('select public.arkab_route_allow_v09() value'),true);
 assert.equal(await scalar('select public.arkab_route_allow_v09() value'),false);
 const share=await scalar('select public.arkab_share_create_v09($1) value',[ride]);
 assert.match(share.token,/^[0-9a-f]{64}$/);
 assert.equal(await scalar('select public.arkab_share_publish_v09($1,$2,$3,$4,now()) value',[ride,share.token,14.25,32.98]),true);
 await denied(()=>db.query('select * from arkab_private.live_ride_shares_v09'));
 await denied(()=>db.query('select public.arkab_share_read_v09($1)',[share.token]));
 await denied(()=>db.query('insert into public.complaints(user_id,body,status) values($1,$2,$3)',[rider,'Invalid privileged field','resolved']));
 await db.query('insert into public.complaints(id,user_id,ride_id,body,category) values($1,$2,$3,$4,$5)',[ticket,rider,ride,'تجربة دعم فني','technical']);
 await role('authenticated',outsider);
 assert.equal(await scalar('select count(*)::int value from public.complaints'),0);
 assert.equal(await scalar('select public.arkab_share_publish_v09($1,$2,$3,$4,now()) value',[ride,share.token,14.20,33]),false);
 await role('service_role');
 const v=await scalar('select public.arkab_share_read_v09($1) value',[share.token]);
 assert.equal(v.latitude,14.25);assert.equal(v.longitude,32.98);
 assert.deepEqual(Object.keys(v).sort(),['expires_at','latitude','location_at','longitude','status']);
 assert.equal(await scalar('select public.arkab_share_read_v09($1) value',['b'.repeat(64)]),null);
 await role('authenticated',rider);
 const replacement=await scalar('select public.arkab_share_create_v09($1) value',[ride]);
 assert.notEqual(replacement.token,share.token);
 assert.equal(await scalar('select public.arkab_share_publish_v09($1,$2,$3,$4,now()) value',[ride,share.token,14.25,32.98]),false);
 await role('service_role');
 assert.equal(await scalar('select public.arkab_share_read_v09($1) value',[share.token]),null);
 await role('authenticated',staff);
 assert.equal(await scalar('select count(*)::int value from public.arkab_support_queue_v09()'),1);
 assert.equal(await scalar('select public.arkab_support_update_v09($1,$2,$3) value',[ticket,'resolved','تمت معالجة الطلب']),true);
 await role('authenticated',rider);
 const mine=await db.query('select status,reply from public.complaints where id=$1',[ticket]);
 assert.equal(mine.rows[0].status,'resolved');assert.equal(mine.rows[0].reply,'تمت معالجة الطلب');
 await db.exec('reset role');await db.query("update public.rides set status='completed' where id=$1",[ride]);
 await role('service_role');
 assert.equal(await scalar('select public.arkab_share_read_v09($1) value',[replacement.token]),null);
 await role('authenticated',driver);
 const report=await scalar('select public.arkab_driver_earnings_v09($1) value',['day']);
 assert.equal(report.ride_count,1);assert.equal(Number(report.gross),4000);assert.equal(report.legacy_count,1);assert.equal(Number(report.legacy_gross),2000);
 assert.equal(report.missing_commission_count,1);
 await denied(()=>db.query('select public.arkab_driver_earnings_v09($1)', ['invalid']));
 console.log('PASS: isolated v0.9 database — earnings, legacy timestamp, restricted support, token rotation, ownership, redacted viewer and terminal revocation.');
}finally{await db.close();}
