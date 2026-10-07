-- Payroll v3: commissions are obligations denominated in USD.
-- Existing settled payroll runs remain unchanged. Pending work is recalculated additively.

alter table public.payroll_work_items
  add column if not exists obligation_usd numeric(18,2),
  add column if not exists payout_mode text;

alter table public.payroll_work_items
  drop constraint if exists payroll_work_items_payout_mode_check;
alter table public.payroll_work_items
  add constraint payroll_work_items_payout_mode_check
  check (payout_mode is null or payout_mode in ('HARD_USD','BCV_VES'));

alter table public.payroll_runs
  add column if not exists commission_hard_usd numeric(18,2),
  add column if not exists commission_bcv_usd numeric(18,2);

-- Attribute this administrative backfill to an existing authenticated user so the audit trigger remains intact.
do $declare v_actor uuid; begin
 select id into v_actor from auth.users order by created_at limit 1;
 if v_actor is null then raise exception 'No authenticated user exists for payroll backfill audit'; end if;
 perform set_config('request.jwt.claim.sub',v_actor::text,true);
end $;

-- Recalculate only work that has not been settled yet.
update public.payroll_work_items w
set obligation_usd = x.obligation_usd,
    payout_mode = x.payout_mode
from (
  select
    w2.id,
    round(
      (
        case
          when i.price_denomination='USD'
            then a.amount_ref * i.bcv_rate_snapshot / nullif(i.operative_rate_snapshot,0)
          else a.amount_ref
        end
      ) * p.value_ves / nullif(o.total_ves,0)
    ,2) as obligation_usd,
    case when p.currency='USD' then 'HARD_USD' else 'BCV_VES' end as payout_mode
  from public.payroll_work_items w2
  join public.payroll_accruals a on a.id=w2.accrual_id
  join public.order_items i on i.id=a.source_order_item_id
  join public.orders o on o.id=w2.order_id
  join public.payments p on p.id=w2.payment_id
  where w2.payroll_run_id is null
    and w2.reversal_of is null
    and o.total_ves>0
    and p.value_ves>0
) x
where w.id=x.id;

update public.payroll_work_items w
set obligation_usd = -abs(coalesce(src.obligation_usd,
  case when src.currency='USD' then src.amount else src.amount*src.ref_per_unit end)),
    payout_mode = coalesce(src.payout_mode,case when src.currency='USD' then 'HARD_USD' else 'BCV_VES' end)
from public.payroll_work_items src
where w.payroll_run_id is null
  and w.reversal_of=src.id;

create or replace function lubricenter_private.payroll_sync()
returns void language plpgsql security definer set search_path='' as $$
begin
 perform lubricenter_private.require_order_admin();
 perform pg_advisory_xact_lock(240924,1);
 perform 1
 from public.orders o
 where exists(select 1 from public.payroll_work_items w where w.order_id=o.id)
    or exists(
      select 1
      from public.order_items i
      join public.payroll_accruals a on a.source_order_item_id=i.id
      where i.order_id=o.id and a.payroll_run_id is null
    )
 order by o.id for update;

 insert into public.payroll_work_items(
   accrual_id,payment_id,employee_id,order_id,order_number,description,source_type,
   currency,original_amount,amount,ref_per_unit,obligation_usd,payout_mode,earned_at