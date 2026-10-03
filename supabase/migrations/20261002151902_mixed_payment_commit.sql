-- Backend bridge. No order activation or automatic historical migration.
alter table public.payments add column collection_quote_id uuid;
alter table public.payments add constraint payment_collection_scope foreign key(order_id,collection_quote_id) references public.collection_quotes(order_id,id) on delete restrict;
alter table public.payments alter column bcv_rate_snapshot drop not null;
alter table public.payments alter column operative_rate_snapshot drop not null;
alter table public.payments alter column value_ves drop not null;
alter table public.payments alter column value_ref drop not null;
alter table public.payments add constraint payment_pending_valuation check(value_ves is not null or (collection_quote_id is not null and currency='USD'));
alter table public.payments add column valuation_status text generated always as (case when value_ves is null then 'PENDING' else 'KNOWN' end) stored;
alter table public.account_movements alter column value_ves drop not null;
alter table public.account_movements add constraint movement_pending_valuation check(value_ves is not null or currency='USD');
alter table public.account_movements add column valuation_status text generated always as (case when value_ves is null then 'PENDING' else 'KNOWN' end) stored;

create function lubricenter_private.guard_payment_v3() returns trigger language plpgsql security definer set search_path='' as $$
declare o public.orders; q public.collection_quotes; t jsonb; b numeric; expected_ves numeric; expected_ref numeric;
begin
 if tg_op<>'INSERT' then
  if old.collection_quote_id is not null then raise exception 'El cobro por concepto conserva su original: usa una reversión económica'; end if;
  if tg_op='DELETE' then return old; else return new; end if;
 end if;
 select * into o from public.orders where id=new.order_id;
 if o.settlement_version<>3 then
  if new.collection_quote_id is not null then raise exception 'Una orden anterior no admite cobros nuevos sin revisión'; end if;
  return new;
 end if;
 if new.collection_quote_id is null then raise exception 'Esta orden requiere cotización y cobro por concepto'; end if;
 select * into q from public.collection_quotes where id=new.collection_quote_id;
 if q.id is null or q.order_id<>o.id or q.created_by<>auth.uid() or q.state<>'PREVIEW' or q.expires_at<now() or q.order_revision<>o.settlement_revision then raise exception 'Cotización vencida, ajena o modificada'; end if;
 select value into t from jsonb_array_elements(q.calculated_payload->'tenders') where value->>'id'=new.id::text;
 select (value->>'bcv')::numeric into b from jsonb_array_elements(q.calculated_payload->'applications') where value->>'tender'=new.id::text limit 1;
 if t is null or new.method<>t->>'method' or new.currency<>t->>'currency' or new.amount_original<>(t->>'applied')::numeric or new.reference is distinct from (t->>'reference') or new.paid_at<>q.effective_at then raise exception 'El pago no coincide con la cotización revisada'; end if;
 expected_ves:=case when new.currency='VES' then new.amount_original else round(new.amount_original*b,2) end;
 expected_ref:=case when new.currency='USD' then new.amount_original else round(new.amount_original/b,4) end;
 if new.bcv_rate_snapshot is distinct from b or new.operative_rate_snapshot is distinct from b or new.value_ves is distinct from expected_ves or new.value_ref is distinct from expected_ref then raise exception 'El cobro conserva su dinero real y la valoración BCV separada'; end if;
 return new;
end $$;
create trigger guard_payment_v3 before insert or update or delete on public.payments for each row execute function lubricenter_private.guard_payment_v3();
revoke all on function lubricenter_private.guard_payment_v3() from public,anon,authenticated;
-- Existing checkout RPCs are SECURITY DEFINER. Browser writes cannot split a commit.
revoke insert,update,delete on public.payments from public,anon,authenticated;

create function lubricenter_private.commit_collection_v3(p_quote uuid,p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q public.collection_quotes; o public.orders; t jsonb; x jsonb; b numeric; pid uuid; result jsonb;
begin
 perform lubricenter_private.finance_require('OPERATOR');
 if p_quote is null or p_request is null then raise exception 'Falta identificador de confirmación'; end if;
 perform pg_advisory_xact_lock(220033);
 select * into q from public.collection_quotes where id=p_quote for update;
 if q.id is null or q.created_by<>auth.uid() then raise exception 'Cotización no encontrada o ajena'; end if;
 if q.state='COMMITTED' then
  if q.committed_request<>p_request then raise exception 'El cobro ya fue confirmado con otro identificador'; end if;
  return jsonb_build_object('quote_id',q.id,'request_id',p_request,'order_id',q.order_id,'state','COMMITTED');
 end if;
 if exists(select 1 from public.collection_quotes where committed_request=p_request and id<>p_quote) then raise exception 'Identificador de confirmación reutilizado'; end if;
 select * into o from public.orders where id=q.order_id for update;
 if o.status<>'OPEN' or o.settlement_version<>3 or o.settlement_revision<>q.order_revision then raise exception 'La orden cambió: vuelve a revisar el cobro'; end if;
 if q.state<>'PREVIEW' or q.expires_at<now() or q.digest<>md5(q.calculated_payload::text) then raise exception 'Cotización vencida o inconsistente'; end if;
 -- Cash change and customer balance bridges must be ready before activating v3.
 if exists(select 1 from jsonb_array_elements(q.calculated_payload->'tenders') where (value->>'change')::numeric<>0) then raise exception 'Este flujo todavía no confirma vuelto: revisa su entrega antes de activar pagos v3'; end if;
 for t in select value from jsonb_array_elements(q.calculated_payload->'tenders') loop
  pid:=(t->>'id')::uuid;
  select (value->>'bcv')::numeric into b from jsonb_array_elements(q.calculated_payload->'applications') where value->>'tender'=pid::text limit 1;
  insert into public.payments(id,order_id,method,currency,amount_original,bcv_rate_snapshot,operative_rate_snapshot,value_ves,value_ref,reference,paid_at,collection_quote_id)
   values(pid,q.order_id,t->>'method',t->>'currency',(t->>'applied')::numeric,b,b,
    case when t->>'currency'='VES' then (t->>'applied')::numeric else round((t->>'applied')::numeric*b,2) end,
    case when t->>'currency'='USD' then (t->>'applied')::numeric else round((t->>'applied')::numeric/b,4) end,t->>'reference',q.effective_at,q.id);
  for x in select value from jsonb_array_elements(q.calculated_payload->'applications') where value->>'tender'=pid::text loop
   insert into public.order_payment_applications(order_id,agreement_id,payment_id,quote_id,currency,native_amount,covered_amount,baseline_amount,benefit_amount,rounding_native,exchange_mode,bcv_rate,bcv_rate_id,acceptance_rate,exact_agreement_id,exact_native,exact_covered,commission_amount,reason,created_by)
    values(q.order_id,(x->>'component')::uuid,pid,q.id,x->>'currency',(x->>'native')::numeric,(x->>'covered')::numeric,(x->>'baseline')::numeric,(x->>'benefit')::numeric,(x->>'rounding_native')::numeric,
     x->>'mode',(x->>'bcv')::numeric,(x->>'bcv_id')::uuid,(x->>'acceptance')::numeric,(x->>'exact_id')::uuid,(x->>'exact_native')::numeric,(x->>'exact_covered')::numeric,(x->>'commission')::numeric,'Cobro por concepto confirmado',auth.uid());
  end loop;
 end loop;
 update public.collection_quotes set state='COMMITTED',committed_request=p_request where id=q.id;
 update public.orders set settlement_revision=settlement_revision+1 where id=q.order_id;
 return jsonb_build_object('quote_id',q.id,'request_id',p_request,'order_id',q.order_id,'state','COMMITTED');
end $$;
create function public.commit_collection_v3(p_quote uuid,p_request uuid) returns jsonb language sql security invoker set search_path='' as $$select lubricenter_private.commit_collection_v3(p_quote,p_request)$$;
revoke all on function lubricenter_private.commit_collection_v3(uuid,uuid),public.commit_collection_v3(uuid,uuid) from public,anon;
grant execute on function lubricenter_private.commit_collection_v3(uuid,uuid),public.commit_collection_v3(uuid,uuid) to authenticated;

-- Never let the legacy close test certify component coverage through value_ves.
create function lubricenter_private.guard_v3_close() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.settlement_version=3 and new.status is distinct from old.status then raise exception 'El cierre y la anulación v3 requieren su flujo de aplicaciones; integración aún no habilitada'; end if;
 return new;
end $$;
create trigger guard_v3_close before update of status on public.orders for each row execute function lubricenter_private.guard_v3_close();
revoke all on function lubricenter_private.guard_v3_close() from public,anon,authenticated;

-- The browser cannot activate unfinished checkout or downgrade its accounting rules.
create function lubricenter_private.guard_settlement_activation() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if current_user not in ('postgres','supabase_admin') and
  ((tg_op='INSERT' and new.settlement_version<>2) or (tg_op='UPDATE' and new.settlement_version is distinct from old.settlement_version))
  then raise exception 'La activación del nuevo cobro requiere completar y publicar su integración'; end if;
 return new;
end $$;
create trigger guard_settlement_activation before insert or update of settlement_version on public.orders for each row execute function lubricenter_private.guard_settlement_activation();
revoke all on function lubricenter_private.guard_settlement_activation() from public,anon,authenticated;

create function lubricenter_private.guard_priced_item_v3() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.orders where id=old.order_id and settlement_version=3) and exists(select 1 from public.order_price_agreements where item_id=old.id and state='ACTIVE') then
  if tg_op='DELETE' then raise exception 'El concepto conserva su historial: requiere anulación económica'; end if;
  if row(new.order_id,new.business_area,new.worker_employee_id,new.quantity,new.charged_ves_amount,new.charged_ref_amount,new.price_denomination,new.agreed_usd)
   is distinct from row(old.order_id,old.business_area,old.worker_employee_id,old.quantity,old.charged_ves_amount,old.charged_ref_amount,old.price_denomination,old.agreed_usd)
   then raise exception 'Cambia el acuerdo por concepto antes de modificar importe o trabajador'; end if;
 end if;
 return case when tg_op='DELETE' then old else new end;
end $$;
create trigger guard_priced_item_v3 before update or delete on public.order_items for each row execute function lubricenter_private.guard_priced_item_v3();
revoke all on function lubricenter_private.guard_priced_item_v3() from public,anon,authenticated;

create function lubricenter_private.advance_settlement_revision() returns trigger language plpgsql security definer set search_path='' as $$
begin
 -- Legacy item RPCs already hold the order row: do not acquire the cash advisory
 -- lock after that row lock. The increment serializes on the parent order itself.
 if tg_op<>'INSERT' then update public.orders set settlement_revision=settlement_revision+1 where id=old.order_id and settlement_version=3; end if;
 if tg_op='INSERT' or (tg_op='UPDATE' and new.order_id is distinct from old.order_id) then update public.orders set settlement_revision=settlement_revision+1 where id=new.order_id and settlement_version=3; end if;
 return null;
end $$;
create trigger settlement_item_revision after insert or update or delete on public.order_items for each row execute function lubricenter_private.advance_settlement_revision();
create trigger settlement_price_revision after insert or update on public.order_price_agreements for each row execute function lubricenter_private.advance_settlement_revision();
revoke all on function lubricenter_private.advance_settlement_revision() from public,anon,authenticated;
