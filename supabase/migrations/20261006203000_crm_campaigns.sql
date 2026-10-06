create table if not exists public.crm_campaigns (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  channel text not null default 'WHATSAPP' check (channel in ('WHATSAPP')),
  objective text not null default 'CASH_FLOW',
  status text not null default 'ACTIVE' check (status in ('DRAFT','ACTIVE','PAUSED','CLOSED')),
  starts_on date not null,
  ends_on date,
  description text,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.crm_campaign_contacts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.crm_campaigns(id) on delete cascade,
  customer_id uuid not null references public.customers(id),
  vehicle_id uuid references public.vehicles(id),
  name_snapshot text not null,
  phone_snapshot text not null,
  vehicle_snapshot text not null,
  plate_snapshot text,
  segment text not null,
  priority boolean not null default false,
  rank integer not null default 0,
  reason text not null default '',
  message_snapshot text not null,
  status text not null default 'PENDING'
    check (status in ('PENDING','SENT','RESPONDED','SCHEDULED','VISITED','CONVERTED','NOT_INTERESTED')),
  sent_at timestamptz,
  responded_at timestamptz,
  scheduled_for timestamptz,
  visited_at timestamptz,
  converted_at timestamptz,
  converted_order_id uuid references public.orders(id),
  outcome_note text,
  last_action_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, customer_id)
);

create index if not exists crm_campaign_contacts_campaign_status_idx
  on public.crm_campaign_contacts(campaign_id, status);
create index if not exists crm_campaign_contacts_customer_idx
  on public.crm_campaign_contacts(customer_id);
create index if not exists crm_campaign_contacts_vehicle_idx
  on public.crm_campaign_contacts(vehicle_id);
create index if not exists crm_campaign_contacts_order_idx
  on public.crm_campaign_contacts(converted_order_id);

alter table public.crm_campaigns enable row level security;
alter table public.crm_campaign_contacts enable row level security;

revoke all on public.crm_campaigns from anon;
revoke all on public.crm_campaign_contacts from anon;
grant select, insert, update on public.crm_campaigns to authenticated;
grant select, insert, update on public.crm_campaign_contacts to authenticated;

drop policy if exists crm_campaigns_owner_admin_select on public.crm_campaigns;
create policy crm_campaigns_owner_admin_select
on public.crm_campaigns for select
to authenticated
using ((select public.finance_role()) in ('OWNER','ADMIN'));

drop policy if exists crm_campaigns_owner_admin_insert on public.crm_campaigns;
create policy crm_campaigns_owner_admin_insert
on public.crm_campaigns for insert
to authenticated
with check ((select public.finance_role()) in ('OWNER','ADMIN'));

drop policy if exists crm_campaigns_owner_admin_update on public.crm_campaigns;
create policy crm_campaigns_owner_admin_update
on public.crm_campaigns for update
to authenticated
using ((select public.finance_role()) in ('OWNER','ADMIN'))
with check ((select public.finance_role()) in ('OWNER','ADMIN'));

drop policy if exists crm_campaign_contacts_owner_admin_select on public.crm_campaign_contacts;
create policy crm_campaign_contacts_owner_admin_select
on public.crm_campaign_contacts for select
to authenticated
using ((select public.finance_role()) in ('OWNER','ADMIN'));

drop policy if exists crm_campaign_contacts_owner_admin_insert on public.crm_campaign_contacts;
create policy crm_campaign_contacts_owner_admin_insert
on public.crm_campaign_contacts for insert
to authenticated
with check ((select public.finance_role()) in ('OWNER','ADMIN'));

drop policy if exists crm_campaign_contacts_owner_admin_update on public.crm_campaign_contacts;
create policy crm_campaign_contacts_owner_admin_update
on public.crm_campaign_contacts for update
to authenticated
using ((select public.finance_role()) in ('OWNER','ADMIN'))
with check ((select public.finance_role()) in ('OWNER','ADMIN'));

insert into public.crm_campaigns (
  slug,name,channel,objective,status,starts_on,ends_on,description
)
values (
  'aceite-inyectores-oct-2026',
  'Cambio de aceite + limpieza de inyectores',
  'WHATSAPP',
  'CASH_FLOW',
  'ACTIVE',
  date '2026-10-06',
  date '2026-10-10',
  'Campaña manual de WhatsApp para reenganche y mantenimiento. La limpieza de inyectores se ofrece con la compra del aceite; aplican condiciones según el vehículo.'
)
on conflict (slug) do update set
  name=excluded.name,
  channel=excluded.channel,
  objective=excluded.objective,
  status=excluded.status,
  starts_on=excluded.starts_on,
  ends_on=excluded.ends_on,
  description=excluded.description,
  updated_at=now();
