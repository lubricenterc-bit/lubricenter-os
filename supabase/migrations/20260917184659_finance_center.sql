alter table public.account_movements add column if not exists payee text;

create or replace function public.finance_dashboard(p_from date default null, p_to date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_from date := coalesce(p_from, date_trunc('month', timezone('America/Caracas', now()))::date);
  v_to date := coalesce(p_to, timezone('America/Caracas', now())::date);
  v_result jsonb;
begin
  perform public.require_auth();
  if v_from > v_to then raise exception 'La fecha inicial debe ser anterior a la final'; end if;
  if v_to - v_from > 366 then raise exception 'El período máximo es de 367 días'; end if;

  with classified_sales as (
    select o.id, o.total_ref, o.total_ves,
      timezone('America/Caracas', coalesce(o.business_at, o.closed_at))::date sale_date,
      case when cs.id is not null then 'CASHEA'
           when r.id is not null then 'CREDIT_LC'
           else 'CASH' end sale_type
    from public.orders o
    left join public.cashea_sales cs on cs.order_id = o.id
    left join public.receivables r on r.order_id = o.id and r.debtor_type <> 'CASHEA'
    where o.status = 'CLOSED'
      and coalesce(o.business_at, o.closed_at) >= (v_from::timestamp at time zone 'America/Caracas')
      and coalesce(o.business_at, o.closed_at) < ((v_to + 1)::timestamp at time zone 'America/Caracas')
  ), sales_summary as (
    select count(*) orders, coalesce(sum(total_ref),0) total_ref, coalesce(sum(total_ves),0) total_ves
    from classified_sales
  ), sales_by_type as (
    select sale_type, count(*) orders, coalesce(sum(total_ref),0) total_ref, coalesce(sum(total_ves),0) total_ves
    from classified_sales group by sale_type
  ), period_payments as (
    select p.* from public.payments p
    where p.paid_at >= (v_from::timestamp at time zone 'America/Caracas')
      and p.paid_at < ((v_to + 1)::timestamp at time zone 'America/Caracas')
  ), collections_summary as (
    select count(*) payments, coalesce(sum(value_ref),0) total_ref, coalesce(sum(value_ves),0) total_ves
    from period_payments
  ), collections_by_method as (
    select method, count(*) payments, coalesce(sum(value_ref),0) total_ref, coalesce(sum(value_ves),0) total_ves
    from period_payments group by method
  ), period_expenses as (
    select am.* from public.account_movements am
    where am.direction='OUT' and am.movement_type='EXPENSE'
      and am.occurred_at >= (v_from::timestamp at time zone 'America/Caracas')
      and am.occurred_at < ((v_to + 1)::timestamp at time zone 'America/Caracas')
  ), expense_summary as (
    select count(*) expenses, coalesce(sum(value_ves),0) total_ves from period_expenses
  ), expenses_by_category as (
    select coalesce(category,'Sin categoría') category, count(*) expenses, coalesce(sum(value_ves),0) total_ves
    from period_expenses group by coalesce(category,'Sin categoría')
  ), daily as (
    select d::date activity_date,
      coalesce((select sum(s.total_ref) from classified_sales s where s.sale_date=d::date),0) sales_ref,
      coalesce((select sum(p.value_ref) from period_payments p where timezone('America/Caracas',p.paid_at)::date=d::date),0) collected_ref,
      coalesce((select sum(e.value_ves) from period_expenses e where timezone('America/Caracas',e.occurred_at)::date=d::date),0) expenses_ves
    from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') d
  ), lc_open as (
    select count(*) accounts, coalesce(sum(outstanding_ves),0) outstanding_ves,
      count(*) filter(where due_date is not null and due_date < timezone('America/Caracas',now())::date) overdue
    from public.receivables where status='OPEN' and debtor_type <> 'CASHEA'
  ), cashea_open as (
    select count(distinct cs.id) sales,
      count(ci.id) filter(where ci.status in ('PENDING','PARTIAL')) installments,
      coalesce(sum(greatest(ci.amount_ref-ci.paid_ref,0)) filter(where ci.status in ('PENDING','PARTIAL')),0) outstanding_ref,
      count(ci.id) filter(where ci.status in ('PENDING','PARTIAL') and ci.due_date < timezone('America/Caracas',now())::date) overdue
    from public.cashea_sales cs left join public.cashea_installments ci on ci.cashea_sale_id=cs.id
    where cs.status <> 'SETTLED'
  ), balances as (
    select id,code,name,currency,account_type,balance_native,balance_ves
    from public.account_balances_current where active order by account_type,name
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from',v_from,'to',v_to,'days',v_to-v_from+1),
    'sales', (select to_jsonb(sales_summary) from sales_summary),
    'sales_by_type', coalesce((select jsonb_agg(to_jsonb(x) order by sale_type) from sales_by_type x),'[]'::jsonb),
    'collections', (select to_jsonb(collections_summary) from collections_summary),
    'collections_by_method', coalesce((select jsonb_agg(to_jsonb(x) order by total_ves desc) from collections_by_method x),'[]'::jsonb),
    'expenses', (select to_jsonb(expense_summary) from expense_summary),
    'expenses_by_category', coalesce((select jsonb_agg(to_jsonb(x) order by total_ves desc) from expenses_by_category x),'[]'::jsonb),
    'net_cash_ves', (select total_ves from collections_summary) - (select total_ves from expense_summary),
    'lc_open', (select to_jsonb(lc_open) from lc_open),
    'cashea_open', (select to_jsonb(cashea_open) from cashea_open),
    'accounts', coalesce((select jsonb_agg(to_jsonb(x)) from balances x),'[]'::jsonb),
    'daily', coalesce((select jsonb_agg(to_jsonb(x) order by activity_date) from daily x),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$;

create or replace function public.record_account_expense_v2(
  p_account_id uuid,
  p_amount numeric,
  p_category text,
  p_payee text default null,
  p_note text default null,
  p_reference text default null,
  p_occurred_on date default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_account public.financial_accounts;
  v_day date := coalesce(p_occurred_on, timezone('America/Caracas',now())::date);
  v_op numeric;
  v_value_ves numeric;
  v_id uuid;
  v_occurred_at timestamptz;
begin
  perform public.require_auth();
  select * into v_account from public.financial_accounts where id=p_account_id and active=true;
  if not found then raise exception 'Cuenta no encontrada'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Monto inválido'; end if;
  if coalesce(trim(p_category),'')='' then raise exception 'Categoría requerida'; end if;
  if v_day > timezone('America/Caracas',now())::date then raise exception 'La fecha del gasto no puede ser futura'; end if;
  if v_day < timezone('America/Caracas',now())::date - 1825 then raise exception 'La fecha del gasto es demasiado antigua'; end if;

  select value into v_op from public.exchange_rates
  where rate_type='OPERATIVE' and timezone('America/Caracas',effective_at)::date <= v_day
  order by effective_at desc limit 1;
  if v_op is null then select operative_rate into v_op from public.current_exchange_rates; end if;
  v_value_ves := case when v_account.currency='USD' then p_amount*v_op else p_amount end;
  v_occurred_at := ((v_day::timestamp + time '12:00') at time zone 'America/Caracas');

  insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,payee,note,reference,occurred_at)
  values(p_account_id,'OUT','EXPENSE',v_account.currency,p_amount,round(v_value_ves,2),trim(p_category),nullif(trim(p_payee),''),nullif(trim(p_note),''),nullif(trim(p_reference),''),v_occurred_at)
  returning id into v_id;

  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('cash.expense_recorded','account_movement',v_id,jsonb_build_object(
    'account_id',p_account_id,'amount',p_amount,'currency',v_account.currency,
    'category',trim(p_category),'payee',nullif(trim(p_payee),''),'occurred_on',v_day
  ));
  return v_id;
end;
$function$;

revoke all on function public.finance_dashboard(date,date) from public, anon;
revoke all on function public.record_account_expense_v2(uuid,numeric,text,text,text,text,date) from public, anon;
grant execute on function public.finance_dashboard(date,date) to authenticated;
grant execute on function public.record_account_expense_v2(uuid,numeric,text,text,text,text,date) to authenticated;

