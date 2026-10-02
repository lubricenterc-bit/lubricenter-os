-- Storage only. No activation, historical conversion, cash receipt or payroll recalculation.
alter table public.orders add column settlement_version integer not null default 2 check(settlement_version in (2,3));
alter table public.orders add column settlement_revision integer not null default 1 check(settlement_revision>0);
alter table public.order_items add constraint order_items_order_identity unique(order_id,id);
alter table public.payments add constraint payments_order_identity unique(order_id,id);

create table public.order_price_agreements (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete restrict,
 item_id uuid not null, version integer not null check(version>0),
 basis text not null check(basis in ('USD_FIXED','USD_REF_BCV','VES_FIXED')),
 principal numeric(24,8) not null check(principal>=0 and principal<1000000000000),
 ownership text not null check(ownership in ('SELF','THIRD_PARTY','UNRESOLVED')),
 supplier_id uuid references public.suppliers(id) on delete restrict,
 commission_worker uuid references public.employees(id) on delete restrict,
 commission_percent numeric(5,2), reason text not null check(length(trim(reason))>=5),
 state text not null default 'ACTIVE' check(state in ('ACTIVE','SUPERSEDED','REVERSED')),
 supersedes_id uuid references public.order_price_agreements(id) on delete restrict,
 commercial_snapshot jsonb not null default '{}', created_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id) on delete restrict,
 unique(order_id,id), unique(item_id,version),
 foreign key(order_id,item_id) references public.order_items(order_id,id) on delete restrict,
 check((commission_worker is null and commission_percent is null) or (commission_worker is not null and commission_percent=40 and ownership='SELF')),
 check(ownership='THIRD_PARTY' or supplier_id is null)
);
create unique index order_price_active on public.order_price_agreements(item_id) where state='ACTIVE';

create table public.collection_quotes (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete restrict,
 order_revision integer not null check(order_revision>0), engine_version integer not null default 3 check(engine_version=3),
 effective_at timestamptz not null, expires_at timestamptz not null,
 request_payload jsonb not null, calculated_payload jsonb not null, digest text not null,
 state text not null default 'PREVIEW' check(state in ('PREVIEW','COMMITTED','EXPIRED')),
 committed_request uuid unique, created_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id) on delete restrict, unique(order_id,id),
 check(expires_at>created_at), check((state='COMMITTED')=(committed_request is not null))
);

create table public.order_payment_applications (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete restrict,
 agreement_id uuid not null, payment_id uuid not null, quote_id uuid not null,
 direction text not null default 'APPLY' check(direction in ('APPLY','REVERSE')),
 reverses_id uuid references public.order_payment_applications(id) on delete restrict,
 currency text not null check(currency in ('USD','VES')), native_amount numeric(20,2) not null check(native_amount>0 and native_amount<1000000000000),
 covered_amount numeric(24,8) not null check(covered_amount>0 and covered_amount<1000000000000),
 baseline_amount numeric(24,8) not null check(baseline_amount>=0 and baseline_amount<1000000000000),
 benefit_amount numeric(24,8) not null check(abs(benefit_amount)<1000000000000), rounding_native numeric(24,8) not null default 0 check(abs(rounding_native)<=0.005),
 exchange_mode text not null check(exchange_mode in ('PAR','RATE','EXACT')),
 bcv_rate numeric(24,8) check(bcv_rate>0 and bcv_rate<1000000000000),
 bcv_rate_id uuid references public.exchange_rates(id) on delete restrict,
 acceptance_rate numeric(24,8) check(acceptance_rate>0 and acceptance_rate<1000000000000),
 exact_agreement_id uuid, exact_native numeric(20,2), exact_covered numeric(24,8),
 commission_amount numeric(20,2) not null default 0 check(commission_amount>=0 and commission_amount<=native_amount),
 reason text not null check(length(trim(reason))>=5), created_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id) on delete restrict,
 foreign key(order_id,agreement_id) references public.order_price_agreements(order_id,id) on delete restrict,
 foreign key(order_id,payment_id) references public.payments(order_id,id) on delete restrict,
 foreign key(order_id,quote_id) references public.collection_quotes(order_id,id) on delete restrict,
 check((direction='REVERSE')=(reverses_id is not null)),
 check((exchange_mode='RATE')=(acceptance_rate is not null)),
 check(exchange_mode<>'RATE' or bcv_rate is not null),
 check((exchange_mode='EXACT')=(exact_agreement_id is not null)),
 check(exchange_mode<>'EXACT' or (exact_native is not null and exact_covered is not null and exact_native>0 and exact_covered>0 and exact_native<1000000000000 and exact_covered<1000000000000)),
 check(exchange_mode='EXACT' or (exact_native is null and exact_covered is null))
);
create index order_application_agreement on public.order_payment_applications(agreement_id);
create index order_application_payment on public.order_payment_applications(payment_id);
create index order_application_reversed on public.order_payment_applications(reverses_id) where reverses_id is not null;
create index order_application_exact on public.order_payment_applications(exact_agreement_id) where exact_agreement_id is not null;

create table public.order_financing_applications (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete restrict,
 agreement_id uuid not null, cashea_sale_id uuid references public.cashea_sales(id) on delete restrict,
 receivable_id uuid references public.receivables(id) on delete restrict,
 amount numeric(24,8) not null check(amount>0 and amount<1000000000000),
 state text not null default 'ACTIVE' check(state in ('ACTIVE','REVERSED')),
 reason text not null check(length(trim(reason))>=5), created_at timestamptz not null default now(),
 created_by uuid not null references auth.users(id) on delete restrict,
 foreign key(order_id,agreement_id) references public.order_price_agreements(order_id,id) on delete restrict,
 check(num_nonnulls(cashea_sale_id,receivable_id)=1)
);
create index order_financing_agreement on public.order_financing_applications(agreement_id);

create function lubricenter_private.settlement_storage_guard() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.order_price_agreements; p public.payments; q public.collection_quotes; original public.order_payment_applications;
 total numeric; financed numeric; native_used numeric; reversed_native numeric; reversed_covered numeric;
 reversed_baseline numeric; reversed_benefit numeric; reversed_rounding numeric;
 previous_base numeric; previous_commission numeric; expected_commission numeric; exact_used numeric;
 factor numeric; group_native numeric; group_covered numeric; expected_covered numeric; expected_baseline numeric;
 contract_capacity numeric; contract_used numeric;
begin
 if tg_op='DELETE' then raise exception 'Conserva el original: utiliza una reversión con historial'; end if;
 if tg_op='UPDATE' then
  if tg_table_name='order_payment_applications' then raise exception 'La aplicación es inmutable: registra una compensación'; end if;
  if (to_jsonb(new)-'state'-'committed_request') is distinct from (to_jsonb(old)-'state'-'committed_request') then raise exception 'El acuerdo o la cotización original son inmutables'; end if;
  if old.state<>'ACTIVE' and tg_table_name<>'collection_quotes' or old.state<>'PREVIEW' and tg_table_name='collection_quotes' then raise exception 'Estado terminal inmutable'; end if;
 end if;
 perform pg_advisory_xact_lock(220033);
 if tg_table_name='collection_quotes' then return new; end if;
 if tg_table_name='order_price_agreements' then
  perform 1 from public.orders where id=new.order_id for update;
  if new.commission_worker is not null and not exists(select 1 from public.employees e join public.order_items i on i.id=new.item_id where e.id=new.commission_worker and e.code='CHEO' and i.business_area='WORKSHOP' and i.worker_employee_id=e.id) then raise exception 'La regla de Cheo solo corresponde a su mano de obra'; end if;
  if tg_op='UPDATE' and coalesce((select sum(case when direction='APPLY' then covered_amount else -covered_amount end) from public.order_payment_applications where agreement_id=old.id),0)<>0 then raise exception 'El precio aplicado requiere reversión económica antes de cambiar'; end if;
  if tg_op='UPDATE' and exists(select 1 from public.order_financing_applications where agreement_id=old.id and state='ACTIVE') then raise exception 'El precio financiado requiere resolver el contrato'; end if;
  if new.supersedes_id is not null and not exists(select 1 from public.order_price_agreements where id=new.supersedes_id and item_id=new.item_id and state='SUPERSEDED' and version<new.version) then raise exception 'Versión anterior incompatible'; end if;
  return new;
 end if;
 select * into a from public.order_price_agreements where id=new.agreement_id for update;
 if a.id is null or a.state<>'ACTIVE' then raise exception 'Acuerdo no activo'; end if;
 select coalesce(sum(case when direction='APPLY' then covered_amount else -covered_amount end),0) into total from public.order_payment_applications where agreement_id=a.id;
 select coalesce(sum(amount),0) into financed from public.order_financing_applications where agreement_id=a.id and state='ACTIVE';
 if tg_table_name='order_financing_applications' then
  if new.cashea_sale_id is not null and not exists(select 1 from public.cashea_sales where id=new.cashea_sale_id and order_id=new.order_id) or new.receivable_id is not null and not exists(select 1 from public.receivables where id=new.receivable_id and order_id=new.order_id) then raise exception 'Contrato ajeno a la orden'; end if;
  if tg_op='INSERT' and new.state='ACTIVE' and total+financed+new.amount>a.principal then raise exception 'Financiación supera saldo disponible'; end if;
  if tg_op='INSERT' and new.state='ACTIVE' then
   if a.basis='VES_FIXED' then raise exception 'Financiación en Bs fijos requiere contrato de conversión explícito'; end if;
   if new.cashea_sale_id is not null then
    select financed_ref into contract_capacity from public.cashea_sales where id=new.cashea_sale_id and status<>'CANCELLED' for update;
    select coalesce(sum(amount),0) into contract_used from public.order_financing_applications where cashea_sale_id=new.cashea_sale_id and state='ACTIVE';
   else
    select principal_ref into contract_capacity from public.receivables where id=new.receivable_id and status<>'CANCELLED' for update;
    select coalesce(sum(amount),0) into contract_used from public.order_financing_applications where receivable_id=new.receivable_id and state='ACTIVE';
   end if;
   if contract_capacity is null or contract_used+new.amount>contract_capacity then raise exception 'Financiación supera capacidad del contrato'; end if;
  end if;
  return new;
 end if;
 select * into p from public.payments where id=new.payment_id for update;
 select * into q from public.collection_quotes where id=new.quote_id;
 if p.currency<>new.currency then raise exception 'Moneda de aplicación distinta al cobro'; end if;
 if q.state='EXPIRED' then raise exception 'Cotización vencida'; end if;
 if new.exchange_mode in ('RATE','EXACT') and (a.basis='USD_FIXED' or new.currency<>'USD') then raise exception 'Preferencia incompatible con base o moneda'; end if;
 if new.exchange_mode='EXACT' and a.basis<>'USD_REF_BCV' then raise exception 'Acuerdo exacto requiere referencia BCV'; end if;
 if new.bcv_rate_id is not null and not exists(select 1 from public.exchange_rates where id=new.bcv_rate_id and rate_type='BCV' and value=new.bcv_rate) then raise exception 'BCV y fuente no coinciden'; end if;
 select coalesce(sum(case when direction='APPLY' then native_amount else -native_amount end),0) into native_used from public.order_payment_applications where payment_id=p.id;
 if new.direction='APPLY' then
  if total+financed+new.covered_amount>a.principal or native_used+new.native_amount>p.amount_original then raise exception 'La aplicación supera saldo o dinero disponible'; end if;
  if new.currency='VES' and a.basis<>'VES_FIXED' or new.currency='USD' and a.basis='VES_FIXED' then
   if new.bcv_rate is null then raise exception 'Falta BCV para convertir monedas'; end if;
  end if;
  factor:=case when new.exchange_mode='EXACT' then new.exact_covered/new.exact_native
   when new.exchange_mode='RATE' and a.basis='VES_FIXED' then new.acceptance_rate
   when new.exchange_mode='RATE' then new.acceptance_rate/new.bcv_rate
   when new.currency='USD' and a.basis<>'VES_FIXED' or new.currency='VES' and a.basis='VES_FIXED' then 1
   when new.currency='USD' then new.bcv_rate else 1/new.bcv_rate end;
  select coalesce(sum(case when direction='APPLY' then native_amount-rounding_native else -(native_amount-rounding_native) end),0),
   coalesce(sum(case when direction='APPLY' then covered_amount else -covered_amount end),0)
  into group_native,group_covered from public.order_payment_applications where agreement_id=a.id and currency=new.currency
   and row(exchange_mode,bcv_rate,acceptance_rate,exact_agreement_id,exact_native,exact_covered) is not distinct from row(new.exchange_mode,new.bcv_rate,new.acceptance_rate,new.exact_agreement_id,new.exact_native,new.exact_covered);
  expected_covered:=round((group_native+new.native_amount-new.rounding_native)*factor,8)-group_covered;
  if new.rounding_native<>0 then
   if total+financed+new.covered_amount<>a.principal or new.rounding_native<>round(new.native_amount-(a.principal-total-financed)/factor,8) then raise exception 'Residual incompatible con el saldo exacto'; end if;
   expected_covered:=a.principal-total-financed;
  end if;
  if new.covered_amount<>expected_covered then raise exception 'La cobertura no corresponde al acuerdo por concepto'; end if;
  if new.rounding_native<>0 and total+financed+new.covered_amount<>a.principal then raise exception 'El residual solo cierra el importe exacto pendiente'; end if;
  expected_baseline:=round(case when a.basis='VES_FIXED' and new.currency='USD' then new.native_amount*new.bcv_rate
   when a.basis<>'VES_FIXED' and new.currency='VES' then new.native_amount/new.bcv_rate else new.native_amount end,8);
  if new.baseline_amount<>expected_baseline or new.benefit_amount<>(case when new.exchange_mode='PAR' then 0 else round(new.native_amount*factor-expected_baseline,8) end) then raise exception 'Base o beneficio comercial incompatible'; end if;
 else
  select * into original from public.order_payment_applications where id=new.reverses_id for update;
  if original.id is null or original.direction<>'APPLY' or original.payment_id<>new.payment_id or original.agreement_id<>new.agreement_id then raise exception 'Origen de reversión incompatible'; end if;
  select coalesce(sum(native_amount),0),coalesce(sum(covered_amount),0),coalesce(sum(baseline_amount),0),coalesce(sum(benefit_amount),0),coalesce(sum(rounding_native),0)
   into reversed_native,reversed_covered,reversed_baseline,reversed_benefit,reversed_rounding from public.order_payment_applications where reverses_id=original.id;
  if reversed_native+new.native_amount>original.native_amount or reversed_covered+new.covered_amount>original.covered_amount or total-new.covered_amount<0 or native_used-new.native_amount<0 then raise exception 'Reversión superior al original'; end if;
  if round(original.covered_amount*(reversed_native+new.native_amount)/original.native_amount,8)-reversed_covered<>new.covered_amount then raise exception 'La reversión conserva la proporción histórica'; end if;
  if round(original.baseline_amount*(reversed_native+new.native_amount)/original.native_amount,8)-reversed_baseline<>new.baseline_amount
   or round(original.benefit_amount*(reversed_native+new.native_amount)/original.native_amount,8)-reversed_benefit<>new.benefit_amount
   or round(original.rounding_native*(reversed_native+new.native_amount)/original.native_amount,8)-reversed_rounding<>new.rounding_native
   then raise exception 'La reversión conserva base, beneficio y residual histórico'; end if;
  if row(new.currency,new.exchange_mode,new.bcv_rate,new.bcv_rate_id,new.acceptance_rate,new.exact_agreement_id,new.exact_native,new.exact_covered) is distinct from row(original.currency,original.exchange_mode,original.bcv_rate,original.bcv_rate_id,original.acceptance_rate,original.exact_agreement_id,original.exact_native,original.exact_covered) then raise exception 'La reversión conserva tasas y acuerdo original'; end if;
 end if;
 if new.exchange_mode='EXACT' then
  if exists(select 1 from public.order_payment_applications where exact_agreement_id=new.exact_agreement_id and row(agreement_id,exact_native,exact_covered) is distinct from row(new.agreement_id,new.exact_native,new.exact_covered)) then raise exception 'Acuerdo exacto reutilizado con otros datos'; end if;
  select coalesce(sum(case when direction='APPLY' then native_amount else -native_amount end),0) into exact_used from public.order_payment_applications where exact_agreement_id=new.exact_agreement_id;
  if exact_used+(case when new.direction='APPLY' then new.native_amount else -new.native_amount end)>new.exact_native then raise exception 'El tramo de acuerdo exacto ya fue consumido'; end if;
 end if;
 select coalesce(sum(case when direction='APPLY' then native_amount else -native_amount end),0),coalesce(sum(case when direction='APPLY' then commission_amount else -commission_amount end),0)
 into previous_base,previous_commission from public.order_payment_applications where agreement_id=a.id and currency=new.currency;
 expected_commission:=case when a.commission_worker is null then 0 else abs(round((previous_base+case when new.direction='APPLY' then new.native_amount else -new.native_amount end)*a.commission_percent/100,2)-previous_commission) end;
 if new.commission_amount<>expected_commission then raise exception 'La comisión no corresponde al cobro real acumulado de mano de obra'; end if;
 return new;
end $$;

-- One read snapshot; no payroll_sync, reconciliation, cash write or quote creation.
create function lubricenter_private.get_order_financial_summary_v3(p_order uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb; can_payroll boolean;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 can_payroll:=lubricenter_private.finance_role() in ('OWNER','ADMIN');
 select jsonb_build_object('order_id',o.id,'version',o.settlement_version,'revision',o.settlement_revision,'status',o.status,
  'components',coalesce((select jsonb_agg(jsonb_build_object(
   'id',a.id,'item_id',a.item_id,'description',i.description,'quantity',i.quantity::text,'business_area',i.business_area,
   'basis',a.basis,'principal',a.principal::text,'ownership',a.ownership,'agreement_version',a.version,
   'covered',coalesce((select sum(case when direction='APPLY' then covered_amount else -covered_amount end) from public.order_payment_applications where agreement_id=a.id),0)::text,
   'financed',coalesce((select sum(amount) from public.order_financing_applications where agreement_id=a.id and state='ACTIVE'),0)::text,
   'commission',case when can_payroll and a.commission_worker is not null then jsonb_build_object('worker',a.commission_worker,'mode','CHEO_COLLECTION','percent','40') else null end,
   'commission_base',case when can_payroll then jsonb_build_object(
    'USD',coalesce((select sum(case when direction='APPLY' then native_amount else -native_amount end) from public.order_payment_applications where agreement_id=a.id and currency='USD'),0)::text,
    'VES',coalesce((select sum(case when direction='APPLY' then native_amount else -native_amount end) from public.order_payment_applications where agreement_id=a.id and currency='VES'),0)::text) else null end,
   'commission_accrued',case when can_payroll then jsonb_build_object(
    'USD',coalesce((select sum(case when direction='APPLY' then commission_amount else -commission_amount end) from public.order_payment_applications where agreement_id=a.id and currency='USD'),0)::text,
    'VES',coalesce((select sum(case when direction='APPLY' then commission_amount else -commission_amount end) from public.order_payment_applications where agreement_id=a.id and currency='VES'),0)::text) else null end
   ) order by a.created_at,a.id) from public.order_price_agreements a join public.order_items i on i.id=a.item_id where a.order_id=o.id and a.state='ACTIVE'),'[]'::jsonb),
  'payments',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'method',p.method,'currency',p.currency,'amount',p.amount_original::text,'paid_at',p.paid_at,'valuation_status',case when p.value_ves is null then 'PENDING' else 'KNOWN' end,
    'applications',coalesce((select jsonb_agg(jsonb_build_object('id',x.id,'agreement_id',x.agreement_id,'direction',x.direction,'native',x.native_amount::text,'covered',x.covered_amount::text,'benefit',x.benefit_amount::text,'rounding_native',x.rounding_native::text,'exchange_mode',x.exchange_mode,'bcv',x.bcv_rate::text,'acceptance',x.acceptance_rate::text) order by x.created_at,x.id) from public.order_payment_applications x where x.payment_id=p.id),'[]'::jsonb)) order by p.paid_at,p.id) from public.payments p where p.order_id=o.id),'[]'::jsonb)
 ) into result from public.orders o where o.id=p_order;
 if result is null then raise exception 'Orden no encontrada'; end if;
 return result;
end $$;
create function public.get_order_financial_summary_v3(p_order uuid) returns jsonb
language sql stable security invoker set search_path='' as $$select lubricenter_private.get_order_financial_summary_v3(p_order)$$;
revoke all on function lubricenter_private.get_order_financial_summary_v3(uuid),public.get_order_financial_summary_v3(uuid) from public,anon;
grant execute on function lubricenter_private.get_order_financial_summary_v3(uuid),public.get_order_financial_summary_v3(uuid) to authenticated;
revoke all on function lubricenter_private.settlement_storage_guard() from public,anon,authenticated;

do $$declare t text; begin
 foreach t in array array['order_price_agreements','collection_quotes','order_payment_applications','order_financing_applications'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('create policy settlement_admin_read on public.%I for select to authenticated using ((select lubricenter_private.finance_role()) in (''ADMIN'',''OWNER''))',t);
  execute format('create trigger settlement_guard before insert or update or delete on public.%I for each row execute function lubricenter_private.settlement_storage_guard()',t);
  execute format('create trigger finance_audit after insert or update or delete on public.%I for each row execute function lubricenter_private.finance_audit()',t);
 end loop;
end $$;
