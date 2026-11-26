-- ARKAB v0.7: conversation for assigned ride participants only.
-- Review in a staging project before applying to the live project.
begin;
create table public.ride_messages (
  id uuid primary key default gen_random_uuid(),
  ride_id uuid not null references public.rides(id) on delete cascade,
  sender_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 500),
  created_at timestamptz not null default now()
);
create index ride_messages_ride_created_idx on public.ride_messages(ride_id,created_at desc);
alter table public.ride_messages enable row level security;
revoke all on public.ride_messages from public, anon, authenticated;
grant select on public.ride_messages to authenticated;
grant insert(ride_id,body) on public.ride_messages to authenticated;
create policy ride_messages_read on public.ride_messages for select to authenticated using (
  exists (select 1 from public.rides r where r.id=ride_messages.ride_id
      and r.driver_id is not null and ((select auth.uid())=r.passenger_id or (select auth.uid())=r.driver_id))
);
create policy ride_messages_send on public.ride_messages for insert to authenticated with check (
  sender_id=(select auth.uid()) and exists (
    select 1 from public.rides r where r.id=ride_messages.ride_id
    and r.driver_id is not null and r.status in ('accepted','arrived','in_progress')
    and ((select auth.uid())=r.passenger_id or (select auth.uid())=r.driver_id)
  )
);
do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime')
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='ride_messages') then
    alter publication supabase_realtime add table public.ride_messages;
  end if;
end;
$$;
commit;
