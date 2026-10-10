-- Read-only queue for BDV outflows, independent of opening a financial week.
-- Classification continues through finance_classify_external: one auditable movement, no duplicate expense.
create or replace function lubricenter_private.finance_bank_outflows_review(
 p_from date, p_to date, p_offset integer default 0
) returns jsonb
language plpgsql stable security definer set search_path to ''
as $bank_review$
declare v_result jsonb;
begin
 perform lubricenter_private.finance_require();
 if p_from is null or p_to is null or p_to < p_from or p_to-p_from > 366 then
  raise exception 'Selecciona un período válido (máximo 366 días)';
 end if;
 select jsonb_build_object(
  'total', (select count(*) from public.external_transactions x join public.external_sources s on s.id=x.source_id
     where s.provider='BDV' and x.direction='OUT' and timezone('America/Caracas',x.occurred_at)::date between p_from and p_to),
  'pending', (select count(*) from public.external_transactions x join public.external_sources s on s.id=x.source_id
     where s.provider='BDV' and x.direction='OUT' and x.nature='UNCLASSIFIED'
       and timezone('America/Caracas',x.occurred_at)::date between p_from and p_to),
  'rows', coalesce((
    select jsonb_agg(to_jsonb(r) order by r.occurred_at desc,r.id desc) from (
      select x.id,x.occurred_at,x.reference,x.description,x.amount::text amount,x.currency,
       x.nature,x.category,x.category_id,x.ownership_status,x.classification_reason,
       exists(select 1 from public.reconciliation_allocations a where a.external_transaction_id=x.id and a.reversed_at is null) allocated
      from public.external_transactions x join public.external_sources s on s.id=x.source_id
      where s.provider='BDV' and x.direction='OUT'
        and timezone('America/Caracas',x.occurred_at)::date between p_from and p_to
      order by x.occurred_at desc,x.id desc limit 100 offset greatest(coalesce(p_offset,0),0)
    ) r),'[]'::jsonb),
  'accounts',coalesce((
    select jsonb_agg(jsonb_build_object('id',a.id,'code',a.code,'name',a.name,'currency',a.currency))
    from public.financial_accounts a where a.active and a.currency='VES'),'[]'::jsonb),
  'sources',coalesce((
    select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name))
    from public.external_sources s where s.provider='BDV' and s.active and s.account_id is not null),'[]'::jsonb),
  'categories',coalesce((
    select jsonb_agg(jsonb_build_object('id',c.id,'name',c.name,'nature',c.nature))
    from public.finance_categories c where c.active),'[]'::jsonb)
 ) into v_result;
 return v_result;
end;
$bank_review$;

create or replace function public.finance_bank_outflows_review(
 p_from date, p_to date, p_offset integer default 0
) returns jsonb
language sql stable set search_path to ''
as $api$
 select lubricenter_private.finance_bank_outflows_review(p_from,p_to,p_offset);
$api$;

revoke all on function lubricenter_private.finance_bank_outflows_review(date,date,integer) from public,anon;
revoke all on function public.finance_bank_outflows_review(date,date,integer) from public,anon;
grant execute on function public.finance_bank_outflows_review(date,date,integer) to authenticated;
grant execute on function lubricenter_private.finance_bank_outflows_review(date,date,integer) to authenticated;
