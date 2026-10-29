-- WhatsApp central · fase 1 (registro y modo sombra). Migración solo aditiva.
--
-- Un número central (Evolution API, luego Cloud API de Meta) recibe los mensajes de clientes.
-- El servidor del OS (service role) guarda conversaciones y mensajes, y un agente (Claude Haiku)
-- clasifica, resume y, en modo sombra, deja un borrador que una persona aprueba antes de enviar.
--
-- * No toca tablas existentes. Reutiliza customers, vehicles, locations y crm_contact_permissions.
-- * Lectura en la app: solo personal con permiso crm.manage (mismo patrón que crm_manual_cases).
-- * Escritura: solo el servidor (service role). La app escribe a través de /api/whatsapp/*.
-- * El agente consulta inventario con wa_agent_product_search: sin costos ni cantidades exactas.

-- ── Configuración por sucursal ──────────────────────────────────────────────
create table if not exists public.wa_location_settings (
  location_id uuid primary key references public.locations(id),
  agent_enabled boolean not null default true,
  answers_inventory boolean not null default false,
  business_hours text,
  address text,
  services text,
  agent_notes text,
  updated_at timestamptz not null default now()
);
comment on table public.wa_location_settings is
  'Datos que el agente de WhatsApp puede decir por sucursal. answers_inventory=false: el agente no responde existencia de esa sucursal.';

insert into public.wa_location_settings (location_id, answers_inventory)
select id, true from public.locations where code = 'CABUDARE'
on conflict (location_id) do nothing;

-- ── Conversaciones ──────────────────────────────────────────────────────────
create table if not exists public.wa_conversations (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique check (phone ~ '^[0-9]{8,15}$'),
  display_name text,
  location_id uuid references public.locations(id),
  customer_id uuid references public.customers(id) on delete set null,
  vehicle_id uuid references public.vehicles(id) on delete set null,
  mode text not null default 'AGENT' check (mode in ('AGENT', 'HUMAN')),
  lead_class text not null default 'SIN_CLASIFICAR' check (lead_class in
    ('SIN_CLASIFICAR', 'PRODUCTOS', 'CAMBIO_ACEITE', 'TALLER', 'ELECTROAUTO', 'OTRA_SUCURSAL',
     'RECORDATORIO', 'POSTVENTA', 'PROVEEDOR', 'SPAM', 'OTRO')),
  lead_status text not null default 'NUEVO' check (lead_status in
    ('NUEVO', 'CALIFICADO', 'ESCALADO', 'GANADO', 'DESCARTADO', 'CERRADO')),
  needs_attention boolean not null default false,
  attention_reason text,
  summary text,
  extracted jsonb not null default '{}'::jsonb,
  opted_out_at timestamptz,
  unread_count integer not null default 0 check (unread_count >= 0),
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_message_at timestamptz,
  last_agent_run_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.wa_conversations is
  'Una conversación por teléfono del número central de WhatsApp. extracted = datos que dijo el cliente (nombre, vehículo, placa, interés).';
create index if not exists wa_conversations_attention_idx on public.wa_conversations (needs_attention, last_message_at desc);
create index if not exists wa_conversations_last_idx on public.wa_conversations (last_message_at desc);
create index if not exists wa_conversations_customer_idx on public.wa_conversations (customer_id);
create index if not exists wa_conversations_vehicle_idx on public.wa_conversations (vehicle_id);
create index if not exists wa_conversations_location_idx on public.wa_conversations (location_id);

-- ── Mensajes ────────────────────────────────────────────────────────────────
create table if not exists public.wa_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.wa_conversations(id) on delete restrict,
  direction text not null check (direction in ('IN', 'OUT')),
  sender text not null check (sender in ('CUSTOMER', 'AGENT', 'STAFF', 'SYSTEM')),
  status text not null check (status in ('RECEIVED', 'DRAFT', 'SENT', 'FAILED', 'DISCARDED')),
  provider text not null default 'evolution',
  provider_message_id text unique,
  body text,
  media_type text,
  provider_timestamp timestamptz,
  sent_by uuid references auth.users(id),
  error text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((direction = 'IN') = (sender = 'CUSTOMER')),
  check (status <> 'DRAFT' or sender = 'AGENT')
);
comment on table public.wa_messages is
  'Mensajes del número central. Los borradores del agente (status DRAFT) solo salen cuando una persona los aprueba.';
create index if not exists wa_messages_conversation_idx on public.wa_messages (conversation_id, created_at);
create index if not exists wa_messages_drafts_idx on public.wa_messages (conversation_id) where status = 'DRAFT';
create index if not exists wa_messages_sent_by_idx on public.wa_messages (sent_by);

-- ── Auditoría del agente ────────────────────────────────────────────────────
create table if not exists public.wa_agent_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.wa_conversations(id) on delete restrict,
  trigger_message_id uuid references public.wa_messages(id),
  mode text not null,
  model text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  cache_write_tokens integer not null default 0,
  tool_calls jsonb not null default '[]'::jsonb,
  result jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
comment on table public.wa_agent_runs is 'Cada ejecución del agente de WhatsApp: herramientas usadas, decisión, tokens (costo) y errores.';
create index if not exists wa_agent_runs_conversation_idx on public.wa_agent_runs (conversation_id, started_at desc);
create index if not exists wa_agent_runs_trigger_idx on public.wa_agent_runs (trigger_message_id);

-- ── updated_at ──────────────────────────────────────────────────────────────
create or replace function public.wa_touch_updated_at()
returns trigger language plpgsql set search_path to '' as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists wa_conversations_touch on public.wa_conversations;
create trigger wa_conversations_touch before update on public.wa_conversations
  for each row execute function public.wa_touch_updated_at();
drop trigger if exists wa_messages_touch on public.wa_messages;
create trigger wa_messages_touch before update on public.wa_messages
  for each row execute function public.wa_touch_updated_at();
drop trigger if exists wa_location_settings_touch on public.wa_location_settings;
create trigger wa_location_settings_touch before update on public.wa_location_settings
  for each row execute function public.wa_touch_updated_at();

-- ── Seguridad: lectura solo para personal con crm.manage; escritura solo servidor ──
alter table public.wa_location_settings enable row level security;
alter table public.wa_conversations enable row level security;
alter table public.wa_messages enable row level security;
alter table public.wa_agent_runs enable row level security;

revoke all on public.wa_location_settings, public.wa_conversations, public.wa_messages, public.wa_agent_runs from anon;
revoke insert, update, delete, truncate on public.wa_location_settings, public.wa_conversations, public.wa_messages, public.wa_agent_runs from authenticated;
grant select on public.wa_location_settings, public.wa_conversations, public.wa_messages, public.wa_agent_runs to authenticated;

do $$
declare t text;
begin
  foreach t in array array['wa_location_settings', 'wa_conversations', 'wa_messages', 'wa_agent_runs'] loop
    execute format('drop policy if exists staff_identity_gate on public.%I', t);
    execute format('create policy staff_identity_gate on public.%I as restrictive for all to authenticated
      using (lubricenter_private.staff_identity_allowed()) with check (lubricenter_private.staff_identity_allowed())', t);
    execute format('drop policy if exists wa_crm_read on public.%I', t);
    execute format('create policy wa_crm_read on public.%I for select to authenticated
      using (lubricenter_private.staff_can(''crm.manage''))', t);
  end loop;
end $$;

-- ── Teléfonos venezolanos: 0412-1234567 / +58 412 1234567 → 584121234567 ────
create or replace function public.wa_normalize_phone(p_phone text)
returns text language sql immutable set search_path to '' as $$
  select case
    when d is null or d = '' then null
    when d ~ '^58[0-9]{10}$' then d
    when d ~ '^0[0-9]{10}$' then '58' || substr(d, 2)
    when d ~ '^[24][0-9]{9}$' then '58' || d
    else d end
  from (select regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g') as d) x
$$;

-- Cliente existente por teléfono (customers.phone o identidades importadas). Solo servidor.
create or replace function public.wa_find_customer_by_phone(p_phone text)
returns table(customer_id uuid, name text, matched_by text)
language sql stable security definer set search_path to '' as $$
  with target as (select public.wa_normalize_phone(p_phone) as phone),
  hits as (
    select c.id, c.name, 'customers.phone'::text as matched_by, 1 as rank, c.updated_at
    from public.customers c, target t
    where t.phone is not null and public.wa_normalize_phone(c.phone) = t.phone
    union all
    select c.id, c.name, 'external:' || e.source_system, 2, c.updated_at
    from public.customer_external_identities e
    join public.customers c on c.id = e.customer_id, target t
    where t.phone is not null and public.wa_normalize_phone(e.normalized_phone) = t.phone
  )
  select id, name, matched_by from hits order by rank, updated_at desc limit 3
$$;

-- Contexto del cliente para el agente: vehículos y último servicio. Sin deudas, saldos ni pagos.
create or replace function public.wa_customer_context(p_customer_id uuid)
returns jsonb language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'name', c.name,
    'vehicles', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', v.id, 'plate', v.plate, 'make', v.make, 'model', v.model, 'year', v.year,
        'last_service', (
          select jsonb_build_object('date', (s.performed_at at time zone 'America/Caracas')::date,
            'odometer', s.odometer, 'oil', concat_ws(' ', s.oil_brand, s.oil_viscosity),
            'next_date', s.next_service_date, 'next_odometer', s.next_service_odometer)
          from public.service_records s where s.vehicle_id = v.id
          order by s.performed_at desc nulls last limit 1)
      ) order by v.updated_at desc)
      from public.vehicles v where v.customer_id = c.id), '[]'::jsonb),
    'opted_out', exists(select 1 from public.crm_contact_permissions p where p.customer_id = c.id and p.status = 'OPT_OUT')
  )
  from public.customers c where c.id = p_customer_id
$$;

-- Búsqueda de productos para el agente. Solo artículos activos de la sucursal indicada.
-- Devuelve disponible sí/no (no cantidades) y precio en Bs y REF BCV con la misma vista que la caja.
-- Nunca devuelve costos ni el precio oculto en divisas. Sin tasas frescas no hay precio.
create or replace function public.wa_agent_product_search(p_query text, p_location_code text default 'CABUDARE', p_limit integer default 8)
returns table(item_id uuid, name text, category text, in_stock boolean, has_price boolean, price_ves numeric, price_ref numeric)
language plpgsql stable security definer set search_path to '' as $$
declare
  v_tokens text[];
  v_rates_ok boolean := true;
begin
  select array_agg(t) into v_tokens
  from unnest(regexp_split_to_array(lower(btrim(coalesce(p_query, ''))), '\s+')) t
  where length(t) >= 2;
  if v_tokens is null then return; end if;

  begin
    perform public.assert_notion_pricing_fresh();
  exception when others then
    v_rates_ok := false;
  end;

  return query
  select c.id,
    coalesce(c.display_name, c.description),
    c.category,
    c.quantity_on_hand > 0,
    v_rates_ok and coalesce(c.price_usd, 0) > 0 and c.current_price_ves is not null,
    case when v_rates_ok and coalesce(c.price_usd, 0) > 0 then c.current_price_ves end,
    case when v_rates_ok and coalesce(c.price_usd, 0) > 0 then round(c.current_ref_bcv, 2) end
  from public.inventory_current c
  where c.location_code = p_location_code
    and not exists (
      select 1 from unnest(v_tokens) tok
      where lower(concat_ws(' ', c.display_name, c.description, c.brand, c.category, c.sku,
                  array_to_string(c.alt_codes, ' '))) not like '%' || tok || '%'
    )
  order by (c.quantity_on_hand > 0) desc, (coalesce(c.price_usd, 0) > 0) desc, coalesce(c.display_name, c.description)
  limit least(greatest(coalesce(p_limit, 8), 1), 15);
end $$;

-- Solo el servidor (service role) ejecuta estas funciones.
revoke all on function public.wa_find_customer_by_phone(text) from public, anon, authenticated;
revoke all on function public.wa_customer_context(uuid) from public, anon, authenticated;
revoke all on function public.wa_agent_product_search(text, text, integer) from public, anon, authenticated;
revoke all on function public.wa_touch_updated_at() from public, anon, authenticated;
grant execute on function public.wa_find_customer_by_phone(text) to service_role;
grant execute on function public.wa_customer_context(uuid) to service_role;
grant execute on function public.wa_agent_product_search(text, text, integer) to service_role;
grant execute on function public.wa_normalize_phone(text) to authenticated, service_role;
