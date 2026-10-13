-- Read-only invoice-date billing report, separated by the currency of actual payment.
-- USD, USDT (Binance) and Zelle receipts are excluded from the VES/BCV invoice total.
-- The financed/uncollected residual stays with the VES invoice and is never a new collection.
-- This migration only defines functions and permissions; no financial rows are updated.

create or replace function lubricenter_private.finance_sales_bcv(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path=''
as $fn$
declare
  v_start timestamptz;
  v_end timestamptz;
  v_report jsonb;
begin
  perform lubricenter_private.finance_require();
  if p_from is null or p_to is null or p_from>p_to or p_to-p_from>366 then
    raise exception 'Selecciona un período válido de máximo 367 días';
  end if;
  v_start := p_from::timestamp at time zone 'America/Caracas';
  v_end := (p_to + 1)::timestamp at time zone 'America/Caracas';

  with invoice_lines as (
    select i.order_id,
      sum(i.charged_ves_amount) as line_ves,
      sum(i.charged_ves_amount/nullif(i.bcv_rate_snapshot,0)) as line_bcv,
      count(*) filter (where i.bcv_rate_snapshot is null or i.bcv_rate_snapshot<=0) as missing_rates
    from public.order_items i
    group by i.order_id
  ), invoice_payments as (
    -- Aggregate independently: joining individual payments to items would multiply the invoice.
    select p.order_id,
      coalesce(sum(p.value_ves) filter(where p.currency='USD'),0) as usd_ves,
      coalesce(sum(p.amount_original) filter(where p.currency='USD'),0) as usd_native,
      coalesce(sum(p.value_ves) filter(where p.currency='VES'),0) as ves_collected
    from public.payments p
    group by p.order_id
  ), invoices as (
    select o.id, o.total_ves, o.total_ref,
      coalesce(ip.usd_ves,0) usd_ves, coalesce(ip.usd_native,0) usd_native,
      coalesce(ip.ves_collected,0) ves_collected,
      coalesce(il.missing_rates,1) missing_rates,
      case when il.line_ves>0 and il.missing_rates=0
        then il.line_bcv/il.line_ves else null end as invoice_bcv_factor,
      (cs.id is not null) cashea,
      (cs.id is not null and cs.ownership_status<>'OWN') unknown_cashea
    from public.orders o
    left join invoice_lines il on il.order_id=o.id
    left join invoice_payments ip on ip.order_id=o.id
    left join public.cashea_sales cs on cs.order_id=o.id
    where o.status='CLOSED'
      and coalesce(o.business_at,o.closed_at)>=v_start
      and coalesce(o.business_at,o.closed_at)<v_end
  ), sums as (
    select
      count(*) filter (where not unknown_cashea) order_count,
      coalesce(sum(total_ref) filter(where not unknown_cashea),0) gross_ref,
      coalesce(sum(total_ves) filter(where not unknown_cashea),0) gross_ves,
      coalesce(sum(usd_native) filter(where not unknown_cashea),0) divisa_usd,
      coalesce(sum(usd_ves) filter(where not unknown_cashea),0) divisa_ves_equiv,
      coalesce(sum(greatest(total_ves-usd_ves,0))
        filter(where not unknown_cashea),0) billed_ves,
      coalesce(sum(greatest(total_ves-usd_ves,0)*invoice_bcv_factor)
        filter(where not unknown_cashea and invoice_bcv_factor is not null
          and usd_ves<=total_ves+0.01),0) billed_bcv,
      coalesce(sum(greatest(total_ves-usd_ves-ves_collected,0))
        filter(where not unknown_cashea),0) pending_ves,
      count(*) filter(where not unknown_cashea and missing_rates>0) missing_bcv_orders,
      count(*) filter(where not unknown_cashea and usd_ves>total_ves+0.01) usd_overpaid_orders,
      count(*) filter(where not unknown_cashea and cashea) cashea_orders,
      coalesce(sum(greatest(total_ves-usd_ves,0)*invoice_bcv_factor)
        filter(where not unknown_cashea and cashea and invoice_bcv_factor is not null),0) cashea_bcv,
      count(*) filter(where unknown_cashea) cashea_other_or_unresolved
    from invoices
  )
  select jsonb_build_object(
    'period',jsonb_build_object('from',p_from,'to',p_to),
    'orders',order_count,
    'gross_ref',round(gross_ref,4),
    'gross_ves',round(gross_ves,2),
    'sales_ves',round(billed_ves,2),
    'sales_bcv',case when missing_bcv_orders>0 or usd_overpaid_orders>0 then null
      else round(billed_bcv,4) end,
    'sales_divisas_usd',round(divisa_usd,4),
    'pending_invoice_ves',round(pending_ves,2),
    'cashea_orders',cashea_orders,
    'cashea_sales_bcv',case when missing_bcv_orders>0 or usd_overpaid_orders>0
      then null else round(cashea_bcv,4) end,
    'warnings',jsonb_build_object('missing_order_bcv',missing_bcv_orders,
      'usd_overpayment',usd_overpaid_orders,
      'excluded_cashea_other_or_unresolved',cashea_other_or_unresolved)
  ) into v_report from sums;
  return v_report;
end $fn$;

create or replace function public.finance_sales_bcv(p_from date,p_to date)
returns jsonb language sql stable security invoker set search_path=''
as $$ select lubricenter_private.finance_sales_bcv(p_from,p_to) $$;

revoke all on function lubricenter_private.finance_sales_bcv(date,date) from public,anon;
revoke all on function public.finance_sales_bcv(date,date) from public,anon;
grant execute on function lubricenter_private.finance_sales_bcv(date,date) to authenticated;
grant execute on function public.finance_sales_bcv(date,date) to authenticated;
