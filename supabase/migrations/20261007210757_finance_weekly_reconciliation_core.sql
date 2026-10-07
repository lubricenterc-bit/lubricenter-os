create table if not exists public.finance_categories(
  id uuid primary key default gen_random_uuid(),
  name text not null,
  nature text not null,
  active boolean not null default true,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint finance_categories_name_check check (length(trim(name)) between 1 and 80),
  constraint finance_categories_nature_check check (nature in (
    'EXPENSE','INVENTORY_PURCHASE','ASSET_PURCHASE','SUPPLIER_PAYMENT','OWNER_DRAW',
    'PAYROLL','INTERNAL_TRANSFER','REFUND','TAX','BANK_FEE','OWNER_CONTRIBUTION','OTHER_INCOME'
  ))
);
create unique index if not exists finance_categories_name_unique on public.finance_categories(lower(trim(name)));
alter table public.finance_categories enable row level security;

alter table public.external_transactions add column if not exists category_id uuid references public.finance_categories(id) on delete restrict;
alter table public.account_movements add column if not exists category_id uuid references public.finance_categories(id) on delete restrict;
alter table public.reconciliation_rules add column if not exists category_id uuid references public.finance_categories(id) on delete restrict;

alter table public.account_movements drop constraint if exists account_movements_finance_nature_check;
alter table public.account_movements add constraint account_movements_finance_nature_check check (
 finance_nature is null or finance_nature in (
  'EXPENSE','INVENTORY_PURCHASE','ASSET_PURCHASE','SUPPLIER_PAYMENT','OWNER_DRAW','PAYROLL',
  'INTERNAL_TRANSFER','REFUND','TAX','BANK_FEE','UNCLASSIFIED','OWNER_CONTRIBUTION','OTHER_INCOME'
 )
);

create table if not exists public.finance_reconciliation_periods(
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete restrict,
  period_start date not null,
  period_end date not null,
  status text not null default 'OPEN' check (status in ('OPEN','CLOSED','CLOSED_WITH_EXCEPTION')),
  opened_by uuid references auth.users(id),
  opened_at timestamptz not null default now(),
  closed_by uuid references auth.users(id),
  closed_at timestamptz,
  close_reason text,
  close_snapshot jsonb,
  created_at timestamptz not null default now(),
  constraint finance_reconciliation_period_dates check (
    period_end = period_start + 6 and extract(isodow from period_start)=1
  ),
  unique(location_id, period_start)
);
alter table public.finance_reconciliation_periods enable row level security;

create table if not exists public.finance_reconciliation_period_accounts(
  period_id uuid not null references public.finance_reconciliation_periods(id) on delete cascade,
  account_id uuid not null references public.financial_accounts(id) on delete restrict,
  opening_native numeric not null,
  closing_native numeric,
  closing_recorded_by uuid references auth.users(id),
  closing_recorded_at timestamptz,
  primary key(period_id,account_id),
  constraint finance_reconciliation_period_opening_check check (opening_native >= 0),
  constraint finance_reconciliation_period_closing_check check (closing_native is null or closing_native >= 0)
);
alter table public.finance_reconciliation_period_accounts enable row level security;

revoke all on table public.finance_categories, public.finance_reconciliation_periods, public.finance_reconciliation_period_accounts from anon,authenticated;
grant select on table public.finance_categories, public.finance_reconciliation_periods, public.finance_reconciliation_period_accounts to authenticated;

drop policy if exists finance_admin_read on public.finance_categories;
create policy finance_admin_read on public.finance_categories for select to authenticated
using ((select lubricenter_private.finance_role()) in ('OWNER','ADMIN'));
drop policy if exists finance_admin_read on public.finance_reconciliation_periods;
create policy finance_admin_read on public.finance_reconciliation_periods for select to authenticated
using ((select lubricenter_private.finance_role()) in ('OWNER','ADMIN'));
drop policy if exists finance_admin_read on public.finance_reconciliation_period_accounts;
create policy finance_admin_read on public.finance_reconciliation_period_accounts for select to authenticated
using ((select lubricenter_private.finance_role()) in ('OWNER','ADMIN'));

create or replace function lubricenter_private.finance_category_upsert(p_name text,p_nature text)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_nature text; v_name text:=trim(p_name);
begin
 perform lubricenter_private.finance_require();
 if length(v_name)<1 or length(v_name)>80 then raise exception 'Nombre de categoría inválido'; end if;
 if p_nature not in ('EXPENSE','INVENTORY_PURCHASE','ASSET_PURCHASE','SUPPLIER_PAYMENT','OWNER_DRAW','PAYROLL','INTERNAL_TRANSFER','REFUND','TAX','BANK_FEE','OWNER_CONTRIBUTION','OTHER_INCOME') then raise exception 'Naturaleza inválida'; end if;
 select id,nature into v_id,v_nature from public.finance_categories where lower(trim(name))=lower(v_name) for update;
 if found then
   if v_nature<>p_nature then raise exception 'La categoría ya existe con otra naturaleza'; end if;
   update public.finance_categories set active=true,updated_at=now() where id=v_id;
   return v_id;
 end if;
 insert into public.finance_categories(name,nature,created_by) values(v_name,p_nature,auth.uid()) returning id into v_id;
 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('finance.category_created','finance_category',v_id,jsonb_build_object('name',v_name,'nature',p_nature));
 return v_id;
end $$;

create or replace function public.finance_category_upsert(p_name text,p_nature text)
returns uuid language sql security invoker set search_path='' as $$
 select lubricenter_private.finance_category_upsert(p_name,p_nature)
$$;

create or replace function lubricenter_private.finance_classify_external(p_id uuid,p_data jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 x public.external_transactions; s public.external_sources; c public.finance_categories;
 v_nature text:=p_data->>'nature'; v_reason text; v_value_ves numeric; v_rate numeric:=1;
 v_movement uuid; v_counter uuid; v_target public.financial_accounts; v_group uuid;
 v_candidates integer; v_rule uuid; v_category_name text;
begin
 perform lubricenter_private.finance_require();
 select * into x from public.external_transactions where id=p_id for update;
 if not found then raise exception 'Movimiento no encontrado'; end if;
 select * into s from public.external_sources where id=x.source_id;
 if s.account_id is null then raise exception 'Esta fuente todavía no está vinculada a una cuenta financiera'; end if;
 if x.ownership_status<>'OWN' then raise exception 'Resuelve primero a quién pertenece el movimiento'; end if;
 if exists(select 1 from public.reconciliation_cases rc where rc.subject_id=x.id and rc.status='OPEN' and rc.kind in ('SOURCE_CONFLICT','SOURCE_AMOUNT')) then
   raise exception 'Resuelve primero la inconsistencia del reporte';
 end if;

 if x.direction='OUT' and v_nature not in ('EXPENSE','INVENTORY_PURCHASE','ASSET_PURCHASE','SUPPLIER_PAYMENT','OWNER_DRAW','PAYROLL','INTERNAL_TRANSFER','REFUND','TAX','BANK_FEE') then
   raise exception 'Naturaleza de salida inválida';
 elsif x.direction='IN' and v_nature not in ('OWNER_CONTRIBUTION','OTHER_INCOME','INTERNAL_TRANSFER','REFUND') then
   raise exception 'Naturaleza de entrada inválida';
 end if;
 if v_nature='OWNER_DRAW' then perform lubricenter_private.finance_require('OWNER'); end if;

 if nullif(p_data->>'category_id','') is not null then
   select * into c from public.finance_categories where id=(p_data->>'category_id')::uuid and active;
   if not found then raise exception 'Categoría no disponible'; end if;
   if c.nature<>v_nature then raise exception 'La categoría no corresponde a esta naturaleza'; end if;
   v_category_name:=c.name;
 elsif v_nature not in ('INTERNAL_TRANSFER','REFUND') then
   raise exception 'Selecciona una categoría';
 end if;

 v_reason:=coalesce(nullif(trim(p_data->>'note'),''),'Conciliación: '||coalesce(v_category_name,v_nature));
 update public.external_transactions
 set nature=v_nature,category=v_category_name,category_id=c.id,classification_reason=v_reason
 where id=x.id;

 select id into v_movement from public.account_movements where finance_request_id=x.id;
 if v_movement is not null then
   return jsonb_build_object('movement_id',v_movement,'created',false);
 end if;
 if exists(select 1 from public.reconciliation_allocations where external_transaction_id=x.id and reversed_at is null) then
   raise exception 'Este movimiento ya tiene una asignación. Revísala antes de reclasificar';
 end if;

 select count(*),(array_agg(m.id order by m.occurred_at,m.id))[1]
 into v_candidates,v_movement
 from public.account_movements m
 where m.account_id=s.account_id and m.direction=x.direction and m.currency=x.currency
   and abs(m.amount_original-x.amount)<=least(5,x.amount*.001)
   and m.occurred_at between x.occurred_at-interval '48 hours' and x.occurred_at+interval '48 hours'
   and not exists(select 1 from public.reconciliation_allocations a where a.account_movement_id=m.id and a.reversed_at is null)
   and (
     (v_nature='INTERNAL_TRANSFER' and m.transfer_group is not null and m.finance_nature='INTERNAL_TRANSFER')
     or
     (v_nature<>'INTERNAL_TRANSFER'
      and length(regexp_replace(coalesce(m.reference,''),'\D','','g'))>=4
      and right(regexp_replace(coalesce(m.reference,''),'\D','','g'),4)=right(x.reference,4))
   );

 if v_candidates>1 then raise exception 'Hay varios registros internos parecidos. Revísalos antes de registrar otro'; end if;

 if v_candidates=1 then
   update public.account_movements
   set finance_nature=coalesce(finance_nature,v_nature),
       category=coalesce(category,v_category_name),
       category_id=coalesce(category_id,c.id)
   where id=v_movement;
 else
   if x.currency='USD' then
     select value into v_rate from public.exchange_rates
     where rate_type='OPERATIVE' and timezone('America/Caracas',effective_at)::date<=timezone('America/Caracas',x.occurred_at)::date
     order by effective_at desc limit 1;
     if v_rate is null then raise exception 'Falta la tasa operativa histórica'; end if;
   end if;
   v_value_ves:=round(x.amount*v_rate,2);

   if v_nature='INTERNAL_TRANSFER' then
     if nullif(p_data->>'target_account_id','') is null then raise exception 'Selecciona la otra cuenta de la transferencia'; end if;
     select * into v_target from public.financial_accounts where id=(p_data->>'target_account_id')::uuid and active;
     if not found or v_target.id=s.account_id or v_target.currency<>x.currency then raise exception 'Cuenta destino incompatible'; end if;
     v_group:=gen_random_uuid();
     insert into public.account_movements(account_id,direction,movement_type,transfer_group,currency,amount_original,value_ves,category,category_id,note,reference,occurred_at,finance_nature,finance_request_id)
     values(s.account_id,x.direction,'TRANSFER',v_group,x.currency,x.amount,v_value_ves,v_category_name,c.id,v_reason,x.reference,x.occurred_at,v_nature,x.id)
     returning id into v_movement;
     insert into public.account_movements(account_id,direction,movement_type,transfer_group,currency,amount_original,value_ves,category,category_id,note,reference,occurred_at,finance_nature)
     values(v_target.id,case when x.direction='OUT' then 'IN' else 'OUT' end,'TRANSFER',v_group,x.currency,x.amount,v_value_ves,v_category_name,c.id,'Contrapartida · '||v_reason,x.reference,x.occurred_at,v_nature)
     returning id into v_counter;
   else
     insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,category_id,note,reference,occurred_at,finance_nature,finance_request_id)
     values(s.account_id,x.direction,
       case when v_nature in ('EXPENSE','PAYROLL','TAX','BANK_FEE') then 'EXPENSE'
            when v_nature in ('INVENTORY_PURCHASE','SUPPLIER_PAYMENT') then 'SUPPLIER_PAYMENT'
            else 'ADJUSTMENT' end,
       x.currency,x.amount,v_value_ves,v_category_name,c.id,v_reason,x.reference,x.occurred_at,v_nature,x.id)
     returning id into v_movement;
   end if;
 end if;

 perform lubricenter_private.finance_allocate(gen_random_uuid(),x.id,v_movement,null,x.amount,x.amount,'EXACT',v_reason);

 update public.reconciliation_cases
 set status='RESOLVED',resolution=v_reason,resolved_by=auth.uid(),resolved_at=now()
 where status='OPEN' and subject_type='external_transaction' and subject_id=x.id and kind in ('UNCLASSIFIED','UNMATCHED');

 if coalesce((p_data->>'save_rule')::boolean,false) then
   perform lubricenter_private.finance_require('OWNER');
   if x.direction<>'OUT' or v_nature not in ('BANK_FEE','EXPENSE') then raise exception 'Solo se automatizan comisiones y gastos repetitivos explícitos'; end if;
   insert into public.reconciliation_rules(source_id,description_contains,nature,category,category_id,approved_by)
   values(x.source_id,upper(trim(x.description)),v_nature,v_category_name,c.id,auth.uid())
   returning id into v_rule;
 end if;

 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('finance.external_classified','external_transaction',x.id,
   jsonb_build_object('nature',v_nature,'category_id',c.id,'movement_id',v_movement,'counter_movement_id',v_counter,'rule_id',v_rule));
 return jsonb_build_object('movement_id',v_movement,'counter_movement_id',v_counter,'rule_id',v_rule,'created',v_candidates=0);
end $$;

create or replace function public.finance_classify_external(p_id uuid,p_data jsonb)
returns jsonb language sql security invoker set search_path='' as $$
 select lubricenter_private.finance_classify_external(p_id,p_data)
$$;

create or replace function lubricenter_private.finance_week_open(p_start date,p_openings jsonb default '{}'::jsonb)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_location uuid; v_id uuid; v_prev uuid; a record; v_open numeric; v_code text;
begin
 perform lubricenter_private.finance_require();
 if p_start is null or extract(isodow from p_start)<>1 then raise exception 'La semana financiera comienza el lunes'; end if;
 if p_start>timezone('America/Caracas',now())::date then raise exception 'Abre la semana cuando llegue el lunes'; end if;
 select id into v_location from public.locations where active order by created_at limit 1;
 if v_location is null then raise exception 'Falta ubicación activa'; end if;
 select id into v_id from public.finance_reconciliation_periods where location_id=v_location and period_start=p_start;
 if v_id is not null then return v_id; end if;

 select id into v_prev from public.finance_reconciliation_periods
 where location_id=v_location and period_start=p_start-7 and status in ('CLOSED','CLOSED_WITH_EXCEPTION');

 insert into public.finance_reconciliation_periods(location_id,period_start,period_end,opened_by)
 values(v_location,p_start,p_start+6,auth.uid()) returning id into v_id;

 for a in
  select * from public.financial_accounts
  where active and code in ('BDV','BNC','CASH_USD','CASH_VES')
  order by code
 loop
  v_code:=a.code; v_open:=null;
  if v_prev is not null then
    select closing_native into v_open from public.finance_reconciliation_period_accounts
    where period_id=v_prev and account_id=a.id;
  end if;
  if v_open is null and p_openings ? v_code then v_open:=(p_openings->>v_code)::numeric; end if;
  if v_open is null or v_open<0 then raise exception 'Falta saldo inicial de %',v_code; end if;
  insert into public.finance_reconciliation_period_accounts(period_id,account_id,opening_native)
  values(v_id,a.id,v_open);
 end loop;
 if (select count(*) from public.finance_reconciliation_period_accounts where period_id=v_id)<>4 then
   raise exception 'Se requieren BDV, BNC, Caja USD y Caja Bs activas';
 end if;
 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('finance.week_opened','finance_reconciliation_period',v_id,jsonb_build_object('start',p_start,'end',p_start+6));
 return v_id;
end $$;

create or replace function public.finance_week_open(p_start date,p_openings jsonb default '{}'::jsonb)
returns uuid language sql security invoker set search_path='' as $$
 select lubricenter_private.finance_week_open(p_start,p_openings)
$$;

create or replace function lubricenter_private.finance_week_set_closing(p_start date,p_account_id uuid,p_closing numeric)
returns void language plpgsql security definer set search_path='' as $$
declare v_location uuid; v_period uuid; v_end date;
begin
 perform lubricenter_private.finance_require();
 if p_closing is null or p_closing<0 or p_closing>='Infinity'::numeric then raise exception 'Saldo final inválido'; end if;
 select id into v_location from public.locations where active order by created_at limit 1;
 select id,period_end into v_period,v_end from public.finance_reconciliation_periods where location_id=v_location and period_start=p_start and status='OPEN';
 if v_period is null then raise exception 'Abre primero la semana financiera'; end if;
 if timezone('America/Caracas',now())::date<=v_end then raise exception 'Registra el saldo final cuando haya terminado el domingo'; end if;
 update public.finance_reconciliation_period_accounts
 set closing_native=p_closing,closing_recorded_by=auth.uid(),closing_recorded_at=now()
 where period_id=v_period and account_id=p_account_id;
 if not found then raise exception 'Cuenta fuera de esta semana'; end if;
end $$;

create or replace function public.finance_week_set_closing(p_start date,p_account_id uuid,p_closing numeric)
returns void language sql security invoker set search_path='' as $$
 select lubricenter_private.finance_week_set_closing(p_start,p_account_id,p_closing)
$$;

create or replace function lubricenter_private.finance_week_status(p_start date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
 v_location uuid; p public.finance_reconciliation_periods; a record;
 v_rows jsonb:='[]'::jsonb; v_blockers jsonb:='[]'::jsonb;
 v_source uuid; v_source_name text; v_imported boolean; v_net numeric; v_expected numeric; v_diff numeric;
 v_pending integer; v_conflicts integer; v_cash_due integer; v_tol numeric; v_ready boolean:=true;
 v_cashea_pending integer:=0; v_cashea_batch boolean:=false;
begin
 perform lubricenter_private.finance_require();
 select id into v_location from public.locations where active order by created_at limit 1;
 select * into p from public.finance_reconciliation_periods where location_id=v_location and period_start=p_start;
 if not found then
   return jsonb_build_object('status','NEEDS_OPENING','start',p_start,'end',p_start+6,'ready',false,'accounts','[]'::jsonb,'blockers',jsonb_build_array('Falta abrir la semana'));
 end if;

 for a in
  select pa.*,fa.code,fa.name,fa.currency,fa.account_type
  from public.finance_reconciliation_period_accounts pa
  join public.financial_accounts fa on fa.id=pa.account_id
  where pa.period_id=p.id order by fa.code
 loop
  v_source:=null; v_source_name:=null; v_imported:=true; v_net:=0; v_pending:=0; v_conflicts:=0; v_cash_due:=0;
  if a.account_type='BANK' then
    select s.id,s.name into v_source,v_source_name
    from public.external_sources s
    where s.active and s.account_id=a.account_id
    order by s.created_at limit 1;

    if v_source is null then
      v_imported:=false;
    else
      select exists(
        select 1 from public.external_import_batches b
        where b.source_id=v_source
          and b.requested_from<=p.period_start and b.requested_to>=p.period_end
          and coalesce(jsonb_array_length(b.validation->'errors'),0)=0
      ) into v_imported;

      select coalesce(sum(case when x.direction='IN' then x.amount else -x.amount end),0),
             count(*) filter(where
               x.amount-coalesce((select sum(ra.external_amount) from public.reconciliation_allocations ra where ra.external_transaction_id=x.id and ra.reversed_at is null),0)>.01
             ),
             count(*) filter(where exists(
               select 1 from public.reconciliation_cases rc
               where rc.subject_type='external_transaction' and rc.subject_id=x.id and rc.status='OPEN'
                 and rc.kind in ('SOURCE_CONFLICT','SOURCE_AMOUNT','OWNERSHIP')
             ))
      into v_net,v_pending,v_conflicts
      from public.external_transactions x
      where x.source_id=v_source
        and timezone('America/Caracas',x.occurred_at)::date between p.period_start and p.period_end;
    end if;
    v_expected:=a.opening_native+v_net;
  else
    select coalesce(sum(case when m.direction='IN' then m.amount_original else -m.amount_original end),0)
    into v_net
    from public.account_movements m
    where m.account_id=a.account_id
      and timezone('America/Caracas',m.occurred_at)::date between p.period_start and p.period_end;
    v_expected:=a.opening_native+v_net;

    select count(*) into v_cash_due
    from (
      select distinct timezone('America/Caracas',m.occurred_at)::date d
      from public.account_movements m
      where m.account_id=a.account_id
        and timezone('America/Caracas',m.occurred_at)::date between p.period_start and p.period_end
    ) d
    where not exists(
      select 1 from public.cash_closings cc
      where cc.location_id=p.location_id and cc.business_date=d.d and cc.status='CLOSED'
    );
  end if;

  v_tol:=case when a.currency='USD' then .01 when a.account_type='CASH' then 1 else .01 end;
  v_diff:=case when a.closing_native is null then null else a.closing_native-v_expected end;

  if a.closing_native is null then
    v_ready:=false; v_blockers:=v_blockers||jsonb_build_array('Falta saldo final de '||a.name);
  end if;
  if a.account_type='BANK' and not v_imported then
    v_ready:=false; v_blockers:=v_blockers||jsonb_build_array('Falta importar el período completo de '||a.name);
  end if;
  if v_pending>0 then
    v_ready:=false; v_blockers:=v_blockers||jsonb_build_array(a.name||': '||v_pending||' movimiento(s) sin conciliar');
  end if;
  if v_conflicts>0 then
    v_ready:=false; v_blockers:=v_blockers||jsonb_build_array(a.name||': '||v_conflicts||' conflicto(s) de fuente');
  end if;
  if v_cash_due>0 then
    v_ready:=false; v_blockers:=v_blockers||jsonb_build_array(a.name||': '||v_cash_due||' día(s) de caja sin cerrar');
  end if;
  if v_diff is not null and abs(v_diff)>v_tol then
    v_ready:=false; v_blockers:=v_blockers||jsonb_build_array(a.name||': diferencia de '||v_diff::text||' '||a.currency);
  end if;

  v_rows:=v_rows||jsonb_build_array(jsonb_build_object(
    'account_id',a.account_id,'code',a.code,'name',a.name,'currency',a.currency,'type',a.account_type,
    'opening',a.opening_native,'closing',a.closing_native,'net',v_net,'expected_closing',v_expected,'difference',v_diff,
    'source_id',v_source,'source_name',v_source_name,'imported',v_imported,'pending',v_pending,'conflicts',v_conflicts,'cash_days_due',v_cash_due
  ));
 end loop;

 select count(*) into v_cashea_pending
 from public.external_transactions x join public.external_sources s on s.id=x.source_id and s.provider='CASHEA_TRANSACTIONS'
 where timezone('America/Caracas',x.occurred_at)::date between p.period_start and p.period_end
   and least(x.amount_ref,x.assigned_ref)-coalesce((select sum(ra.external_amount) from public.reconciliation_allocations ra where ra.external_transaction_id=x.id and ra.reversed_at is null),0)>.005;
 select exists(select 1 from public.external_import_batches b join public.external_sources s on s.id=b.source_id and s.provider='CASHEA_TRANSACTIONS'
   where b.requested_from<=p.period_start and b.requested_to>=p.period_end and coalesce(jsonb_array_length(b.validation->'errors'),0)=0)
 into v_cashea_batch;
 if not v_cashea_batch then
   v_ready:=false; v_blockers:=v_blockers||jsonb_build_array('Falta importar cobros Cashea de la semana');
 end if;
 if v_cashea_pending>0 then
   v_ready:=false; v_blockers:=v_blockers||jsonb_build_array('Cashea: '||v_cashea_pending||' cobro(s) por conciliar');
 end if;

 return jsonb_build_object('id',p.id,'status',p.status,'start',p.period_start,'end',p.period_end,'ready',case when p.status='OPEN' then v_ready else true end,
   'accounts',v_rows,'cashea',jsonb_build_object('imported',v_cashea_batch,'pending',v_cashea_pending),
   'blockers',v_blockers,'close_reason',p.close_reason,'closed_at',p.closed_at);
end $$;

create or replace function public.finance_week_status(p_start date)
returns jsonb language sql stable security invoker set search_path='' as $$
 select lubricenter_private.finance_week_status(p_start)
$$;

create or replace function lubricenter_private.finance_week_pending(p_start date,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_location uuid; v_period uuid; v_end date; v_total integer; v_rows jsonb;
begin
 perform lubricenter_private.finance_require();
 select id into v_location from public.locations where active order by created_at limit 1;
 select id,period_end into v_period,v_end from public.finance_reconciliation_periods where location_id=v_location and period_start=p_start;
 if v_period is null then return jsonb_build_object('total',0,'rows','[]'::jsonb,'categories','[]'::jsonb); end if;

 with pending as (
   select x.*,fa.name account_name,fa.id account_id,
     x.amount-coalesce((select sum(ra.external_amount) from public.reconciliation_allocations ra where ra.external_transaction_id=x.id and ra.reversed_at is null),0) remaining
   from public.external_transactions x
   join public.external_sources s on s.id=x.source_id
   join public.financial_accounts fa on fa.id=s.account_id
   join public.finance_reconciliation_period_accounts pa on pa.period_id=v_period and pa.account_id=fa.id
   where timezone('America/Caracas',x.occurred_at)::date between p_start and v_end
 ), numbered as (
   select *,row_number() over(order by occurred_at,id) rn from pending
   where remaining>.01
 )
 select count(*)::integer,
   coalesce(jsonb_agg(jsonb_build_object(
     'id',id,'account_id',account_id,'account_name',account_name,'occurred_at',occurred_at,'reference',reference,
     'description',description,'direction',direction,'currency',currency,'amount',amount,'remaining',remaining,
     'nature',nature,'category',category,'category_id',category_id
   ) order by occurred_at,id) filter(where rn>greatest(p_offset,0) and rn<=greatest(p_offset,0)+50),'[]'::jsonb)
 into v_total,v_rows from numbered;

 return jsonb_build_object(
   'total',v_total,'rows',v_rows,
   'categories',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'nature',nature) order by nature,name) from public.finance_categories where active),'[]'::jsonb),
   'accounts',coalesce((select jsonb_agg(jsonb_build_object('id',fa.id,'code',fa.code,'name',fa.name,'currency',fa.currency) order by fa.code)
     from public.finance_reconciliation_period_accounts pa join public.financial_accounts fa on fa.id=pa.account_id where pa.period_id=v_period),'[]'::jsonb)
 );
end $$;

create or replace function public.finance_week_pending(p_start date,p_offset integer default 0)
returns jsonb language sql stable security invoker set search_path='' as $$
 select lubricenter_private.finance_week_pending(p_start,p_offset)
$$;

create or replace function lubricenter_private.finance_week_close(p_start date,p_force boolean default false,p_reason text default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_location uuid; p public.finance_reconciliation_periods; v_status jsonb; v_ready boolean;
begin
 perform lubricenter_private.finance_require();
 perform pg_advisory_xact_lock(hashtextextended('finance-week:'||p_start::text,22));
 perform lubricenter_private.finance_reconcile();
 select id into v_location from public.locations where active order by created_at limit 1;
 select * into p from public.finance_reconciliation_periods where location_id=v_location and period_start=p_start for update;
 if not found then raise exception 'Semana financiera no abierta'; end if;
 if p.status<>'OPEN' then return lubricenter_private.finance_week_status(p_start); end if;
 if timezone('America/Caracas',now())::date<=p.period_end then raise exception 'La semana todavía no terminó'; end if;
 v_status:=lubricenter_private.finance_week_status(p_start); v_ready:=(v_status->>'ready')::boolean;
 if not v_ready then
   if not p_force then raise exception 'La semana no cuadra. Resuelve los pendientes antes de cerrar'; end if;
   perform lubricenter_private.finance_require('OWNER');
   if length(trim(coalesce(p_reason,'')))<10 then raise exception 'Explica por qué cierras con diferencias'; end if;
 end if;
 update public.finance_reconciliation_periods
 set status=case when v_ready then 'CLOSED' else 'CLOSED_WITH_EXCEPTION' end,
     closed_by=auth.uid(),closed_at=now(),close_reason=nullif(trim(p_reason),''),close_snapshot=v_status
 where id=p.id;
 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('finance.week_closed','finance_reconciliation_period',p.id,jsonb_build_object('forced',not v_ready,'snapshot',v_status,'reason',p_reason));
 return lubricenter_private.finance_week_status(p_start);
end $$;

create or replace function public.finance_week_close(p_start date,p_force boolean default false,p_reason text default null)
returns jsonb language sql security invoker set search_path='' as $$
 select lubricenter_private.finance_week_close(p_start,p_force,p_reason)
$$;

do $$
declare f record;
begin
 for f in
  select n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname in ('public','lubricenter_private')
    and p.proname in ('finance_category_upsert','finance_classify_external','finance_week_open','finance_week_set_closing','finance_week_status','finance_week_pending','finance_week_close')
 loop
  execute format('revoke all on function %I.%I(%s) from public,anon',f.nspname,f.proname,f.args);
  execute format('grant execute on function %I.%I(%s) to authenticated',f.nspname,f.proname,f.args);
 end loop;
end $$;
