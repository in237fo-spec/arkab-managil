-- ARKAB v0.9. Additive, staging-tested migration; do not run legacy schema.
begin;
alter table public.rides add column if not exists completed_at timestamptz;
create index if not exists arkab_driver_completed_v09_idx on public.rides(driver_id,completed_at) where status='completed';
create or replace function arkab_private.stamp_completed_v09()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status='completed' and (tg_op='INSERT' or old.status is distinct from new.status) then new.completed_at=now();
  elsif new.status<>'completed' then new.completed_at=null;
  end if;
  return new;
end; $$;
revoke all on function arkab_private.stamp_completed_v09() from public,anon,authenticated;
create trigger arkab_stamp_completed_v09 before insert or update of status on public.rides
for each row execute function arkab_private.stamp_completed_v09();

-- Invoker respects existing ride/commission RLS. Count only rides with a documented
-- completion date; historical rows without one are intentionally not backdated.
create function public.arkab_driver_earnings_v09(p_period text)
returns jsonb language plpgsql stable set search_path='' as $$
declare v_start timestamptz; v_end timestamptz;
begin
  if auth.uid() is null or not exists(select 1 from public.drivers d where d.id=auth.uid()) then
    raise exception 'Driver account required' using errcode='42501';
  end if;
  if p_period not in ('day','week','month') then raise exception 'Invalid period' using errcode='22023'; end if;
  v_start:=date_trunc(p_period, now() at time zone 'Africa/Khartoum') at time zone 'Africa/Khartoum';
  v_end:=(date_trunc(p_period,now() at time zone 'Africa/Khartoum') + case p_period when 'day' then interval '1 day' when 'week' then interval '7 days' else interval '1 month' end) at time zone 'Africa/Khartoum';
  return (
    with completed as (
      select r.id,r.agreed_fare,r.completed_at,c.amount commission
      from public.rides r left join public.commissions c on c.ride_id=r.id
      where r.driver_id=auth.uid() and r.status='completed'
    )
    select jsonb_build_object(
      'period',p_period,'start',v_start,'end',v_end,
      'ride_count',count(*) filter(where completed_at>=v_start and completed_at<v_end),
      'gross',coalesce(sum(agreed_fare) filter(where completed_at>=v_start and completed_at<v_end),0),
      'missing_fare_count',count(*) filter(where completed_at>=v_start and completed_at<v_end and agreed_fare is null),
      'commission_recorded',coalesce(sum(commission) filter(where completed_at>=v_start and completed_at<v_end),0),
      'missing_commission_count',count(*) filter(where completed_at>=v_start and completed_at<v_end and commission is null),
      'legacy_count',count(*) filter(where completed_at is null),
      'legacy_gross',coalesce(sum(agreed_fare) filter(where completed_at is null),0)
    ) from completed
  );
end; $$;
revoke all on function public.arkab_driver_earnings_v09(text) from public,anon;
grant execute on function public.arkab_driver_earnings_v09(text) to authenticated;

-- Reuse existing complaint table, policies and owner relationship.
alter table public.complaints add column if not exists category text not null default 'other',
  add column if not exists status text not null default 'open',
  add column if not exists reply text,
  add column if not exists updated_at timestamptz not null default now();
alter table public.complaints add constraint arkab_complaint_category_v09 check(category in ('ride','fare','technical','safety','other')),
  add constraint arkab_complaint_status_v09 check(status in ('open','in_review','resolved')),
  add constraint arkab_complaint_reply_v09 check(reply is null or char_length(btrim(reply)) between 1 and 2000);
alter table public.complaints add constraint arkab_complaint_body_v09 check(char_length(btrim(body)) between 5 and 1500) not valid;
revoke insert,update,delete on public.complaints from public,anon,authenticated;
grant select on public.complaints to authenticated;
grant insert(id,user_id,ride_id,body,category) on public.complaints to authenticated;
create index if not exists arkab_complaints_owner_v09_idx on public.complaints(user_id,created_at desc);

-- Staff membership is provisioned explicitly by the project owner, never by a client.
create table arkab_private.support_staff_v09(user_id uuid primary key references auth.users(id) on delete cascade);
alter table arkab_private.support_staff_v09 enable row level security;
revoke all on arkab_private.support_staff_v09 from public,anon,authenticated;

create function arkab_private.support_queue_v09()
returns setof public.complaints language plpgsql stable security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from arkab_private.support_staff_v09 s where s.user_id=auth.uid()) then
    raise exception 'Support access required' using errcode='42501';
  end if;
  return query select c.* from public.complaints c order by case c.status when 'open' then 0 when 'in_review' then 1 else 2 end,c.created_at desc limit 200;
end; $$;
create function public.arkab_support_queue_v09() returns setof public.complaints
language sql stable set search_path='' as $$ select * from arkab_private.support_queue_v09(); $$;
create function arkab_private.support_update_v09(p_ticket uuid,p_status text,p_reply text)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not exists(select 1 from arkab_private.support_staff_v09 s where s.user_id=auth.uid()) then
    raise exception 'Support access required' using errcode='42501';
  end if;
  if p_status not in ('open','in_review','resolved') or char_length(coalesce(btrim(p_reply),''))>2000 then raise exception 'Invalid response' using errcode='22023'; end if;
  if p_status='resolved' and nullif(btrim(p_reply),'') is null then raise exception 'A resolution reply is required' using errcode='22023'; end if;
  update public.complaints set status=p_status,reply=nullif(btrim(p_reply),''),updated_at=now() where id=p_ticket;
  return found;
end; $$;
create function public.arkab_support_update_v09(p_ticket uuid,p_status text,p_reply text)
returns boolean language sql set search_path='' as $$ select arkab_private.support_update_v09(p_ticket,p_status,p_reply); $$;
revoke all on function public.arkab_support_queue_v09(),public.arkab_support_update_v09(uuid,text,text),
  arkab_private.support_queue_v09(),arkab_private.support_update_v09(uuid,text,text) from public,anon;
grant execute on function public.arkab_support_queue_v09(),public.arkab_support_update_v09(uuid,text,text),
  arkab_private.support_queue_v09(),arkab_private.support_update_v09(uuid,text,text) to authenticated;

-- Opt-in tracking: share only the passenger's own GPS during an assigned active
-- trip. No driver phone, plate, account identity, origin or destination is exposed.
create table arkab_private.live_ride_shares_v09(
  ride_id uuid primary key references public.rides(id) on delete cascade,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  token_hash text not null unique check(length(token_hash)=64),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  latitude double precision check(latitude between -90 and 90),
  longitude double precision check(longitude between -180 and 180),
  location_at timestamptz
);
alter table arkab_private.live_ride_shares_v09 enable row level security;
revoke all on arkab_private.live_ride_shares_v09 from public,anon,authenticated;

create function arkab_private.share_create_v09(p_ride uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_token text;v_expiry timestamptz:=now()+interval '2 hours';v_owner uuid:=auth.uid();
begin
  if v_owner is null or not exists(select 1 from public.rides r where r.id=p_ride and r.passenger_id=v_owner
     and r.driver_id is not null and r.status in('accepted','arrived','in_progress') for update) then
    raise exception 'Active passenger ride required' using errcode='42501';
  end if;
  v_token:=replace(gen_random_uuid()::text,'-','')||replace(gen_random_uuid()::text,'-','');
  insert into arkab_private.live_ride_shares_v09(ride_id,owner_id,token_hash,expires_at)
  values(p_ride,v_owner,encode(sha256(convert_to(v_token,'UTF8')),'hex'),v_expiry)
  on conflict(ride_id) do update set owner_id=excluded.owner_id,token_hash=excluded.token_hash,expires_at=excluded.expires_at,
    revoked_at=null,latitude=null,longitude=null,location_at=null;
  return jsonb_build_object('token',v_token,'expires_at',v_expiry);
end; $$;
create function arkab_private.share_publish_v09(p_ride uuid,p_token text,p_lat double precision,p_lng double precision,p_sample_at timestamptz)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_owner uuid:=auth.uid();
begin
  if v_owner is null or p_token is null or p_token!~'^[0-9a-f]{64}$' then return false; end if;
  if p_lat is null or p_lng is null or p_sample_at is null or not(p_lat between -90 and 90 and p_lng between -180 and 180) then raise exception 'Invalid location' using errcode='22023'; end if;
  if not exists(select 1 from arkab_private.live_ride_shares_v09 s join public.rides r on r.id=s.ride_id
      where s.ride_id=p_ride and s.owner_id=v_owner and s.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') and r.passenger_id=v_owner and s.revoked_at is null and s.expires_at>now()
        and r.driver_id is not null and r.status in('accepted','arrived','in_progress')) then return false; end if;
  -- Ignore stale or future device timestamps rather than present them as live.
  if p_sample_at<now()-interval '2 minutes' or p_sample_at>now()+interval '30 seconds' then return true; end if;
  update arkab_private.live_ride_shares_v09 s set latitude=p_lat,longitude=p_lng,location_at=p_sample_at
  where s.ride_id=p_ride and s.owner_id=v_owner and s.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex') and s.revoked_at is null and s.expires_at>now()
    and (s.location_at is null or s.location_at<p_sample_at)
    and exists(select 1 from public.rides r where r.id=s.ride_id and r.passenger_id=v_owner and r.driver_id is not null and r.status in('accepted','arrived','in_progress'));
  return true;
end; $$;
create function arkab_private.share_revoke_v09(p_ride uuid)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then return false; end if;
  update arkab_private.live_ride_shares_v09 set revoked_at=now(),latitude=null,longitude=null,location_at=null where ride_id=p_ride and owner_id=auth.uid();
  return found;
end; $$;
create function arkab_private.share_read_v09(p_token text)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('status',r.status,'expires_at',s.expires_at,
    'location_at',case when s.location_at>=now()-interval '2 minutes' then s.location_at end,
    'latitude',case when s.location_at>=now()-interval '2 minutes' then s.latitude end,
    'longitude',case when s.location_at>=now()-interval '2 minutes' then s.longitude end)
  from arkab_private.live_ride_shares_v09 s join public.rides r on r.id=s.ride_id
  where p_token~'^[0-9a-f]{64}$' and s.token_hash=encode(sha256(convert_to(p_token,'UTF8')),'hex')
    and s.revoked_at is null and s.expires_at>now() and r.passenger_id=s.owner_id
    and r.driver_id is not null and r.status in('accepted','arrived','in_progress') limit 1;
$$;
create function arkab_private.share_end_v09() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status not in('accepted','arrived','in_progress') then
    update arkab_private.live_ride_shares_v09 set revoked_at=now(),latitude=null,longitude=null,location_at=null where ride_id=new.id and revoked_at is null;
  end if;
  return new;
end; $$;
create trigger arkab_share_end_v09 after update of status on public.rides for each row execute function arkab_private.share_end_v09();

create function public.arkab_share_create_v09(p_ride uuid) returns jsonb language sql set search_path='' as $$ select arkab_private.share_create_v09(p_ride); $$;
create function public.arkab_share_publish_v09(p_ride uuid,p_token text,p_lat double precision,p_lng double precision,p_sample_at timestamptz) returns boolean language sql set search_path='' as $$ select arkab_private.share_publish_v09(p_ride,p_token,p_lat,p_lng,p_sample_at); $$;
create function public.arkab_share_revoke_v09(p_ride uuid) returns boolean language sql set search_path='' as $$ select arkab_private.share_revoke_v09(p_ride); $$;
create function public.arkab_share_read_v09(p_token text) returns jsonb language sql stable set search_path='' as $$ select arkab_private.share_read_v09(p_token); $$;
revoke all on function public.arkab_share_create_v09(uuid),public.arkab_share_publish_v09(uuid,text,double precision,double precision,timestamptz),public.arkab_share_revoke_v09(uuid),
  arkab_private.share_create_v09(uuid),arkab_private.share_publish_v09(uuid,text,double precision,double precision,timestamptz),arkab_private.share_revoke_v09(uuid) from public,anon;
grant execute on function public.arkab_share_create_v09(uuid),public.arkab_share_publish_v09(uuid,text,double precision,double precision,timestamptz),public.arkab_share_revoke_v09(uuid),
  arkab_private.share_create_v09(uuid),arkab_private.share_publish_v09(uuid,text,double precision,double precision,timestamptz),arkab_private.share_revoke_v09(uuid) to authenticated;
revoke all on function public.arkab_share_read_v09(text),arkab_private.share_read_v09(text),arkab_private.share_end_v09() from public,anon,authenticated;
grant execute on function public.arkab_share_read_v09(text),arkab_private.share_read_v09(text) to service_role;
-- Per-account route quota; no user can allocate requests for another account.
create table arkab_private.route_quota_v09(user_id uuid primary key references auth.users(id) on delete cascade,
  window_start timestamptz not null,requests integer not null check(requests between 1 and 12));
alter table arkab_private.route_quota_v09 enable row level security;
revoke all on arkab_private.route_quota_v09 from public,anon,authenticated;
create function arkab_private.route_allow_v09() returns boolean language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid(); v_result integer;
begin
  if v_user is null then return false; end if;
  insert into arkab_private.route_quota_v09 as q(user_id,window_start,requests) values(v_user,now(),1)
  on conflict(user_id) do update set window_start=case when q.window_start<=now()-interval '1 minute' then now() else q.window_start end,
    requests=case when q.window_start<=now()-interval '1 minute' then 1 else q.requests+1 end
  where q.window_start<=now()-interval '1 minute' or q.requests<12 returning requests into v_result;
  return v_result is not null;
end; $$;
create function public.arkab_route_allow_v09() returns boolean language sql set search_path='' as $$ select arkab_private.route_allow_v09(); $$;
revoke all on function arkab_private.route_allow_v09(),public.arkab_route_allow_v09() from public,anon;
grant execute on function arkab_private.route_allow_v09(),public.arkab_route_allow_v09() to authenticated;
commit;
