-- G · Regla «solo se paga lo registrado», etapa 1 (Q-01).
--
-- Desde el negocio del 30 nov 2026, la mano de obra (comisión de taller, de electroauto y bono de
-- ayudante) de una orden SIN cliente o SIN vehículo entra a Nómina como «Por aprobar del dueño»:
-- decisión HOLD (no entra a la liquidación) hasta que el dueño la cambie a Pagar en Nómina
-- → Revisar / ajustar. Del 23 al 29 nov es marcha blanca: se paga igual y lleva el aviso.
--
-- Se aplica al generar el trabajo de nómina (payroll_work_items), por eso no cambia ninguna de las
-- 5 funciones de cierre que escriben payroll_accruals (menos choque con el Frente C1). Las fechas
-- viven en app_settings para poder moverlas sin migración. Aditiva.

insert into public.app_settings(key, value) values
  ('payroll_registered_rule_warn_from', '"2026-11-23"'),
  ('payroll_registered_rule_from', '"2026-11-30"')
on conflict (key) do nothing;

create or replace function lubricenter_private.payroll_registered_rule()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  o record; v_day date; v_warn date; v_from date;
begin
  if new.reversal_of is not null or new.order_id is null
     or coalesce(new.source_type, '') not in ('WORKSHOP_COMMISSION', 'ELECTROAUTO_COMMISSION', 'ASSISTANT_BONUS') then
    return new;
  end if;
  select ord.customer_id, ord.vehicle_id, ord.business_at, ord.closed_at into o from public.orders ord where ord.id = new.order_id;
  if not found or (o.customer_id is not null and o.vehicle_id is not null) then return new; end if;

  v_day := (coalesce(o.business_at, o.closed_at, new.earned_at, now()) at time zone 'America/Caracas')::date;
  select (s.value #>> '{}')::date into v_warn from public.app_settings s where s.key = 'payroll_registered_rule_warn_from';
  select (s.value #>> '{}')::date into v_from from public.app_settings s where s.key = 'payroll_registered_rule_from';

  if v_from is not null and v_day >= v_from then
    if new.decision = 'PAY' then
      new.decision := 'HOLD';
      new.reason := 'Por aprobar del dueño: la orden no tiene cliente y vehículo registrados';
    end if;
  elsif v_warn is not null and v_day >= v_warn then
    new.reason := coalesce(new.reason || ' · ', '')
      || 'Marcha blanca: desde el ' || to_char(coalesce(v_from, v_warn), 'DD/MM')
      || ' esto quedaría por aprobar (orden sin cliente o vehículo)';
  end if;
  return new;
end $$;

drop trigger if exists aa_payroll_registered_rule on public.payroll_work_items;
create trigger aa_payroll_registered_rule before insert on public.payroll_work_items
  for each row execute function lubricenter_private.payroll_registered_rule();

revoke all on function lubricenter_private.payroll_registered_rule() from public, anon, authenticated;
