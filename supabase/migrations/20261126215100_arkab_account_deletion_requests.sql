-- Additive, non-destructive request intake. Actual deletion is an owner-reviewed
-- operation considering shared trips and storage objects; no user is deleted here.
begin;
create table public.account_deletion_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  status text not null default 'requested' check (status in ('requested','reviewing'))
);
alter table public.account_deletion_requests enable row level security;
revoke all on table public.account_deletion_requests from public,anon,authenticated;
grant select on table public.account_deletion_requests to authenticated;
grant insert(user_id) on table public.account_deletion_requests to authenticated;
grant select,update(status) on table public.account_deletion_requests to service_role;
create policy arkab_deletion_request_read_own on public.account_deletion_requests
  for select to authenticated using ((select auth.uid()) = user_id);
create policy arkab_deletion_request_insert_own on public.account_deletion_requests
  for insert to authenticated with check ((select auth.uid()) = user_id);
commit;
