-- Conciliación Cashea por sucursal (Cabudare).
-- Cashea has one merchant store for every branch and all instalments land in the pooled
-- BNC account ***4493. This layer stores the BNC statement and the manual decisions needed
-- to say how much of that account belongs to each branch since the last "zero".
-- Additive: new tables and functions only. Existing finance imports (finance_import) keep
-- storing the Cashea exports and the BDV statement; this layer only reads them, except for
-- three explicit, audited actions: branch ownership of Cashea collections, instalment status
-- synchronised from the Cashea orders export, and correcting a sale's Cashea reference.

create table if not exists public.cashea_branches(
 code text primary key check (code ~ '^[A-Z][A-Z_]{1,39}$'),
 name text not null check (length(btrim(name)) between 2 and 80),
 sort integer not null default 50,
 active boolean not null default true,
 created_at timestamptz not null default now()
);
insert into public.cashea_branches(code,name,sort) values
 ('CABUDARE','Cabudare',1),('NORTE','Norte',2),('LA_MORAN','La Morán',3),
 ('AFUERA','Afuera (sin nomenclatura)',4),('AFUERA_SIN_ASIGNAR','Afuera (sin asignar)',5),('POR_CONFIRMAR','Por confirmar',6)
on conflict (code) do nothing;

create table if not exists public.cashea_conc_imports(
 id uuid primary key default gen_random_uuid(),
 kind text not null check (kind in ('BNC','CASHEA_PAYMENTS','CASHEA_ORDERS','BDV')),
 file_name text not null check (length(file_name) between 1 and 200),
 row_count integer not null default 0 check (row_count>=0),
 inserted integer not null default 0 check (inserted>=0),
 observed_from date, observed_to date,
 chain_ok boolean,
 finance_batch_id uuid references public.external_import_batches(id),
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now()
);

create table if not exists public.cashea_bnc_lines(
 id uuid primary key default gen_random_uuid(),
 identity_key text not null unique,
 line_date date not null,
 day_index integer not null check (day_index>=0),
 tx_code text not null default '',
 tx_type text not null default '',
 op_type text not null default '',
 description text not null default '',
 reference text not null check (reference ~ '^\d{1,32}$'),
 debit numeric(18,2) not null default 0 check (debit>=0),
 credit numeric(18,2) not null default 0 check (credit>=0),
 balance numeric(18,2) not null,
 first_import_id uuid not null references public.cashea_conc_imports(id),
 created_at timestamptz not null default now(),
 check ((debit>0) <> (credit>0))
);
create index if not exists cashea_bnc_lines_order on public.cashea_bnc_lines(line_date,day_index);

create table if not exists public.cashea_ownership_overrides(
 id uuid primary key default gen_random_uuid(),
 subject text not null check (subject in ('ORDER','BANK_LINE')),
 subject_key text not null check (length(subject_key) between 1 and 64),
 branch text not null references public.cashea_branches(code),
 note text not null check (length(btrim(note)) between 3 and 500),
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 revoked_at timestamptz, revoked_by uuid, revoke_reason text
);
create unique index if not exists cashea_ownership_overrides_active on public.cashea_ownership_overrides(subject,subject_key) where revoked_at is null;

create table if not exists public.cashea_branch_adjustments(
 id uuid primary key default gen_random_uuid(),
 occurred_on date not null,
 amount_ves numeric(18,2) not null check (amount_ves>0),
 debit_branch text not null references public.cashea_branches(code),
 credit_branch text not null references public.cashea_branches(code),
 note text not null check (length(btrim(note)) between 3 and 500),
 reference text check (reference is null or length(reference)<=64),
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 voided_at timestamptz, voided_by uuid, void_reason text,
 check (debit_branch<>credit_branch)
);

create table if not exists public.cashea_cutoffs(
 id uuid primary key default gen_random_uuid(),
 cut_date date not null,
 reference text not null check (reference ~ '^\d{1,32}$'),
 balance_ves numeric(18,2) not null,
 bank_line_id uuid references public.cashea_bnc_lines(id),
 note text,
 summary jsonb,
 created_by uuid default auth.uid(),
 created_at timestamptz not null default now(),
 voided_at timestamptz, voided_by uuid, void_reason text
);
create unique index if not exists cashea_cutoffs_line on public.cashea_cutoffs(bank_line_id) where voided_at is null and bank_line_id is not null;
insert into public.cashea_cutoffs(cut_date,reference,balance_ves,note,created_by)
select date '2026-10-21','34806',1802.12,'Último cero registrado en la conciliación manual: retiro 268.000 Bs + comisión 804 Bs.',null
where not exists(select 1 from public.cashea_cutoffs);

create table if not exists public.cashea_withdrawal_destinations(
 cedula text primary key check (cedula ~ '^[VEJPG][1-9]\d{4,9}$'),
 branch text not null references public.cashea_branches(code),
 label text not null check (length(btrim(label)) between 2 and 120),
 updated_by uuid default auth.uid(),
 updated_at timestamptz not null default now()
);
insert into public.cashea_withdrawal_destinations(cedula,branch,label,updated_by) values
 ('V30881436','CABUDARE','Cabudare · BDV 0102…941198',null),
 ('V12306298','AFUERA_SIN_ASIGNAR','Afuera · cuenta 0108…071576',null)
on conflict (cedula) do nothing;

do $$ declare t text; begin
 foreach t in array array['cashea_branches','cashea_conc_imports','cashea_bnc_lines','cashea_ownership_overrides','cashea_branch_adjustments','cashea_cutoffs','cashea_withdrawal_destinations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('drop policy if exists finance_admin_read on public.%I',t);
  execute format('create policy finance_admin_read on public.%I for select to authenticated using ((select lubricenter_private.finance_role()) in (''OWNER'',''ADMIN''))',t);
  execute format('drop policy if exists staff_identity_gate on public.%I',t);
  execute format('create policy staff_identity_gate on public.%I as restrictive for all to authenticated using ((select lubricenter_private.staff_identity_allowed()))',t);
 end loop;
 foreach t in array array['cashea_ownership_overrides','cashea_branch_adjustments','cashea_cutoffs','cashea_withdrawal_destinations'] loop
  execute format('drop trigger if exists finance_audit on public.%I',t);
  execute format('create trigger finance_audit after insert or update or delete on public.%I for each row execute function lubricenter_private.finance_audit()',t);
 end loop;
end $$;

-- Everything the screen needs in one read. Bank lines start at p_from; Cashea orders use the
-- latest snapshot of each order (each export may cover a window: newest version wins).
create or replace function lubricenter_private.cashea_conc_dataset(p_from date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_from date; v_pay_from date;
begin
 perform lubricenter_private.finance_require();
 v_from:=coalesce(p_from,(select max(cut_date) from public.cashea_cutoffs where voided_at is null)-7,current_date-30);
 v_pay_from:=v_from-10;
 return jsonb_build_object(
  'from',v_from,
  'branches',(select coalesce(jsonb_agg(jsonb_build_object('code',code,'name',name,'sort',sort) order by sort),'[]') from public.cashea_branches where active),
  'bank_lines',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'line_date',line_date,'day_index',day_index,'reference',reference,'op_type',op_type,'tx_type',tx_type,'description',description,'debit',debit,'credit',credit,'balance',balance) order by line_date,day_index),'[]') from public.cashea_bnc_lines where line_date>=v_from),
  'cashea_payments',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'occurred_at',x.occurred_at,'reference',x.reference,'external_order',x.external_order,'installments',to_jsonb(x.installments),'currency',x.currency,'amount',x.amount,'amount_ref',x.amount_ref,'rate',x.exchange_rate,'rate_date',x.rate_date,'invoice',nullif(btrim(x.raw->>'# Factura'),'')) order by x.occurred_at),'[]')
    from public.external_transactions x join public.external_sources s on s.id=x.source_id and s.provider='CASHEA_TRANSACTIONS'
    where x.occurred_at>=v_pay_from and not exists(select 1 from public.reconciliation_transaction_exclusions e where e.transaction_id=x.id)),
  'cashea_orders',(select coalesce(jsonb_agg(jsonb_build_object('external_order',o.external_order,'invoice',nullif(btrim(o.raw->>'# Factura'),''),'buyer',o.raw->>'Nombre del comprador','purchased_on',o.purchased_on,'status',o.status,'total_ref',o.total_ref,'initial_ref',o.initial_ref,'installments',o.installments,'snapshot_at',o.created_at)),'[]')
    from (select distinct on (external_order) * from public.cashea_order_snapshots order by external_order,created_at desc,id desc) o),
  'os_sales',(select coalesce(jsonb_agg(jsonb_build_object('sale_id',s.id,'order_id',o.id,'order_number',o.order_number,'cashea_reference',s.cashea_reference,'status',s.status,'order_date',timezone('America/Caracas',coalesce(o.business_at,o.closed_at,o.opened_at))::date,'gross_ref',s.gross_ref,'initial_ref',s.initial_ref)),'[]')
    from public.cashea_sales s join public.orders o on o.id=s.order_id),
  'os_orders',(select coalesce(jsonb_agg(jsonb_build_object('order_id',o.id,'order_number',o.order_number,'order_date',timezone('America/Caracas',coalesce(o.business_at,o.closed_at,o.opened_at))::date,'total_ref',o.total_ref,'status',o.status,'has_cashea',exists(select 1 from public.cashea_sales s where s.order_id=o.id))),'[]')
    from public.orders o where o.status='CLOSED' and coalesce(o.business_at,o.closed_at,o.opened_at)>=v_from-120),
  'os_payments',(select coalesce(jsonb_agg(jsonb_build_object('payment_id',p.id,'order_id',p.order_id,'order_number',o.order_number,'method',p.method,'currency',p.currency,'amount',p.amount_original,'reference',p.reference,'paid_at',p.paid_at,'cashea_order',exists(select 1 from public.cashea_sales s where s.order_id=p.order_id))),'[]')
    from public.payments p join public.orders o on o.id=p.order_id
    where p.method in ('TRANSFER_BDV','TRANSFER_BNC','MOBILE_PAYMENT') and p.currency='VES' and p.paid_at>=v_from-3 and o.status<>'CANCELLED'),
  'overrides',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'subject',subject,'subject_key',subject_key,'branch',branch,'note',note,'created_at',created_at)),'[]') from public.cashea_ownership_overrides where revoked_at is null),
  'adjustments',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'occurred_on',occurred_on,'amount_ves',amount_ves,'debit_branch',debit_branch,'credit_branch',credit_branch,'note',note,'reference',reference) order by occurred_on),'[]') from public.cashea_branch_adjustments where voided_at is null),
  'cutoffs',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'cut_date',cut_date,'reference',reference,'balance_ves',balance_ves,'bank_line_id',bank_line_id,'note',note,'summary',summary,'created_at',created_at) order by cut_date,created_at),'[]') from public.cashea_cutoffs where voided_at is null),
  'destinations',(select coalesce(jsonb_agg(jsonb_build_object('cedula',cedula,'branch',branch,'label',label) order by cedula),'[]') from public.cashea_withdrawal_destinations),
  'imports',(select coalesce(jsonb_agg(i order by i.created_at desc),'[]') from (select id,kind,file_name,row_count,inserted,observed_from,observed_to,chain_ok,created_at from public.cashea_conc_imports order by created_at desc limit 15) i),
  'bdv_lines',(select coalesce(jsonb_agg(jsonb_build_object('id',x.id,'occurred_at',x.occurred_at,'reference',x.reference,'description',x.description,'direction',x.direction,'amount',x.amount,'balance',x.balance) order by x.occurred_at,x.id),'[]')
    from public.external_transactions x join public.external_sources s on s.id=x.source_id and s.provider='BDV' where x.occurred_at>=v_from)
 );
end $$;

-- Stores BNC statement lines. Overlapping statements are expected: a line is identified by
-- (date, reference without leading zeros, debit, credit, balance) and inserted once.
create or replace function lubricenter_private.cashea_conc_import_bnc(p_file_name text,p_lines jsonb,p_chain_ok boolean)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_import uuid; r jsonb; v_key text; v_inserted integer:=0; v_day date; v_count integer; v_stored integer; v_ref text;
begin
 perform lubricenter_private.finance_require();
 if jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'El estado de cuenta está vacío'; end if;
 if jsonb_array_length(p_lines)>20000 then raise exception 'Importa hasta 20000 movimientos por archivo'; end if;
 perform pg_advisory_xact_lock(291029,1);
 insert into public.cashea_conc_imports(kind,file_name,row_count,chain_ok,observed_from,observed_to)
 values('BNC',left(coalesce(nullif(btrim(p_file_name),''),'BNC'),200),jsonb_array_length(p_lines),p_chain_ok,
  (select min((z->>'line_date')::date) from jsonb_array_elements(p_lines) z),(select max((z->>'line_date')::date) from jsonb_array_elements(p_lines) z))
 returning id into v_import;
 for r in select value from jsonb_array_elements(p_lines) loop
  v_ref:=regexp_replace(coalesce(r->>'reference',''),'\D','','g');
  if v_ref='' or (r->>'line_date') is null or (r->>'day_index')::integer<0 or (r->>'debit')::numeric<0 or (r->>'credit')::numeric<0
   or ((r->>'debit')::numeric>0)=((r->>'credit')::numeric>0) or (r->>'balance') is null then
   raise exception 'Movimiento BNC inválido (fila %)',r->>'row';
  end if;
  v_key:=concat_ws('|',(r->>'line_date')::date,coalesce(nullif(ltrim(v_ref,'0'),''),'0'),round((r->>'debit')::numeric,2),round((r->>'credit')::numeric,2),round((r->>'balance')::numeric,2));
  insert into public.cashea_bnc_lines(identity_key,line_date,day_index,tx_code,tx_type,op_type,description,reference,debit,credit,balance,first_import_id)
  values(v_key,(r->>'line_date')::date,(r->>'day_index')::integer,left(coalesce(r->>'tx_code',''),40),left(coalesce(r->>'tx_type',''),80),left(coalesce(r->>'op_type',''),120),left(coalesce(r->>'description',''),500),v_ref,
   round((r->>'debit')::numeric,2),round((r->>'credit')::numeric,2),round((r->>'balance')::numeric,2),v_import)
  on conflict (identity_key) do nothing;
  if found then v_inserted:=v_inserted+1; end if;
 end loop;
 -- A day that arrives more complete than what is stored defines the order of that day.
 for v_day,v_count in select (z->>'line_date')::date,count(*) from jsonb_array_elements(p_lines) z group by 1 loop
  select count(*) into v_stored from public.cashea_bnc_lines where line_date=v_day;
  if v_count>=v_stored then
   update public.cashea_bnc_lines l set day_index=(z->>'day_index')::integer
   from jsonb_array_elements(p_lines) z
   where (z->>'line_date')::date=v_day and l.identity_key=concat_ws('|',(z->>'line_date')::date,coalesce(nullif(ltrim(regexp_replace(z->>'reference','\D','','g'),'0'),''),'0'),round((z->>'debit')::numeric,2),round((z->>'credit')::numeric,2),round((z->>'balance')::numeric,2))
    and l.day_index<>(z->>'day_index')::integer;
  end if;
 end loop;
 update public.cashea_conc_imports set inserted=v_inserted where id=v_import;
 -- Attach saved zeros that were registered before their bank line was loaded.
 update public.cashea_cutoffs c set bank_line_id=l.id from public.cashea_bnc_lines l
 where c.bank_line_id is null and c.voided_at is null and l.line_date=c.cut_date and ltrim(l.reference,'0')=ltrim(c.reference,'0') and l.balance=c.balance_ves
  and not exists(select 1 from public.cashea_cutoffs z where z.bank_line_id=l.id and z.voided_at is null);
 return jsonb_build_object('import_id',v_import,'inserted',v_inserted,'duplicates',jsonb_array_length(p_lines)-v_inserted);
end $$;

-- Records which file fed a finance_import batch so the screen can show the upload history.
create or replace function lubricenter_private.cashea_conc_log_import(p_kind text,p_file_name text,p_batch_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare b public.external_import_batches;
begin
 perform lubricenter_private.finance_require();
 if p_kind not in ('CASHEA_PAYMENTS','CASHEA_ORDERS','BDV') then raise exception 'Tipo de archivo inválido'; end if;
 select * into b from public.external_import_batches where id=p_batch_id;
 if not found then raise exception 'Lote no encontrado'; end if;
 insert into public.cashea_conc_imports(kind,file_name,row_count,inserted,observed_from,observed_to,finance_batch_id)
 values(p_kind,left(coalesce(nullif(btrim(p_file_name),''),p_kind),200),b.row_count,b.row_count,b.observed_from,b.observed_to,b.id);
end $$;

-- Manual branch for a Cashea order or a bank line. Null branch removes the decision.
create or replace function lubricenter_private.cashea_conc_set_override(p_subject text,p_key text,p_branch text,p_note text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 perform lubricenter_private.finance_require();
 if p_subject not in ('ORDER','BANK_LINE') or coalesce(btrim(p_key),'')='' then raise exception 'Indica la orden o el movimiento'; end if;
 if p_subject='ORDER' and p_key!~'^\d{1,32}$' then raise exception 'Número de orden Cashea inválido'; end if;
 if p_subject='BANK_LINE' and not exists(select 1 from public.cashea_bnc_lines where id::text=p_key) then raise exception 'Movimiento BNC no encontrado'; end if;
 if length(btrim(coalesce(p_note,'')))<3 then raise exception 'Explica el motivo de la reasignación'; end if;
 update public.cashea_ownership_overrides set revoked_at=now(),revoked_by=auth.uid(),revoke_reason=btrim(p_note)
 where subject=p_subject and subject_key=btrim(p_key) and revoked_at is null;
 if p_branch is null then return null; end if;
 if not exists(select 1 from public.cashea_branches where code=p_branch and active) then raise exception 'Sucursal inválida'; end if;
 insert into public.cashea_ownership_overrides(subject,subject_key,branch,note) values(p_subject,btrim(p_key),p_branch,btrim(p_note)) returning id into v_id;
 return v_id;
end $$;

create or replace function lubricenter_private.cashea_conc_adjustment(p_occurred_on date,p_amount numeric,p_debit_branch text,p_credit_branch text,p_note text,p_reference text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 perform lubricenter_private.finance_require();
 if p_occurred_on is null or p_occurred_on>current_date+1 then raise exception 'Fecha inválida'; end if;
 if p_amount is null or p_amount<=0 or p_amount>=1e12 then raise exception 'Monto inválido'; end if;
 if p_debit_branch=p_credit_branch then raise exception 'Las sucursales deben ser distintas'; end if;
 insert into public.cashea_branch_adjustments(occurred_on,amount_ves,debit_branch,credit_branch,note,reference)
 values(p_occurred_on,round(p_amount,2),p_debit_branch,p_credit_branch,btrim(p_note),nullif(btrim(p_reference),'')) returning id into v_id;
 return v_id;
end $$;

create or replace function lubricenter_private.cashea_conc_void(p_kind text,p_id uuid,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
begin
 perform lubricenter_private.finance_require(case when p_kind='CUTOFF' then 'OWNER' else 'ADMIN' end);
 if length(btrim(coalesce(p_reason,'')))<5 then raise exception 'Indica el motivo'; end if;
 if p_kind='ADJUSTMENT' then update public.cashea_branch_adjustments set voided_at=now(),voided_by=auth.uid(),void_reason=btrim(p_reason) where id=p_id and voided_at is null;
 elsif p_kind='CUTOFF' then update public.cashea_cutoffs set voided_at=now(),voided_by=auth.uid(),void_reason=btrim(p_reason) where id=p_id and voided_at is null;
 else raise exception 'Registro inválido'; end if;
 if not found then raise exception 'Registro no disponible'; end if;
end $$;

-- A zero is the bank line after which the BNC balance stays under 10.000 Bs. The frozen
-- summary of the period that ends there is stored for history and export.
create or replace function lubricenter_private.cashea_conc_mark_cutoff(p_bank_line_id uuid,p_note text,p_summary jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare l public.cashea_bnc_lines; v_last public.cashea_cutoffs; v_id uuid;
begin
 perform lubricenter_private.finance_require();
 perform pg_advisory_xact_lock(291029,2);
 select * into l from public.cashea_bnc_lines where id=p_bank_line_id;
 if not found then raise exception 'Movimiento BNC no encontrado'; end if;
 if l.debit=0 then raise exception 'El cero se marca en un retiro o en su comisión'; end if;
 if l.balance>=10000 then raise exception 'El saldo después de este movimiento (%) no está por debajo de 10.000 Bs',l.balance; end if;
 select * into v_last from public.cashea_cutoffs where voided_at is null order by cut_date desc,created_at desc limit 1;
 if found and (l.line_date<v_last.cut_date or l.id=v_last.bank_line_id
   or (v_last.bank_line_id is not null and exists(select 1 from public.cashea_bnc_lines z where z.id=v_last.bank_line_id and (z.line_date,z.day_index)>=(l.line_date,l.day_index)))) then
  raise exception 'El nuevo cero debe ser posterior al último cero registrado (%)',v_last.cut_date;
 end if;
 insert into public.cashea_cutoffs(cut_date,reference,balance_ves,bank_line_id,note,summary)
 values(l.line_date,l.reference,l.balance,l.id,nullif(btrim(p_note),''),case when jsonb_typeof(p_summary)='object' then p_summary else null end) returning id into v_id;
 return v_id;
end $$;

create or replace function lubricenter_private.cashea_conc_set_destination(p_cedula text,p_branch text,p_label text)
returns void language plpgsql security definer set search_path='' as $$
declare v_ced text:=upper(regexp_replace(coalesce(p_cedula,''),'[^A-Za-z0-9]','','g'));
begin
 perform lubricenter_private.finance_require();
 v_ced:=regexp_replace(v_ced,'^([VEJPG])0+','\1');
 if v_ced!~'^[VEJPG][1-9]\d{4,9}$' then raise exception 'Cédula inválida'; end if;
 if not exists(select 1 from public.cashea_branches where code=p_branch and active) then raise exception 'Sucursal inválida'; end if;
 insert into public.cashea_withdrawal_destinations(cedula,branch,label) values(v_ced,p_branch,btrim(p_label))
 on conflict (cedula) do update set branch=excluded.branch,label=excluded.label,updated_by=auth.uid(),updated_at=now();
end $$;

-- Applies the branch decided by the rules to the Cashea collections stored by finance_import.
-- Other branches become OTHER_LOCATION, which finance_reconcile skips; their ownership
-- cases close on the next reconciliation. A collection already matched to an OS sale is
-- never touched, and Cabudare/por confirmar decisions return the row to the normal flow.
create or replace function lubricenter_private.cashea_conc_apply_ownership(p_items jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_other integer:=0; v_reset integer:=0;
begin
 perform lubricenter_private.finance_require();
 if jsonb_typeof(p_items)<>'array' or jsonb_array_length(p_items)>20000 then raise exception 'Lista inválida'; end if;
 if exists(select 1 from jsonb_array_elements(p_items) z where coalesce(z->>'external_order','')!~'^\d{1,32}$'
   or not exists(select 1 from public.cashea_branches b where b.code=z->>'branch')) then raise exception 'Orden o sucursal inválida'; end if;
 with items as (select distinct on (z->>'external_order') z->>'external_order' external_order,z->>'branch' branch from jsonb_array_elements(p_items) z),
 upd as (
  update public.external_transactions x set ownership_status='OTHER_LOCATION',ownership_reason='BRANCH:'||i.branch,
   ownership_evidence=jsonb_build_object('branch',i.branch,'source','cashea_conciliation','at',now())
  from items i, public.external_sources s
  where s.id=x.source_id and s.provider='CASHEA_TRANSACTIONS' and x.external_order=i.external_order
   and i.branch not in ('CABUDARE','POR_CONFIRMAR')
   and x.ownership_reason<>'ORDER_MATCH' and x.ownership_reason is distinct from 'BRANCH:'||i.branch
  returning 1)
 select count(*) into v_other from upd;
 with items as (select distinct on (z->>'external_order') z->>'external_order' external_order,z->>'branch' branch from jsonb_array_elements(p_items) z),
 upd as (
  update public.external_transactions x set ownership_status='UNRESOLVED',ownership_reason='UNKNOWN',ownership_evidence=jsonb_build_object('cashea_sale_id',null)
  from items i, public.external_sources s
  where s.id=x.source_id and s.provider='CASHEA_TRANSACTIONS' and x.external_order=i.external_order
   and i.branch in ('CABUDARE','POR_CONFIRMAR') and x.ownership_reason like 'BRANCH:%'
  returning 1)
 select count(*) into v_reset from upd;
 return jsonb_build_object('other_location',v_other,'returned',v_reset);
end $$;

-- Marks OS instalments as collected using the latest Cashea orders export. It does not create
-- payments: the money sits in the pooled BNC account and is reported by this module.
create or replace function lubricenter_private.cashea_conc_sync_installments()
returns jsonb language plpgsql security definer set search_path='' as $$
declare r record; v_paid integer:=0; v_partial integer:=0; v_settled integer:=0; v_new_status text; v_new_paid numeric; v_when timestamptz; v_ves numeric;
begin
 perform lubricenter_private.finance_require();
 perform pg_advisory_xact_lock(291029,3);
 for r in
  with snap as (select distinct on (external_order) * from public.cashea_order_snapshots order by external_order,created_at desc,id desc)
  select i.*,s.id sale_id,s.cashea_reference,q->>'status' cashea_status,least(coalesce((q->>'paid_ref')::numeric,0),i.amount_ref) cashea_paid
  from public.cashea_sales s
  join snap on snap.external_order=btrim(s.cashea_reference) and snap.status<>'CANCELLED'
  join public.cashea_installments i on i.cashea_sale_id=s.id and i.status<>'PAID'
  join lateral jsonb_array_elements(snap.installments) q on (q->>'number')::integer=i.installment_no
  where s.status='ACTIVE' and s.ownership_status='OWN'
  order by i.id
  for update of i
 loop
  if r.cashea_status='DONE' or r.cashea_paid>=r.amount_ref-0.01 then v_new_status:='PAID'; v_new_paid:=r.amount_ref;
  elsif r.cashea_paid>r.paid_ref+0.005 then v_new_status:='PARTIAL'; v_new_paid:=round(r.cashea_paid,4);
  else continue; end if;
  select max(x.occurred_at),sum(case when x.currency='VES' then x.amount/greatest(cardinality(x.installments),1) else 0 end)
  into v_when,v_ves from public.external_transactions x join public.external_sources so on so.id=x.source_id and so.provider='CASHEA_TRANSACTIONS'
  where x.external_order=btrim(r.cashea_reference) and r.installment_no=any(x.installments);
  update public.cashea_installments set status=v_new_status,paid_ref=v_new_paid,
   paid_ves_actual=greatest(paid_ves_actual,round(coalesce(v_ves,0),2)),
   paid_at=case when v_new_status='PAID' then coalesce(v_when,now()) else paid_at end,updated_at=now()
  where id=r.id;
  insert into public.audit_events(event_type,entity_type,entity_id,data)
  values('cashea.installment_synced_from_export','cashea_installment',r.id,jsonb_build_object('sale_id',r.sale_id,'external_order',r.cashea_reference,'installment_no',r.installment_no,'cashea_status',r.cashea_status,'before',jsonb_build_object('status',r.status,'paid_ref',r.paid_ref),'after',jsonb_build_object('status',v_new_status,'paid_ref',v_new_paid)));
  if v_new_status='PAID' then v_paid:=v_paid+1; else v_partial:=v_partial+1; end if;
 end loop;
 with settled as (
  update public.cashea_sales s set status='SETTLED',settled_at=now()
  where s.status='ACTIVE' and s.ownership_status='OWN' and exists(select 1 from public.cashea_installments i where i.cashea_sale_id=s.id)
   and not exists(select 1 from public.cashea_installments i where i.cashea_sale_id=s.id and i.status<>'PAID')
  returning 1)
 select count(*) into v_settled from settled;
 return jsonb_build_object('paid',v_paid,'partial',v_partial,'settled',v_settled);
end $$;

-- Corrects the Cashea order number stored on an OS sale (typos, missing links). The existing
-- reference guard validates digits and uniqueness; collections of that order return to the
-- normal reconciliation flow so finance_reconcile can link them.
create or replace function lubricenter_private.cashea_conc_set_reference(p_sale_id uuid,p_reference text,p_reason text)
returns void language plpgsql security definer set search_path='' as $$
declare s public.cashea_sales; v_ref text:=btrim(coalesce(p_reference,''));
begin
 perform lubricenter_private.finance_require();
 if v_ref!~'^\d{1,32}$' then raise exception 'La referencia Cashea debe tener solo números'; end if;
 if length(btrim(coalesce(p_reason,'')))<5 then raise exception 'Indica el motivo de la corrección'; end if;
 select * into s from public.cashea_sales where id=p_sale_id for update;
 if not found then raise exception 'Venta Cashea no encontrada'; end if;
 if s.cashea_reference is not distinct from v_ref then return; end if;
 update public.cashea_sales set cashea_reference=v_ref where id=s.id;
 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('cashea.reference_corrected','cashea_sale',s.id,jsonb_build_object('before',s.cashea_reference,'after',v_ref,'reason',btrim(p_reason),'source','cashea_conciliation'));
 update public.external_transactions x set ownership_status='UNRESOLVED',ownership_reason='UNKNOWN',ownership_evidence=jsonb_build_object('cashea_sale_id',null)
 from public.external_sources so where so.id=x.source_id and so.provider='CASHEA_TRANSACTIONS' and x.external_order=v_ref and x.ownership_reason like 'BRANCH:%';
end $$;

-- Public wrappers (same pattern as the rest of finance): invoker SQL calling the private definer.
create or replace function public.cashea_conc_dataset(p_from date default null) returns jsonb language sql set search_path='' as $$ select lubricenter_private.cashea_conc_dataset(p_from) $$;
create or replace function public.cashea_conc_import_bnc(p_file_name text,p_lines jsonb,p_chain_ok boolean) returns jsonb language sql set search_path='' as $$ select lubricenter_private.cashea_conc_import_bnc(p_file_name,p_lines,p_chain_ok) $$;
create or replace function public.cashea_conc_log_import(p_kind text,p_file_name text,p_batch_id uuid) returns void language sql set search_path='' as $$ select lubricenter_private.cashea_conc_log_import(p_kind,p_file_name,p_batch_id) $$;
create or replace function public.cashea_conc_set_override(p_subject text,p_key text,p_branch text,p_note text) returns uuid language sql set search_path='' as $$ select lubricenter_private.cashea_conc_set_override(p_subject,p_key,p_branch,p_note) $$;
create or replace function public.cashea_conc_adjustment(p_occurred_on date,p_amount numeric,p_debit_branch text,p_credit_branch text,p_note text,p_reference text default null) returns uuid language sql set search_path='' as $$ select lubricenter_private.cashea_conc_adjustment(p_occurred_on,p_amount,p_debit_branch,p_credit_branch,p_note,p_reference) $$;
create or replace function public.cashea_conc_void(p_kind text,p_id uuid,p_reason text) returns void language sql set search_path='' as $$ select lubricenter_private.cashea_conc_void(p_kind,p_id,p_reason) $$;
create or replace function public.cashea_conc_mark_cutoff(p_bank_line_id uuid,p_note text,p_summary jsonb) returns uuid language sql set search_path='' as $$ select lubricenter_private.cashea_conc_mark_cutoff(p_bank_line_id,p_note,p_summary) $$;
create or replace function public.cashea_conc_set_destination(p_cedula text,p_branch text,p_label text) returns void language sql set search_path='' as $$ select lubricenter_private.cashea_conc_set_destination(p_cedula,p_branch,p_label) $$;
create or replace function public.cashea_conc_apply_ownership(p_items jsonb) returns jsonb language sql set search_path='' as $$ select lubricenter_private.cashea_conc_apply_ownership(p_items) $$;
create or replace function public.cashea_conc_sync_installments() returns jsonb language sql set search_path='' as $$ select lubricenter_private.cashea_conc_sync_installments() $$;
create or replace function public.cashea_conc_set_reference(p_sale_id uuid,p_reference text,p_reason text) returns void language sql set search_path='' as $$ select lubricenter_private.cashea_conc_set_reference(p_sale_id,p_reference,p_reason) $$;

do $$ declare f text; begin
 foreach f in array array[
  'cashea_conc_dataset(date)','cashea_conc_import_bnc(text,jsonb,boolean)','cashea_conc_log_import(text,text,uuid)',
  'cashea_conc_set_override(text,text,text,text)','cashea_conc_adjustment(date,numeric,text,text,text,text)','cashea_conc_void(text,uuid,text)',
  'cashea_conc_mark_cutoff(uuid,text,jsonb)','cashea_conc_set_destination(text,text,text)','cashea_conc_apply_ownership(jsonb)',
  'cashea_conc_sync_installments()','cashea_conc_set_reference(uuid,text,text)'] loop
  execute format('revoke all on function lubricenter_private.%s from public,anon,authenticated',f);
  execute format('grant execute on function lubricenter_private.%s to authenticated',f);
  execute format('revoke all on function public.%s from public,anon',f);
  execute format('grant execute on function public.%s to authenticated',f);
 end loop;
end $$;
