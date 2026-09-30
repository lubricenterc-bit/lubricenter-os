-- An unresolved contradictory source report cannot be shown as a verified month.
create or replace function lubricenter_private.finance_report_coverage(p_from date default null,p_to date default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_from date:=coalesce(p_from,date_trunc('month',timezone('America/Caracas',now()))::date);
 v_to date:=coalesce(p_to,timezone('America/Caracas',now())::date);
 s record; v_rows jsonb:='[]'::jsonb; v_missing date; v_conflict date;
 v_complete integer; v_review integer; v_source_conflicts integer; v_source_conflict_from date;
 v_snapshot timestamptz; v_status text; v_stop date;
begin
 perform lubricenter_private.finance_require();
 if v_from>v_to or v_to-v_from>366 then raise exception 'Selecciona un período válido de máximo un año'; end if;
 for s in select * from public.external_sources where active order by provider,name,id loop
  select count(*) filter(where b.status='COMPLETE'),count(*) filter(where b.status='REVIEW')
   into v_complete,v_review from public.external_import_batches b
   where b.source_id=s.id and b.requested_from<=v_to and b.requested_to>=v_from;
  v_missing:=null; v_conflict:=null; v_snapshot:=null;
  select count(*), min(timezone('America/Caracas',x.occurred_at)::date)
   into v_source_conflicts,v_source_conflict_from
   from public.reconciliation_cases c
   join public.external_transactions x on x.id=c.subject_id
   where c.status='OPEN' and c.kind in ('SOURCE_CONFLICT','SOURCE_AMOUNT')
    and x.source_id=s.id
    and timezone('America/Caracas',x.occurred_at)::date between v_from and v_to;
  if s.provider='CASHEA_ORDERS' then
   select max(verified_at) into v_snapshot from public.external_import_batches
    where source_id=s.id and status='COMPLETE';
   v_status:=case when v_source_conflicts>0 then 'SOURCE_CONFLICT'
    when v_review>0 then 'NEEDS_VERIFICATION'
    when v_snapshot is not null then 'SNAPSHOT_AVAILABLE' else 'MISSING_REPORT' end;
  else
   select min(d::date) into v_missing
    from generate_series(v_from,v_to,interval '1 day') d
    where d::date>=timezone('America/Caracas',now())::date or not exists(
     select 1 from public.external_import_batches b
     where b.source_id=s.id and b.status='COMPLETE'
      and d::date between b.requested_from and b.requested_to
    );
   if s.provider='BDV' then
    select min(b.requested_from) into v_conflict
     from public.external_import_batches a join public.external_import_batches b
      on b.source_id=a.source_id and b.status='COMPLETE' and b.requested_from=a.requested_to+1
     where a.source_id=s.id and a.status='COMPLETE'
      and a.requested_to>=v_from and b.requested_from<=v_to
      and (a.controls->>'closing')::numeric is distinct from (b.controls->>'opening')::numeric;
   end if;
   v_status:=case when v_source_conflicts>0 then 'SOURCE_CONFLICT'
    when v_conflict is not null then 'BALANCE_CONFLICT'
    when v_missing is null then 'COVERAGE_VERIFIED'
    when v_missing=timezone('America/Caracas',now())::date and v_to=v_missing and v_complete>0 then 'IN_PROGRESS'
    when v_complete=0 and v_review>0 then 'NEEDS_VERIFICATION'
    when v_complete=0 then 'MISSING_REPORT' else 'PARTIAL' end;
  end if;
  v_stop:=least(coalesce(v_missing,v_to+1),coalesce(v_conflict,v_to+1),coalesce(v_source_conflict_from,v_to+1));
  v_rows:=v_rows||jsonb_build_array(jsonb_build_object(
   'source_id',s.id,'source_name',s.name,'provider',s.provider,
   'account_id',s.account_id,'currency',s.currency,'status',v_status,
   'covered_through',case when s.provider='CASHEA_ORDERS' or v_stop<=v_from then null else v_stop-1 end,
   'missing_from',v_missing,'balance_conflict_from',v_conflict,
   'source_conflict_from',v_source_conflict_from,'source_conflicts',v_source_conflicts,
   'latest_snapshot_imported_at',v_snapshot,
   'verified_batches',v_complete,'review_batches',v_review
  ));
 end loop;
 return jsonb_build_object('from',v_from,'to',v_to,'sources',v_rows);
end $$;
create or replace function public.finance_report_coverage(p_from date default null,p_to date default null)
returns jsonb language sql stable security invoker set search_path='' as $$
 select lubricenter_private.finance_report_coverage(p_from,p_to)
$$;
