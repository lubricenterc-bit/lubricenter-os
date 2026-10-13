-- Detailed, read-only order ledger for the daily sales screen.
-- Native collections and Cashea contractual initial are displayed separately.
-- SECURITY INVOKER preserves existing RLS. No financial records are altered.
create or replace function public.search_order_collection_v2(
  p_query text default '',
  p_status text default 'ALL',
  p_from date default null,
  p_to date default null,
  p_page integer default 0,
  p_payment_filter text default 'ALL'
) returns jsonb
language sql stable security invoker set search_path=''
as $orders$
with base as (
 select
   o.id, o.order_number, o.status, o.customer_id,
   coalesce(o.business_at,o.closed_at,o.opened_at) sale_at,
   o.cancellation_reason, c.name customer_name, v.plate,
   case when cs.id is not null then 'Cashea'
     when exists(select 1 from public.receivables rec
       where rec.order_id=o.id and rec.debtor_type='CUSTOMER') then 'Crédito LC'
     else 'Contado / mixto' end payment_type,
   (cs.id is not null or exists(select 1 from public.receivables rec where rec.order_id=o.id)) has_financed_sale,
   oi.kind, oi.total_ref, oi.total_ves,
   coalesce(pay.paid_ves,0) collected_ves,
   coalesce(pay.paid_usd,0) collected_usd,
   coalesce(pay.paid_usd_ves,0) collected_usd_ves_equiv,
   coalesce(pay.payment_details,'[]'::jsonb) payment_details,
   case when cs.id is null then null else jsonb_build_object(
     'status',cs.status,
     'ownership_status',cs.ownership_status,
     'initial_percent',cs.initial_percent,
     'initial_bcv_usd',cs.initial_ref,
     'initial_ves',cs.initial_ves_snapshot,
     'financed_bcv_usd',cs.financed_ref,
     'total_bcv_usd',cs.gross_ref,
     'bcv_rate',cs.bcv_rate_snapshot,
     'reference',cs.cashea_reference,
     'initial_method',cs.initial_payment_method
   ) end cashea,
   cs.initial_ref cashea_initial_ref,
   cs.initial_ves_snapshot cashea_initial_ves,
   cs.financed_ref cashea_financed_ref
 from public.orders o
 left join public.customers c on c.id=o.customer_id
 left join public.vehicles v on v.id=o.vehicle_id
 left join lateral (
   select s.* from public.cashea_sales s
   where s.order_id=o.id order by s.created_at desc,s.id limit 1
 ) cs on true
 left join lateral (
   select
     case when count(*) filter(where i.item_type='SERVICE')>0
       then 'Orden de servicio' else 'Venta' end kind,
     coalesce(sum(i.charged_ref_amount),0) total_ref,
     coalesce(sum(i.charged_ves_amount),0) total_ves
   from public.order_items i where i.order_id=o.id
 ) oi on true
 left join lateral (
   select
     coalesce(sum(p.amount_original) filter(where p.currency='VES'),0) paid_ves,
     coalesce(sum(p.amount_original) filter(where p.currency='USD'),0) paid_usd,
     coalesce(sum(p.value_ves) filter(where p.currency='USD'),0) paid_usd_ves,
     coalesce(jsonb_agg(jsonb_build_object(
       'method',p.method,
       'currency',p.currency,
       'amount_original',p.amount_original,
       'value_ves',p.value_ves,
       'bcv_rate',p.bcv_rate_snapshot,
       'equivalent_bcv',case when p.currency='VES'
         then p.amount_original/nullif(p.bcv_rate_snapshot,0)
         else p.value_ves/nullif(p.bcv_rate_snapshot,0) end,
       'reference_tail',right(coalesce(p.reference,''),4),
       'paid_at',p.paid_at
     ) order by p.paid_at,p.id) filter(where p.id is not null),'[]'::jsonb) payment_details
   from public.payments p where p.order_id=o.id
 ) pay on true
 where (p_status='ALL' or o.status=p_status)
   and (p_from is null or coalesce(o.business_at,o.closed_at,o.opened_at)>=
     (p_from::timestamp at time zone 'America/Caracas'))
   and (p_to is null or coalesce(o.business_at,o.closed_at,o.opened_at)<
     ((p_to+1)::timestamp at time zone 'America/Caracas'))
   and (btrim(coalesce(p_query,''))='' or concat_ws(' ',
       o.order_number,c.name,c.phone,v.plate,v.make,v.model)
       ilike '%'||btrim(p_query)||'%')
), filtered as (
 select * from base b where
   p_payment_filter='ALL'
   or (p_payment_filter='CASHEA' and b.cashea is not null)
   or (p_payment_filter='CONTADO' and b.payment_type='Contado / mixto')
   or (p_payment_filter='CREDIT' and b.payment_type='Crédito LC')
), paged as (
 select id,order_number,status,customer_id,sale_at,cancellation_reason,customer_name,plate,
   payment_type,has_financed_sale,kind,total_ref,total_ves,
   collected_ves,collected_usd,collected_usd_ves_equiv,payment_details,cashea
 from filtered order by sale_at desc,id desc
 limit 30 offset greatest(coalesce(p_page,0),0)*30
)
select jsonb_build_object(
 'count',(select count(*) from filtered),
 'summary',(
   select jsonb_build_object(
     'orders',count(*),
     'closed',count(*) filter(where status='CLOSED'),
     'cashea',count(*) filter(where status='CLOSED' and cashea is not null),
     'sales_ref',coalesce(sum(total_ref) filter(where status='CLOSED'),0),
     'collected_ves',coalesce(sum(collected_ves) filter(where status='CLOSED'),0),
     'collected_usd',coalesce(sum(collected_usd) filter(where status='CLOSED'),0),
     'cashea_initial_bcv',coalesce(sum(cashea_initial_ref) filter(where status='CLOSED'),0),
     'cashea_initial_ves',coalesce(sum(cashea_initial_ves) filter(where status='CLOSED'),0),
     'cashea_financed_bcv',coalesce(sum(cashea_financed_ref) filter(where status='CLOSED'),0)
   ) from filtered
 ),
 'rows',coalesce((select jsonb_agg(to_jsonb(p) order by p.sale_at desc,p.id desc) from paged p),'[]'::jsonb)
);
$orders$;

revoke all on function public.search_order_collection_v2(text,text,date,date,integer,text) from public,anon;
grant execute on function public.search_order_collection_v2(text,text,date,date,integer,text) to authenticated;
