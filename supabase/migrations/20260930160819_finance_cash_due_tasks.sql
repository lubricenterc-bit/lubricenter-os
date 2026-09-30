-- Derived tasks are stable by location and day. Reading them never creates
-- cases or audit events, so opening the inbox repeatedly is harmless.
create function lubricenter_private.finance_cash_due(p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_location uuid; v_today date:=timezone('America/Caracas',now())::date;
 v_openings integer; v_start date; v_total integer; v_tasks jsonb;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if p_offset is null or p_offset<0 then raise exception 'Página inválida'; end if;
 select id into v_location from public.locations where active order by created_at limit 1;
 if v_location is null then
  return jsonb_build_object('status','NEEDS_LOCATION','total',0,'tasks','[]'::jsonb);
 end if;
 select count(*),max(timezone('America/Caracas',o.effective_at)::date)
  into v_openings,v_start
  from public.finance_cash_openings o
  join public.financial_accounts a on a.id=o.account_id
  where a.active and a.account_type='CASH' and a.code in ('CASH_USD','CASH_VES');
 if v_openings<>2 then
  return jsonb_build_object('status','NEEDS_OPENING','total',0,'tasks','[]'::jsonb);
 end if;
 with activity as (
  select distinct timezone('America/Caracas',m.occurred_at)::date business_date
   from public.account_movements m
   join public.financial_accounts a on a.id=m.account_id
   join public.finance_cash_openings o on o.account_id=a.id
   where a.active and a.account_type='CASH' and a.code in ('CASH_USD','CASH_VES')
    and m.occurred_at>=o.effective_at
  union
  select c.business_date from public.cash_closings c
   where c.location_id=v_location and c.finance_version=22
 ), due as (
  select d.business_date,c.status closing_status
   from activity d
   left join public.cash_closings c
    on c.location_id=v_location and c.business_date=d.business_date
   where d.business_date>=v_start and d.business_date<v_today
    and (c.id is null or c.status<>'CLOSED')
 ), numbered as (
  select *,row_number() over(order by business_date desc) rn from due
 )
 select count(*)::integer,
  coalesce(jsonb_agg(jsonb_build_object(
   'task_key','cash:'||v_location||':'||business_date,
   'business_date',business_date,
   'kind',case when closing_status='REVIEW' then 'REVIEW' else 'CLOSE' end,
   'title',case when closing_status='REVIEW' then 'Revisar cuadre de caja' else 'Falta cerrar caja' end,
   'reason',case when closing_status='REVIEW'
    then 'Un movimiento o conteo cambió después del cierre'
    else 'Hay actividad de efectivo o un conteo iniciado sin cierre' end,
   'action_url','/cash-close?day='||business_date
  ) order by business_date desc) filter(where rn>p_offset and rn<=p_offset+20),'[]'::jsonb)
 into v_total,v_tasks from numbered;
 return jsonb_build_object('status','ACTIVE','total',v_total,'tasks',v_tasks);
end $$;

create function public.finance_cash_due(p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path='' as $$
 select lubricenter_private.finance_cash_due(p_offset)
$$;
revoke all on function lubricenter_private.finance_cash_due(integer) from public,anon;
revoke all on function public.finance_cash_due(integer) from public,anon;
grant execute on function lubricenter_private.finance_cash_due(integer) to authenticated;
grant execute on function public.finance_cash_due(integer) to authenticated;
