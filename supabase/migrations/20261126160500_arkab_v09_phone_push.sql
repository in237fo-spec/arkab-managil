-- Upgrade existing ride triggers in place; never create duplicate triggers.
-- The payload contains no contact, address or location information.
create or replace function public.claim_ride_push(p_notification uuid, p_nonce uuid)
returns jsonb language sql volatile set search_path='' as $$
  with claimed as (
    update arkab_private.push_dispatch d set claimed_at=now()
    from public.notifications n
    where d.notification_id=p_notification and d.nonce=p_nonce and d.claimed_at is null
      and n.id=d.notification_id and n.created_at > now()-interval '5 minutes'
    returning d.notification_id
  )
  select jsonb_agg(jsonb_build_object('to',d.token,'title',n.title,'body',n.body,
    'sound','default','channelId','rides','priority','high',
    'ttl',case when n.title='طلب مشوار قريب' then 180 else 600 end,
    'data',jsonb_build_object('rideId',n.ride_id,'notificationId',n.id,
      'event',case when n.title='طلب مشوار قريب' then 'new_request' else 'ride_update' end)))
  from claimed join public.notifications n on n.id=claimed.notification_id
  cross join lateral (
    select token from arkab_private.push_devices where user_id=n.user_id
    and updated_at > now()-interval '90 days' order by updated_at desc limit 5
  ) d;
$$;
revoke all on function public.claim_ride_push(uuid,uuid) from public, anon, authenticated;
grant execute on function public.claim_ride_push(uuid,uuid) to service_role;


create or replace function arkab_private.note_ride_change()
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
        (new.passenger_id,new.id,'الكابتن في الطريق إليك','تم تأكيد المشوار. افتح أركب لمتابعة الكابتن.'),
        (new.driver_id,new.id,'الراكب وافق على عرضك','افتح أركب وتوجّه لنقطة الالتقاء.');
    elsif new.status in ('arrived','in_progress','completed') then
      insert into public.notifications(user_id,ride_id,title,body)
      select distinct recipient,new.id,
        case new.status when 'arrived' then 'الكابتن وصل' when 'in_progress' then 'الرحلة بدأت' else 'انتهت الرحلة' end,
        'افتح أركب لعرض تفاصيل المشوار.'
      from unnest(array[new.passenger_id,new.driver_id]) recipient
      where recipient is not null;
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

revoke all on function arkab_private.note_ride_change() from public, anon, authenticated;
