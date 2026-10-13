-- Independent VES, BCV and USD financial reporting.
-- Reporting only: no historical payment, sale or balance is rewritten.
create or replace function lubricenter_private.finance_currency_summary(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path = ''
as $$
declare
  v_from timestamptz;
  v_until timestamptz;
  v_data jsonb;
begin
  perform lubricenter_private.finance_require();
  if p_from is null or p_to is null or p_from > p_to or p_to-p_from > 366 then
    raise exception 'Selecciona un período válido de máximo 367 días';
  end if;
  v_from := p_from::timestamp at time zone 'America/Caracas';
  v_until := (p_to + 1)::timestamp at time zone 'America/Caracas';

  with movements as (
    select m.id, m.account_id, a.code, a.name, a.account_type, a.currency,
      m.direction, m.movement_type, m.finance_nature, m.transfer_group,
      m.amount_original, m.occurred_at,
      coalesce(nullif(p.bcv_rate_snapshot,0), rb.value) bcv,
      coalesce(nullif(p.operative_rate_snapshot,0), ro.value) operative
    from public.account_movements m
    join public.financial_accounts a on a.id=m.account_id
    left join public.payments p on p.id=m.source_payment_id
    left join lateral (
      select r.value from public.exchange_rates r
      where r.rate_type='BCV' and r.effective_at <= m.occurred_at
      order by r.effective_at desc, r.created_at desc limit 1
    ) rb on true
    left join lateral (
      select r.value from public.exchange_rates r
      where r.rate_type='OPERATIVE' and r.effective_at <= m.occurred_at
      order by r.effective_at desc, r.created_at desc limit 1
    ) ro on true
    where m.occurred_at >= v_from and m.occurred_at < v_until
      and a.account_type <> 'RELATED'
  ), totals as (
    select
      coalesce(sum(amount_original) filter(where currency='VES' and direction='IN'),0) ves_in,
      coalesce(sum(amount_original) filter(where currency='VES' and direction='OUT'),0) ves_out,
      coalesce(sum(amount_original) filter(where currency='VES' and direction='IN' and movement_type<>'TRANSFER'),0) ves_external_in,
      coalesce(sum(amount_original) filter(where currency='VES' and direction='OUT' and movement_type<>'TRANSFER'),0) ves_external_out,
      coalesce(sum(amount_original) filter(where currency='VES' and direction='IN' and movement_type='PAYMENT'),0) ves_payments,
      coalesce(sum(amount_original) filter(where currency='USD' and direction='IN'),0) usd_in,
      coalesce(sum(amount_original) filter(where currency='USD' and direction='OUT'),0) usd_out,
      coalesce(sum(amount_original) filter(where currency='USD' and direction='IN' and movement_type<>'TRANSFER'),0) usd_external_in,
      coalesce(sum(amount_original) filter(where currency='USD' and direction='OUT' and movement_type<>'TRANSFER'),0) usd_external_out,
      coalesce(sum(amount_original) filter(where currency='USD' and direction='IN' and movement_type='PAYMENT'),0) usd_payments,
      coalesce(sum(amount_original / nullif(bcv,0)) filter(where currency='VES' and direction='IN'),0) bcv_in,
      coalesce(sum(amount_original / nullif(bcv,0)) filter(where currency='VES' and direction='OUT'),0) bcv_out,
      coalesce(sum(amount_original / nullif(bcv,0)) filter(where currency='VES' and direction='IN' and movement_type<>'TRANSFER'),0) bcv_external_in,
      coalesce(sum(amount_original / nullif(bcv,0)) filter(where currency='VES' and direction='OUT' and movement_type<>'TRANSFER'),0) bcv_external_out,
      coalesce(sum(amount_original / nullif(bcv,0)) filter(where currency='VES' and direction='IN' and movement_type='PAYMENT'),0) bcv_payments,
      coalesce(sum(amount_original / nullif(operative,0)) filter(where currency='VES' and direction='IN'),0) op_in,
      coalesce(sum(amount_original / nullif(operative,0)) filter(where currency='VES' and direction='OUT'),0) op_out,
      coalesce(sum(amount_original / nullif(operative,0)) filter(where currency='VES' and direction='IN' and movement_type<>'TRANSFER'),0) op_external_in,
      coalesce(sum(amount_original / nullif(operative,0)) filter(where currency='VES' and direction='OUT' and movement_type<>'TRANSFER'),0) op_external_out,
      count(*) filter(where currency='VES' and (bcv is null or bcv<=0)) missing_bcv,
      count(*) filter(where currency='VES' and (operative is null or operative<=0)) missing_op,
      count(*) filter(where movement_type='ADJUSTMENT' and finance_nature is null) unclassified_adjustments,
      count(*) filter(where movement_type='TRANSFER' and transfer_group is null) unmatched_transfers
    from movements
  ), sales as (
    -- Allocation by recorded payment currency, dated by the CLOSED order's business date.
    -- Unpaid/financed portions remain unallocated, never silently mapped to VES or USD.
    select
      coalesce(sum(p.amount_original) filter(where p.currency='VES'),0) ves_assigned,
      coalesce(sum(p.amount_original) filter(where p.currency='USD'),0) usd_assigned,
      count(distinct o.id) orders_with_payments
    from public.orders o join public.payments p on p.order_id=o.id
    where o.status='CLOSED'
      and coalesce(o.business_at,o.closed_at)>=v_from
      and coalesce(o.business_at,o.closed_at)<v_until
  ), cashea as (
    select count(*) sales,
      coalesce(sum(cs.gross_ref),0) gross_ref,
      coalesce(sum(cs.initial_ref),0) initial_ref,
      coalesce(sum(cs.financed_ref),0) financed_ref,
      coalesce(sum(cs.commission_ref),0) commission_ref
    from public.cashea_sales cs
    join public.orders o on o.id=cs.order_id
    where cs.ownership_status='OWN' and o.status='CLOSED'
      and coalesce(o.business_at,o.closed_at)>=v_from
      and coalesce(o.business_at,o.closed_at)<v_until
  ), cashea_payouts as (
    select
      coalesce(sum(e.amount_ref) filter(where x.ownership_status='OWN'),0) linked_ref,
      count(*) filter(where e.bank_transaction_id is null) unlinked
    from public.cashea_balance_events e
    left join public.external_transactions x on x.id=e.bank_transaction_id
    where e.kind='PAYOUT' and e.reversed_at is null
      and e.occurred_on between p_from and p_to
  ), per_account as (
    select a.id, a.code, a.name, a.currency, a.account_type,
      coalesce((select sum(case when m.direction='IN' then m.amount_original else -m.amount_original end)
        from public.account_movements m where m.account_id=a.id and m.occurred_at<v_from),0) opening,
      coalesce((select sum(m.amount_original)
        from public.account_movements m where m.account_id=a.id and m.direction='IN' and m.occurred_at>=v_from and m.occurred_at<v_until),0) incoming,
      coalesce((select sum(m.amount_original)
        from public.account_movements m where m.account_id=a.id and m.direction='OUT' and m.occurred_at>=v_from and m.occurred_at<v_until),0) outgoing,
      coalesce((select sum(case when m.direction='IN' then m.amount_original else -m.amount_original end)
        from public.account_movements m where m.account_id=a.id and m.occurred_at<v_until),0) closing,
      (select ca.actual_native from public.cash_closing_accounts ca
        join public.cash_closings cc on cc.id=ca.cash_closing_id
        where ca.account_id=a.id and cc.business_date=p_to
          and cc.status in ('REVIEW','CLOSED')
        order by cc.updated_at desc limit 1) counted
    from public.financial_accounts a
    where a.active and a.account_type<>'RELATED'
  )
  select jsonb_build_object(
    'period',jsonb_build_object('from',p_from,'to',p_to),
    'bs',jsonb_build_object('sales_assigned',s.ves_assigned,'collections',t.ves_payments,
      'entries',t.ves_in,'external_entries',t.ves_external_in,
      'outflows',t.ves_out,'external_outflows',t.ves_external_out),
    'bcv',jsonb_build_object('collections',case when t.missing_bcv>0 then null else t.bcv_payments end,
      'entries',case when t.missing_bcv>0 then null else t.bcv_in end,
      'external_entries',case when t.missing_bcv>0 then null else t.bcv_external_in end,
      'outflows',case when t.missing_bcv>0 then null else t.bcv_out end,
      'external_outflows',case when t.missing_bcv>0 then null else t.bcv_external_out end),
    'usd',jsonb_build_object('sales_assigned',s.usd_assigned,'collections',t.usd_payments,
      'entries',t.usd_in,'external_entries',t.usd_external_in,
      'outflows',t.usd_out,'external_outflows',t.usd_external_out),
    'operative',jsonb_build_object('entries',case when t.missing_op>0 then null else t.op_in end,
      'external_entries',case when t.missing_op>0 then null else t.op_external_in end,
      'outflows',case when t.missing_op>0 then null else t.op_out end,
      'external_outflows',case when t.missing_op>0 then null else t.op_external_out end),
    'accounts',coalesce((select jsonb_agg(to_jsonb(a) order by a.currency,a.name) from per_account a),'[]'::jsonb),
    'cashea',jsonb_build_object('sales',c.sales,'gross_ref',c.gross_ref,'initial_ref',c.initial_ref,
      'financed_ref',c.financed_ref,'commission_ref',c.commission_ref,
      'payouts_linked_ref',cp.linked_ref,'payouts_unlinked',cp.unlinked),
    'warnings',jsonb_build_object('bcv_missing',t.missing_bcv,'operative_missing',t.missing_op,
      'unclassified_adjustments',t.unclassified_adjustments,
      'unmatched_transfers',t.unmatched_transfers)
  ) into v_data
  from totals t cross join sales s cross join cashea c cross join cashea_payouts cp;
  return v_data;
end $$;

create or replace function public.finance_currency_summary(p_from date,p_to date)
returns jsonb language sql stable security invoker set search_path=''
as $$ select lubricenter_private.finance_currency_summary(p_from,p_to) $$;
revoke all on function lubricenter_private.finance_currency_summary(date,date) from public,anon;
revoke all on function public.finance_currency_summary(date,date) from public,anon;
grant execute on function lubricenter_private.finance_currency_summary(date,date) to authenticated;
grant execute on function public.finance_currency_summary(date,date) to authenticated;

-- FX transfers: both native amounts are supplied explicitly. This never creates sales/payments.
create or replace function lubricenter_private.finance_transfer_fx(
 p_from_account_id uuid,p_to_account_id uuid,
 p_from_amount numeric,p_to_amount numeric,
 p_note text default null,p_reference text default null
) returns uuid language plpgsql security definer set search_path=''
as $$
declare a public.financial_accounts; b public.financial_accounts;
        g uuid := gen_random_uuid(); ves numeric;
begin
 perform lubricenter_private.finance_require();
 if p_from_account_id=p_to_account_id or p_from_amount is null or p_to_amount is null
    or p_from_amount<=0 or p_to_amount<=0 or p_from_amount>=1000000000000
    or p_to_amount>=1000000000000 or p_from_amount::text in ('NaN','Infinity','-Infinity')
    or p_to_amount::text in ('NaN','Infinity','-Infinity') then
   raise exception 'Cuentas o importes de conversión inválidos';
 end if;
 select * into a from public.financial_accounts where id=p_from_account_id and active=true;
 select * into b from public.financial_accounts where id=p_to_account_id and active=true;
 if a.id is null or b.id is null or a.currency=b.currency
    or a.account_type='RELATED' or b.account_type='RELATED' then
   raise exception 'Elige dos cuentas propias activas de distinta moneda';
 end if;
 ves:=case when a.currency='VES' then p_from_amount else p_to_amount end;
 insert into public.account_movements
 (account_id,direction,movement_type,finance_nature,transfer_group,currency,amount_original,value_ves,note,reference,occurred_at)
 values
 (a.id,'OUT','TRANSFER','INTERNAL_TRANSFER',g,a.currency,p_from_amount,ves,nullif(trim(p_note),''),nullif(trim(p_reference),''),now()),
 (b.id,'IN','TRANSFER','INTERNAL_TRANSFER',g,b.currency,p_to_amount,ves,nullif(trim(p_note),''),nullif(trim(p_reference),''),now());
 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values ('cash.fx_transfer','transfer',g,jsonb_build_object(
   'from_account',a.code,'to_account',b.code,
   'from_amount',p_from_amount,'to_amount',p_to_amount,
   'ves_amount',ves,'usd_amount',case when a.currency='USD' then p_from_amount else p_to_amount end));
 return g;
end $$;

create or replace function public.finance_transfer_fx(
 p_from_account_id uuid,p_to_account_id uuid,
 p_from_amount numeric,p_to_amount numeric,
 p_note text default null,p_reference text default null
) returns uuid language sql security invoker set search_path=''
as $$ select lubricenter_private.finance_transfer_fx(p_from_account_id,p_to_account_id,p_from_amount,p_to_amount,p_note,p_reference) $$;
revoke all on function lubricenter_private.finance_transfer_fx(uuid,uuid,numeric,numeric,text,text) from public,anon;
revoke all on function public.finance_transfer_fx(uuid,uuid,numeric,numeric,text,text) from public,anon;
grant execute on function lubricenter_private.finance_transfer_fx(uuid,uuid,numeric,numeric,text,text) to authenticated;
grant execute on function public.finance_transfer_fx(uuid,uuid,numeric,numeric,text,text) to authenticated;
