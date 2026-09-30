-- A physical count is an anchor. A backdated movement changes the expected
-- balance at the first later count for that account, not at every later count.
create or replace function lubricenter_private.finance_cash_movement_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare a uuid; d date; v_close uuid;
begin
 perform pg_advisory_xact_lock(220033);
 for a,d in
  select case when tg_op='DELETE' then old.account_id else new.account_id end,
   timezone('America/Caracas',case when tg_op='DELETE' then old.occurred_at else new.occurred_at end)::date
  union
  select case when tg_op='INSERT' then new.account_id else old.account_id end,
   timezone('America/Caracas',case when tg_op='INSERT' then new.occurred_at else old.occurred_at end)::date
 loop
  if exists(select 1 from public.financial_accounts
   where id=a and account_type='CASH') then
   select c.id into v_close
   from public.cash_closings c
   join public.cash_closing_accounts ca on ca.cash_closing_id=c.id
   where ca.account_id=a and ca.actual_native is not null
    and c.finance_version=22 and c.status in ('CLOSED','REVIEW')
    and c.business_date>=d
   order by c.business_date,c.id limit 1;
   update public.cash_closings set status='REVIEW',
    review_reason='Se registró o corrigió un movimiento de efectivo anterior al conteo',
    updated_at=now()
   where id=v_close and status='CLOSED';
  end if;
 end loop;
 return coalesce(new,old);
end $$;

-- A corrected physical count can change only the next count's expected
-- opening. That next count anchors all subsequent days.
create or replace function lubricenter_private.finance_cash_recount_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_day date; v_close uuid;
begin
 if old.actual_native is distinct from new.actual_native then
  select business_date into v_day from public.cash_closings where id=new.cash_closing_id;
  select c.id into v_close from public.cash_closings c
   join public.cash_closing_accounts ca on ca.cash_closing_id=c.id
   where ca.account_id=new.account_id and ca.actual_native is not null
    and c.finance_version=22 and c.status in ('CLOSED','REVIEW')
    and c.business_date>v_day
   order by c.business_date,c.id limit 1;
  update public.cash_closings set status='REVIEW',
   review_reason='Se corrigió un conteo anterior que afecta la apertura',
   updated_at=now()
  where id=v_close and status='CLOSED';
 end if;
 return new;
end $$;
revoke all on function lubricenter_private.finance_cash_movement_guard() from public,anon,authenticated;
revoke all on function lubricenter_private.finance_cash_recount_guard() from public,anon,authenticated;
