-- Additive Finance Core. Apply this file only after reviewing docs/finance-core-v2.2-audit.md.
-- No external evidence writes to payments, revenue, inventory or receivable balances.
create schema if not exists lubricenter_private;

create table public.finance_memberships (
  user_id uuid primary key references auth.users(id) on delete restrict,
  role text not null check(role in ('OPERATOR','ADMIN')),
  granted_by uuid not null, granted_at timestamptz not null default now()
);
create function lubricenter_private.finance_role() returns text language sql stable security definer set search_path='' as $$
 select case when exists(select 1 from auth.users where id=auth.uid() and lower(email)='lubricenterc@gmail.com' and email_confirmed_at is not null) then 'OWNER'
 else coalesce((select role from public.finance_memberships where user_id=auth.uid()),'OPERATOR') end
$$;
create function lubricenter_private.finance_require(p_role text default 'ADMIN') returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.uid() is null then raise exception 'Inicia sesión para continuar'; end if;
 if p_role='OWNER' and lubricenter_private.finance_role()<>'OWNER' or p_role='ADMIN' and lubricenter_private.finance_role() not in ('ADMIN','OWNER') then raise exception 'Esta acción necesita un administrador financiero'; end if;
end $$;
create function public.finance_role() returns text language sql stable security invoker set search_path='' as $$ select lubricenter_private.finance_role() $$;

create table public.external_sources (
 id uuid primary key default gen_random_uuid(), provider text not null check(provider in ('BDV','CASHEA_TRANSACTIONS','CASHEA_ORDERS')),
 name text not null, account_id uuid references public.financial_accounts(id) on delete restrict,
 external_account text not null default '', currency text not null check(currency in ('USD','VES')),
 active boolean not null default true, created_at timestamptz not null default now(), created_by uuid default auth.uid(),
 unique(provider,external_account), check(provider<>'BDV' or account_id is not null)
);
create table public.external_import_batches (
 id uuid primary key default gen_random_uuid(), source_id uuid not null references public.external_sources(id),
 fingerprint text not null, parser_version text not null default '2.2.0', source_name text not null,
 requested_from date not null, requested_to date not null, observed_from date, observed_to date,
 status text not null default 'REVIEW' check(status in ('REVIEW','COMPLETE','REJECTED')),
 row_count integer not null check(row_count>=0), duplicate_count integer not null default 0,
 balance_chain boolean, controls jsonb not null default '{}', validation jsonb not null default '{}', payload jsonb not null,
 created_at timestamptz not null default now(), created_by uuid default auth.uid(), verified_at timestamptz, verified_by uuid,
 unique(source_id,fingerprint), check(requested_from<=requested_to), check(requested_to-requested_from<=366)
);
create table public.external_transactions (
 id uuid primary key default gen_random_uuid(), source_id uuid not null references public.external_sources(id),
 identity_key text not null, first_batch_id uuid not null references public.external_import_batches(id),
 occurred_at timestamptz not null, reference text not null, description text not null, direction text not null check(direction in ('IN','OUT')),
 currency text not null check(currency in ('USD','VES')), amount numeric(20,8) not null check(amount>0 and amount<'Infinity'::numeric),
 balance numeric(20,8), amount_ref numeric(20,8), assigned_ref numeric(20,8), exchange_rate numeric(20,8), rate_date date,
 external_order text, installments integer[], provider_account text, channel_label text,
 ownership_status text not null check(ownership_status in ('OWN','OTHER_LOCATION','UNRESOLVED')),
 ownership_reason text not null, ownership_evidence jsonb not null default '{}',
 nature text not null default 'UNCLASSIFIED', category text, classification_reason text,
 raw jsonb not null, created_at timestamptz not null default now(), unique(source_id,identity_key),
 check(amount_ref is null or amount_ref>0 and amount_ref<'Infinity'::numeric),
 check(assigned_ref is null or assigned_ref>0 and assigned_ref<'Infinity'::numeric),
 check(exchange_rate is null or exchange_rate>0 and exchange_rate<'Infinity'::numeric),
 check(balance is null or abs(balance)<'Infinity'::numeric)
);
create table public.external_batch_transactions (
 batch_id uuid not null references public.external_import_batches(id), transaction_id uuid not null references public.external_transactions(id),
 row_number integer not null, primary key(batch_id,transaction_id,row_number)
);
create table public.cashea_order_snapshots (
 id uuid primary key default gen_random_uuid(), batch_id uuid not null references public.external_import_batches(id),
 external_order text not null, purchased_on date not null, status text not null check(status in ('IN PROGRESS','CLOSED','CANCELLED')),
 total_ref numeric(20,8) not null check(total_ref>0 and total_ref<'Infinity'::numeric),
 initial_ref numeric(20,8) not null check(initial_ref>=0 and initial_ref<'Infinity'::numeric),
 installments jsonb not null, raw jsonb not null, created_at timestamptz not null default now(), unique(batch_id,external_order)
);
create table public.reconciliation_allocations (
 id uuid primary key default gen_random_uuid(), request_id uuid not null unique,
 external_transaction_id uuid not null references public.external_transactions(id),
 account_movement_id uuid references public.account_movements(id) on delete restrict,
 cashea_installment_id uuid references public.cashea_installments(id) on delete restrict,
 cashea_sale_id uuid references public.cashea_sales(id) on delete restrict,
 currency text not null check(currency in ('USD','VES')),
 external_amount numeric(20,8) not null check(external_amount>0 and external_amount<'Infinity'::numeric),
 target_amount numeric(20,8) not null check(target_amount>0 and target_amount<'Infinity'::numeric),
 difference numeric(20,8) generated always as (external_amount-target_amount) stored,
 method text not null check(method in ('EXACT','ROUNDING','MANUAL')), reason text not null,
 created_at timestamptz not null default now(), created_by uuid default auth.uid(), reversed_at timestamptz, reversed_by uuid, reversal_reason text,
 check(num_nonnulls(account_movement_id,cashea_installment_id,cashea_sale_id)=1),
 check(method<>'EXACT' or external_amount=target_amount), check(reversed_at is null or length(trim(reversal_reason))>0)
);
create table public.reconciliation_cases (
 id uuid primary key default gen_random_uuid(), case_key text not null unique, kind text not null,
 status text not null default 'OPEN' check(status in ('OPEN','RESOLVED','DISMISSED')),
 subject_type text not null, subject_id uuid not null, title text not null, explanation text not null,
 evidence jsonb not null default '{}', resolution text, resolved_by uuid, resolved_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.reconciliation_rules (
 id uuid primary key default gen_random_uuid(), version integer not null default 1, source_id uuid references public.external_sources(id),
 description_contains text not null check(length(trim(description_contains))>=6), nature text not null, category text,
 active boolean not null default true, approved_by uuid not null, approved_at timestamptz not null default now(),
 check(nature in ('BANK_FEE','EXPENSE'))
);
create table public.finance_cash_openings (
 account_id uuid primary key references public.financial_accounts(id), effective_at timestamptz not null,
 amount numeric(20,8) not null check(amount>=0 and amount<'Infinity'::numeric), reason text not null,
 created_by uuid default auth.uid(), created_at timestamptz not null default now()
);
alter table public.account_movements add column finance_nature text;
alter table public.account_movements add constraint account_movements_finance_nature_check check(finance_nature is null or finance_nature in ('EXPENSE','INVENTORY_PURCHASE','ASSET_PURCHASE','SUPPLIER_PAYMENT','OWNER_DRAW','PAYROLL','INTERNAL_TRANSFER','REFUND','TAX','BANK_FEE','UNCLASSIFIED'));
alter table public.account_movements add column finance_request_id uuid unique;
alter table public.cash_closings add column finance_version integer;
alter table public.cashea_sales add column ownership_status text not null default 'OWN' check(ownership_status in ('OWN','OTHER_LOCATION','UNRESOLVED'));
alter table public.cashea_sales add column ownership_reason text not null default 'INTERNAL_ORDER';
alter table public.cashea_sales add column ownership_evidence jsonb not null default '{}';

create index external_batches_source_dates on public.external_import_batches(source_id,requested_from,requested_to);
create index external_transactions_order_idx on public.external_transactions(external_order) where external_order is not null;
create index external_transactions_date_idx on public.external_transactions(source_id,occurred_at);
create index external_transactions_batch_idx on public.external_transactions(first_batch_id);
create index external_batch_transaction_idx on public.external_batch_transactions(transaction_id);
create index cashea_snapshots_order_idx on public.cashea_order_snapshots(external_order,created_at desc);
create index allocations_external_idx on public.reconciliation_allocations(external_transaction_id) where reversed_at is null;
create index allocations_movement_idx on public.reconciliation_allocations(account_movement_id) where reversed_at is null;
create index allocations_installment_idx on public.reconciliation_allocations(cashea_installment_id) where reversed_at is null;
create index allocations_cashea_initial_idx on public.reconciliation_allocations(cashea_sale_id) where reversed_at is null;
create index reconciliation_cases_open_idx on public.reconciliation_cases(updated_at desc) where status='OPEN';

create function lubricenter_private.finance_audit() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and tg_table_name='reconciliation_cases' and to_jsonb(new)-'updated_at'=to_jsonb(old)-'updated_at' then return new; end if;
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('finance.'||lower(tg_op),tg_table_name,
 case when tg_op='DELETE' then coalesce((to_jsonb(old)->>'id')::uuid,(to_jsonb(old)->>'account_id')::uuid) else coalesce((to_jsonb(new)->>'id')::uuid,(to_jsonb(new)->>'account_id')::uuid) end,
 jsonb_build_object('before',case when tg_op='INSERT' then null else to_jsonb(old) end,'after',case when tg_op='DELETE' then null else to_jsonb(new) end));
 return coalesce(new,old);
end $$;
do $$ declare t text; begin
 foreach t in array array['finance_memberships','external_sources','external_import_batches','external_transactions','external_batch_transactions','cashea_order_snapshots','reconciliation_allocations','reconciliation_cases','reconciliation_rules','finance_cash_openings'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy finance_admin_read on public.%I for select to authenticated using ((select lubricenter_private.finance_role()) in (''OWNER'',''ADMIN''))',t);
  if t not in ('external_batch_transactions') then execute format('create trigger finance_audit after insert or update or delete on public.%I for each row execute function lubricenter_private.finance_audit()',t); end if;
end loop;
end $$;

-- Existing audit_events has a broad authenticated read policy. A restrictive policy
-- prevents imported financial evidence leaking back to operators through the audit log.
create policy finance_audit_visibility on public.audit_events as restrictive for select to authenticated
 using (event_type not like 'finance.%' or (select lubricenter_private.finance_role()) in ('ADMIN','OWNER'));
create function lubricenter_private.finance_immutable_audit() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.event_type like 'finance.%' then raise exception 'El historial financiero es inmutable'; end if;
 return coalesce(new,old);
end $$;
create trigger finance_immutable_audit before update or delete on public.audit_events for each row execute function lubricenter_private.finance_immutable_audit();

create function lubricenter_private.finance_case(p_key text,p_kind text,p_type text,p_id uuid,p_title text,p_explanation text,p_evidence jsonb default '{}') returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 insert into public.reconciliation_cases(case_key,kind,subject_type,subject_id,title,explanation,evidence,updated_at)
 values(p_key,p_kind,p_type,p_id,p_title,p_explanation,p_evidence,clock_timestamp())
 on conflict(case_key) do update set title=excluded.title,explanation=excluded.explanation,evidence=excluded.evidence,
 status=case when public.reconciliation_cases.status='DISMISSED' and public.reconciliation_cases.evidence=excluded.evidence then 'DISMISSED' else 'OPEN' end,updated_at=clock_timestamp()
 returning id into v_id; return v_id;
end $$;

create function lubricenter_private.finance_configure(p_action text,p_data jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 perform lubricenter_private.finance_require('OWNER');
 if p_action='MEMBERSHIP' then
  insert into public.finance_memberships(user_id,role,granted_by) values((p_data->>'user_id')::uuid,p_data->>'role',auth.uid())
  on conflict(user_id) do update set role=excluded.role,granted_by=auth.uid(),granted_at=now();
  return (p_data->>'user_id')::uuid;
 elsif p_action='SOURCE' then
  if p_data->>'provider'='BDV' and not exists(select 1 from public.financial_accounts where id=(p_data->>'account_id')::uuid and code='BDV' and currency='VES' and active) then raise exception 'Selecciona la cuenta Banco de Venezuela'; end if;
  insert into public.external_sources(provider,name,account_id,external_account,currency) values(p_data->>'provider',p_data->>'name',nullif(p_data->>'account_id','')::uuid,coalesce(p_data->>'external_account',''),p_data->>'currency') returning id into v_id;
 elsif p_action='RULE' then
  insert into public.reconciliation_rules(source_id,description_contains,nature,category,approved_by) values(nullif(p_data->>'source_id','')::uuid,upper(trim(p_data->>'description_contains')),p_data->>'nature',p_data->>'category',auth.uid()) returning id into v_id;
 elsif p_action='DISABLE_RULE' then
  update public.reconciliation_rules set active=false where id=(p_data->>'id')::uuid returning id into v_id;
 else raise exception 'Acción de configuración inválida'; end if;
 return v_id;
end $$;
create function public.finance_configure(p_action text,p_data jsonb) returns uuid language sql security invoker set search_path='' as $$ select lubricenter_private.finance_configure(p_action,p_data) $$;

create function lubricenter_private.finance_import(p_source_id uuid,p_name text,p_from date,p_to date,p_preview jsonb) returns uuid language plpgsql security definer set search_path='' as $$
declare s public.external_sources; b uuid; t uuid; r jsonb; v_key text; v_fp text; v_own text; v_reason text; v_matches integer; v_sale uuid; v_bad boolean; v_time timestamptz;
begin
 perform lubricenter_private.finance_require();
 select * into s from public.external_sources where id=p_source_id and active for update;
 if not found then raise exception 'Fuente no disponible'; end if;
 if s.provider<>p_preview->>'provider' then raise exception 'Reporte incompatible con la fuente'; end if;
 if p_from is null or p_to is null or p_to<p_from or p_to-p_from>366 then raise exception 'Selecciona un período válido, máximo un año'; end if;
 if jsonb_typeof(p_preview->'rows')<>'array' or jsonb_typeof(p_preview->'orders')<>'array' or jsonb_typeof(p_preview->'errors')<>'array' then raise exception 'Formato del reporte inválido'; end if;
 if jsonb_array_length(p_preview->'rows')+jsonb_array_length(p_preview->'orders')>10000 then raise exception 'Importa hasta 10000 filas por lote'; end if;
 if jsonb_array_length(p_preview->'rows')+jsonb_array_length(p_preview->'orders')=0 then raise exception 'El reporte está vacío'; end if;
 v_fp:=md5(jsonb_build_object('from',p_from,'to',p_to,'rows',p_preview->'rows','orders',p_preview->'orders','errors',p_preview->'errors')::text);
 select id into b from public.external_import_batches where source_id=s.id and fingerprint=v_fp;
 if b is not null then return b; end if;
 insert into public.external_import_batches(source_id,fingerprint,source_name,requested_from,requested_to,row_count,duplicate_count,balance_chain,validation,payload)
 values(s.id,v_fp,left(p_name,200),p_from,p_to,jsonb_array_length(p_preview->'rows')+jsonb_array_length(p_preview->'orders'),coalesce((p_preview->>'duplicates')::integer,0),null,
 jsonb_build_object('errors',p_preview->'errors','warnings',p_preview->'warnings'),p_preview) returning id into b;
 for r in select value from jsonb_array_elements(p_preview->'rows') loop
  v_time:=(r->>'occurred_at')::timestamptz;
  if s.provider='CASHEA_ORDERS' or coalesce(r->>'reference','')!~'^\d+$' or coalesce(r->>'direction','') not in ('IN','OUT') or r->>'currency'<>s.currency or (r->>'amount')::numeric is null or (r->>'amount')::numeric<=0 or (r->>'amount')::numeric>='Infinity'::numeric then raise exception 'Movimiento inválido en fila %',r->>'row'; end if;
  if s.provider='BDV' and (r->>'balance') is null then raise exception 'Falta saldo BDV'; end if;
  if s.provider='CASHEA_TRANSACTIONS' and (coalesce(r->>'external_order','')!~'^\d+$' or (r->>'amount_ref') is null or (r->>'assigned_ref') is null or coalesce(r->>'provider_account','')<>s.external_account or r->>'direction'<>'IN') then raise exception 'Reporte Cashea: revisa cuenta, orden y montos en fila %',r->>'row'; end if;
  v_key:=md5(jsonb_build_array(v_time,r->>'reference',r->>'direction',(r->>'amount')::numeric,case when s.provider='BDV' then (r->>'balance')::numeric else null end,coalesce(r->>'provider_account',''))::text);
  v_own:='OWN'; v_reason:='OWN_BANK_ACCOUNT'; v_sale:=null;
  if s.provider='CASHEA_TRANSACTIONS' then
   select count(*),(array_agg(id))[1] into v_matches,v_sale from public.cashea_sales where trim(cashea_reference)=r->>'external_order' and status<>'CANCELLED';
   v_own:=case when v_matches=1 then 'OWN' else 'UNRESOLVED' end; v_reason:=case when v_matches=1 then 'ORDER_MATCH' else 'UNKNOWN' end;
  end if;
  insert into public.external_transactions(source_id,identity_key,first_batch_id,occurred_at,reference,description,direction,currency,amount,balance,amount_ref,assigned_ref,exchange_rate,rate_date,external_order,installments,provider_account,channel_label,ownership_status,ownership_reason,ownership_evidence,raw)
  values(s.id,v_key,b,v_time,r->>'reference',r->>'description',r->>'direction',r->>'currency',(r->>'amount')::numeric,(r->>'balance')::numeric,(r->>'amount_ref')::numeric,(r->>'assigned_ref')::numeric,(r->>'rate')::numeric,(r->>'rate_date')::date,r->>'external_order',array(select value::integer from jsonb_array_elements_text(coalesce(r->'installments','[]'))),r->>'provider_account',r->>'channel_label',v_own,v_reason,jsonb_build_object('cashea_sale_id',v_sale),r->'raw')
  on conflict(source_id,identity_key) do nothing returning id into t;
  if t is null then
   select id into t from public.external_transactions where source_id=s.id and identity_key=v_key;
   if exists(select 1 from public.external_transactions where id=t and (external_order is distinct from r->>'external_order' or amount_ref is distinct from (r->>'amount_ref')::numeric or assigned_ref is distinct from (r->>'assigned_ref')::numeric or installments is distinct from array(select value::integer from jsonb_array_elements_text(coalesce(r->'installments','[]'))))) then
    perform lubricenter_private.finance_case('conflict:'||t,'SOURCE_CONFLICT','external_transaction',t,'Reporte con versiones distintas','El mismo cobro aparece con otra orden, cuota o importe. No se duplicó ni sobrescribió.',jsonb_build_object('batch_id',b,'row',r));
   end if;
  end if;
  insert into public.external_batch_transactions values(b,t,(r->>'row')::integer) on conflict do nothing;
  if (r->>'assigned_ref')::numeric-(r->>'amount_ref')::numeric>0.005 then perform lubricenter_private.finance_case('amount:'||t,'SOURCE_AMOUNT','external_transaction',t,'Revisar importe Cashea','Monto asignado supera el USD informado más allá de medio centavo; conserva ambas cifras.',r); end if;
  t:=null;
 end loop;
 for r in select value from jsonb_array_elements(p_preview->'orders') loop
  if s.provider<>'CASHEA_ORDERS' or coalesce(r->>'external_order','')!~'^\d+$' or jsonb_typeof(r->'installments')<>'array' then raise exception 'Snapshot Cashea inválido'; end if;
  insert into public.cashea_order_snapshots(batch_id,external_order,purchased_on,status,total_ref,initial_ref,installments,raw)
  values(b,r->>'external_order',(r->>'purchased_on')::date,r->>'status',(r->>'total_ref')::numeric,(r->>'initial_ref')::numeric,r->'installments',r->'raw');
 end loop;
 update public.external_import_batches set
 observed_from=(select min(d) from (select timezone('America/Caracas',x.occurred_at)::date d from public.external_transactions x join public.external_batch_transactions l on l.transaction_id=x.id where l.batch_id=b union all select purchased_on from public.cashea_order_snapshots where batch_id=b) q),
 observed_to=(select max(d) from (select timezone('America/Caracas',x.occurred_at)::date d from public.external_transactions x join public.external_batch_transactions l on l.transaction_id=x.id where l.batch_id=b union all select purchased_on from public.cashea_order_snapshots where batch_id=b) q)
 where id=b;
 -- Recalculate chain from persisted decimals; never trust browser's 'complete' or chain flag.
 if s.provider='BDV' then
  with ordered as (select x.*,lag(balance) over(order by x.occurred_at,case when (select (z->>'occurred_at')::timestamptz from jsonb_array_elements(p_preview->'rows') z limit 1) >= (select (z->>'occurred_at')::timestamptz from jsonb_array_elements(p_preview->'rows') with ordinality a(z,n) order by n desc limit 1) then -l.row_number else l.row_number end) prev from public.external_transactions x join public.external_batch_transactions l on l.transaction_id=x.id where l.batch_id=b)
  select bool_or(prev is not null and balance<>prev+case when direction='IN' then amount else -amount end) into v_bad from ordered;
  update public.external_import_batches set balance_chain=not coalesce(v_bad,false) where id=b;
 end if;
 perform lubricenter_private.finance_case('batch:'||b,'COVERAGE','import_batch',b,'Confirmar cobertura del reporte','La fecha del primer y último movimiento no prueba que estén todas las páginas.',jsonb_build_object('source_name',p_name));
 return b;
end $$;
create function public.finance_import(p_source_id uuid,p_name text,p_from date,p_to date,p_preview jsonb) returns uuid language sql security invoker set search_path='' as $$ select lubricenter_private.finance_import(p_source_id,p_name,p_from,p_to,p_preview) $$;

create function lubricenter_private.finance_verify_batch(p_id uuid,p_controls jsonb) returns void language plpgsql security definer set search_path='' as $$
declare b public.external_import_batches; s public.external_sources; v_total numeric; v_in numeric; v_out numeric; v_first numeric; v_last numeric; v_count integer; v_desc boolean;
begin
 perform lubricenter_private.finance_require();
 select * into b from public.external_import_batches where id=p_id for update;
 if not found then raise exception 'Lote no encontrado'; end if;
 select * into s from public.external_sources where id=b.source_id;
 if b.status='COMPLETE' then return; end if;
 if jsonb_array_length(b.validation->'errors')>0 then raise exception 'Revisa los errores del archivo y vuelve a importarlo completo'; end if;
 if b.observed_from<b.requested_from or b.observed_to>b.requested_to then raise exception 'Hay movimientos fuera del período solicitado'; end if;
 if coalesce(p_controls->>'all_pages','false')<>'true' or length(trim(coalesce(p_controls->>'evidence','')))<10 then raise exception 'Indica el control independiente del reporte y confirma todas las páginas'; end if;
 if (p_controls->>'from')::date is distinct from b.requested_from or (p_controls->>'to')::date is distinct from b.requested_to then raise exception 'Las fechas del control no coinciden con el período'; end if;
 if s.provider='CASHEA_ORDERS' then
  select count(*),coalesce(sum(total_ref),0) into v_count,v_total from public.cashea_order_snapshots where batch_id=b.id;
 else
  select count(*),coalesce(sum(case when s.provider='BDV' then x.amount else x.amount_ref end),0),coalesce(sum(amount) filter(where direction='IN'),0),coalesce(sum(amount) filter(where direction='OUT'),0) into v_count,v_total,v_in,v_out from public.external_transactions x where exists(select 1 from public.external_batch_transactions l where l.batch_id=b.id and l.transaction_id=x.id);
 end if;
 if (p_controls->>'expected_count')::integer is distinct from v_count or (p_controls->>'expected_total')::numeric is distinct from v_total then raise exception 'Cantidad o total del control no coincide. No se puede confirmar cobertura'; end if;
 if s.provider='BDV' then
  if b.balance_chain is distinct from true then raise exception 'La cadena de saldos tiene saltos'; end if;
  v_desc:=(b.payload->'rows'->0->>'occurred_at')::timestamptz>=(b.payload->'rows'->-1->>'occurred_at')::timestamptz;
  select x.balance-case when x.direction='IN' then x.amount else -x.amount end into v_first from public.external_transactions x join public.external_batch_transactions l on l.transaction_id=x.id where l.batch_id=b.id order by x.occurred_at,case when v_desc then -l.row_number else l.row_number end limit 1;
  select x.balance into v_last from public.external_transactions x join public.external_batch_transactions l on l.transaction_id=x.id where l.batch_id=b.id order by x.occurred_at desc,case when v_desc then l.row_number else -l.row_number end limit 1;
  if (p_controls->>'opening')::numeric is distinct from v_first or (p_controls->>'closing')::numeric is distinct from v_last or (p_controls->>'opening')::numeric+v_in-v_out is distinct from (p_controls->>'closing')::numeric then raise exception 'Saldos inicial/final no coinciden con el control independiente'; end if;
 end if;
 update public.external_import_batches set status='COMPLETE',controls=p_controls,verified_by=auth.uid(),verified_at=now() where id=b.id;
 update public.reconciliation_cases set status='RESOLVED',resolution='Cobertura verificada con controles',resolved_by=auth.uid(),resolved_at=now() where case_key='batch:'||b.id;
end $$;
create function public.finance_verify_batch(p_id uuid,p_controls jsonb) returns void language sql security invoker set search_path='' as $$ select lubricenter_private.finance_verify_batch(p_id,p_controls) $$;

create function lubricenter_private.finance_allocate(p_request_id uuid,p_external_id uuid,p_movement_id uuid,p_installment_id uuid,p_external_amount numeric,p_target_amount numeric,p_method text,p_reason text,p_sale_id uuid default null) returns uuid language plpgsql security definer set search_path='' as $$
declare x public.external_transactions; s public.external_sources; m public.account_movements; i public.cashea_installments; c public.cashea_sales; v_id uuid; v_used numeric; v_capacity numeric; v_currency text; v_tolerance numeric; a public.reconciliation_allocations;
begin
 perform lubricenter_private.finance_require();
 if p_request_id is null or length(trim(coalesce(p_reason,'')))<3 then raise exception 'Identificador y motivo requeridos'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,22));
 select * into a from public.reconciliation_allocations where request_id=p_request_id;
 if found then
  if a.external_transaction_id<>p_external_id or a.account_movement_id is distinct from p_movement_id or a.cashea_installment_id is distinct from p_installment_id or a.cashea_sale_id is distinct from p_sale_id or a.external_amount<>p_external_amount or a.target_amount<>p_target_amount or a.method<>p_method then raise exception 'La clave de operación ya se usó con otros datos'; end if;
  return a.id;
 end if;
 if num_nonnulls(p_movement_id,p_installment_id,p_sale_id)<>1 or p_external_amount is null or p_target_amount is null or p_external_amount<=0 or p_target_amount<=0 or p_external_amount>='Infinity'::numeric or p_target_amount>='Infinity'::numeric then raise exception 'Asignación inválida'; end if;
 select * into x from public.external_transactions where id=p_external_id for update;
 if not found or x.ownership_status<>'OWN' then raise exception 'Resuelve primero a quién pertenece el cobro'; end if;
 if exists(select 1 from public.reconciliation_cases where subject_id=x.id and status='OPEN' and kind in ('SOURCE_CONFLICT','SOURCE_AMOUNT')) then raise exception 'Resuelve la inconsistencia del reporte antes de asignar'; end if;
 select * into s from public.external_sources where id=x.source_id;
 if p_movement_id is not null then
  if s.provider<>'BDV' then raise exception 'Cashea se asigna a cuotas; el banco se asigna a movimientos'; end if;
  select * into m from public.account_movements where id=p_movement_id for update;
  if not found or m.account_id<>s.account_id or m.currency<>x.currency or m.direction<>x.direction then raise exception 'Cuenta, moneda o dirección incompatible'; end if;
  if m.source_payment_id is not null and exists(select 1 from public.payments p join public.orders o on o.id=p.order_id where p.id=m.source_payment_id and o.status='CANCELLED') then raise exception 'El pago pertenece a una orden anulada'; end if;
  v_capacity:=m.amount_original; v_currency:=m.currency;
  select coalesce(sum(target_amount),0) into v_used from public.reconciliation_allocations where account_movement_id=m.id and reversed_at is null;
 elsif p_sale_id is not null then
  if s.provider<>'CASHEA_TRANSACTIONS' or not 0=any(x.installments) then raise exception 'Este movimiento no documenta una inicial Cashea'; end if;
  select * into c from public.cashea_sales where id=p_sale_id for update;
  if not found or c.status='CANCELLED' or c.ownership_status<>'OWN' or trim(c.cashea_reference) is distinct from x.external_order then raise exception 'Inicial incompatible con la orden Cashea'; end if;
  v_capacity:=c.initial_ref; v_currency:='USD';
  select coalesce(sum(target_amount),0) into v_used from public.reconciliation_allocations where cashea_sale_id=c.id and reversed_at is null;
 else
  if s.provider<>'CASHEA_TRANSACTIONS' then raise exception 'Solo el reporte de cobros Cashea se asigna a cuotas'; end if;
  select * into i from public.cashea_installments where id=p_installment_id for update;
  if not found then raise exception 'Cuota no encontrada'; end if;
  select * into c from public.cashea_sales where id=i.cashea_sale_id;
  if c.status='CANCELLED' or c.ownership_status<>'OWN' or trim(c.cashea_reference) is distinct from x.external_order or not i.installment_no=any(x.installments) then raise exception 'Orden o cuota incompatible con el reporte'; end if;
  v_capacity:=i.amount_ref; v_currency:='USD';
  select coalesce(sum(target_amount),0) into v_used from public.reconciliation_allocations where cashea_installment_id=i.id and reversed_at is null;
 end if;
 if s.provider='CASHEA_TRANSACTIONS' and (select status from public.cashea_order_snapshots where external_order=x.external_order order by created_at desc,id desc limit 1)='CANCELLED' then raise exception 'La última evidencia Cashea muestra la orden cancelada'; end if;
 if v_used+p_target_amount>v_capacity then raise exception 'La asignación excede el saldo conciliable del destino'; end if;
 v_capacity:=case when s.provider='BDV' then x.amount else least(x.amount_ref,x.assigned_ref) end;
 select coalesce(sum(external_amount),0) into v_used from public.reconciliation_allocations where external_transaction_id=x.id and reversed_at is null;
 if v_capacity is null or v_used+p_external_amount>v_capacity then raise exception 'El movimiento externo no tiene saldo suficiente'; end if;
 v_tolerance:=case when v_currency='VES' then least(5,p_target_amount*.001) when s.provider='CASHEA_TRANSACTIONS' then least(0.005,p_target_amount*.001) else 0 end;
 if p_method='ROUNDING' and abs(p_external_amount-p_target_amount)>v_tolerance then raise exception 'Diferencia fuera de tolerancia'; end if;
 if p_method='MANUAL' and p_external_amount<>p_target_amount then raise exception 'Una diferencia comercial necesita ajuste documentado separado, no conciliación manual'; end if;
 insert into public.reconciliation_allocations(request_id,external_transaction_id,account_movement_id,cashea_installment_id,cashea_sale_id,currency,external_amount,target_amount,method,reason)
 values(p_request_id,x.id,p_movement_id,p_installment_id,p_sale_id,v_currency,p_external_amount,p_target_amount,p_method,trim(p_reason)) returning id into v_id;
 return v_id;
end $$;
create function public.finance_allocate(p_request_id uuid,p_external_id uuid,p_movement_id uuid,p_installment_id uuid,p_external_amount numeric,p_target_amount numeric,p_method text,p_reason text,p_sale_id uuid default null) returns uuid language sql security invoker set search_path='' as $$ select lubricenter_private.finance_allocate(p_request_id,p_external_id,p_movement_id,p_installment_id,p_external_amount,p_target_amount,p_method,p_reason,p_sale_id) $$;

create function lubricenter_private.finance_resolve(p_action text,p_id uuid,p_data jsonb) returns void language plpgsql security definer set search_path='' as $$
declare x public.external_transactions; v_role text;
begin
 perform lubricenter_private.finance_require(); v_role:=lubricenter_private.finance_role();
 if length(trim(coalesce(p_data->>'reason','')))<5 then raise exception 'Escribe el motivo para el historial'; end if;
 if p_action='OWNERSHIP' then
  select * into x from public.external_transactions where id=p_id for update;
  if not found then raise exception 'Movimiento no encontrado'; end if;
  if exists(select 1 from public.reconciliation_allocations where external_transaction_id=x.id and reversed_at is null) then raise exception 'Revierte las asignaciones antes de cambiar propiedad'; end if;
  if p_data->>'status' not in ('OWN','OTHER_LOCATION','UNRESOLVED') then raise exception 'Propiedad inválida'; end if;
  update public.external_transactions set ownership_status=p_data->>'status',ownership_reason='MANUAL_ASSIGNMENT',ownership_evidence=jsonb_build_object('reason',p_data->>'reason','actor',auth.uid()) where id=p_id;
 elsif p_action='CLASSIFY' then
  if p_data->>'nature' not in ('EXPENSE','INVENTORY_PURCHASE','ASSET_PURCHASE','SUPPLIER_PAYMENT','OWNER_DRAW','PAYROLL','INTERNAL_TRANSFER','REFUND','TAX','BANK_FEE','UNCLASSIFIED') then raise exception 'Naturaleza inválida'; end if;
  if p_data->>'nature'='OWNER_DRAW' and v_role<>'OWNER' then raise exception 'El dueño debe confirmar sus retiros'; end if;
  if p_data->>'nature' in ('EXPENSE','BANK_FEE') and length(trim(coalesce(p_data->>'category','')))=0 then raise exception 'Selecciona categoría'; end if;
  update public.external_transactions set nature=p_data->>'nature',category=nullif(trim(p_data->>'category'),''),classification_reason=p_data->>'reason' where id=p_id and direction='OUT';
  if not found then raise exception 'Salida no encontrada'; end if;
 elsif p_action='CLASSIFY_MOVEMENT' then
  if p_data->>'nature' not in ('EXPENSE','ASSET_PURCHASE','OWNER_DRAW','TAX','BANK_FEE','UNCLASSIFIED') then raise exception 'Vincula la compra, proveedor o transferencia desde su módulo antes de clasificar'; end if;
  if p_data->>'nature'='OWNER_DRAW' and v_role<>'OWNER' then raise exception 'El dueño debe confirmar sus retiros'; end if;
  if p_data->>'nature' in ('EXPENSE','BANK_FEE') and length(trim(coalesce(p_data->>'category','')))=0 then raise exception 'Selecciona categoría'; end if;
  update public.account_movements set finance_nature=p_data->>'nature',category=nullif(trim(p_data->>'category'),''),movement_type=case when p_data->>'nature' in ('EXPENSE','TAX','BANK_FEE') then 'EXPENSE' else 'ADJUSTMENT' end
   where id=p_id and finance_nature='UNCLASSIFIED' and direction='OUT';
  if not found then raise exception 'La salida ya fue clasificada; recarga antes de cambiarla'; end if;
  insert into public.audit_events(event_type,entity_type,entity_id,data) values('finance.nature_classified','account_movement',p_id,p_data);
  if p_data->>'nature'<>'UNCLASSIFIED' then update public.reconciliation_cases set status='RESOLVED',resolution=p_data->>'reason',resolved_by=auth.uid(),resolved_at=now() where case_key='nature:'||p_id; end if;
 elsif p_action='REVERSE_ALLOCATION' then
  perform 1 from public.external_transactions where id=(select external_transaction_id from public.reconciliation_allocations where id=p_id) for update;
  update public.reconciliation_allocations set reversed_at=now(),reversed_by=auth.uid(),reversal_reason=p_data->>'reason' where id=p_id and reversed_at is null;
 elsif p_action='DISMISS_CASE' then
  if v_role<>'OWNER' then raise exception 'Solo el dueño puede descartar una anomalía'; end if;
  update public.reconciliation_cases set status='DISMISSED',resolution=p_data->>'reason',resolved_by=auth.uid(),resolved_at=now() where id=p_id and kind not in ('COVERAGE','SOURCE_CONFLICT','SOURCE_AMOUNT');
 else raise exception 'Acción inválida'; end if;
end $$;
create function public.finance_resolve(p_action text,p_id uuid,p_data jsonb) returns void language sql security invoker set search_path='' as $$ select lubricenter_private.finance_resolve(p_action,p_id,p_data) $$;

-- Mandatory capture only for new payments / explicit reference edits. No historical backfill.
create function lubricenter_private.finance_reference_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='payments' then
  if new.method in ('TRANSFER_BDV','TRANSFER_BNC','MOBILE_PAYMENT') and coalesce(trim(new.reference),'')!~'^\d{4,32}$' then raise exception 'Escribe al menos los últimos 4 números de la referencia bancaria'; end if;
  if new.amount_original>='Infinity'::numeric then raise exception 'Monto inválido'; end if;
 else
  if coalesce(trim(new.cashea_reference),'')!~'^\d{1,32}$' then raise exception 'Escribe el número de orden Cashea'; end if;
  perform pg_advisory_xact_lock(hashtextextended(trim(new.cashea_reference),22));
  if exists(select 1 from public.cashea_sales where trim(cashea_reference)=trim(new.cashea_reference) and id<>new.id) then raise exception 'Este número de orden Cashea ya está vinculado'; end if;
  new.cashea_reference:=trim(new.cashea_reference);
 end if; return new;
end $$;
create trigger finance_payment_reference before insert or update of reference,method,amount_original on public.payments for each row execute function lubricenter_private.finance_reference_guard();
create trigger finance_cashea_reference before insert or update of cashea_reference on public.cashea_sales for each row execute function lubricenter_private.finance_reference_guard();

-- Definer helpers are private; direct browser calls receive no general write grants.
do $$ declare p record; begin
 for p in select f.proname,pg_get_function_identity_arguments(f.oid) args from pg_proc f join pg_namespace n on n.oid=f.pronamespace where n.nspname='lubricenter_private' and f.proname like 'finance_%' loop
  execute format('revoke all on function lubricenter_private.%I(%s) from public,anon,authenticated',p.proname,p.args);
 end loop;
end $$;
grant usage on schema lubricenter_private to authenticated;
grant execute on function lubricenter_private.finance_role() to authenticated;
do $$ declare p record; begin
 for p in select n.nspname,f.proname,pg_get_function_identity_arguments(f.oid) args from pg_proc f join pg_namespace n on n.oid=f.pronamespace where n.nspname in ('public','lubricenter_private') and f.proname in ('finance_role','finance_configure','finance_import','finance_verify_batch','finance_allocate','finance_resolve') loop
  execute format('revoke all on function %I.%I(%s) from public,anon',p.nspname,p.proname,p.args);
  execute format('grant execute on function %I.%I(%s) to authenticated',p.nspname,p.proname,p.args);
 end loop;
end $$;
