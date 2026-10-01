-- Cashea's merchant invoice is separate from customer collections and bank cash.
-- Balance events are evidence of an actual portal entry, never generated from an estimate.
create table public.cashea_merchant_statements (
 id uuid primary key default gen_random_uuid(),
 period_from date not null, period_to date not null,
 invoice_number text not null,
 ownership_status text not null default 'UNRESOLVED' check(ownership_status in ('OWN','SHARED','UNRESOLVED')),
 ownership_reason text not null default 'Pendiente de atribuir a Lubricenter' check(length(trim(ownership_reason))>=5),
 sales_ref numeric(20,2) not null check(sales_ref>0 and sales_ref<'Infinity'::numeric),
 commission_percent numeric(8,4) not null check(commission_percent>=0 and commission_percent<=100),
 service_ref numeric(20,2) not null check(service_ref>=0 and service_ref<'Infinity'::numeric),
 vat_ref numeric(20,2) not null check(vat_ref>=0 and vat_ref<'Infinity'::numeric),
 withholding_ref numeric(20,2) not null default 0 check(withholding_ref>=0 and withholding_ref<'Infinity'::numeric),
 total_deduct_ref numeric(20,2) generated always as (service_ref+vat_ref-withholding_ref) stored,
 calculation_difference_ref numeric(20,2) generated always as (service_ref-round(sales_ref*commission_percent/100,2)) stored,
 evidence text not null check(length(trim(evidence))>=5),
 created_at timestamptz not null default now(), created_by uuid not null default auth.uid(),
 voided_at timestamptz, voided_by uuid, void_reason text,
 check(period_from<=period_to and period_to-period_from<=366),
 check(service_ref+vat_ref>=withholding_ref),
 check(voided_at is null or length(trim(void_reason))>=5)
);
create unique index cashea_statement_active_invoice on public.cashea_merchant_statements(invoice_number) where voided_at is null;
create unique index cashea_statement_active_period on public.cashea_merchant_statements(period_from,period_to) where voided_at is null;

create table public.cashea_balance_events (
 id uuid primary key default gen_random_uuid(), request_id uuid not null unique,
 kind text not null check(kind in ('OPENING_CREDIT','OPENING_DEBIT','COVERAGE_CREDIT','SERVICE_DEDUCTION','PAYOUT','ADJUSTMENT_CREDIT','ADJUSTMENT_DEBIT')),
 occurred_on date not null, amount_ref numeric(20,2) not null check(amount_ref>0 and amount_ref<'Infinity'::numeric),
 reference text not null check(length(trim(reference))>=3),
 evidence text not null check(length(trim(evidence))>=5),
 statement_id uuid references public.cashea_merchant_statements(id) on delete restrict,
 bank_transaction_id uuid references public.external_transactions(id) on delete restrict,
 created_at timestamptz not null default now(), created_by uuid not null default auth.uid(),
 reversed_at timestamptz, reversed_by uuid, reversal_reason text,
 check((kind='SERVICE_DEDUCTION')=(statement_id is not null)),
 check(bank_transaction_id is null or kind='PAYOUT'),
 check(reversed_at is null or length(trim(reversal_reason))>=5)
);
create unique index cashea_balance_event_source on public.cashea_balance_events(kind,reference,occurred_on) where reversed_at is null;
create unique index cashea_balance_event_statement on public.cashea_balance_events(statement_id) where statement_id is not null and reversed_at is null;
create unique index cashea_balance_event_bank on public.cashea_balance_events(bank_transaction_id) where bank_transaction_id is not null and reversed_at is null;
create unique index cashea_balance_single_opening on public.cashea_balance_events((true)) where kind in ('OPENING_CREDIT','OPENING_DEBIT') and reversed_at is null;
create index cashea_balance_events_date on public.cashea_balance_events(occurred_on,id);

alter table public.cashea_merchant_statements enable row level security;
alter table public.cashea_balance_events enable row level security;
revoke all on public.cashea_merchant_statements,public.cashea_balance_events from anon,authenticated;
grant select on public.cashea_merchant_statements,public.cashea_balance_events to authenticated;
create policy finance_admin_read on public.cashea_merchant_statements for select to authenticated using ((select lubricenter_private.finance_role()) in ('ADMIN','OWNER'));
create policy finance_admin_read on public.cashea_balance_events for select to authenticated using ((select lubricenter_private.finance_role()) in ('ADMIN','OWNER'));
create trigger finance_audit after insert or update or delete on public.cashea_merchant_statements for each row execute function lubricenter_private.finance_audit();
create trigger finance_audit after insert or update or delete on public.cashea_balance_events for each row execute function lubricenter_private.finance_audit();

create function lubricenter_private.finance_cashea_statement(p_request_id uuid,p_from date,p_to date,p_invoice text,p_sales numeric,p_percent numeric,p_service numeric,p_vat numeric,p_withholding numeric,p_evidence text,p_ownership_status text default 'UNRESOLVED',p_ownership_reason text default 'Pendiente de atribuir a Lubricenter')
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_old public.cashea_merchant_statements;
begin
 perform lubricenter_private.finance_require();
 if p_request_id is null then raise exception 'Falta identificador de solicitud'; end if;
 if p_invoice is null or length(trim(p_invoice))<3 then raise exception 'Escribe el número de factura Cashea'; end if;
 if p_evidence is null or length(trim(p_evidence))<5 then raise exception 'Indica la evidencia de la factura'; end if;
 if p_from is null or p_to is null or p_from>p_to or p_to>timezone('America/Caracas',now())::date or p_to-p_from>366 then raise exception 'Revisa el período de la factura'; end if;
 if p_sales is null or p_sales<=0 or p_sales>='Infinity'::numeric or p_percent is null or p_percent<0 or p_percent>100 or p_service is null or p_service<0 or p_service>='Infinity'::numeric or p_vat is null or p_vat<0 or p_vat>='Infinity'::numeric or coalesce(p_withholding,0)<0 or coalesce(p_withholding,0)>='Infinity'::numeric then raise exception 'Importes de factura inválidos'; end if;
 if p_sales<>round(p_sales,2) or p_service<>round(p_service,2) or p_vat<>round(p_vat,2) or coalesce(p_withholding,0)<>round(coalesce(p_withholding,0),2) then raise exception 'Usa hasta dos decimales en los importes de factura'; end if;
 -- The request ID guards retries; period and invoice guard duplicate economic facts.
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,23));
 select * into v_old from public.cashea_merchant_statements where id=p_request_id;
 if found then
  if row(v_old.period_from,v_old.period_to,v_old.invoice_number,v_old.sales_ref,v_old.commission_percent,v_old.service_ref,v_old.vat_ref,v_old.withholding_ref,v_old.evidence,v_old.ownership_status,v_old.ownership_reason) is distinct from row(p_from,p_to,trim(p_invoice),p_sales,p_percent,p_service,p_vat,coalesce(p_withholding,0),trim(p_evidence),p_ownership_status,trim(p_ownership_reason)) then raise exception 'La solicitud ya fue guardada con otros datos. Recarga antes de corregir'; end if;
  return v_old.id;
 end if;
 insert into public.cashea_merchant_statements(id,period_from,period_to,invoice_number,sales_ref,commission_percent,service_ref,vat_ref,withholding_ref,evidence,ownership_status,ownership_reason)
 values(p_request_id,p_from,p_to,trim(p_invoice),p_sales,p_percent,p_service,p_vat,coalesce(p_withholding,0),trim(p_evidence),p_ownership_status,trim(p_ownership_reason)) returning id into v_id;
 if abs(p_service-round(p_sales*p_percent/100,2))>0.02 then
  perform lubricenter_private.finance_case('cashea_service:'||v_id,'CASHEA_SERVICE_VARIANCE','cashea_merchant_statement',v_id,'Revisar cálculo de comisión Cashea','La factura difiere del porcentaje sobre las ventas informadas. Se conservó el documento sin cambiar caja ni ventas.',jsonb_build_object('invoice_number',trim(p_invoice),'sales_ref',p_sales,'commission_percent',p_percent,'service_ref',p_service,'difference_ref',p_service-round(p_sales*p_percent/100,2)));
 end if;
 return v_id;
exception when unique_violation then raise exception 'Esta factura o período ya está registrado. Revisa el historial antes de guardar';
end $$;
create function public.finance_cashea_statement(p_request_id uuid,p_from date,p_to date,p_invoice text,p_sales numeric,p_percent numeric,p_service numeric,p_vat numeric,p_withholding numeric,p_evidence text,p_ownership_status text default 'UNRESOLVED',p_ownership_reason text default 'Pendiente de atribuir a Lubricenter')
returns uuid language sql security invoker set search_path='' as $$
 select lubricenter_private.finance_cashea_statement(p_request_id,p_from,p_to,p_invoice,p_sales,p_percent,p_service,p_vat,p_withholding,p_evidence,p_ownership_status,p_ownership_reason)
$$;

create function lubricenter_private.finance_cashea_balance_entry(p_request_id uuid,p_kind text,p_date date,p_amount numeric,p_reference text,p_evidence text,p_statement_id uuid default null,p_bank_transaction_id uuid default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_statement public.cashea_merchant_statements; v_bank public.external_transactions; v_old public.cashea_balance_events;
begin
 perform lubricenter_private.finance_require(case when p_kind in ('OPENING_CREDIT','OPENING_DEBIT','ADJUSTMENT_CREDIT','ADJUSTMENT_DEBIT') then 'OWNER' else 'ADMIN' end);
 if p_request_id is null then raise exception 'Falta identificador de solicitud'; end if;
 if p_kind not in ('OPENING_CREDIT','OPENING_DEBIT','COVERAGE_CREDIT','SERVICE_DEDUCTION','PAYOUT','ADJUSTMENT_CREDIT','ADJUSTMENT_DEBIT') then raise exception 'Tipo de balance Cashea inválido'; end if;
 if p_date is null or p_date>timezone('America/Caracas',now())::date then raise exception 'Fecha del movimiento inválida'; end if;
 if p_amount is null or p_amount<=0 or p_amount>='Infinity'::numeric or p_amount<>round(p_amount,2) then raise exception 'Importe USD inválido'; end if;
 if p_reference is null or length(trim(p_reference))<3 or p_evidence is null or length(trim(p_evidence))<5 then raise exception 'Indica referencia y evidencia comprobable'; end if;
 if (p_kind='SERVICE_DEDUCTION')<>(p_statement_id is not null) or (p_bank_transaction_id is not null and p_kind<>'PAYOUT') then raise exception 'Vínculo de balance inválido'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,24));
 select * into v_old from public.cashea_balance_events where request_id=p_request_id;
 if found then
  if row(v_old.kind,v_old.occurred_on,v_old.amount_ref,v_old.reference,v_old.evidence,v_old.statement_id,v_old.bank_transaction_id) is distinct from row(p_kind,p_date,p_amount,trim(p_reference),trim(p_evidence),p_statement_id,p_bank_transaction_id) then raise exception 'La solicitud ya fue guardada con otros datos. Recarga antes de corregir'; end if;
  return v_old.id;
 end if;
 if p_kind='SERVICE_DEDUCTION' then
  select * into v_statement from public.cashea_merchant_statements where id=p_statement_id for update;
  if not found or v_statement.voided_at is not null or p_amount<>v_statement.total_deduct_ref or p_date<v_statement.period_to then raise exception 'El descuento debe coincidir con la factura vigente y ser posterior al período'; end if;
 end if;
 if p_bank_transaction_id is not null then
  select * into v_bank from public.external_transactions where id=p_bank_transaction_id for update;
  if not found or v_bank.direction<>'IN' or v_bank.ownership_status<>'OWN' or v_bank.amount_ref is null or abs(v_bank.amount_ref-p_amount)>0.01 or v_bank.reference<>trim(p_reference) or timezone('America/Caracas',v_bank.occurred_at)::date<>p_date or not exists(select 1 from public.external_sources s join public.financial_accounts a on a.id=s.account_id where s.id=v_bank.source_id and s.provider in ('BDV','BNC') and a.account_type='BANK') then
   raise exception 'El pago no coincide con un ingreso bancario propio comprobado';
  end if;
 end if;
 insert into public.cashea_balance_events(request_id,kind,occurred_on,amount_ref,reference,evidence,statement_id,bank_transaction_id)
 values(p_request_id,p_kind,p_date,p_amount,trim(p_reference),trim(p_evidence),p_statement_id,p_bank_transaction_id) returning id into v_id;
 return v_id;
exception when unique_violation then raise exception 'Ya existe un registro activo para este movimiento, factura o apertura';
end $$;
create function public.finance_cashea_balance_entry(p_request_id uuid,p_kind text,p_date date,p_amount numeric,p_reference text,p_evidence text,p_statement_id uuid default null,p_bank_transaction_id uuid default null)
returns uuid language sql security invoker set search_path='' as $$
 select lubricenter_private.finance_cashea_balance_entry(p_request_id,p_kind,p_date,p_amount,p_reference,p_evidence,p_statement_id,p_bank_transaction_id)
$$;

create function lubricenter_private.finance_cashea_reverse(p_kind text,p_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform lubricenter_private.finance_require('OWNER');
 if p_id is null or p_reason is null or length(trim(p_reason))<5 then raise exception 'Explica la corrección'; end if;
 if p_kind='EVENT' then
  update public.cashea_balance_events set reversed_at=now(),reversed_by=auth.uid(),reversal_reason=trim(p_reason)
   where id=p_id and reversed_at is null;
  if not found then raise exception 'Movimiento no disponible para corregir'; end if;
 elsif p_kind='STATEMENT' then
  perform 1 from public.cashea_merchant_statements where id=p_id and voided_at is null for update;
  if not found then raise exception 'Factura no disponible para corregir'; end if;
  if exists(select 1 from public.cashea_balance_events where statement_id=p_id and reversed_at is null) then raise exception 'Revierte primero el descuento vinculado'; end if;
  update public.cashea_merchant_statements set voided_at=now(),voided_by=auth.uid(),void_reason=trim(p_reason) where id=p_id;
  update public.reconciliation_cases set status='RESOLVED',resolution='Factura anulada: '||trim(p_reason),resolved_at=now(),resolved_by=auth.uid() where subject_id=p_id and kind='CASHEA_SERVICE_VARIANCE' and status='OPEN';
 else raise exception 'Tipo de corrección inválido'; end if;
end $$;
create function public.finance_cashea_reverse(p_kind text,p_id uuid,p_reason text)
returns void language sql security invoker set search_path='' as $$
 select lubricenter_private.finance_cashea_reverse(p_kind,p_id,p_reason)
$$;

-- Aggregate over the full history, independently of the UI page size.
-- An opening anchors the start of a day; earlier evidence stays in history only.
create function lubricenter_private.finance_cashea_balance_summary()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_opening date; v_net numeric; v_total integer;
begin
 perform lubricenter_private.finance_require();
 select occurred_on into v_opening from public.cashea_balance_events where kind in ('OPENING_CREDIT','OPENING_DEBIT') and reversed_at is null;
 select coalesce(sum(amount_ref*case when kind in ('SERVICE_DEDUCTION','PAYOUT','OPENING_DEBIT','ADJUSTMENT_DEBIT') then -1 else 1 end),0)
 into v_net from public.cashea_balance_events where reversed_at is null and (v_opening is null or occurred_on>=v_opening);
 select count(*) into v_total from public.cashea_balance_events;
 return jsonb_build_object('opening_on',v_opening,'recorded_net',v_net::text,'events_total',v_total,
  'pending_bank_payouts',(select count(*) from public.cashea_balance_events where kind='PAYOUT' and reversed_at is null and bank_transaction_id is null),
  'statements_total',(select count(*) from public.cashea_merchant_statements),
  'pending_deductions',(select count(*) from public.cashea_merchant_statements s where voided_at is null and not exists(select 1 from public.cashea_balance_events e where e.statement_id=s.id and e.reversed_at is null)));
end $$;
create function public.finance_cashea_balance_summary()
returns jsonb language sql stable security invoker set search_path='' as $$ select lubricenter_private.finance_cashea_balance_summary() $$;

create function lubricenter_private.finance_cashea_charges(p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
 perform lubricenter_private.finance_require();
 if p_from is null or p_to is null or p_from>p_to or p_to-p_from>366 then raise exception 'Período inválido'; end if;
 select jsonb_build_object('count',count(*),'service_ref',coalesce(sum(service_ref),0)::text,
  'vat_ref',coalesce(sum(vat_ref),0)::text,'withholding_ref',coalesce(sum(withholding_ref),0)::text,
  'total_deduct_ref',coalesce(sum(total_deduct_ref),0)::text,
  'unattributed',count(*) filter(where ownership_status<>'OWN')) into v_result
 from public.cashea_merchant_statements where voided_at is null and period_to between p_from and p_to;
 return v_result;
end $$;
create function public.finance_cashea_charges(p_from date,p_to date)
returns jsonb language sql stable security invoker set search_path='' as $$ select lubricenter_private.finance_cashea_charges(p_from,p_to) $$;

create function lubricenter_private.finance_cashea_ownership(p_id uuid,p_status text,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform lubricenter_private.finance_require();
 if p_status is null or p_status not in ('OWN','SHARED','UNRESOLVED') or p_reason is null or length(trim(p_reason))<5 then raise exception 'Indica propiedad y evidencia de la factura'; end if;
 perform 1 from public.cashea_merchant_statements where id=p_id and voided_at is null for update;
 if not found then raise exception 'Factura no disponible'; end if;
 update public.cashea_merchant_statements set ownership_status=p_status,ownership_reason=trim(p_reason)
 where id=p_id and row(ownership_status,ownership_reason) is distinct from row(p_status,trim(p_reason));
end $$;
create function public.finance_cashea_ownership(p_id uuid,p_status text,p_reason text)
returns void language sql security invoker set search_path='' as $$ select lubricenter_private.finance_cashea_ownership(p_id,p_status,p_reason) $$;

revoke all on function lubricenter_private.finance_cashea_statement(uuid,date,date,text,numeric,numeric,numeric,numeric,numeric,text,text,text) from public,anon,authenticated;
revoke all on function lubricenter_private.finance_cashea_balance_entry(uuid,text,date,numeric,text,text,uuid,uuid) from public,anon,authenticated;
revoke all on function lubricenter_private.finance_cashea_reverse(text,uuid,text) from public,anon,authenticated;
revoke all on function lubricenter_private.finance_cashea_balance_summary() from public,anon,authenticated;
revoke all on function lubricenter_private.finance_cashea_charges(date,date) from public,anon,authenticated;
revoke all on function lubricenter_private.finance_cashea_ownership(uuid,text,text) from public,anon,authenticated;
revoke all on function public.finance_cashea_statement(uuid,date,date,text,numeric,numeric,numeric,numeric,numeric,text,text,text) from public,anon;
revoke all on function public.finance_cashea_balance_entry(uuid,text,date,numeric,text,text,uuid,uuid) from public,anon;
revoke all on function public.finance_cashea_reverse(text,uuid,text) from public,anon;
revoke all on function public.finance_cashea_balance_summary() from public,anon;
revoke all on function public.finance_cashea_charges(date,date) from public,anon;
revoke all on function public.finance_cashea_ownership(uuid,text,text) from public,anon;
grant execute on function lubricenter_private.finance_cashea_statement(uuid,date,date,text,numeric,numeric,numeric,numeric,numeric,text,text,text) to authenticated;
grant execute on function lubricenter_private.finance_cashea_balance_entry(uuid,text,date,numeric,text,text,uuid,uuid) to authenticated;
grant execute on function lubricenter_private.finance_cashea_reverse(text,uuid,text) to authenticated;
grant execute on function lubricenter_private.finance_cashea_balance_summary() to authenticated;
grant execute on function lubricenter_private.finance_cashea_charges(date,date) to authenticated;
grant execute on function lubricenter_private.finance_cashea_ownership(uuid,text,text) to authenticated;
grant execute on function public.finance_cashea_statement(uuid,date,date,text,numeric,numeric,numeric,numeric,numeric,text,text,text) to authenticated;
grant execute on function public.finance_cashea_balance_entry(uuid,text,date,numeric,text,text,uuid,uuid) to authenticated;
grant execute on function public.finance_cashea_reverse(text,uuid,text) to authenticated;
grant execute on function public.finance_cashea_balance_summary() to authenticated;
grant execute on function public.finance_cashea_charges(date,date) to authenticated;
grant execute on function public.finance_cashea_ownership(uuid,text,text) to authenticated;
