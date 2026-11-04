-- Cashea: cuotas pagadas solo con verificación al 100 % (D-02).
--   Regla A: el export de órdenes dice que la cuota está pagada (igual que la v1).
--   Regla B: el export de pagos la cubre Y cada pago está en el estado de cuenta BNC
--            (misma referencia sin ceros, ±1 Bs, ±3 días).
-- Lo demás queda «por confirmar» con su motivo. Nunca baja paid_ref ni toca una cuota PAID.
--
-- Duplicados del export de pagos: no se borran. Se excluyen con
-- reconciliation_transaction_exclusions (el mecanismo que ya usa finanzas), con un
-- motivo nuevo para los que solo difieren en ceros a la izquierda o decimales.

-- 1. Motivo nuevo de exclusión (se amplía el CHECK, no se quita nada).
alter table public.reconciliation_transaction_exclusions
  drop constraint if exists reconciliation_transaction_exclusions_reason_check;
alter table public.reconciliation_transaction_exclusions
  add constraint reconciliation_transaction_exclusions_reason_check
  check (reason in ('EXACT_SOURCE_DUPLICATE', 'NORMALIZED_SOURCE_DUPLICATE'));

-- Clave normalizada de un pago del export de Cashea.
create or replace function lubricenter_private.cashea_payment_key(x public.external_transactions)
returns text language sql immutable set search_path to '' as $$
  select md5(jsonb_build_array(x.source_id, x.occurred_at, ltrim(coalesce(x.reference, ''), '0'),
    x.external_order, x.installments, round(x.amount, 2))::text)
$$;
revoke all on function lubricenter_private.cashea_payment_key(public.external_transactions) from public, anon;

-- 2. Marca los duplicados que ya existen. Se conserva la fila con asignaciones
--    vigentes; si no hay, la más antigua.
with alloc as (
  select external_transaction_id as id, count(*) as n
  from public.reconciliation_allocations where reversed_at is null group by 1
), ranked as (
  select x.id,
    first_value(x.id) over w as canonical_id,
    count(*) over (partition by lubricenter_private.cashea_payment_key(x)) as group_size,
    count(*) filter (where coalesce(a.n, 0) > 0) over (partition by lubricenter_private.cashea_payment_key(x)) as allocated_rows
  from public.external_transactions x
  join public.external_sources s on s.id = x.source_id and s.provider = 'CASHEA_TRANSACTIONS'
  left join alloc a on a.id = x.id
  where not exists (select 1 from public.reconciliation_transaction_exclusions e where e.transaction_id = x.id)
  window w as (partition by lubricenter_private.cashea_payment_key(x)
               order by (coalesce(a.n, 0) > 0) desc, x.created_at, x.id)
), marked as (
  insert into public.reconciliation_transaction_exclusions(transaction_id, canonical_transaction_id, reason, evidence)
  select r.id, r.canonical_id, 'NORMALIZED_SOURCE_DUPLICATE', jsonb_build_object(
    'rule', 'same source, timestamp, reference without leading zeros, Cashea order, installments and amount rounded to 2',
    'group_size', r.group_size, 'migration', 'cashea_sync_verificada')
  from ranked r
  where r.group_size > 1 and r.id <> r.canonical_id and r.allocated_rows <= 1
  on conflict (transaction_id) do nothing
  returning transaction_id, canonical_transaction_id
), cases as (
  update public.reconciliation_cases c
  set status = 'DISMISSED',
      resolution = 'Pago repetido del export de Cashea; se conserva la transacción ' || m.canonical_transaction_id::text,
      resolved_at = now(), updated_at = now()
  from marked m
  where c.subject_type = 'external_transaction' and c.subject_id = m.transaction_id and c.status = 'OPEN'
  returning 1
)
insert into public.audit_events(event_type, entity_type, entity_id, data)
select 'finance.normalized_duplicate_excluded', 'external_transaction', m.transaction_id,
  jsonb_build_object('canonical_transaction_id', m.canonical_transaction_id, 'rule', 'NORMALIZED_SOURCE_DUPLICATE',
    'dismissed_cases', (select count(*) from cases))
from marked m;

-- 3. Origen: cada pago nuevo que repite uno existente (aunque cambien los ceros
--    o los decimales) queda excluido al importarse. La importación no cambia.
create or replace function lubricenter_private.cashea_payment_mark_duplicate()
returns trigger language plpgsql security definer set search_path to '' as $$
declare v_canonical uuid;
begin
  if not exists (select 1 from public.external_sources s where s.id = new.source_id and s.provider = 'CASHEA_TRANSACTIONS') then
    return null;
  end if;
  select x.id into v_canonical
  from public.external_transactions x
  where x.source_id = new.source_id and x.id <> new.id
    and x.occurred_at = new.occurred_at
    and ltrim(coalesce(x.reference, ''), '0') = ltrim(coalesce(new.reference, ''), '0')
    and x.external_order is not distinct from new.external_order
    and x.installments is not distinct from new.installments
    and round(x.amount, 2) = round(new.amount, 2)
    and not exists (select 1 from public.reconciliation_transaction_exclusions e where e.transaction_id = x.id)
  order by x.created_at, x.id
  limit 1;
  if v_canonical is not null then
    insert into public.reconciliation_transaction_exclusions(transaction_id, canonical_transaction_id, reason, evidence, created_by)
    values (new.id, v_canonical, 'NORMALIZED_SOURCE_DUPLICATE',
      jsonb_build_object('rule', 'import trigger: same Cashea payment with another reference/amount format',
        'batch_id', new.first_batch_id), auth.uid())
    on conflict (transaction_id) do nothing;
    insert into public.audit_events(event_type, entity_type, entity_id, data)
    values ('finance.normalized_duplicate_excluded', 'external_transaction', new.id,
      jsonb_build_object('canonical_transaction_id', v_canonical, 'rule', 'NORMALIZED_SOURCE_DUPLICATE', 'source', 'import'));
  end if;
  return null;
end $$;
revoke all on function lubricenter_private.cashea_payment_mark_duplicate() from public, anon;

drop trigger if exists cashea_payment_mark_duplicate on public.external_transactions;
create trigger cashea_payment_mark_duplicate
  after insert on public.external_transactions
  for each row execute function lubricenter_private.cashea_payment_mark_duplicate();

-- 4. Sincronización verificada.
create or replace function lubricenter_private.cashea_conc_sync_installments_v2(p_dry_run boolean default false)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  r record; cur record;
  v_today date := (now() at time zone 'America/Caracas')::date;
  v_bnc_to date; v_bnc_from date;
  v_paid int := 0; v_partial int := 0; v_settled int := 0; v_rule_a int := 0; v_rule_b int := 0;
  v_paid_ids uuid[] := '{}';
  v_unverified jsonb := '[]'::jsonb;
  v_snap_paid numeric; v_snap_done boolean;
  v_ver_ref numeric; v_ver_ves numeric; v_ver_when timestamptz; v_all_when timestamptz; v_all_ves numeric;
  v_status text; v_new_paid numeric; v_rule text; v_reason text; v_hint text; v_last_pay timestamptz;
begin
  perform lubricenter_private.finance_require();
  perform pg_advisory_xact_lock(291029, 3);
  select min(line_date), max(line_date) into v_bnc_from, v_bnc_to from public.cashea_bnc_lines;

  for r in
    with snap as (
      select distinct on (external_order) * from public.cashea_order_snapshots
      order by external_order, created_at desc, id desc
    )
    select i.id, i.cashea_sale_id, i.installment_no, i.due_date, i.amount_ref, i.paid_ref, i.status,
      s.id as sale_id, btrim(s.cashea_reference) as ref, o.order_number,
      sn.id as snap_id, sn.status as snap_status,
      (select q from jsonb_array_elements(sn.installments) q where (q->>'number')::int = i.installment_no limit 1) as snap_q,
      (select coalesce(jsonb_agg(jsonb_build_object(
          'id', x.id, 'reference', x.reference, 'currency', x.currency, 'amount', x.amount,
          'occurred_at', x.occurred_at,
          'share_ref', coalesce(x.assigned_ref, x.amount_ref) / greatest(cardinality(x.installments), 1),
          'share_ves', case when x.currency = 'VES' then x.amount / greatest(cardinality(x.installments), 1) else 0 end,
          'bnc_line', bl.id,
          'bnc_ref_seen', bl2.id is not null) order by x.occurred_at), '[]'::jsonb)
        from public.external_transactions x
        join public.external_sources so on so.id = x.source_id and so.provider = 'CASHEA_TRANSACTIONS'
        left join lateral (
          select l.id from public.cashea_bnc_lines l
          where x.currency = 'VES'
            and ltrim(l.reference, '0') = ltrim(x.reference, '0')
            and abs(l.credit - x.amount) <= 1
            and l.line_date between (x.occurred_at at time zone 'America/Caracas')::date - 3
                                and (x.occurred_at at time zone 'America/Caracas')::date + 3
          order by abs(l.credit - x.amount), l.line_date limit 1) bl on true
        left join lateral (
          select l.id from public.cashea_bnc_lines l
          where ltrim(l.reference, '0') = ltrim(x.reference, '0') limit 1) bl2 on true
        where x.external_order = btrim(s.cashea_reference)
          and i.installment_no = any(x.installments)
          and not exists (select 1 from public.reconciliation_transaction_exclusions e where e.transaction_id = x.id)
      ) as pays
    from public.cashea_sales s
    join public.cashea_installments i on i.cashea_sale_id = s.id and i.status <> 'PAID'
    left join public.orders o on o.id = s.order_id
    left join snap sn on sn.external_order = btrim(s.cashea_reference)
    where s.status = 'ACTIVE' and s.ownership_status = 'OWN'
    order by i.due_date, i.id
  loop
    select status, paid_ref into cur from public.cashea_installments where id = r.id for update;
    if cur.status = 'PAID' then continue; end if;

    -- Regla A: export de órdenes.
    v_snap_done := r.snap_id is not null and r.snap_status <> 'CANCELLED' and r.snap_q ->> 'status' = 'DONE';
    v_snap_paid := case when r.snap_id is not null and r.snap_status <> 'CANCELLED'
      then least(coalesce((r.snap_q ->> 'paid_ref')::numeric, 0), r.amount_ref) else 0 end;

    -- Regla B: pagos verificados en el BNC.
    select coalesce(sum((p ->> 'share_ref')::numeric) filter (where p ->> 'bnc_line' is not null), 0),
           coalesce(sum((p ->> 'share_ves')::numeric) filter (where p ->> 'bnc_line' is not null), 0),
           max((p ->> 'occurred_at')::timestamptz) filter (where p ->> 'bnc_line' is not null),
           max((p ->> 'occurred_at')::timestamptz),
           coalesce(sum((p ->> 'share_ves')::numeric), 0)
      into v_ver_ref, v_ver_ves, v_ver_when, v_all_when, v_all_ves
    from jsonb_array_elements(r.pays) p;

    v_status := null; v_rule := null;
    if v_snap_done or (r.snap_id is not null and r.snap_status <> 'CANCELLED' and v_snap_paid >= r.amount_ref - 0.01) then
      v_status := 'PAID'; v_new_paid := r.amount_ref; v_rule := 'A';
    elsif v_ver_ref >= r.amount_ref - 0.01 then
      v_status := 'PAID'; v_new_paid := r.amount_ref; v_rule := 'B';
    elsif greatest(v_snap_paid, v_ver_ref) > cur.paid_ref + 0.005 then
      v_status := 'PARTIAL';
      v_new_paid := round(least(greatest(v_snap_paid, v_ver_ref), r.amount_ref), 4);
      v_rule := case when v_ver_ref >= v_snap_paid then 'B' else 'A' end;
    end if;

    if v_status is not null then
      v_new_paid := greatest(v_new_paid, cur.paid_ref);
      if not p_dry_run then
        update public.cashea_installments set
          status = v_status,
          paid_ref = v_new_paid,
          paid_ves_actual = greatest(coalesce(paid_ves_actual, 0),
            round(case when v_rule = 'B' then v_ver_ves else v_all_ves end, 2)),
          paid_at = case when v_status = 'PAID'
            then coalesce(case when v_rule = 'B' then v_ver_when else v_all_when end, now()) else paid_at end,
          updated_at = now()
        where id = r.id;
        insert into public.audit_events(event_type, entity_type, entity_id, data)
        values ('cashea.installment_synced_v2', 'cashea_installment', r.id, jsonb_build_object(
          'rule', v_rule, 'sale_id', r.sale_id, 'external_order', r.ref, 'installment_no', r.installment_no,
          'cashea_status', r.snap_q ->> 'status',
          'payments', (select coalesce(jsonb_agg(p -> 'id'), '[]'::jsonb) from jsonb_array_elements(r.pays) p
                       where v_rule = 'A' or p ->> 'bnc_line' is not null),
          'bnc_lines', (select coalesce(jsonb_agg(p -> 'bnc_line'), '[]'::jsonb) from jsonb_array_elements(r.pays) p
                        where p ->> 'bnc_line' is not null),
          'verified_ref', round(v_ver_ref, 4),
          'before', jsonb_build_object('status', cur.status, 'paid_ref', cur.paid_ref),
          'after', jsonb_build_object('status', v_status, 'paid_ref', v_new_paid)));
      end if;
      if v_status = 'PAID' then v_paid := v_paid + 1; v_paid_ids := v_paid_ids || r.id; else v_partial := v_partial + 1; end if;
      if v_rule = 'A' then v_rule_a := v_rule_a + 1; else v_rule_b := v_rule_b + 1; end if;
    end if;

    -- Por confirmar: no quedó pagada y hay alguna señal.
    if v_status is distinct from 'PAID' then
      v_reason := null; v_hint := null;
      v_last_pay := (select max((p ->> 'occurred_at')::timestamptz) from jsonb_array_elements(r.pays) p where p ->> 'bnc_line' is null);
      if r.snap_status = 'CANCELLED' then
        v_reason := 'ORDER_CANCELLED_IN_CASHEA';
        v_hint := 'Cashea muestra la orden cancelada. Revísala antes de cobrar o anular.';
      elsif jsonb_array_length(r.pays) > 0 and exists (select 1 from jsonb_array_elements(r.pays) p
            where p ->> 'bnc_line' is null and (p ->> 'bnc_ref_seen')::boolean) then
        v_reason := 'BNC_AMOUNT_MISMATCH';
        v_hint := 'La referencia está en el BNC, pero el monto o la fecha no coinciden. Revisa el pago.';
      elsif v_last_pay is not null then
        v_reason := 'NO_BNC_LINE';
        v_hint := case when v_bnc_to is null or (v_last_pay at time zone 'America/Caracas')::date > v_bnc_to
          then 'Pago en Cashea del ' || to_char((v_last_pay at time zone 'America/Caracas')::date, 'DD/MM')
            || ', pero el estado del BNC que subiste llega hasta el '
            || coalesce(to_char(v_bnc_to, 'DD/MM'), '—') || '. Sube uno más reciente.'
          else 'Pago en Cashea del ' || to_char((v_last_pay at time zone 'America/Caracas')::date, 'DD/MM')
            || ' que no aparece en el BNC. Revisa la referencia.' end;
      elsif jsonb_array_length(r.pays) > 0 then
        v_reason := 'AMOUNT_SHORT';
        v_hint := 'Lo verificado en el BNC no cubre la cuota completa.';
      elsif r.snap_id is null and r.due_date < v_today then
        v_reason := 'NO_SNAPSHOT_NO_PAYMENT';
        v_hint := 'Vencida y sin datos de Cashea. Sube un export de órdenes que incluya esta venta.';
      end if;
      if v_reason is not null then
        v_unverified := v_unverified || jsonb_build_object(
          'order_number', r.order_number, 'cashea_reference', r.ref, 'installment_no', r.installment_no,
          'due_date', r.due_date, 'amount_ref', round(r.amount_ref, 2), 'verified_ref', round(v_ver_ref, 2),
          'reason', v_reason, 'hint', v_hint);
      end if;
    end if;
  end loop;

  if not p_dry_run then
    with settled as (
      update public.cashea_sales s set status = 'SETTLED', settled_at = now()
      where s.status = 'ACTIVE' and s.ownership_status = 'OWN'
        and exists (select 1 from public.cashea_installments i where i.cashea_sale_id = s.id)
        and not exists (select 1 from public.cashea_installments i where i.cashea_sale_id = s.id and i.status <> 'PAID')
      returning 1)
    select count(*) into v_settled from settled;
  else
    select count(*) into v_settled from public.cashea_sales s
    where s.status = 'ACTIVE' and s.ownership_status = 'OWN'
      and exists (select 1 from public.cashea_installments i where i.cashea_sale_id = s.id)
      and not exists (select 1 from public.cashea_installments i where i.cashea_sale_id = s.id
                      and i.status <> 'PAID' and not (i.id = any(v_paid_ids)));
  end if;

  return jsonb_build_object(
    'paid', v_paid, 'partial', v_partial, 'settled', v_settled,
    'by_rule', jsonb_build_object('A', v_rule_a, 'B', v_rule_b),
    'unverified', v_unverified,
    'bnc_range', jsonb_build_object('from', v_bnc_from, 'to', v_bnc_to),
    'dry_run', p_dry_run);
end $$;
revoke all on function lubricenter_private.cashea_conc_sync_installments_v2(boolean) from public, anon;
grant execute on function lubricenter_private.cashea_conc_sync_installments_v2(boolean) to authenticated;

create or replace function public.cashea_conc_sync_installments_v2(p_dry_run boolean default false)
returns jsonb language sql security invoker set search_path to '' as $$
  select lubricenter_private.cashea_conc_sync_installments_v2(p_dry_run)
$$;
revoke all on function public.cashea_conc_sync_installments_v2(boolean) from public, anon;
grant execute on function public.cashea_conc_sync_installments_v2(boolean) to authenticated;

-- La v1 pasa a ser la v2 con las mismas claves de respuesta.
create or replace function lubricenter_private.cashea_conc_sync_installments()
returns jsonb language sql security definer set search_path to '' as $$
  select jsonb_build_object('paid', v -> 'paid', 'partial', v -> 'partial', 'settled', v -> 'settled')
  from (select lubricenter_private.cashea_conc_sync_installments_v2(false) as v) q
$$;

-- 5. Seguimiento: frescura de los reportes y fuente de cada cuota pagada.
create or replace function public.cashea_tracking_status()
returns jsonb language sql stable security invoker set search_path to '' as $$
  with last_import as (
    select kind, max(observed_to) as observed_to from public.cashea_conc_imports group by kind
  ), active as (
    select s.id, s.created_at, nullif(btrim(s.cashea_reference), '') as ref
    from public.cashea_sales s where s.status = 'ACTIVE' and s.ownership_status = 'OWN'
  ), missing as (
    select a.* from active a
    where a.ref is not null
      and not exists (select 1 from public.cashea_order_snapshots sn where sn.external_order = a.ref)
  ), src as (
    select distinct on (e.entity_id) e.entity_id,
      case when e.event_type = 'cashea.installment_synced_v2' and e.data ->> 'rule' = 'B' then 'BNC' else 'CASHEA' end as source
    from public.audit_events e
    where e.entity_type = 'cashea_installment'
      and e.event_type in ('cashea.installment_synced_v2', 'cashea.installment_synced_from_export')
      and e.data #>> '{after,status}' = 'PAID'
    order by e.entity_id, e.created_at desc
  )
  select jsonb_build_object(
    'orders_to', (select observed_to from last_import where kind = 'CASHEA_ORDERS'),
    'payments_to', (select observed_to from last_import where kind = 'CASHEA_PAYMENTS'),
    'bnc_to', (select observed_to from last_import where kind = 'BNC'),
    'never_in_orders_export', (select count(*) from missing),
    'oldest_missing_since', (select min((created_at at time zone 'America/Caracas')::date) from missing),
    'without_reference', (select count(*) from active where ref is null),
    'paid_sources', coalesce((
      select jsonb_object_agg(i.id, coalesce(src.source, 'MANUAL'))
      from public.cashea_installments i
      join public.cashea_sales s on s.id = i.cashea_sale_id
      left join src on src.entity_id = i.id
      where i.status = 'PAID' and s.status in ('ACTIVE', 'SETTLED')), '{}'::jsonb))
$$;
revoke all on function public.cashea_tracking_status() from public, anon;
grant execute on function public.cashea_tracking_status() to authenticated;
