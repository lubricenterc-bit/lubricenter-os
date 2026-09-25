create function lubricenter_private.finance_reconcile() returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare r record; x record; c record; v_count integer:=0; v_candidates integer; v_used numeric; v_capacity numeric; v_rule record; v_run timestamptz;
begin
 perform lubricenter_private.finance_require();
 perform pg_advisory_xact_lock(221122);
 v_run:=clock_timestamp();
 update public.external_transactions x set ownership_status='OWN',ownership_reason='ORDER_MATCH',ownership_evidence=jsonb_build_object('cashea_sale_id',c.id)
 from public.cashea_sales c where x.external_order=trim(c.cashea_reference) and c.status<>'CANCELLED' and x.ownership_reason='UNKNOWN'
 and (select count(*) from public.cashea_sales z where trim(z.cashea_reference)=x.external_order and z.status<>'CANCELLED')=1;
 -- Freeze the candidate graph before consuming anything: uniqueness in BOTH directions.
 for r in with candidates as (
  select x.id xid,m.id mid,x.amount ea,m.amount_original ta,count(*) over(partition by x.id) nx,count(*) over(partition by m.id) nm
  from public.external_transactions x join public.external_sources s on s.id=x.source_id and s.provider='BDV'
  join public.account_movements m on m.account_id=s.account_id and m.currency=x.currency and m.direction=x.direction
   and right(regexp_replace(coalesce(m.reference,''),'\D','','g'),4)=right(x.reference,4) and length(regexp_replace(coalesce(m.reference,''),'\D','','g'))>=4
   and abs(extract(epoch from(m.occurred_at-x.occurred_at)))<=172800 and abs(m.amount_original-x.amount)<=least(5,m.amount_original*.001)
  where x.ownership_status='OWN'
   and not exists(select 1 from public.reconciliation_allocations a where (a.external_transaction_id=x.id or a.account_movement_id=m.id) and a.reversed_at is null)
   and not exists(select 1 from public.reconciliation_cases c where c.subject_id=x.id and c.status='OPEN' and c.kind in ('SOURCE_CONFLICT','SOURCE_AMOUNT'))
   and not exists(select 1 from public.payments p join public.orders o on o.id=p.order_id where p.id=m.source_payment_id and o.status='CANCELLED')
 ) select * from candidates where nx=1 and nm=1 order by xid loop
  perform lubricenter_private.finance_allocate(gen_random_uuid(),r.xid,r.mid,null,r.ea,r.ta,case when r.ea=r.ta then 'EXACT' else 'ROUNDING' end,'Referencia, cuenta, moneda, fecha y monto coinciden; candidato único en ambos extremos'); v_count:=v_count+1;
 end loop;
 for x in select t.*,s.provider from public.external_transactions t join public.external_sources s on s.id=t.source_id order by t.occurred_at,t.id loop
  if x.ownership_status='OTHER_LOCATION' then continue; end if;
  if x.ownership_status='UNRESOLVED' then
   perform lubricenter_private.finance_case('owner:'||x.id,'OWNERSHIP','external_transaction',x.id,'Identificar cobro Cashea','No hay una orden interna inequívoca. No se asume otro local.',jsonb_build_object('order',x.external_order,'amount',x.amount_ref)); continue;
  end if;
  if x.provider='CASHEA_TRANSACTIONS' and cardinality(x.installments)=1
   and not exists(select 1 from public.reconciliation_allocations where external_transaction_id=x.id and reversed_at is null)
   and not exists(select 1 from public.reconciliation_cases where subject_id=x.id and status='OPEN' and kind in ('SOURCE_CONFLICT','SOURCE_AMOUNT')) then
   select i.id,i.amount_ref-coalesce((select sum(a.target_amount) from public.reconciliation_allocations a where a.cashea_installment_id=i.id and a.reversed_at is null),0) remaining into c
   from public.cashea_installments i join public.cashea_sales cs on cs.id=i.cashea_sale_id
   where trim(cs.cashea_reference)=x.external_order and cs.status<>'CANCELLED' and cs.ownership_status='OWN' and i.installment_no=x.installments[1];
   if found and least(x.amount_ref,x.assigned_ref)<=c.remaining
    and coalesce((select status from public.cashea_order_snapshots ss where ss.external_order=x.external_order order by created_at desc,id desc limit 1),'')<>'CANCELLED' then
    v_capacity:=least(x.amount_ref,x.assigned_ref);
    if c.remaining>v_capacity and c.remaining-v_capacity<=least(0.005,c.remaining*.001) then
     perform lubricenter_private.finance_allocate(gen_random_uuid(),x.id,null,c.id,v_capacity,c.remaining,'ROUNDING','Precisión del reporte Cashea: diferencia máxima de medio centavo, conservada explícitamente');
    else perform lubricenter_private.finance_allocate(gen_random_uuid(),x.id,null,c.id,v_capacity,v_capacity,'EXACT','Orden y cuota identificadas; cobro parcial o completo sin alterar cartera'); end if;
    v_count:=v_count+1;
   end if;
   if x.installments[1]=0 then
    select cs.id,cs.initial_ref-coalesce((select sum(a.target_amount) from public.reconciliation_allocations a where a.cashea_sale_id=cs.id and a.reversed_at is null),0) remaining into c from public.cashea_sales cs where trim(cs.cashea_reference)=x.external_order and cs.status<>'CANCELLED' and cs.ownership_status='OWN';
    if found and least(x.amount_ref,x.assigned_ref)<=c.remaining and coalesce((select status from public.cashea_order_snapshots ss where ss.external_order=x.external_order order by created_at desc,id desc limit 1),'')<>'CANCELLED' then
     perform lubricenter_private.finance_allocate(gen_random_uuid(),x.id,null,null,least(x.amount_ref,x.assigned_ref),least(x.amount_ref,x.assigned_ref),'EXACT','Inicial documentada por Cashea; no se registra otro pago',c.id); v_count:=v_count+1;
    end if;
   end if;
  end if;
  select coalesce(sum(external_amount),0) into v_used from public.reconciliation_allocations where external_transaction_id=x.id and reversed_at is null;
  v_capacity:=case when x.provider='BDV' then x.amount else least(x.amount_ref,x.assigned_ref) end;
  if x.direction='OUT' and x.nature='UNCLASSIFIED' then
   select count(*) into v_candidates from public.reconciliation_rules where active and (source_id is null or source_id=x.source_id) and position(description_contains in upper(x.description))>0;
   if v_candidates=1 then
    select * into v_rule from public.reconciliation_rules where active and (source_id is null or source_id=x.source_id) and position(description_contains in upper(x.description))>0;
    update public.external_transactions set nature=v_rule.nature,category=v_rule.category,classification_reason='Regla aprobada '||v_rule.id||' versión '||v_rule.version where id=x.id;
   else perform lubricenter_private.finance_case('class:'||x.id,'UNCLASSIFIED','external_transaction',x.id,'Clasificar salida',x.description,jsonb_build_object('amount',x.amount,'currency',x.currency)); end if;
  end if;
  if v_used<v_capacity and (x.direction='IN' or x.nature<>'UNCLASSIFIED' or v_candidates=1) then
   perform lubricenter_private.finance_case('unmatched:'||x.id,'UNMATCHED','external_transaction',x.id,case when x.direction='IN' then 'Cobro por vincular' else 'Salida sin registro interno' end,
   case when cardinality(x.installments)>1 then 'Este cobro cubre varias cuotas: distribuye solo el monto comprobado.' else 'No hay una coincidencia única. Busca el registro interno.' end,jsonb_build_object('remaining',v_capacity-v_used,'reference',x.reference,'order',x.external_order));
  end if;
 end loop;
 for r in select distinct on (s.external_order) s.* from public.cashea_order_snapshots s order by s.external_order,s.created_at desc,s.id desc loop
  select * into c from public.cashea_sales where trim(cashea_reference)=r.external_order and status<>'CANCELLED';
  if found and (r.status='CANCELLED' or abs(c.gross_ref-r.total_ref)>.01 or abs(c.initial_ref-r.initial_ref)>.01 or exists(
   select 1 from jsonb_array_elements(r.installments) q left join public.cashea_installments i on i.cashea_sale_id=c.id and i.installment_no=(q->>'number')::integer
   where i.id is null or abs(i.amount_ref-(q->>'amount_ref')::numeric)>.0001 or i.due_date<>(q->>'due_date')::date)) then
   perform lubricenter_private.finance_case('schedule:'||c.id,'CASHEA_SCHEDULE','cashea_sale',c.id,'Revisar condiciones Cashea','Total, inicial, calendario o cancelación difiere de la orden interna.',jsonb_build_object('snapshot_id',r.id,'external_order',r.external_order));
  end if;
 end loop;
 for r in select m.* from public.account_movements m join public.financial_accounts a on a.id=m.account_id and a.account_type='BANK'
 where m.direction='IN' and m.occurred_at<now()-interval '48 hours'
 and not exists(select 1 from public.reconciliation_allocations z where z.account_movement_id=m.id and z.reversed_at is null)
 and exists(select 1 from public.external_import_batches b join public.external_sources s on s.id=b.source_id where s.provider='BDV' and s.account_id=m.account_id and b.status='COMPLETE'
  and b.requested_from<=timezone('America/Caracas',m.occurred_at-interval '48 hours')::date and b.requested_to>=timezone('America/Caracas',m.occurred_at+interval '48 hours')::date)
 and not exists(select 1 from public.payments p join public.orders o on o.id=p.order_id where p.id=m.source_payment_id and o.status='CANCELLED') loop
  perform lubricenter_private.finance_case('missing:'||r.id,'MISSING_EXTERNAL','account_movement',r.id,'Pago sin evidencia bancaria','Período y margen de 48 horas verificados. Revisa referencia y cuenta.',jsonb_build_object('amount',r.amount_original,'reference',r.reference));
 end loop;
 for r in select d.*,a.currency from public.cash_closing_accounts d join public.cash_closings c on c.id=d.cash_closing_id and c.finance_version=22 and c.status in ('CLOSED','REVIEW') join public.financial_accounts a on a.id=d.account_id where abs(d.difference_native)>case when a.currency='USD' then .01 else 1 end loop
  perform lubricenter_private.finance_case('cash:'||r.cash_closing_id||':'||r.account_id,'CASH_VARIANCE','cash_closing',r.cash_closing_id,'Diferencia en efectivo','Conteo guardado. Revisar diferencia; no es un ingreso o gasto automático.',jsonb_build_object('account_id',r.account_id,'difference',r.difference_native,'explanation',r.explanation));
 end loop;
 update public.reconciliation_cases set status='RESOLVED',resolution='La evidencia actual ya no presenta esta excepción',resolved_at=now(),resolved_by=auth.uid()
 where status='OPEN' and kind in ('OWNERSHIP','UNMATCHED','UNCLASSIFIED','MISSING_EXTERNAL','CASHEA_SCHEDULE','CASH_VARIANCE') and updated_at<v_run;
 return jsonb_build_object('matched',v_count,'open_cases',(select count(*) from public.reconciliation_cases where status='OPEN'));
end $$;
create function public.finance_reconcile() returns jsonb language sql security invoker set search_path='' as $$ select lubricenter_private.finance_reconcile() $$;

create function lubricenter_private.finance_inbox(p_offset integer default 0) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform lubricenter_private.finance_require();
 return jsonb_build_object('role',lubricenter_private.finance_role(),'total',(select count(*) from public.reconciliation_cases where status='OPEN'),
 'cases',coalesce((select jsonb_agg(to_jsonb(c)) from (select * from public.reconciliation_cases where status='OPEN' order by created_at,id limit 50 offset greatest(p_offset,0)) c),'[]'),
 'sources',coalesce((select jsonb_agg(to_jsonb(s)) from public.external_sources s where active),'[]'),
 'users',case when lubricenter_private.finance_role()='OWNER' then coalesce((select jsonb_agg(jsonb_build_object('id',u.id,'email',u.email,'role',coalesce(m.role,'OPERATOR'))) from auth.users u left join public.finance_memberships m on m.user_id=u.id where u.email_confirmed_at is not null),'[]') else '[]'::jsonb end,
 'rules',coalesce((select jsonb_agg(to_jsonb(r)) from public.reconciliation_rules r where active),'[]'),
 'batches',coalesce((select jsonb_agg(to_jsonb(b)-'payload') from (select * from public.external_import_batches order by created_at desc limit 20) b),'[]'),
 'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'code',code,'currency',currency)) from public.financial_accounts where active),'[]'));
end $$;
create function public.finance_inbox(p_offset integer default 0) returns jsonb language sql stable security invoker set search_path='' as $$ select lubricenter_private.finance_inbox(p_offset) $$;

create function lubricenter_private.finance_review(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare x public.external_transactions; s public.external_sources; v_targets jsonb;
begin
 perform lubricenter_private.finance_require();
 select * into x from public.external_transactions where id=p_id;
 if not found then raise exception 'Movimiento externo no encontrado'; end if;
 select * into s from public.external_sources where id=x.source_id;
 if s.provider='BDV' then
  select coalesce(jsonb_agg(to_jsonb(m)),'[]') into v_targets from (
   select m.id,'movement' kind,m.occurred_at,m.reference,m.note,m.amount_original::text amount,m.currency,
    (m.amount_original-coalesce((select sum(target_amount) from public.reconciliation_allocations where account_movement_id=m.id and reversed_at is null),0))::text remaining
   from public.account_movements m where m.account_id=s.account_id and m.direction=x.direction and m.currency=x.currency
    and m.occurred_at between x.occurred_at-interval '7 days' and x.occurred_at+interval '7 days' order by abs(extract(epoch from(m.occurred_at-x.occurred_at))),m.id limit 100) m;
 else
  select coalesce(jsonb_agg(to_jsonb(i)),'[]') into v_targets from (
   select i.id,'installment' kind,i.installment_no,i.due_date,i.amount_ref::text amount,'USD' currency,
    (i.amount_ref-coalesce((select sum(target_amount) from public.reconciliation_allocations where cashea_installment_id=i.id and reversed_at is null),0))::text remaining
   from public.cashea_installments i join public.cashea_sales c on c.id=i.cashea_sale_id where trim(c.cashea_reference)=x.external_order and c.status<>'CANCELLED' and i.installment_no=any(x.installments)
   union all select c.id,'initial',0,null,c.initial_ref::text,'USD',(c.initial_ref-coalesce((select sum(target_amount) from public.reconciliation_allocations where cashea_sale_id=c.id and reversed_at is null),0))::text from public.cashea_sales c where trim(c.cashea_reference)=x.external_order and c.status<>'CANCELLED' and 0=any(x.installments)) i;
 end if;
 return jsonb_build_object('transaction',to_jsonb(x)||jsonb_build_object('amount',x.amount::text,'amount_ref',x.amount_ref::text,'assigned_ref',x.assigned_ref::text),'targets',v_targets,'allocations',coalesce((select jsonb_agg(to_jsonb(a)||jsonb_build_object('external_amount',a.external_amount::text,'target_amount',a.target_amount::text,'difference',a.difference::text)) from public.reconciliation_allocations a where external_transaction_id=x.id),'[]'),
 'history',coalesce((select jsonb_agg(to_jsonb(e)) from (select * from public.audit_events where entity_id=x.id order by created_at desc limit 30) e),'[]'));
end $$;
create function public.finance_review(p_id uuid) returns jsonb language sql stable security invoker set search_path='' as $$ select lubricenter_private.finance_review(p_id) $$;

do $$ declare p record; begin
 for p in select n.nspname,f.proname,pg_get_function_identity_arguments(f.oid) args from pg_proc f join pg_namespace n on n.oid=f.pronamespace where n.nspname in ('public','lubricenter_private') and f.proname in ('finance_reconcile','finance_inbox','finance_review') loop
  execute format('revoke all on function %I.%I(%s) from public,anon',p.nspname,p.proname,p.args);
  execute format('grant execute on function %I.%I(%s) to authenticated',p.nspname,p.proname,p.args);
 end loop;
end $$;
