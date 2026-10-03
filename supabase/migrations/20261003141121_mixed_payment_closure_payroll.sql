-- Close against commercial applications, never a global operative exchange rate.
alter table public.orders alter column total_ves drop not null;
alter table public.orders alter column total_ref drop not null;
alter table public.orders alter column total_cash_usd_equivalent drop not null;
alter table public.orders add constraint legacy_order_totals_present check
 (settlement_version=3 or (total_ves is not null and total_ref is not null and total_cash_usd_equivalent is not null));
create table public.order_settlement_closures (
 order_id uuid primary key references public.orders(id), revision integer not null,
 summary jsonb not null, created_by uuid not null default auth.uid(), created_at timestamptz not null default now()
);
alter table public.order_settlement_closures enable row level security;
create policy closure_read on public.order_settlement_closures for select to authenticated using
 (lubricenter_private.is_order_admin());
grant select on public.order_settlement_closures to authenticated;
create function lubricenter_private.keep_settlement_closure() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'El cierre conserva su cálculo e historial originales'; end $$;
create trigger keep_settlement_closure before update or delete on public.order_settlement_closures
 for each row execute function lubricenter_private.keep_settlement_closure();
create function lubricenter_private.readable_settlement_closure(p_snapshot jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
 select case when lubricenter_private.finance_role() in ('OWNER','ADMIN') then p_snapshot else
  jsonb_set(p_snapshot,'{components}',coalesce((select jsonb_agg(c||jsonb_build_object
   ('commission',null,'commission_base',null,'commission_accrued',null))
   from jsonb_array_elements(p_snapshot->'components') c),'[]'::jsonb)) end
$$;
revoke all on function lubricenter_private.readable_settlement_closure(jsonb) from public,anon,authenticated;

create or replace function lubricenter_private.guard_v3_close() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.settlement_version=3 and new.status is distinct from old.status then
  if old.status<>'OPEN' or new.status<>'CLOSED' or not exists
   (select 1 from public.order_settlement_closures c where c.order_id=old.id and c.revision=old.settlement_revision
    and c.summary->>'total_ref' is not distinct from new.total_ref::text
    and c.summary->>'total_ves' is not distinct from new.total_ves::text
    and c.summary->>'cash_usd' is not distinct from new.total_cash_usd_equivalent::text)
   then raise exception 'Revisa y cierra por conceptos; una anulación necesita revertir sus cobros'; end if;
 end if;
 return new;
end $$;

create function lubricenter_private.close_order_v3(p_order uuid,p_revision integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o public.orders; missing text; b numeric; tr numeric; tv numeric; cash numeric; snapshot jsonb;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 perform pg_advisory_xact_lock(220033);
 select * into o from public.orders where id=p_order for update;
 if o.id is null or o.settlement_version<>3 then raise exception 'Orden no encontrada en el nuevo cálculo'; end if;
 if o.status='CLOSED' then
  select summary into snapshot from public.order_settlement_closures where order_id=o.id;
  if snapshot is not null then return lubricenter_private.readable_settlement_closure(snapshot); end if;
 end if;
 if o.status<>'OPEN' then raise exception 'La orden no está abierta'; end if;
 if p_revision is null or o.settlement_revision<>p_revision then raise exception 'La orden cambió: revisa el resumen antes de cerrar'; end if;
 if not exists(select 1 from public.order_items where order_id=o.id) then raise exception 'Agrega al menos un concepto antes de cerrar'; end if;
 select string_agg(i.description,', ') into missing from public.order_items i
 left join public.order_price_agreements a on a.item_id=i.id and a.state='ACTIVE'
 where i.order_id=o.id and (a.id is null or a.principal<>
  coalesce((select sum(case when direction='APPLY' then covered_amount else -covered_amount end) from public.order_payment_applications where agreement_id=a.id),0)
  +coalesce((select sum(amount) from public.order_financing_applications where agreement_id=a.id and state='ACTIVE'),0));
 if missing is not null then raise exception 'Falta cobrar o financiar: %',missing; end if;
 perform public.validate_order_ready_to_close(o.id);
 select value into b from public.exchange_rates where rate_type='BCV' and effective_at<=now() order by effective_at desc,created_at desc limit 1;
 -- These are gross commercial projections. Actual receipts and negotiated benefits
 -- remain separate in the immutable component summary, including their frozen rates.
 select case when bool_or(basis='VES_FIXED') and b is null then null else round(sum(case when basis='VES_FIXED' then principal/b else principal end),4) end,
  case when bool_or(basis<>'VES_FIXED') and b is null then null else round(sum(case when basis='VES_FIXED' then principal else principal*b end),2) end
 into tr,tv from public.order_price_agreements where order_id=o.id and state='ACTIVE';
 select round(coalesce(sum(case when direction='APPLY' then native_amount else -native_amount end) filter(where currency='USD'),0),4) into cash
 from public.order_payment_applications where order_id=o.id;
 snapshot:=lubricenter_private.get_order_financial_summary_v3(o.id)||jsonb_build_object
  ('status','CLOSED','total_ref',tr::numeric(18,4)::text,'total_ves',tv::numeric(18,2)::text,'cash_usd',cash::numeric(18,4)::text,
   'projection_bcv',b::text,'valuation_status',case when tr is null or tv is null then 'PENDING' else 'KNOWN' end);
 insert into public.order_settlement_closures(order_id,revision,summary) values(o.id,o.settlement_revision,snapshot);
 update public.orders set status='CLOSED',closed_at=now(),total_ref=tr,total_ves=tv,total_cash_usd_equivalent=cash where id=o.id;
 insert into public.integration_events(event_type,aggregate_type,aggregate_id,payload)
 values('order.closed','order',o.id,jsonb_build_object('order_number',o.order_number,'settlement_version',3,'total_ref',tr,'total_ves',tv));
 insert into public.audit_events(event_type,entity_type,entity_id,data)
 values('order.closed_v3','order',o.id,jsonb_build_object('revision',o.settlement_revision,'snapshot',snapshot,'actor',auth.uid()));
 return lubricenter_private.readable_settlement_closure(snapshot);
end $$;
create function public.close_order_v3(p_order uuid,p_revision integer) returns jsonb language sql security invoker set search_path='' as $$
 select lubricenter_private.close_order_v3(p_order,p_revision)
$$;

-- Existing callers retain their response shape. Old clients cannot close v3 with
-- the old payment-total check or create nominal payroll accruals a second time.
alter function public.close_order(uuid) rename to close_order_v2;
revoke all on function public.close_order_v2(uuid) from public,anon,authenticated;
create function public.close_order(p_order_id uuid)
returns table(order_number text,total_ves numeric,total_ref numeric,total_cash_usd_equivalent numeric)
language plpgsql security definer set search_path='' as $$
declare o public.orders;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 perform pg_advisory_xact_lock(220033);
 select * into o from public.orders where id=p_order_id for update;
 if o.settlement_version=3 then
  perform lubricenter_private.close_order_v3(o.id,o.settlement_revision);
  return query select x.order_number,x.total_ves,x.total_ref,x.total_cash_usd_equivalent from public.orders x where x.id=o.id;
 else return query select * from public.close_order_v2(p_order_id); end if;
end $$;
do $$declare f record; begin
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname in ('public','lubricenter_private') and p.proname in ('close_order','close_order_v3') loop
  execute format('revoke all on function %s from public,anon',f.signature);
  execute format('grant execute on function %s to authenticated',f.signature);
 end loop;
end $$;
revoke all on function lubricenter_private.keep_settlement_closure() from public,anon,authenticated;

-- Provenance binds payroll to real labor allocations, not every payment in an order.
alter table public.payroll_work_items add column settlement_application_id uuid references public.order_payment_applications(id);
alter table public.payroll_work_items add column settlement_source_amount numeric(18,2);
alter table public.payroll_work_items add column settlement_reversal_source uuid references public.order_payment_applications(id);
create unique index payroll_application_source on public.payroll_work_items(settlement_application_id) where settlement_application_id is not null and settlement_reversal_source is null;
create unique index payroll_application_compensation on public.payroll_work_items(settlement_reversal_source) where settlement_reversal_source is not null;

create function lubricenter_private.payroll_sync_v3() returns void language plpgsql security definer set search_path='' as $$
declare current_work public.payroll_work_items; source_amount numeric;
begin
 perform lubricenter_private.require_order_admin();
 -- Caller holds the payroll mutex and parent-order locks. A payment contributes
 -- only its actual amount allocated to this worker's labor.
 insert into public.payroll_work_items(accrual_id,payment_id,employee_id,order_id,order_number,description,source_type,currency,
  original_amount,amount,ref_per_unit,earned_at,settlement_application_id,settlement_source_amount)
 select ap.id,ap.payment_id,a.commission_worker,o.id,o.order_number,i.description,'WORKSHOP_COMMISSION',ap.currency,
  ap.commission_amount,ap.commission_amount,case when ap.currency='USD' then 1 else 1/ap.bcv_rate end,
  greatest(o.closed_at,p.paid_at),ap.id,ap.commission_amount
 from public.order_payment_applications ap join public.order_price_agreements a on a.id=ap.agreement_id
 join public.order_items i on i.id=a.item_id join public.orders o on o.id=ap.order_id join public.payments p on p.id=ap.payment_id
 where o.settlement_version=3 and o.status='CLOSED' and ap.direction='APPLY' and ap.commission_amount>0
 and a.commission_worker is not null and a.ownership='SELF' and (ap.currency='USD' or ap.bcv_rate is not null)
 on conflict(settlement_application_id) where settlement_application_id is not null and settlement_reversal_source is null do nothing;
 for current_work in select * from public.payroll_work_items where settlement_application_id is not null and settlement_reversal_source is null and payroll_run_id is null for update loop
  select ap.commission_amount-coalesce((select sum(r.commission_amount) from public.order_payment_applications r where r.reverses_id=ap.id),0)
  into source_amount from public.order_payment_applications ap where ap.id=current_work.settlement_application_id;
  if source_amount is distinct from current_work.settlement_source_amount then
   if current_work.decision='PAY' and current_work.amount=current_work.settlement_source_amount and current_work.reason is null then
    update public.payroll_work_items set amount=source_amount,settlement_source_amount=source_amount,version=version+1 where id=current_work.id;
   else
    update public.payroll_work_items set settlement_source_amount=source_amount,decision='HOLD',
     reason='Cambió el cobro de este trabajo; revisa el ajuste anterior antes de liquidar',version=version+1 where id=current_work.id;
   end if;
  end if;
 end loop;
 -- Each partial reversal has its own stable source; paid receipts remain immutable.
 insert into public.payroll_work_items(accrual_id,payment_id,employee_id,order_id,order_number,description,source_type,currency,
  original_amount,amount,ref_per_unit,earned_at,settlement_application_id,settlement_reversal_source,settlement_source_amount,reason)
 select r.id,w.payment_id,w.employee_id,w.order_id,w.order_number,'Reversión · '||w.description,w.source_type,w.currency,
  -r.commission_amount,-round(r.commission_amount*w.amount/nullif(w.settlement_source_amount,0),2),w.ref_per_unit,r.created_at,
  w.settlement_application_id,r.id,-r.commission_amount,'Reversión parcial del cobro de mano de obra'
 from public.order_payment_applications r join public.payroll_work_items w on w.settlement_application_id=r.reverses_id
 where r.direction='REVERSE' and r.commission_amount>0 and w.payroll_run_id is not null and w.decision='PAY'
 and w.settlement_reversal_source is null and w.settlement_source_amount>0
 on conflict(settlement_reversal_source) where settlement_reversal_source is not null do nothing;
end $$;
revoke all on function lubricenter_private.payroll_sync_v3() from public,anon,authenticated;

create or replace function lubricenter_private.payroll_sync() returns void language plpgsql security definer set search_path='' as $$
begin
 perform lubricenter_private.require_order_admin();
 perform pg_advisory_xact_lock(240924,1);
 perform 1 from public.orders o where exists(select 1 from public.payroll_work_items w where w.order_id=o.id) or exists(select 1 from public.order_items i join public.payroll_accruals a on a.source_order_item_id=i.id where i.order_id=o.id and a.payroll_run_id is null) order by o.id for update;
 insert into public.payroll_work_items(accrual_id,payment_id,employee_id,order_id,order_number,description,source_type,currency,original_amount,amount,ref_per_unit,earned_at)
 select a.id,p.id,a.employee_id,o.id,o.order_number,coalesce(a.description,i.description),a.source_type,p.currency,
  round(p.amount_original*a.amount_ref*i.bcv_rate_snapshot/o.total_ves,2),
  round(p.amount_original*a.amount_ref*i.bcv_rate_snapshot/o.total_ves,2),
  p.value_ref/p.amount_original,greatest(a.occurred_at,p.paid_at)
 from public.payroll_accruals a join public.order_items i on i.id=a.source_order_item_id
 join public.orders o on o.id=i.order_id join public.payments p on p.order_id=o.id
 where o.settlement_version<>3 and a.payroll_run_id is null and o.status='CLOSED' and o.total_ves>0 and p.amount_original>0 and p.value_ref>0
 on conflict(accrual_id,payment_id) where reversal_of is null do nothing;

 -- Reversals preserve already settled receipts. No legacy REF deduction is created:
 -- new work items deliberately do not mark the original accrual as legacy-settled.
 insert into public.payroll_work_items(accrual_id,payment_id,employee_id,order_id,order_number,description,source_type,currency,original_amount,amount,ref_per_unit,earned_at,reversal_of,reason)
 select w.accrual_id,w.payment_id,w.employee_id,w.order_id,w.order_number,'Reversión · '||w.description,w.source_type,w.currency,
  -w.amount,-w.amount,w.ref_per_unit,now(),w.id,'Orden anulada o cobro/trabajo corregido'
 from public.payroll_work_items w
 where w.settlement_application_id is null and w.payroll_run_id is not null and w.reversal_of is null and w.decision='PAY' and w.amount<>0
 and (not exists(select 1 from public.payroll_accruals a where a.id=w.accrual_id)
  or not exists(select 1 from public.payments p where p.id=w.payment_id)
  or not exists(select 1 from public.orders o where o.id=w.order_id and o.status='CLOSED'))
 on conflict(reversal_of) where reversal_of is not null do nothing;
 update public.payroll_work_items w set decision='EXCLUDE',reason='Orden anulada o cobro/trabajo corregido',version=version+1
 where settlement_application_id is null and payroll_run_id is null and reversal_of is null and decision<>'EXCLUDE'
 and (not exists(select 1 from public.payroll_accruals a where a.id=w.accrual_id)
  or not exists(select 1 from public.payments p where p.id=w.payment_id)
  or not exists(select 1 from public.orders o where o.id=w.order_id and o.status='CLOSED'));
 perform lubricenter_private.payroll_sync_v3();
end $$;

create or replace function lubricenter_private.payroll_review_work(p_id uuid,p_version integer,p_decision text,p_amount numeric,p_reason text) returns void language plpgsql security definer set search_path='' as $$
declare w public.payroll_work_items; updated public.payroll_work_items;
begin
 perform lubricenter_private.require_order_admin();
 perform pg_advisory_xact_lock(240924,1);
 select * into w from public.payroll_work_items where id=p_id for update;
 if not found then raise exception 'Trabajo no encontrado'; end if;
 if w.payroll_run_id is not null then raise exception 'Este trabajo ya está liquidado; su recibo no se puede reescribir'; end if;
 if w.version<>p_version then raise exception 'El trabajo cambió. Recarga la revisión antes de guardar'; end if;
 if length(trim(coalesce(p_reason,'')))<5 then raise exception 'Explica el motivo del cambio (mínimo 5 caracteres)'; end if;
 if p_decision is null or p_decision not in ('PAY','HOLD','EXCLUDE') or p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity') then raise exception 'Decisión o monto inválido'; end if;
 if w.reversal_of is null and w.settlement_reversal_source is null and p_amount<0 then raise exception 'La comisión no puede ser negativa'; end if;
 if w.settlement_application_id is null and w.reversal_of is null and (not exists(select 1 from public.payroll_accruals where id=w.accrual_id) or not exists(select 1 from public.payments where id=w.payment_id) or not exists(select 1 from public.orders where id=w.order_id and status='CLOSED')) then raise exception 'Este trabajo fue anulado o corregido y no puede pagarse'; end if;
 if w.settlement_application_id is not null and w.settlement_reversal_source is null and p_decision='PAY' and (w.settlement_source_amount<=0 or not exists(select 1 from public.orders where id=w.order_id and status='CLOSED')) then raise exception 'El cobro de este trabajo fue revertido; no puede pagarse'; end if;
 if (w.reversal_of is not null or w.settlement_reversal_source is not null) and p_amount<>w.amount then raise exception 'La reversión conserva el monto originalmente liquidado'; end if;
 update public.payroll_work_items set decision=p_decision,amount=round(p_amount,2),reason=trim(p_reason),version=version+1 where id=p_id returning * into updated;
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('payroll.work_reviewed','payroll_work_item',p_id,jsonb_build_object('reason',p_reason,'before',to_jsonb(w),'after',to_jsonb(updated),'actor',auth.uid()));
end $$;
