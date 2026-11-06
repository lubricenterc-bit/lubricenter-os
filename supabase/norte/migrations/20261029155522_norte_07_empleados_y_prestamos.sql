-- ===== Administración de empleados =====
create or replace function lubricenter_private.require_payroll_admin() returns void
 language plpgsql stable security definer set search_path to '' as $f$
begin
  if not (lubricenter_private.is_order_admin() or lubricenter_private.staff_can('payroll.manage')) then
    raise exception 'Solo el dueño puede administrar empleados' using errcode='42501';
  end if;
end $f$;

create or replace function lubricenter_private.employee_save(p_id uuid, p_name text, p_role text, p_active boolean)
 returns uuid language plpgsql security definer set search_path to '' as $f$
declare v_id uuid; v_name text := btrim(coalesce(p_name,'')); v_code text;
begin
  perform lubricenter_private.require_payroll_admin();
  if length(v_name) < 2 or length(v_name) > 80 then raise exception 'Escribe el nombre del empleado'; end if;
  if p_id is null then
    v_code := upper(regexp_replace(translate(v_name,'áéíóúÁÉÍÓÚñÑ','aeiouAEIOUnN'),'[^A-Za-z0-9]+','_','g'));
    if exists(select 1 from public.employees where code=v_code) then v_code := v_code||'_'||to_char(now(),'MMDDHH24MI'); end if;
    insert into public.employees(code,name,active) values (v_code,v_name,coalesce(p_active,true)) returning id into v_id;
  else
    update public.employees set name=v_name, active=coalesce(p_active,active), updated_at=now() where id=p_id returning id into v_id;
    if v_id is null then raise exception 'Empleado no encontrado'; end if;
  end if;
  insert into public.audit_events(event_type,entity_type,entity_id,data,actor_id)
  values ('employee.saved','employee',v_id,jsonb_build_object('name',v_name,'role',p_role,'active',p_active),auth.uid());
  return v_id;
end $f$;

-- Cambia una regla de pago con vigencia: cierra la anterior y abre la nueva desde la fecha indicada.
create or replace function lubricenter_private.employee_set_rule(p_employee uuid, p_rule_type text, p_value numeric, p_valid_from date default null)
 returns uuid language plpgsql security definer set search_path to '' as $f$
declare v_from date := coalesce(p_valid_from,(now() at time zone 'America/Caracas')::date); v_id uuid;
begin
  perform lubricenter_private.require_payroll_admin();
  if p_rule_type not in ('WORKSHOP_PERCENT','ASSISTANT_BONUS_PERCENT','FIXED_WEEKLY','ELECTROAUTO_PERCENT') then raise exception 'Tipo de pago inválido'; end if;
  if p_value is null or p_value < 0 or (p_rule_type like '%PERCENT' and p_value > 100) or p_value > 100000 then raise exception 'Valor inválido'; end if;
  if not exists(select 1 from public.employees where id=p_employee) then raise exception 'Empleado no encontrado'; end if;
  if exists(select 1 from public.compensation_rules where employee_id=p_employee and rule_type=p_rule_type and valid_from>v_from) then
    raise exception 'Ya hay un cambio programado para una fecha posterior';
  end if;
  update public.compensation_rules set value=p_value, valid_to=null, note='Administración de empleados'
   where employee_id=p_employee and rule_type=p_rule_type and valid_from=v_from returning id into v_id;
  if v_id is null then
    update public.compensation_rules set valid_to=v_from-1
     where employee_id=p_employee and rule_type=p_rule_type and valid_from<v_from and (valid_to is null or valid_to>=v_from);
    insert into public.compensation_rules(employee_id,rule_type,value,valid_from,note)
    values (p_employee,p_rule_type,p_value,v_from,'Administración de empleados') returning id into v_id;
  end if;
  insert into public.audit_events(event_type,entity_type,entity_id,data,actor_id)
  values ('employee.rule','employee',p_employee,jsonb_build_object('rule',p_rule_type,'value',p_value,'from',v_from),auth.uid());
  return v_id;
end $f$;

create or replace function lubricenter_private.employees_admin()
 returns jsonb language sql stable security definer set search_path to '' as $f$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',e.id,'code',e.code,'name',e.name,'active',e.active,
    'workshop_percent',(select value from public.compensation_rules r where r.employee_id=e.id and r.rule_type='WORKSHOP_PERCENT' and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date) order by valid_from desc limit 1),
    'assistant_percent',(select value from public.compensation_rules r where r.employee_id=e.id and r.rule_type='ASSISTANT_BONUS_PERCENT' and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date) order by valid_from desc limit 1),
    'fixed_weekly',(select value from public.compensation_rules r where r.employee_id=e.id and r.rule_type='FIXED_WEEKLY' and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date) order by valid_from desc limit 1)
  ) order by e.active desc, e.name),'[]'::jsonb) from public.employees e
$f$;

create or replace function public.employee_save(p_id uuid, p_name text, p_role text, p_active boolean) returns uuid language sql set search_path to '' as $f$ select lubricenter_private.employee_save(p_id,p_name,p_role,p_active) $f$;
create or replace function public.employee_set_rule(p_employee uuid, p_rule_type text, p_value numeric, p_valid_from date default null) returns uuid language sql set search_path to '' as $f$ select lubricenter_private.employee_set_rule(p_employee,p_rule_type,p_value,p_valid_from) $f$;
create or replace function public.employees_admin() returns jsonb language sql stable set search_path to '' as $f$ select lubricenter_private.employees_admin() $f$;

-- ===== Préstamos de mercancía entre sucursales =====
create table if not exists public.merchandise_loans (
  id uuid primary key default gen_random_uuid(),
  direction text not null check (direction in ('LENT','BORROWED')),
  counterparty text not null check (length(btrim(counterparty)) between 2 and 80),
  inventory_item_id uuid references public.inventory_items(id),
  location_id uuid not null references public.locations(id),
  description text not null,
  quantity numeric(14,3) not null check (quantity > 0),
  settled_quantity numeric(14,3) not null default 0 check (settled_quantity >= 0),
  status text not null default 'OPEN' check (status in ('OPEN','SETTLED')),
  note text,
  occurred_on date not null default ((now() at time zone 'America/Caracas')::date),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.merchandise_loan_settlements (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.merchandise_loans(id),
  quantity numeric(14,3) not null check (quantity > 0),
  mode text not null check (mode in ('GOODS','PAID')),
  amount_usd numeric(14,2),
  note text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
create index if not exists merchandise_loans_open_idx on public.merchandise_loans(status, occurred_on desc);
create index if not exists merchandise_loan_settlements_loan_idx on public.merchandise_loan_settlements(loan_id);
create index if not exists merchandise_loans_item_idx on public.merchandise_loans(inventory_item_id);
create index if not exists merchandise_loans_location_idx on public.merchandise_loans(location_id);
alter table public.merchandise_loans enable row level security;
alter table public.merchandise_loan_settlements enable row level security;
revoke all on public.merchandise_loans, public.merchandise_loan_settlements from anon, public;
grant select on public.merchandise_loans, public.merchandise_loan_settlements to authenticated;
create policy authenticated_read on public.merchandise_loans for select to authenticated using (true);
create policy staff_identity_gate on public.merchandise_loans as restrictive for all to authenticated using (lubricenter_private.staff_identity_allowed()) with check (lubricenter_private.staff_identity_allowed());
create policy authenticated_read on public.merchandise_loan_settlements for select to authenticated using (true);
create policy staff_identity_gate on public.merchandise_loan_settlements as restrictive for all to authenticated using (lubricenter_private.staff_identity_allowed()) with check (lubricenter_private.staff_identity_allowed());

create or replace function lubricenter_private.loan_register(p_direction text, p_counterparty text, p_inventory_item_id uuid, p_description text, p_quantity numeric, p_note text, p_occurred_on date default null)
 returns uuid language plpgsql security definer set search_path to '' as $f$
declare v_loc uuid; v_id uuid; v_desc text := btrim(coalesce(p_description,'')); v_item public.inventory_items;
begin
  if not lubricenter_private.staff_can('inventory.count') then raise exception 'No tienes permiso para registrar préstamos' using errcode='42501'; end if;
  if p_direction not in ('LENT','BORROWED') then raise exception 'Indica si prestaste o te prestaron'; end if;
  if p_quantity is null or p_quantity <= 0 then raise exception 'Cantidad inválida'; end if;
  if length(btrim(coalesce(p_counterparty,''))) < 2 then raise exception 'Indica la sucursal'; end if;
  select id into v_loc from public.locations where code='NORTE' and active;
  if p_inventory_item_id is not null then
    select * into v_item from public.inventory_items where id=p_inventory_item_id and active;
    if v_item.id is null then raise exception 'Artículo no encontrado'; end if;
    if v_desc = '' then v_desc := v_item.sku||' · '||coalesce(v_item.display_name,v_item.description); end if;
  end if;
  if length(v_desc) < 2 then raise exception 'Describe la mercancía'; end if;
  insert into public.merchandise_loans(direction,counterparty,inventory_item_id,location_id,description,quantity,note,occurred_on)
  values (p_direction,btrim(p_counterparty),p_inventory_item_id,v_loc,v_desc,p_quantity,nullif(btrim(coalesce(p_note,'')),''),coalesce(p_occurred_on,(now() at time zone 'America/Caracas')::date))
  returning id into v_id;
  -- Prestar saca mercancía; recibir prestado la agrega
  if p_inventory_item_id is not null then
    insert into public.inventory_movements(inventory_item_id,location_id,quantity_delta,movement_type,note)
    values (p_inventory_item_id,v_loc,case when p_direction='LENT' then -p_quantity else p_quantity end,
            case when p_direction='LENT' then 'TRANSFER_OUT' else 'TRANSFER_IN' end,
            'Préstamo '||case when p_direction='LENT' then 'a ' else 'de ' end||btrim(p_counterparty));
  end if;
  insert into public.audit_events(event_type,entity_type,entity_id,data,actor_id)
  values ('loan.registered','merchandise_loan',v_id,jsonb_build_object('direction',p_direction,'counterparty',p_counterparty,'quantity',p_quantity,'description',v_desc),auth.uid());
  return v_id;
end $f$;

create or replace function lubricenter_private.loan_settle(p_loan uuid, p_quantity numeric, p_mode text, p_amount_usd numeric default null, p_note text default null)
 returns jsonb language plpgsql security definer set search_path to '' as $f$
declare l public.merchandise_loans; v_left numeric;
begin
  if not lubricenter_private.staff_can('inventory.count') then raise exception 'No tienes permiso para registrar devoluciones' using errcode='42501'; end if;
  select * into l from public.merchandise_loans where id=p_loan for update;
  if l.id is null then raise exception 'Préstamo no encontrado'; end if;
  if l.status='SETTLED' then raise exception 'Este préstamo ya está saldado'; end if;
  if p_mode not in ('GOODS','PAID') then raise exception 'Indica si se devolvió mercancía o se pagó'; end if;
  v_left := l.quantity - l.settled_quantity;
  if p_quantity is null or p_quantity <= 0 or p_quantity > v_left then raise exception 'Cantidad inválida: quedan % por saldar', v_left; end if;
  insert into public.merchandise_loan_settlements(loan_id,quantity,mode,amount_usd,note) values (l.id,p_quantity,p_mode,p_amount_usd,nullif(btrim(coalesce(p_note,'')),''));
  if p_mode='GOODS' and l.inventory_item_id is not null then
    insert into public.inventory_movements(inventory_item_id,location_id,quantity_delta,movement_type,note)
    values (l.inventory_item_id,l.location_id,case when l.direction='LENT' then p_quantity else -p_quantity end,
            case when l.direction='LENT' then 'TRANSFER_IN' else 'TRANSFER_OUT' end,
            'Devolución de préstamo · '||l.counterparty);
  end if;
  update public.merchandise_loans set settled_quantity=settled_quantity+p_quantity,
    status=case when settled_quantity+p_quantity>=quantity then 'SETTLED' else 'OPEN' end, updated_at=now()
  where id=l.id returning * into l;
  return jsonb_build_object('id',l.id,'status',l.status,'pending',l.quantity-l.settled_quantity);
end $f$;

create or replace function public.loan_register(p_direction text, p_counterparty text, p_inventory_item_id uuid, p_description text, p_quantity numeric, p_note text, p_occurred_on date default null) returns uuid language sql set search_path to '' as $f$ select lubricenter_private.loan_register(p_direction,p_counterparty,p_inventory_item_id,p_description,p_quantity,p_note,p_occurred_on) $f$;
create or replace function public.loan_settle(p_loan uuid, p_quantity numeric, p_mode text, p_amount_usd numeric default null, p_note text default null) returns jsonb language sql set search_path to '' as $f$ select lubricenter_private.loan_settle(p_loan,p_quantity,p_mode,p_amount_usd,p_note) $f$;

revoke all on function lubricenter_private.require_payroll_admin(), lubricenter_private.employee_save(uuid,text,text,boolean), lubricenter_private.employee_set_rule(uuid,text,numeric,date), lubricenter_private.employees_admin(),
  lubricenter_private.loan_register(text,text,uuid,text,numeric,text,date), lubricenter_private.loan_settle(uuid,numeric,text,numeric,text),
  public.employee_save(uuid,text,text,boolean), public.employee_set_rule(uuid,text,numeric,date), public.employees_admin(),
  public.loan_register(text,text,uuid,text,numeric,text,date), public.loan_settle(uuid,numeric,text,numeric,text) from public, anon;
grant execute on function lubricenter_private.require_payroll_admin(), lubricenter_private.employee_save(uuid,text,text,boolean), lubricenter_private.employee_set_rule(uuid,text,numeric,date), lubricenter_private.employees_admin(),
  lubricenter_private.loan_register(text,text,uuid,text,numeric,text,date), lubricenter_private.loan_settle(uuid,numeric,text,numeric,text),
  public.employee_save(uuid,text,text,boolean), public.employee_set_rule(uuid,text,numeric,date), public.employees_admin(),
  public.loan_register(text,text,uuid,text,numeric,text,date), public.loan_settle(uuid,numeric,text,numeric,text) to authenticated;