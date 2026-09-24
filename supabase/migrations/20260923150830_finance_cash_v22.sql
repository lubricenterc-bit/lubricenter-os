create function lubricenter_private.finance_cash_activate(p_account_id uuid,p_amount numeric,p_reason text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform lubricenter_private.finance_require('OWNER');
 perform pg_advisory_xact_lock(220033);
 if not exists(select 1 from public.financial_accounts where id=p_account_id and account_type='CASH' and code in ('CASH_USD','CASH_VES') and active) then raise exception 'Selecciona Caja USD o Caja Bs'; end if;
 if length(trim(coalesce(p_reason,'')))<5 then raise exception 'Describe el conteo inicial'; end if;
 insert into public.finance_cash_openings(account_id,effective_at,amount,reason) values(p_account_id,clock_timestamp(),p_amount,p_reason);
end $$;
create function public.finance_cash_activate(p_account_id uuid,p_amount numeric,p_reason text) returns void language sql security invoker set search_path='' as $$ select lubricenter_private.finance_cash_activate(p_account_id,p_amount,p_reason) $$;

create function lubricenter_private.finance_cash_totals(p_day date) returns table(id uuid,code text,name text,currency text,account_type text,activated boolean,opening_native numeric,system_in_native numeric,system_out_native numeric,expected_native numeric) language sql stable security definer set search_path='' as $$
 with bases as (
  select a.*,o.account_id is not null and timezone('America/Caracas',o.effective_at)::date<=p_day activated,
   coalesce(prev.actual_native,o.amount,0) base,
   coalesce(((prev.business_date+1)::timestamp at time zone 'America/Caracas'),o.effective_at) since
  from public.financial_accounts a left join public.finance_cash_openings o on o.account_id=a.id
  left join lateral(select d.actual_native,c.business_date from public.cash_closing_accounts d join public.cash_closings c on c.id=d.cash_closing_id
   where d.account_id=a.id and c.finance_version=22 and c.status in ('CLOSED','REVIEW') and c.business_date<p_day and d.actual_native is not null
   and c.business_date>=timezone('America/Caracas',o.effective_at)::date order by c.business_date desc limit 1) prev on true
  where a.active and a.code in ('CASH_USD','CASH_VES') and a.account_type='CASH'
 ), sums as (
  select b.id,b.code,b.name,b.currency,b.account_type,b.activated,
   b.base+coalesce(sum(case when m.direction='IN' then m.amount_original else -m.amount_original end) filter(where m.occurred_at<(p_day::timestamp at time zone 'America/Caracas')),0) opening_native,
   coalesce(sum(m.amount_original) filter(where m.direction='IN' and m.occurred_at>=(p_day::timestamp at time zone 'America/Caracas')),0) system_in_native,
   coalesce(sum(m.amount_original) filter(where m.direction='OUT' and m.occurred_at>=(p_day::timestamp at time zone 'America/Caracas')),0) system_out_native
  from bases b left join public.account_movements m on m.account_id=b.id and m.occurred_at>=b.since and m.occurred_at<((p_day+1)::timestamp at time zone 'America/Caracas')
  group by b.id,b.code,b.name,b.currency,b.account_type,b.activated,b.base
 ) select *,opening_native+system_in_native-system_out_native expected_native from sums
$$;

create function lubricenter_private.finance_cash_dashboard(p_business_date date default null) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_day date:=coalesce(p_business_date,timezone('America/Caracas',now())::date); v_location uuid; v_close public.cash_closings; v_accounts jsonb;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 select id into v_location from public.locations where active order by created_at limit 1;
 select * into v_close from public.cash_closings where business_date=v_day and location_id=v_location;
 if v_close.id is not null and v_close.finance_version is null then
  select coalesce(jsonb_agg(to_jsonb(q)),'[]') into v_accounts from (select a.id,a.code,a.name,a.currency,a.account_type,true activated,d.opening_native,d.system_in_native,d.system_out_native,d.expected_native,d.actual_native,d.difference_native,d.explanation,d.denomination_counts,d.updated_at counted_at from public.cash_closing_accounts d join public.financial_accounts a on a.id=d.account_id where d.cash_closing_id=v_close.id) q;
 else
  select coalesce(jsonb_agg(to_jsonb(q)),'[]') into v_accounts from (select a.*,d.actual_native,d.difference_native,d.explanation,d.denomination_counts,d.updated_at counted_at from lubricenter_private.finance_cash_totals(v_day) a left join public.cash_closing_accounts d on d.cash_closing_id=v_close.id and d.account_id=a.id) q;
 end if;
 return jsonb_build_object('business_date',v_day,'location_id',v_location,'role',lubricenter_private.finance_role(),'legacy',v_close.id is not null and v_close.finance_version is null,'status',coalesce(v_close.status,'OPEN'),'closing',case when v_close.id is null then null else to_jsonb(v_close) end,'accounts',v_accounts);
end $$;
create or replace function public.cash_close_dashboard(p_business_date date default null) returns jsonb language sql stable security invoker set search_path='' as $$ select lubricenter_private.finance_cash_dashboard(p_business_date) $$;

create function lubricenter_private.finance_cash_count(p_business_date date,p_account_id uuid,p_actual_native numeric,p_explanation text default null,p_denominations jsonb default '{}') returns uuid language plpgsql security definer set search_path='' as $$
declare v_location uuid; c public.cash_closings; t record;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 perform pg_advisory_xact_lock(220033);
 if p_business_date is null or p_business_date>timezone('America/Caracas',now())::date then raise exception 'Fecha de conteo inválida'; end if;
 if p_actual_native is null or p_actual_native<0 or p_actual_native>='Infinity'::numeric then raise exception 'Escribe el efectivo contado; cero es válido'; end if;
 select * into t from lubricenter_private.finance_cash_totals(p_business_date) where id=p_account_id;
 if not found or not t.activated then raise exception 'El dueño debe registrar primero el conteo de apertura de esta caja'; end if;
 select id into v_location from public.locations where active order by created_at limit 1;
 insert into public.cash_closings(business_date,location_id,finance_version) values(p_business_date,v_location,22) on conflict(business_date,location_id) do nothing;
 select * into c from public.cash_closings where business_date=p_business_date and location_id=v_location for update;
 if c.finance_version is null then raise exception 'Cierre histórico conservado. Inicia el nuevo control desde la apertura física'; end if;
 if c.status='CLOSED' then raise exception 'El día está cerrado; pide al dueño que lo reabra'; end if;
 if c.status in ('REVIEW','REOPENED') then perform lubricenter_private.finance_require(); end if;
 insert into public.cash_closing_accounts(cash_closing_id,account_id,opening_native,system_in_native,system_out_native,expected_native,actual_native,difference_native,explanation,denomination_counts,updated_by,updated_at)
 values(c.id,p_account_id,t.opening_native,t.system_in_native,t.system_out_native,t.expected_native,p_actual_native,p_actual_native-t.expected_native,nullif(trim(p_explanation),''),p_denominations,auth.uid(),now())
 on conflict(cash_closing_id,account_id) do update set opening_native=excluded.opening_native,system_in_native=excluded.system_in_native,system_out_native=excluded.system_out_native,expected_native=excluded.expected_native,actual_native=excluded.actual_native,difference_native=excluded.difference_native,explanation=excluded.explanation,denomination_counts=excluded.denomination_counts,updated_by=auth.uid(),updated_at=now();
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('finance.cash_count','cash_closing',c.id,jsonb_build_object('account',p_account_id,'actual',p_actual_native,'expected',t.expected_native));
 return c.id;
end $$;
create or replace function public.save_cash_count(p_business_date date,p_account_id uuid,p_actual_native numeric,p_explanation text default null,p_denominations jsonb default '{}') returns uuid language sql security invoker set search_path='' as $$ select lubricenter_private.finance_cash_count(p_business_date,p_account_id,p_actual_native,p_explanation,p_denominations) $$;

create function lubricenter_private.finance_cash_close(p_business_date date,p_notes text default null) returns uuid language plpgsql security definer set search_path='' as $$
declare v_location uuid; c public.cash_closings; t record; d public.cash_closing_accounts;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 perform pg_advisory_xact_lock(220033);
 select id into v_location from public.locations where active order by created_at limit 1;
 select * into c from public.cash_closings where business_date=p_business_date and location_id=v_location for update;
 if not found then raise exception 'Primero cuenta Caja USD y Caja Bs'; end if;
 if c.status='CLOSED' then return c.id; end if;
 if c.finance_version is null then raise exception 'Este cierre pertenece al control histórico'; end if;
 if c.status in ('REVIEW','REOPENED') then perform lubricenter_private.finance_require(); end if;
 if (select count(*) from lubricenter_private.finance_cash_totals(p_business_date))<>2 then raise exception 'Configura Caja USD y Caja Bs'; end if;
 for t in select * from lubricenter_private.finance_cash_totals(p_business_date) loop
  select * into d from public.cash_closing_accounts where cash_closing_id=c.id and account_id=t.id;
  if not t.activated or d.actual_native is null then raise exception 'Falta el conteo de %',t.name; end if;
  if d.expected_native<>t.expected_native or d.system_in_native<>t.system_in_native or d.system_out_native<>t.system_out_native then raise exception 'Hubo movimientos después del conteo de %. Confirma nuevamente el efectivo',t.name; end if;
 end loop;
 -- A discrepancy is an administrative case, never a block on tomorrow's sales.
 update public.cash_closings set status='CLOSED',notes=nullif(trim(p_notes),''),closed_by=auth.uid(),closed_at=now(),review_reason=null,updated_at=now() where id=c.id;
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('finance.cash_closed','cash_closing',c.id,jsonb_build_object('business_date',p_business_date));
 for d in select * from public.cash_closing_accounts where cash_closing_id=c.id loop
  if abs(d.difference_native)>(case when (select currency from public.financial_accounts where id=d.account_id)='USD' then 0.01 else 1 end) then
   perform lubricenter_private.finance_case('cash:'||c.id||':'||d.account_id,'CASH_VARIANCE','cash_closing',c.id,'Diferencia en efectivo','Se guardó el conteo sin inventar un ajuste contable.',jsonb_build_object('account_id',d.account_id,'difference',d.difference_native,'explanation',d.explanation));
  end if;
 end loop;
 return c.id;
end $$;
create or replace function public.close_cash_day(p_business_date date,p_notes text default null) returns uuid language sql security invoker set search_path='' as $$ select lubricenter_private.finance_cash_close(p_business_date,p_notes) $$;

create function lubricenter_private.finance_cash_movement_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare a uuid; d date;
begin
 perform pg_advisory_xact_lock(220033);
 for a,d in select account_id,timezone('America/Caracas',occurred_at)::date from (select (case when tg_op='DELETE' then old else new end).* union all select (case when tg_op='INSERT' then new else old end).*) q loop
  if exists(select 1 from public.financial_accounts where id=a and account_type='CASH') then
   update public.cash_closings set status='REVIEW',review_reason='Se registró o corrigió un movimiento de efectivo anterior al cierre',updated_at=now()
    where finance_version=22 and status='CLOSED' and business_date>=d;
  end if;
 end loop;
 return coalesce(new,old);
end $$;
create trigger finance_cash_movement_guard before insert or update or delete on public.account_movements for each row execute function lubricenter_private.finance_cash_movement_guard();
create function lubricenter_private.finance_cash_recount_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.actual_native is distinct from new.actual_native then
  update public.cash_closings set status='REVIEW',review_reason='Se corrigió un conteo anterior que afecta la apertura',updated_at=now()
   where finance_version=22 and status='CLOSED' and business_date>(select business_date from public.cash_closings where id=new.cash_closing_id);
 end if;return new;
end $$;
create trigger finance_cash_recount_guard after update on public.cash_closing_accounts for each row execute function lubricenter_private.finance_cash_recount_guard();
revoke all on function lubricenter_private.finance_cash_recount_guard() from public,anon,authenticated;
-- The historical trigger must not send a v2.2 physical closing to review for bank-only changes.
create or replace function public.mark_cash_close_review() returns trigger language plpgsql security definer set search_path='' as $$
declare d date;
begin
 d:=timezone('America/Caracas',case when tg_op='DELETE' then old.occurred_at else new.occurred_at end)::date;
 update public.cash_closings set status='REVIEW',review_reason='Movimiento posterior al cierre histórico',updated_at=now() where finance_version is null and business_date=d and status='CLOSED';
 return coalesce(new,old);
end $$;

create function lubricenter_private.finance_outflow(p_request_id uuid,p_account_id uuid,p_amount numeric,p_nature text,p_category text,p_payee text,p_note text,p_reference text,p_occurred_on date) returns uuid language plpgsql security definer set search_path='' as $$
declare a public.financial_accounts; v_rate numeric; v_id uuid; v_day date:=coalesce(p_occurred_on,timezone('America/Caracas',now())::date); m public.account_movements;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if p_request_id is null then raise exception 'Identificador requerido'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,22));
 select * into m from public.account_movements where finance_request_id=p_request_id;
 if found then
  if m.account_id<>p_account_id or m.amount_original<>p_amount or m.finance_nature<>p_nature then raise exception 'Operación ya utilizada con datos distintos'; end if; return m.id;
 end if;
 if p_nature='OWNER_DRAW' then perform lubricenter_private.finance_require('OWNER'); end if;
 if p_nature not in ('EXPENSE','ASSET_PURCHASE','OWNER_DRAW','TAX','BANK_FEE','UNCLASSIFIED') then raise exception 'Usa el módulo de compras, proveedores, nómina, devolución o transferencia para enlazar su documento'; end if;
 if p_nature in ('EXPENSE','BANK_FEE') and coalesce(trim(p_category),'')='' then raise exception 'Selecciona una categoría'; end if;
 select * into a from public.financial_accounts where id=p_account_id and active and account_type in ('CASH','BANK');
 if not found then raise exception 'Selecciona una cuenta del negocio'; end if;
 if p_amount is null or p_amount<=0 or p_amount>='Infinity'::numeric then raise exception 'Monto inválido'; end if;
 if v_day>timezone('America/Caracas',now())::date then raise exception 'La salida no puede ser futura'; end if;
 if a.account_type='BANK' and coalesce(trim(p_reference),'')!~'^\d{4,32}$' then raise exception 'Escribe los últimos 4 números de la referencia'; end if;
 if a.currency='USD' then
  select value into v_rate from public.exchange_rates where rate_type='OPERATIVE' and timezone('America/Caracas',effective_at)::date<=v_day order by effective_at desc limit 1;
  if v_rate is null then raise exception 'Falta la tasa histórica para valorar esta salida en USD'; end if;
 else v_rate:=1; end if;
 insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,payee,note,reference,occurred_at,finance_nature,finance_request_id)
 values(a.id,'OUT',case when p_nature in ('EXPENSE','TAX','BANK_FEE') then 'EXPENSE' else 'ADJUSTMENT' end,a.currency,p_amount,round(p_amount*v_rate,2),nullif(trim(p_category),''),p_payee,p_note,p_reference,
 case when v_day=timezone('America/Caracas',now())::date then now() else ((v_day::timestamp+time '12:00') at time zone 'America/Caracas') end,p_nature,p_request_id) returning id into v_id;
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('finance.outflow_recorded','account_movement',v_id,jsonb_build_object('nature',p_nature,'rate_snapshot',v_rate,'reason',p_note));
 if p_nature='UNCLASSIFIED' then perform lubricenter_private.finance_case('nature:'||v_id,'OUTFLOW_NATURE','account_movement',v_id,'Clasificar salida registrada','El efectivo ya salió; falta identificar su naturaleza.',jsonb_build_object('amount',p_amount,'currency',a.currency)); end if;
 return v_id;
end $$;
create function public.finance_outflow(p_request_id uuid,p_account_id uuid,p_amount numeric,p_nature text,p_category text,p_payee text,p_note text,p_reference text,p_occurred_on date) returns uuid language sql security invoker set search_path='' as $$ select lubricenter_private.finance_outflow(p_request_id,p_account_id,p_amount,p_nature,p_category,p_payee,p_note,p_reference,p_occurred_on) $$;

create function lubricenter_private.finance_record_external_outflow(p_id uuid,p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare x public.external_transactions; s public.external_sources; v_id uuid;
begin
 perform lubricenter_private.finance_require();
 select * into x from public.external_transactions where id=p_id for update;
 if not found then raise exception 'Movimiento no encontrado'; end if;
 select id into v_id from public.account_movements where finance_request_id=x.id;
 if found then return v_id; end if;
 select * into s from public.external_sources where id=x.source_id;
 if s.provider<>'BDV' or x.direction<>'OUT' or x.ownership_status<>'OWN' then raise exception 'Esta acción registra únicamente una salida bancaria propia'; end if;
 if length(trim(coalesce(p_reason,'')))<5 then raise exception 'Confirma por qué esta salida no tiene registro interno'; end if;
 if x.nature not in ('EXPENSE','ASSET_PURCHASE','OWNER_DRAW','TAX','BANK_FEE') then raise exception 'Primero clasifica. Compras, proveedores y transferencias se registran desde sus documentos'; end if;
 if x.nature='OWNER_DRAW' then perform lubricenter_private.finance_require('OWNER'); end if;
 if exists(select 1 from public.reconciliation_allocations where external_transaction_id=x.id and reversed_at is null) then raise exception 'Este movimiento ya tiene una asignación; revisa el registro existente'; end if;
 if exists(select 1 from public.account_movements where account_id=s.account_id and direction='OUT' and currency=x.currency and abs(amount_original-x.amount)<=least(5,x.amount*.001) and right(regexp_replace(coalesce(reference,''),'\D','','g'),4)=right(x.reference,4) and occurred_at between x.occurred_at-interval '48 hours' and x.occurred_at+interval '48 hours') then raise exception 'Ya hay una salida similar: vincúlala en lugar de duplicarla'; end if;
 insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,note,reference,occurred_at,finance_nature,finance_request_id)
 values(s.account_id,'OUT',case when x.nature in ('EXPENSE','TAX','BANK_FEE') then 'EXPENSE' else 'ADJUSTMENT' end,x.currency,x.amount,x.amount,x.category,p_reason,x.reference,x.occurred_at,x.nature,x.id) returning id into v_id;
 perform lubricenter_private.finance_allocate(gen_random_uuid(),x.id,v_id,null,x.amount,x.amount,'EXACT','Salida registrada desde evidencia externa; '||p_reason);
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('finance.external_outflow_recorded','account_movement',v_id,jsonb_build_object('external_transaction_id',x.id,'reason',p_reason));
 return v_id;
end $$;
create function public.finance_record_external_outflow(p_id uuid,p_reason text) returns uuid language sql security invoker set search_path='' as $$ select lubricenter_private.finance_record_external_outflow(p_id,p_reason) $$;

revoke all on function lubricenter_private.finance_cash_totals(date),lubricenter_private.finance_cash_movement_guard() from public,anon,authenticated;
do $$ declare p record; begin
 for p in select n.nspname,f.proname,pg_get_function_identity_arguments(f.oid) args from pg_proc f join pg_namespace n on n.oid=f.pronamespace where n.nspname in ('public','lubricenter_private') and f.proname in ('finance_cash_activate','finance_cash_dashboard','finance_cash_count','finance_cash_close','cash_close_dashboard','save_cash_count','close_cash_day','finance_outflow','finance_record_external_outflow') loop
  execute format('revoke all on function %I.%I(%s) from public,anon',p.nspname,p.proname,p.args);
  execute format('grant execute on function %I.%I(%s) to authenticated',p.nspname,p.proname,p.args);
 end loop;
end $$;
