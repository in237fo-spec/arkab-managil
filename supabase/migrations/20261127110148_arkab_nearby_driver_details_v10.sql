create or replace function arkab_private.nearby_driver_details(p_lat double precision, p_lng double precision)
returns table(
  driver_id uuid,
  full_name text,
  avatar_url text,
  kind text,
  lat double precision,
  lng double precision,
  distance_km double precision
)
language sql
stable
security definer
set search_path = ''
as $function$
  with eligible as (
    select
      d.id as driver_id,
      p.full_name,
      p.avatar_url,
      v.kind,
      l.latitude,
      l.longitude,
      12742 * asin(sqrt(least(1,
        power(sin(radians((l.latitude-p_lat)/2)),2)
        + cos(radians(p_lat))*cos(radians(l.latitude))
        * power(sin(radians((l.longitude-p_lng)/2)),2)
      ))) as distance_km
    from public.driver_locations l
    join public.drivers d on d.id=l.driver_id
    join public.profiles p on p.id=d.id and p.role='driver'
    cross join lateral (
      select vv.kind
      from public.vehicles vv
      where vv.driver_id=d.id and vv.approved
      order by vv.id
      limit 1
    ) v
    where auth.uid() is not null
      and (select arkab_private.current_user_is_passenger())
      and p_lat between -90 and 90
      and p_lng between -180 and 180
      and d.approved
      and d.online
      and l.updated_at between now()-interval '2 minutes' and now()
      and l.latitude between p_lat-0.035 and p_lat+0.035
      and l.longitude between p_lng-0.035 and p_lng+0.035
      and not exists (
        select 1 from public.rides r
        where r.driver_id=d.id and r.status in ('accepted','arrived','in_progress')
      )
  )
  select
    e.driver_id,
    e.full_name,
    e.avatar_url,
    e.kind,
    round(e.latitude::numeric,3)::double precision as lat,
    round(e.longitude::numeric,3)::double precision as lng,
    round(e.distance_km::numeric,1)::double precision as distance_km
  from eligible e
  where e.distance_km<=2
  order by e.distance_km
  limit 40;
$function$;

revoke all on function arkab_private.nearby_driver_details(double precision,double precision) from public, anon;
grant execute on function arkab_private.nearby_driver_details(double precision,double precision) to authenticated;

create or replace function public.nearby_driver_details(p_lat double precision, p_lng double precision)
returns table(
  driver_id uuid,
  full_name text,
  avatar_url text,
  kind text,
  lat double precision,
  lng double precision,
  distance_km double precision
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select * from arkab_private.nearby_driver_details(p_lat,p_lng);
$function$;

revoke all on function public.nearby_driver_details(double precision,double precision) from public, anon;
grant execute on function public.nearby_driver_details(double precision,double precision) to authenticated;
