-- Review every imported report without exposing the private raw payload.
create index if not exists external_batches_recent_idx
 on public.external_import_batches(created_at desc,id desc);

create function lubricenter_private.finance_batches(p_from date,p_to date,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform lubricenter_private.finance_require();
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>366 then
  raise exception 'Selecciona un período válido de máximo un año';
 end if;
 return jsonb_build_object(
  'total',(select count(*) from public.external_import_batches b
   where b.requested_from<=p_to and b.requested_to>=p_from),
  'batches',coalesce((select jsonb_agg(to_jsonb(q)) from (
   select b.id,b.source_id,b.source_name,b.status,b.requested_from,b.requested_to,
    b.row_count,b.balance_chain,b.created_at,b.verified_at
   from public.external_import_batches b
   where b.requested_from<=p_to and b.requested_to>=p_from
   order by b.created_at desc,b.id desc limit 20 offset greatest(p_offset,0)
  ) q),'[]'::jsonb)
 );
end $$;
create function public.finance_batches(p_from date,p_to date,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path='' as $$
 select lubricenter_private.finance_batches(p_from,p_to,p_offset)
$$;

create function lubricenter_private.finance_batch(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
 perform lubricenter_private.finance_require();
 select to_jsonb(b)-'payload' into v_result
  from public.external_import_batches b where b.id=p_id;
 if v_result is null then raise exception 'Reporte no encontrado'; end if;
 return v_result;
end $$;
create function public.finance_batch(p_id uuid)
returns jsonb language sql stable security invoker set search_path='' as $$
 select lubricenter_private.finance_batch(p_id)
$$;

revoke all on function lubricenter_private.finance_batches(date,date,integer) from public,anon;
revoke all on function public.finance_batches(date,date,integer) from public,anon;
revoke all on function lubricenter_private.finance_batch(uuid) from public,anon;
revoke all on function public.finance_batch(uuid) from public,anon;
grant execute on function lubricenter_private.finance_batches(date,date,integer) to authenticated;
grant execute on function public.finance_batches(date,date,integer) to authenticated;
grant execute on function lubricenter_private.finance_batch(uuid) to authenticated;
grant execute on function public.finance_batch(uuid) to authenticated;
