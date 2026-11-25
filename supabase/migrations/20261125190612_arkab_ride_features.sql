alter table public.rides
  add column pickup_note text check (char_length(pickup_note) <= 240),
  add column recipient_phone text check (recipient_phone ~ '^\+249[0-9]{9}$'),
  add column cargo_description text check (cargo_description is null or (vehicle_kind = 'cargo_tuktuk' and char_length(cargo_description) <= 180)),
  add column cargo_photo_path text check (cargo_photo_path is null or (vehicle_kind = 'cargo_tuktuk' and cargo_photo_path = passenger_id::text || '/' || id::text || '.jpg'));

create table public.saved_rides (
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  ride_id uuid not null references public.rides(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, ride_id)
);
alter table public.saved_rides enable row level security;
revoke all on public.saved_rides from anon, authenticated;
grant select, insert, delete on public.saved_rides to authenticated;
create policy saved_rides_read on public.saved_rides for select to authenticated
  using ((select auth.uid()) = user_id);
create policy saved_rides_add on public.saved_rides for insert to authenticated
  with check ((select auth.uid()) = user_id and exists (
    select 1 from public.rides r where r.id = ride_id and r.passenger_id = (select auth.uid())
  ));
create policy saved_rides_remove on public.saved_rides for delete to authenticated
  using ((select auth.uid()) = user_id);

create function arkab_private.available_ride_details()
returns table(id uuid, vehicle_kind text, pickup text, destination text, proposed_fare numeric,
  created_at timestamptz, pickup_note text, cargo_description text, cargo_photo_path text)
language sql stable security definer set search_path = '' as $$
  select a.*, r.pickup_note, r.cargo_description, r.cargo_photo_path
  from arkab_private.available_rides() a join public.rides r on r.id = a.id
  order by a.created_at desc;
$$;
create function public.available_ride_details()
returns table(id uuid, vehicle_kind text, pickup text, destination text, proposed_fare numeric,
  created_at timestamptz, pickup_note text, cargo_description text, cargo_photo_path text)
language sql stable set search_path = '' as $$
  select * from arkab_private.available_ride_details();
$$;
revoke all on function public.available_ride_details(), arkab_private.available_ride_details() from public, anon;
grant execute on function public.available_ride_details(), arkab_private.available_ride_details() to authenticated;

create function arkab_private.nearby_vehicles(p_lat double precision, p_lng double precision)
returns table(kind text, lat double precision, lng double precision, vehicle_count integer)
language sql stable security definer set search_path = '' as $$
  with cells as (
    select v.kind, round(l.latitude / 0.004) * 0.004 as lat, round(l.longitude / 0.004) * 0.004 as lng
    from public.driver_locations l join public.drivers d on d.id = l.driver_id
    cross join lateral (
      select v.kind from public.vehicles v where v.driver_id = d.id and v.approved order by v.id limit 1
    ) v
    where (select arkab_private.current_user_is_passenger())
      and p_lat between -90 and 90 and p_lng between -180 and 180
      and d.approved and d.online and l.updated_at between now() - interval '2 minutes' and now()
      and l.latitude between p_lat - 0.035 and p_lat + 0.035
      and not exists (select 1 from public.rides r where r.driver_id = d.id and r.status in ('accepted','arrived','in_progress'))
  )
  select c.kind, c.lat, c.lng, count(*)::integer
  from cells c
  where 12742 * asin(sqrt(least(1, power(sin(radians((c.lat-p_lat)/2)),2)
    + cos(radians(p_lat))*cos(radians(c.lat))*power(sin(radians((c.lng-p_lng)/2)),2)))) <= 2
  group by c.kind, c.lat, c.lng
  order by c.lat, c.lng, c.kind;
$$;
create function public.nearby_vehicles(p_lat double precision, p_lng double precision)
returns table(kind text, lat double precision, lng double precision, vehicle_count integer)
language sql stable set search_path = '' as $$
  select * from arkab_private.nearby_vehicles(p_lat, p_lng);
$$;
revoke all on function public.nearby_vehicles(double precision,double precision),
  arkab_private.nearby_vehicles(double precision,double precision) from public, anon;
grant execute on function public.nearby_vehicles(double precision,double precision),
  arkab_private.nearby_vehicles(double precision,double precision) to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('ride-cargo','ride-cargo',false,4194304,array['image/jpeg']);
create policy cargo_photo_upload on storage.objects for insert to authenticated with check (
  bucket_id='ride-cargo' and (storage.foldername(name))[1] = (select auth.uid())::text
  and name ~ '^[0-9a-f-]{36}/[0-9a-f-]{36}\.jpg$'
);
create function arkab_private.can_read_cargo_photo(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.rides r where r.cargo_photo_path = p_name
    and (
      r.passenger_id = (select auth.uid()) or r.driver_id = (select auth.uid())
      or exists (select 1 from arkab_private.available_rides() a where a.id = r.id)
    )
  );
$$;
revoke all on function arkab_private.can_read_cargo_photo(text) from public, anon;
grant execute on function arkab_private.can_read_cargo_photo(text) to authenticated;
create policy cargo_photo_read on storage.objects for select to authenticated using (
  bucket_id='ride-cargo' and (
    (storage.foldername(name))[1] = (select auth.uid())::text
    or arkab_private.can_read_cargo_photo(name)
  )
);

create extension if not exists pg_net with schema extensions;
alter table public.notifications add column ride_id uuid references public.rides(id) on delete set null;
do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
end;
$$;
create index if not exists notifications_user_created_idx on public.notifications(user_id,created_at desc);
create table arkab_private.push_devices (
  token text primary key check (token ~ '^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]+\]$' and char_length(token)<=150),
  user_id uuid not null references public.profiles(id) on delete cascade,
  updated_at timestamptz not null default now()
);
create index push_devices_user_idx on arkab_private.push_devices(user_id,updated_at desc);
revoke all on arkab_private.push_devices from public, anon, authenticated;

create function arkab_private.set_push_device(p_token text, p_enabled boolean)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_enabled then
    insert into arkab_private.push_devices(token,user_id) values (p_token,auth.uid())
    on conflict(token) do update set user_id=excluded.user_id,updated_at=now();
  else
    delete from arkab_private.push_devices where token=p_token and user_id=auth.uid();
  end if;
end;
$$;
create function public.set_push_device(p_token text, p_enabled boolean)
returns void language sql set search_path='' as $$
  select arkab_private.set_push_device(p_token,p_enabled);
$$;
revoke all on function public.set_push_device(text,boolean), arkab_private.set_push_device(text,boolean) from public, anon;
grant execute on function public.set_push_device(text,boolean), arkab_private.set_push_device(text,boolean) to authenticated;

create table arkab_private.push_dispatch (
  notification_id uuid primary key references public.notifications(id) on delete cascade,
  nonce uuid not null default gen_random_uuid(),
  claimed_at timestamptz
);
revoke all on arkab_private.push_dispatch from public, anon, authenticated;
grant select, update on arkab_private.push_dispatch to service_role;
grant select on arkab_private.push_devices to service_role;
grant usage on schema arkab_private to service_role;

-- Restricted to the Edge Function's service role. Only real notifications can be claimed.
create function public.claim_ride_push(p_notification uuid, p_nonce uuid)
returns jsonb language sql volatile set search_path='' as $$
  with claimed as (
    update arkab_private.push_dispatch d set claimed_at=now()
    from public.notifications n
    where d.notification_id=p_notification and d.nonce=p_nonce and d.claimed_at is null
      and n.id=d.notification_id and n.created_at > now()-interval '5 minutes'
    returning d.notification_id
  )
  select jsonb_agg(jsonb_build_object('to',d.token,'title',n.title,'body',n.body,
    'sound','default','channelId','rides','data',jsonb_build_object('rideId',n.ride_id)))
  from claimed join public.notifications n on n.id=claimed.notification_id
  cross join lateral (
    select token from arkab_private.push_devices where user_id=n.user_id
    and updated_at > now()-interval '90 days' order by updated_at desc limit 5
  ) d;
$$;
revoke all on function public.claim_ride_push(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_ride_push(uuid,uuid) to service_role;

create function arkab_private.deliver_ride_push()
returns trigger language plpgsql security definer set search_path='' as $$
declare request_nonce uuid;
begin
  if new.ride_id is not null and exists (select 1 from arkab_private.push_devices
    where user_id=new.user_id and updated_at > now()-interval '90 days') then
    insert into arkab_private.push_dispatch(notification_id) values(new.id) returning nonce into request_nonce;
    perform net.http_post(url:='https://hfhkscqmsmxsxzjfxzew.supabase.co/functions/v1/arkab-ride-push',
      body:=jsonb_build_object('notification_id',new.id,'nonce',request_nonce),
      headers:='{"Content-Type":"application/json"}'::jsonb,timeout_milliseconds:=15000);
  end if;
  return new;
exception when others then
  raise warning 'ARKAB push enqueue failed, SQLSTATE %', SQLSTATE;
  return new;
end;
$$;
create trigger deliver_ride_push after insert on public.notifications
  for each row execute function arkab_private.deliver_ride_push();

create function arkab_private.note_ride_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    insert into public.notifications(user_id,ride_id,title,body)
    select d.id,new.id,'طلب مشوار قريب','افتح أركب لمراجعة الطلب وإرسال عرضك.'
    from public.drivers d join public.driver_locations l on l.driver_id=d.id
    where new.status='requested' and new.pickup_lat between -90 and 90 and new.pickup_lng between -180 and 180
      and d.approved and d.online and l.updated_at between now()-interval '2 minutes' and now()
      and l.latitude between -90 and 90 and l.longitude between -180 and 180
      and exists(select 1 from public.vehicles v where v.driver_id=d.id and v.approved and v.kind=new.vehicle_kind)
      and not exists(select 1 from public.rides r where r.driver_id=d.id and r.status in ('accepted','arrived','in_progress'))
      and 12742 * asin(sqrt(least(1,power(sin(radians((l.latitude-new.pickup_lat)/2)),2)
        + cos(radians(l.latitude))*cos(radians(new.pickup_lat))*power(sin(radians((l.longitude-new.pickup_lng)/2)),2)))) <= 2
    order by abs(l.latitude-new.pickup_lat)+abs(l.longitude-new.pickup_lng)
    limit 12;
  elsif old.status is distinct from new.status then
    if new.status='accepted' then
      insert into public.notifications(user_id,ride_id,title,body) values
        (new.passenger_id,new.id,'تم تأكيد الرحلة','افتح أركب لمتابعة الكابتن.'),
        (new.driver_id,new.id,'الراكب وافق على عرضك','افتح أركب وتوجّه لنقطة الالتقاء.');
    elsif new.status in ('arrived','in_progress','completed') then
      insert into public.notifications(user_id,ride_id,title,body) values
        (new.passenger_id,new.id,
          case new.status when 'arrived' then 'الكابتن وصل' when 'in_progress' then 'الرحلة بدأت' else 'انتهت الرحلة' end,
          'افتح أركب لعرض تفاصيل رحلتك.');
    elsif new.status='cancelled' then
      insert into public.notifications(user_id,ride_id,title,body)
      select distinct user_id,new.id,'تم إلغاء المشوار','افتح أركب لعرض حالة الطلب.'
      from (
        select new.passenger_id user_id
        union all select new.driver_id
        union all select o.driver_id from public.ride_offers o where o.ride_id=new.id and old.status='requested'
      ) recipients
      where user_id is not null and user_id is distinct from (select auth.uid());
    end if;
  end if;
  return new;
end;
$$;
create trigger note_ride_change after insert or update of status on public.rides
  for each row execute function arkab_private.note_ride_change();

create function arkab_private.note_ride_offer()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  insert into public.notifications(user_id,ride_id,title,body)
    select r.passenger_id,r.id,'وصلك عرض من كابتن','افتح أركب لمراجعة الأجرة والعروض المتاحة.'
    from public.rides r where r.id=new.ride_id and r.status='requested';
  return new;
end;
$$;
create trigger note_ride_offer after insert on public.ride_offers
  for each row execute function arkab_private.note_ride_offer();
revoke all on function arkab_private.deliver_ride_push(), arkab_private.note_ride_change(),
  arkab_private.note_ride_offer() from public, anon, authenticated;
