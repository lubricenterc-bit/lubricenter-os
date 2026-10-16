-- Additive, read-only management report. No sale, payment, balance or rate is rewritten.
-- Sales use the invoice business date in Caracas. Credit repayments never reclassify a sale.
create or replace function lubricenter_private.finance_management_report(p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path=''
as $report$
declare v_start timestamptz; v_end timestamptz; v_result jsonb;
begin
 perform lubricenter_private.finance_require();
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>366
    or p_to>(now() at time zone 'America/Caracas')::date then
  raise exception 'Selecciona fechas válidas, hasta hoy y de máximo 367 días';
 end if;
 v_start:=p_from::timestamp at time zone 'America/Caracas';
 v_end:=(p_to+1)::timestamp at time zone 'America/Caracas';
 with line_rates as (
  select i.order_id,
   case when sum(i.charged_ves_amount)>0
     and count(*) filter(where i.bcv_rate_snapshot is null or i.bcv_rate_snapshot<=0)=0
    then sum(i.charged_ves_amount/nullif(i.bcv_rate_snapshot,0))/sum(i.charged_ves_amount)
    else null end factor
  from public.order_items i group by i.order_id
 ), checkout as (
  select p.order_id,
   coalesce(sum(p.value_ves) filter(where p.currency='VES'),0) cash_ves,
   coalesce(sum(p.value_ves) filter(where p.currency='USD'),0) usd_ves,
   coalesce(sum(p.amount_original) filter(where p.currency='USD'),0) usd_native,
   array_agg(distinct p.method order by p.method) methods
  from public.payments p
  where p.receivable_id is null and p.paid_at<v_end
  group by p.order_id
 ), invoices as (
  select o.id,o.order_number,coalesce(o.business_at,o.closed_at) business_at,
   coalesce(c.name,'Cliente de mostrador') customer,coalesce(v.plate,'') plate,
   coalesce(l.name,'Sede sin identificar') location,
   o.total_ves,lr.factor,cs.id is not null is_cashea,
   cs.id is not null and (cs.ownership_status is distinct from 'OWN' or cs.status='CANCELLED') excluded,
   coalesce(ch.cash_ves,0) cash_ves,coalesce(ch.usd_ves,0) usd_ves,
   coalesce(ch.usd_native,0) usd_native,coalesce(ch.methods,'{}'::text[]) methods,
   coalesce(cs.initial_ref,0) initial_ref,coalesce(cs.financed_ref,0) financed_ref,
   coalesce(cs.commission_ref,0) commission_ref
  from public.orders o
  left join line_rates lr on lr.order_id=o.id
  left join checkout ch on ch.order_id=o.id
  left join public.cashea_sales cs on cs.order_id=o.id
  left join public.customers c on c.id=o.customer_id
  left join public.vehicles v on v.id=o.vehicle_id
  left join public.locations l on l.id=o.location_id
  where o.status='CLOSED' and coalesce(o.business_at,o.closed_at)>=v_start
   and coalesce(o.business_at,o.closed_at)<v_end
 ), allocation as (
  select *,case when is_cashea then total_ves else 0 end cashea_ves,
   case when is_cashea then 0 else cash_ves end contado_ves,
   case when is_cashea then 0 else usd_native end divisas_usd,
   case when is_cashea then 0 else greatest(total_ves-cash_ves-usd_ves,0) end credit_ves,
   (cash_ves+usd_ves>total_ves+0.01) overpaid
  from invoices where not excluded
 ), allocated as (
  select *,case when cashea_ves=0 then 0 else cashea_ves*factor end cashea_bcv,
   case when contado_ves=0 then 0 else contado_ves*factor end contado_bcv,
   case when credit_ves=0 then 0 else credit_ves*factor end credit_bcv,
   case when is_cashea then 'CASHEA'
    when (case when cash_ves>0 then 1 else 0 end+case when usd_native>0 then 1 else 0 end
      +case when credit_ves>0.01 then 1 else 0 end)>1 then 'MIXTA'
    when credit_ves>0.01 then 'CREDITO' when usd_native>0 then 'DIVISAS' else 'CONTADO' end channel
  from allocation
 ), sales as (
  select count(*) orders,coalesce(sum(total_ves),0) gross_ves,
   coalesce(sum(cashea_ves),0) cashea_ves,coalesce(sum(cashea_bcv),0) cashea_bcv,
   coalesce(sum(contado_ves),0) contado_ves,coalesce(sum(contado_bcv),0) contado_bcv,
   coalesce(sum(divisas_usd),0) divisas_usd,
   coalesce(sum(credit_ves),0) credit_ves,coalesce(sum(credit_bcv),0) credit_bcv,
   count(*) filter(where is_cashea) cashea_orders,
   count(*) filter(where contado_ves>0) contado_orders,
   count(*) filter(where divisas_usd>0) divisas_orders,
   count(*) filter(where credit_ves>0.01) credit_orders,
   count(*) filter(where factor is null and (cashea_ves+contado_ves+credit_ves)>0) missing_rates,
   count(*) filter(where overpaid) overpaid,
   coalesce(sum(initial_ref) filter(where is_cashea),0) cashea_initial_ref,
   coalesce(sum(financed_ref) filter(where is_cashea),0) cashea_financed_ref,
   coalesce(sum(commission_ref) filter(where is_cashea),0) cashea_commission_ref
  from allocated
 ), credit_payments as (
  select receivable_id,sum(value_ves) paid_ves from public.payments
  where receivable_id is not null and paid_at<v_end group by receivable_id
 ), customer_debts as (
  select r.id,r.order_id,o.order_number,coalesce(c.name,'Cliente sin identificar') customer,
   r.due_date,r.principal_ves,greatest(r.principal_ves-coalesce(cp.paid_ves,0),0) outstanding_ves,
   lr.factor
  from public.receivables r
  join public.orders o on o.id=r.order_id and o.status='CLOSED'
  left join public.customers c on c.id=r.customer_id
  left join line_rates lr on lr.order_id=r.order_id
  left join credit_payments cp on cp.receivable_id=r.id
  where r.debtor_type<>'CASHEA' and r.created_at<v_end
   and coalesce(o.business_at,o.closed_at)<v_end
   and (r.status<>'CANCELLED' or r.closed_at>=v_end)
 ), debts as (
  select count(*) filter(where outstanding_ves>0.01) accounts,
   coalesce(sum(outstanding_ves),0) outstanding_ves,
   case when count(*) filter(where outstanding_ves>0.01 and factor is null)>0 then null
    else coalesce(sum(outstanding_ves*factor),0) end outstanding_bcv,
   count(*) filter(where outstanding_ves>0.01 and due_date<p_to) overdue
  from customer_debts
 ), cashea_opening as (
  select max(occurred_on) opening_on from public.cashea_balance_events
  where kind in ('OPENING_CREDIT','OPENING_DEBIT') and occurred_on<=p_to
   and (reversed_at is null or reversed_at>=v_end)
 ), cashea_ledger as (
  select b.opening_on,count(e.id) events,
   case when b.opening_on is null then null else coalesce(sum(e.amount_ref*
    case when e.kind in ('SERVICE_DEDUCTION','PAYOUT','OPENING_DEBIT','ADJUSTMENT_DEBIT') then -1 else 1 end),0) end recorded_ref
  from cashea_opening b left join public.cashea_balance_events e
   on e.occurred_on<=p_to and e.occurred_on>=b.opening_on
   and (e.reversed_at is null or e.reversed_at>=v_end)
  group by b.opening_on
 )
 select jsonb_build_object('period',jsonb_build_object('from',p_from,'to',p_to,'timezone','America/Caracas'),
  'generated_at',now(),'totals',jsonb_build_object('orders',s.orders,'gross_ves',round(s.gross_ves,2),
   'sales_equivalent',case when s.missing_rates>0 or s.overpaid>0 then null
    else round(s.cashea_bcv+s.contado_bcv+s.divisas_usd+s.credit_bcv,4) end),
  'channels',jsonb_build_object(
   'cashea',jsonb_build_object('orders',s.cashea_orders,'ves',round(s.cashea_ves,2),
    'equivalent',case when s.missing_rates>0 or s.overpaid>0 then null else round(s.cashea_bcv,4) end,
    'initial_ref',s.cashea_initial_ref,'financed_ref',s.cashea_financed_ref,'commission_ref',s.cashea_commission_ref),
   'contado',jsonb_build_object('orders',s.contado_orders,'ves',round(s.contado_ves,2),
    'equivalent',case when s.missing_rates>0 or s.overpaid>0 then null else round(s.contado_bcv,4) end),
   'divisas',jsonb_build_object('orders',s.divisas_orders,'usd',round(s.divisas_usd,4),'equivalent',round(s.divisas_usd,4)),
   'credito',jsonb_build_object('orders',s.credit_orders,'ves',round(s.credit_ves,2),
    'equivalent',case when s.missing_rates>0 or s.overpaid>0 then null else round(s.credit_bcv,4) end)),
  'receivables',jsonb_build_object('as_of',p_to,'accounts',d.accounts,'overdue',d.overdue,
   'outstanding_ves',round(d.outstanding_ves,2),'outstanding_bcv',round(d.outstanding_bcv,4),
   'cashea_recorded_ref',cl.recorded_ref,'cashea_opening_on',cl.opening_on,
   'items',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'order_id',x.order_id,'order_number',x.order_number,
    'customer',x.customer,'due_date',x.due_date,'outstanding_ves',round(x.outstanding_ves,2),
    'outstanding_bcv',round(x.outstanding_ves*x.factor,4)) order by x.due_date nulls last,x.order_number)
    from customer_debts x where x.outstanding_ves>0.01),'[]'::jsonb)),
  'orders',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'order_number',a.order_number,
   'business_at',a.business_at,'customer',a.customer,'plate',a.plate,'location',a.location,
   'channel',a.channel,'methods',a.methods,'total_ves',round(a.total_ves,2),
   'sales_equivalent',case when a.overpaid then null else round(a.cashea_bcv+a.contado_bcv+a.divisas_usd+a.credit_bcv,4) end,
   'cashea_bcv',round(a.cashea_bcv,4),'contado_bcv',round(a.contado_bcv,4),
   'divisas_usd',round(a.divisas_usd,4),'credit_bcv',round(a.credit_bcv,4))
   order by a.business_at desc,a.order_number desc) from allocated a),'[]'::jsonb),
  'warnings',jsonb_build_object('missing_invoice_rates',s.missing_rates,'overpaid_orders',s.overpaid,
   'excluded_cashea',(select count(*) from invoices where excluded)))
 into v_result from sales s cross join debts d cross join cashea_ledger cl;
 return v_result;
end $report$;

create or replace function public.finance_management_report(p_from date,p_to date)
returns jsonb language sql stable security invoker set search_path=''
as $$select lubricenter_private.finance_management_report(p_from,p_to)$$;
revoke all on function lubricenter_private.finance_management_report(date,date),public.finance_management_report(date,date) from public,anon;
grant execute on function lubricenter_private.finance_management_report(date,date),public.finance_management_report(date,date) to authenticated;
