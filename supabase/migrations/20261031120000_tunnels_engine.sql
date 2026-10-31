-- Modo túnel: motor genérico (Cabudare).
-- A tunnel guides one decision at a time over the same data the manual views use. This layer
-- stores sessions, every decision (with what is needed to revert it), learned rules and an
-- audit row per AI call. Process-specific effects run through registered handlers: each
-- action type maps to an apply function (payload jsonb -> revert jsonb) and a revert
-- function (revert jsonb -> void), both in lubricenter_private. Applying a decision and
-- recording it happen in one transaction; so does reverting it.
-- Additive: new tables, functions and permission catalog rows only.

create table if not exists public.tunnel_sessions(
 id uuid primary key default gen_random_uuid(),
 tunnel_key text not null check (tunnel_key ~ '^[a-z][a-z0-9_]{1,39}$'),
 location_id uuid references public.locations(id),
 started_by uuid not null default auth.uid(),
 attendant text check (attendant is null or length(btrim(attendant)) between 1 and 60),
 started_at timestamptz not null default now(),
 finished_at timestamptz,
 status text not null default 'OPEN' check (status in ('OPEN','CLOSED','ABANDONED')),
 case_count integer not null default 0 check (case_count between 0 and 100000),
 balance_snapshot jsonb,
 close_note text check (close_note is null or length(close_note)<=2000),
 updated_at timestamptz not null default now()
);
create unique index if not exists tunnel_sessions_one_open on public.tunnel_sessions(tunnel_key,started_by) where status='OPEN';
create index if not exists tunnel_sessions_key_finished on public.tunnel_sessions(tunnel_key,finished_at desc);

create table if not exists public.tunnel_decisions(
 id uuid primary key default gen_random_uuid(),
 session_id uuid not null references public.tunnel_sessions(id) on delete cascade,
 case_id text not null check (length(case_id) between 1 and 200),
 case_snapshot jsonb not null default '{}'::jsonb,
 answer text not null check (answer in ('YES','NO','OPTION','INPUT','SKIP')),
 action jsonb,
 revert jsonb,
 user_explanation text check (user_explanation is null or length(user_explanation)<=8000),
 ai_proposal jsonb,
 rule_created_id uuid,
 applied_at timestamptz,
 undone_at timestamptz,
 undone_by uuid,
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index if not exists tunnel_decisions_live_case on public.tunnel_decisions(session_id,case_id) where undone_at is null;
create index if not exists tunnel_decisions_session on public.tunnel_decisions(session_id,created_at);

create table if not exists public.tunnel_rules(
 id uuid primary key default gen_random_uuid(),
 tunnel_key text not null check (tunnel_key ~ '^[a-z][a-z0-9_]{1,39}$'),
 condition jsonb not null check (jsonb_typeof(condition->'all')='array' and jsonb_array_length(condition->'all') between 1 and 10),
 outcome jsonb not null check (jsonb_typeof(outcome->'action')='object' and coalesce(outcome->'action'->>'type','')<>''),
 description text not null check (length(btrim(description)) between 3 and 2000),
 source_decision_id uuid references public.tunnel_decisions(id) on delete set null,
 status text not null default 'ACTIVE' check (status in ('ACTIVE','DISABLED','PENDING_APPROVAL')),
 created_by uuid not null default auth.uid(),
 times_used integer not null default 0 check (times_used>=0),
 last_used_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists tunnel_rules_key_status on public.tunnel_rules(tunnel_key,status);
do $$ begin
 if not exists(select 1 from pg_constraint where conname='tunnel_decisions_rule_created_fk') then
  alter table public.tunnel_decisions add constraint tunnel_decisions_rule_created_fk foreign key (rule_created_id) references public.tunnel_rules(id) on delete set null;
 end if;
end $$;

-- One row per AI call. Never stores keys or access tokens.
create table if not exists public.tunnel_ai_runs(
 id uuid primary key default gen_random_uuid(),
 decision_id uuid references public.tunnel_decisions(id) on delete set null,
 tunnel_key text not null,
 model text not null check (length(model) between 1 and 100),
 prompt_tokens integer check (prompt_tokens is null or prompt_tokens>=0),
 completion_tokens integer check (completion_tokens is null or completion_tokens>=0),
 tools_called jsonb not null default '[]'::jsonb,
 result jsonb,
 error text check (error is null or length(error)<=2000),
 created_by uuid not null default auth.uid(),
 created_at timestamptz not null default now()
);
create index if not exists tunnel_ai_runs_decision on public.tunnel_ai_runs(decision_id);

-- Prepared for later: when someone other than the owner concilia, new rules wait for approval.
create table if not exists public.tunnel_settings(
 tunnel_key text primary key check (tunnel_key ~ '^[a-z][a-z0-9_]{1,39}$'),
 rules_require_approval boolean not null default false,
 updated_at timestamptz not null default now()
);

-- Registry of reversible actions. Not exposed through the API.
create table if not exists lubricenter_private.tunnel_action_handlers(
 action_type text primary key check (action_type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
 tunnel_key text not null check (tunnel_key ~ '^[a-z][a-z0-9_]{1,39}$'),
 apply_fn regproc not null,
 revert_fn regproc not null,
 permission text,
 created_at timestamptz not null default now()
);
revoke all on lubricenter_private.tunnel_action_handlers from public,anon,authenticated;

insert into public.staff_permission_catalog(key,area,label,explanation,recommended,sort_order) values
 ('tunnels.use','Túneles','Usar túneles','Resolver procesos una decisión a la vez',false,60),
 ('tunnels.rules.manage','Túneles','Administrar reglas aprendidas','Ver, editar, desactivar y borrar reglas aprendidas',false,61),
 ('tunnels.cashea','Túneles','Túnel de conciliación Cashea','Cuadrar el BNC de Cashea por sucursal desde el túnel',false,62)
on conflict (key) do nothing;

do $$ declare t text; begin
 foreach t in array array['tunnel_sessions','tunnel_decisions','tunnel_rules','tunnel_ai_runs','tunnel_settings'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
  execute format('drop policy if exists tunnel_read on public.%I',t);
  execute format('create policy tunnel_read on public.%I for select to authenticated using ((select lubricenter_private.staff_can(''tunnels.use'')))',t);
  execute format('drop policy if exists staff_identity_gate on public.%I',t);
  execute format('create policy staff_identity_gate on public.%I as restrictive for all to authenticated using ((select lubricenter_private.staff_identity_allowed()))',t);
 end loop;
 execute 'drop trigger if exists finance_audit on public.tunnel_rules';
 execute 'create trigger finance_audit after insert or update or delete on public.tunnel_rules for each row execute function lubricenter_private.finance_audit()';
end $$;

create or replace function lubricenter_private.tunnel_require(p_key text default null)
returns void language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not lubricenter_private.staff_can('tunnels.use') then
  raise exception 'No tienes permiso para usar los túneles';
 end if;
 if p_key is not null and not lubricenter_private.staff_can('tunnels.'||p_key) then
  raise exception 'No tienes permiso para este túnel';
 end if;
end $$;

-- Locks the caller's open session of a tunnel and returns it.
create or replace function lubricenter_private.tunnel_lock_session(p_session uuid)
returns public.tunnel_sessions language plpgsql security definer set search_path='' as $$
declare v public.tunnel_sessions;
begin
 select * into v from public.tunnel_sessions where id=p_session for update;
 if not found then raise exception 'Sesión de túnel no encontrada'; end if;
 perform lubricenter_private.tunnel_require(v.tunnel_key);
 if v.started_by<>auth.uid() then raise exception 'Esta sesión la abrió otra persona'; end if;
 if v.status<>'OPEN' then raise exception 'Esta sesión ya está cerrada'; end if;
 return v;
end $$;

-- Runs one action (or a batch of actions) and returns what is needed to revert it.
create or replace function lubricenter_private.tunnel_apply_action(p_key text,p_action jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_type text:=p_action->>'type'; v_payload jsonb:=coalesce(p_action->'payload','{}'::jsonb);
 h lubricenter_private.tunnel_action_handlers; v_item jsonb; v_reverts jsonb:='[]'::jsonb; v_revert jsonb;
begin
 if jsonb_typeof(p_action)<>'object' or coalesce(v_type,'')='' then raise exception 'Acción inválida'; end if;
 if jsonb_typeof(v_payload)<>'object' then raise exception 'Datos de la acción inválidos'; end if;
 if v_type='tunnel.batch' then
  if jsonb_typeof(v_payload->'items')<>'array' or jsonb_array_length(v_payload->'items') not between 1 and 500 then raise exception 'Lote vacío o demasiado grande'; end if;
  for v_item in select value from jsonb_array_elements(v_payload->'items') loop
   if v_item->'action'->>'type'='tunnel.batch' then raise exception 'Un lote no puede contener otro lote'; end if;
   v_revert:=lubricenter_private.tunnel_apply_action(p_key,v_item->'action');
   v_reverts:=v_reverts||jsonb_build_array(jsonb_build_object('case_id',v_item->>'case_id','action',v_item->'action','revert',v_revert));
  end loop;
  return jsonb_build_object('items',v_reverts);
 end if;
 select * into h from lubricenter_private.tunnel_action_handlers where action_type=v_type and tunnel_key=p_key;
 if not found then raise exception 'Acción no permitida en este túnel: %',v_type; end if;
 if h.permission is not null and not lubricenter_private.staff_can(h.permission) then raise exception 'No tienes permiso para esta acción'; end if;
 execute format('select %s($1)',h.apply_fn) into v_revert using v_payload;
 return coalesce(v_revert,'{}'::jsonb);
end $$;

create or replace function lubricenter_private.tunnel_revert_action(p_key text,p_action jsonb,p_revert jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_type text:=p_action->>'type'; h lubricenter_private.tunnel_action_handlers; v_item jsonb;
begin
 if v_type='tunnel.batch' then
  -- Last applied first.
  for v_item in select value from jsonb_array_elements(coalesce(p_revert->'items','[]'::jsonb)) with ordinality e(value,n) order by n desc loop
   perform lubricenter_private.tunnel_revert_action(p_key,v_item->'action',v_item->'revert');
  end loop;
  return;
 end if;
 select * into h from lubricenter_private.tunnel_action_handlers where action_type=v_type and tunnel_key=p_key;
 if not found then raise exception 'No sé cómo deshacer la acción %',v_type; end if;
 if h.permission is not null and not lubricenter_private.staff_can(h.permission) then raise exception 'No tienes permiso para esta acción'; end if;
 execute format('select %s($1)',h.revert_fn) using coalesce(p_revert,'{}'::jsonb);
end $$;

create or replace function lubricenter_private.tunnel_open_session(p_key text,p_attendant text,p_case_count integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.tunnel_sessions;
begin
 perform lubricenter_private.tunnel_require(p_key);
 select * into v from public.tunnel_sessions where tunnel_key=p_key and started_by=auth.uid() and status='OPEN' for update;
 if not found then
  insert into public.tunnel_sessions(tunnel_key,location_id,attendant,case_count)
  values(p_key,(select id from public.locations where active order by created_at limit 1),nullif(btrim(coalesce(p_attendant,'')),''),greatest(coalesce(p_case_count,0),0))
  returning * into v;
 else
  update public.tunnel_sessions set case_count=greatest(case_count,coalesce(p_case_count,0)),
   attendant=coalesce(nullif(btrim(coalesce(p_attendant,'')),''),attendant),updated_at=now()
  where id=v.id returning * into v;
 end if;
 return jsonb_build_object('session',to_jsonb(v),'decisions',coalesce((
  select jsonb_agg(to_jsonb(d) order by d.created_at) from public.tunnel_decisions d where d.session_id=v.id and d.undone_at is null),'[]'::jsonb));
end $$;

-- Records one answer. YES/OPTION/INPUT apply the action in the same transaction. p_from_decision
-- turns an earlier "NO" (explained to the AI) into the final answer, keeping the explanation.
create or replace function lubricenter_private.tunnel_decide(p_session uuid,p_case_id text,p_case_snapshot jsonb,p_answer text,p_action jsonb,p_explanation text,p_from_decision uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.tunnel_sessions; d public.tunnel_decisions; v_revert jsonb; v_rule text;
begin
 s:=lubricenter_private.tunnel_lock_session(p_session);
 if coalesce(btrim(p_case_id),'')='' then raise exception 'Caso inválido'; end if;
 if p_answer not in ('YES','NO','OPTION','INPUT','SKIP') then raise exception 'Respuesta inválida'; end if;
 if p_answer in ('YES','OPTION','INPUT') and p_action is null then raise exception 'Falta la acción a aplicar'; end if;
 if p_answer in ('NO','SKIP') and p_action is not null then raise exception 'Esta respuesta no aplica cambios'; end if;
 if p_from_decision is not null then
  select * into d from public.tunnel_decisions where id=p_from_decision and session_id=s.id for update;
  if not found or d.undone_at is not null or d.answer<>'NO' or d.case_id<>p_case_id then raise exception 'La explicación previa ya no está disponible'; end if;
 elsif exists(select 1 from public.tunnel_decisions where session_id=s.id and case_id=p_case_id and undone_at is null) then
  raise exception 'Este caso ya tiene una respuesta. Deshazla para cambiarla';
 end if;
 if p_action is not null then v_revert:=lubricenter_private.tunnel_apply_action(s.tunnel_key,p_action); end if;
 if d.id is null then
  insert into public.tunnel_decisions(session_id,case_id,case_snapshot,answer,action,revert,user_explanation,applied_at)
  values(s.id,btrim(p_case_id),coalesce(p_case_snapshot,'{}'::jsonb),p_answer,p_action,v_revert,nullif(btrim(coalesce(p_explanation,'')),''),case when p_action is not null then now() end)
  returning * into d;
 else
  update public.tunnel_decisions set answer=p_answer,action=p_action,revert=v_revert,
   user_explanation=coalesce(nullif(btrim(coalesce(p_explanation,'')),''),user_explanation),
   applied_at=case when p_action is not null then now() end,updated_at=now()
  where id=d.id returning * into d;
 end if;
 if p_answer in ('YES','OPTION','INPUT') and jsonb_typeof(p_case_snapshot->'ruleIds')='array' then
  for v_rule in select value from jsonb_array_elements_text(p_case_snapshot->'ruleIds') loop
   if v_rule ~ '^[0-9a-f-]{36}$' then
    update public.tunnel_rules set times_used=times_used+1,last_used_at=now() where id=v_rule::uuid and tunnel_key=s.tunnel_key;
   end if;
  end loop;
 end if;
 update public.tunnel_sessions set updated_at=now() where id=s.id;
 return to_jsonb(d);
end $$;

create or replace function lubricenter_private.tunnel_undo(p_decision uuid)
returns void language plpgsql security definer set search_path='' as $$
declare d public.tunnel_decisions; s public.tunnel_sessions;
begin
 select * into d from public.tunnel_decisions where id=p_decision for update;
 if not found then raise exception 'Decisión no encontrada'; end if;
 s:=lubricenter_private.tunnel_lock_session(d.session_id);
 if d.undone_at is not null then raise exception 'Esta decisión ya se deshizo'; end if;
 if d.action is not null then perform lubricenter_private.tunnel_revert_action(s.tunnel_key,d.action,d.revert); end if;
 update public.tunnel_decisions set undone_at=now(),undone_by=auth.uid(),updated_at=now() where id=d.id;
 update public.tunnel_sessions set updated_at=now() where id=s.id;
end $$;

-- Stores the person's explanation as a "NO" before asking the AI.
create or replace function lubricenter_private.tunnel_explain(p_session uuid,p_case_id text,p_case_snapshot jsonb,p_explanation text,p_decision uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare s public.tunnel_sessions; d public.tunnel_decisions; v_text text:=btrim(coalesce(p_explanation,''));
begin
 s:=lubricenter_private.tunnel_lock_session(p_session);
 if length(v_text) not between 3 and 4000 then raise exception 'Explica en una o dos frases qué pasa'; end if;
 if p_decision is not null then
  select * into d from public.tunnel_decisions where id=p_decision and session_id=s.id and undone_at is null and answer='NO' for update;
  if not found then raise exception 'La explicación previa ya no está disponible'; end if;
  update public.tunnel_decisions set user_explanation=left(coalesce(user_explanation||E'\n---\n','')||v_text,8000),updated_at=now() where id=d.id;
  return d.id;
 end if;
 if exists(select 1 from public.tunnel_decisions where session_id=s.id and case_id=p_case_id and undone_at is null) then
  raise exception 'Este caso ya tiene una respuesta. Deshazla para cambiarla';
 end if;
 insert into public.tunnel_decisions(session_id,case_id,case_snapshot,answer,user_explanation)
 values(s.id,btrim(p_case_id),coalesce(p_case_snapshot,'{}'::jsonb),'NO',v_text) returning * into d;
 return d.id;
end $$;

create or replace function lubricenter_private.tunnel_record_ai(p_decision uuid,p_model text,p_prompt_tokens integer,p_completion_tokens integer,p_tools jsonb,p_result jsonb,p_error text)
returns uuid language plpgsql security definer set search_path='' as $$
declare d public.tunnel_decisions; s public.tunnel_sessions; v_id uuid;
begin
 select * into d from public.tunnel_decisions where id=p_decision;
 if not found then raise exception 'Decisión no encontrada'; end if;
 select * into s from public.tunnel_sessions where id=d.session_id;
 perform lubricenter_private.tunnel_require(s.tunnel_key);
 if s.started_by<>auth.uid() then raise exception 'Esta sesión la abrió otra persona'; end if;
 insert into public.tunnel_ai_runs(decision_id,tunnel_key,model,prompt_tokens,completion_tokens,tools_called,result,error)
 values(d.id,s.tunnel_key,left(coalesce(p_model,'desconocido'),100),p_prompt_tokens,p_completion_tokens,coalesce(p_tools,'[]'::jsonb),p_result,left(p_error,2000))
 returning id into v_id;
 if p_error is null and d.undone_at is null and d.answer='NO' then
  update public.tunnel_decisions set ai_proposal=p_result,updated_at=now() where id=d.id;
 end if;
 return v_id;
end $$;

create or replace function lubricenter_private.tunnel_close_session(p_session uuid,p_status text,p_balance jsonb,p_note text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.tunnel_sessions;
begin
 s:=lubricenter_private.tunnel_lock_session(p_session);
 if p_status not in ('CLOSED','ABANDONED') then raise exception 'Estado inválido'; end if;
 if p_status='CLOSED' and coalesce(p_balance->>'ok','false')<>'true' and length(btrim(coalesce(p_note,'')))<5 then
  raise exception 'El cuadre no da. Explica la diferencia antes de cerrar';
 end if;
 update public.tunnel_sessions set status=p_status,finished_at=now(),balance_snapshot=p_balance,
  close_note=nullif(btrim(coalesce(p_note,'')),''),updated_at=now()
 where id=s.id returning * into s;
 return to_jsonb(s);
end $$;

create or replace function lubricenter_private.tunnel_rule_status_for_new(p_key text)
returns text language sql stable security definer set search_path='' as $$
 select case
  when not lubricenter_private.staff_can('tunnels.rules.manage') then 'PENDING_APPROVAL'
  when coalesce((select rules_require_approval from public.tunnel_settings where tunnel_key=p_key),false) and not lubricenter_private.staff_owner() then 'PENDING_APPROVAL'
  else 'ACTIVE' end
$$;

create or replace function lubricenter_private.tunnel_create_rule(p_key text,p_condition jsonb,p_outcome jsonb,p_description text,p_source_decision uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.tunnel_rules;
begin
 perform lubricenter_private.tunnel_require(p_key);
 if not exists(select 1 from lubricenter_private.tunnel_action_handlers where tunnel_key=p_key and action_type=p_outcome->'action'->>'type') then
  raise exception 'La regla propone una acción que este túnel no tiene';
 end if;
 if p_source_decision is not null and not exists(
  select 1 from public.tunnel_decisions d join public.tunnel_sessions s on s.id=d.session_id
  where d.id=p_source_decision and s.tunnel_key=p_key and s.started_by=auth.uid()) then
  raise exception 'Decisión de origen inválida';
 end if;
 insert into public.tunnel_rules(tunnel_key,condition,outcome,description,source_decision_id,status)
 values(p_key,p_condition,p_outcome,btrim(p_description),p_source_decision,lubricenter_private.tunnel_rule_status_for_new(p_key))
 returning * into r;
 if p_source_decision is not null then
  update public.tunnel_decisions set rule_created_id=r.id,updated_at=now() where id=p_source_decision;
 end if;
 return to_jsonb(r);
end $$;

create or replace function lubricenter_private.tunnel_update_rule(p_id uuid,p_description text,p_condition jsonb,p_outcome jsonb,p_status text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.tunnel_rules;
begin
 select * into r from public.tunnel_rules where id=p_id for update;
 if not found then raise exception 'Regla no encontrada'; end if;
 perform lubricenter_private.tunnel_require(r.tunnel_key);
 if not lubricenter_private.staff_can('tunnels.rules.manage') then raise exception 'No tienes permiso para administrar reglas'; end if;
 if p_status is not null and p_status not in ('ACTIVE','DISABLED','PENDING_APPROVAL') then raise exception 'Estado inválido'; end if;
 if p_status='ACTIVE' and r.status='PENDING_APPROVAL' and coalesce((select rules_require_approval from public.tunnel_settings where tunnel_key=r.tunnel_key),false)
  and not lubricenter_private.staff_owner() then raise exception 'Solo el dueño aprueba reglas'; end if;
 if p_outcome is not null and not exists(select 1 from lubricenter_private.tunnel_action_handlers where tunnel_key=r.tunnel_key and action_type=p_outcome->'action'->>'type') then
  raise exception 'La regla propone una acción que este túnel no tiene';
 end if;
 update public.tunnel_rules set description=coalesce(nullif(btrim(coalesce(p_description,'')),''),description),
  condition=coalesce(p_condition,condition),outcome=coalesce(p_outcome,outcome),status=coalesce(p_status,status),updated_at=now()
 where id=r.id returning * into r;
 return to_jsonb(r);
end $$;

create or replace function lubricenter_private.tunnel_delete_rule(p_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.tunnel_rules;
begin
 select * into r from public.tunnel_rules where id=p_id for update;
 if not found then raise exception 'Regla no encontrada'; end if;
 perform lubricenter_private.tunnel_require(r.tunnel_key);
 if not lubricenter_private.staff_can('tunnels.rules.manage') then raise exception 'No tienes permiso para administrar reglas'; end if;
 delete from public.tunnel_rules where id=r.id;
end $$;

-- What the "Túneles pendientes" list needs besides the process counts.
create or replace function lubricenter_private.tunnel_overview()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform lubricenter_private.tunnel_require();
 return jsonb_build_object(
  'open',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'tunnel_key',s.tunnel_key,'started_at',s.started_at,
    'decisions',(select count(*) from public.tunnel_decisions d where d.session_id=s.id and d.undone_at is null)))
   from public.tunnel_sessions s where s.status='OPEN' and s.started_by=auth.uid()),'[]'::jsonb),
  'last_closed',coalesce((select jsonb_agg(x) from (
    select distinct on (s.tunnel_key) jsonb_build_object('tunnel_key',s.tunnel_key,'finished_at',s.finished_at,'balance',s.balance_snapshot) x
    from public.tunnel_sessions s where s.status='CLOSED' order by s.tunnel_key,s.finished_at desc) q),'[]'::jsonb),
  'rules',coalesce((select jsonb_object_agg(k,n) from (select tunnel_key k,count(*) n from public.tunnel_rules where status='ACTIVE' group by 1) q),'{}'::jsonb));
end $$;

create or replace function public.tunnel_open_session(p_key text,p_attendant text default null,p_case_count integer default 0) returns jsonb language sql set search_path='' as $$ select lubricenter_private.tunnel_open_session(p_key,p_attendant,p_case_count) $$;
create or replace function public.tunnel_decide(p_session uuid,p_case_id text,p_case_snapshot jsonb,p_answer text,p_action jsonb default null,p_explanation text default null,p_from_decision uuid default null) returns jsonb language sql set search_path='' as $$ select lubricenter_private.tunnel_decide(p_session,p_case_id,p_case_snapshot,p_answer,p_action,p_explanation,p_from_decision) $$;
create or replace function public.tunnel_undo(p_decision uuid) returns void language sql set search_path='' as $$ select lubricenter_private.tunnel_undo(p_decision) $$;
create or replace function public.tunnel_explain(p_session uuid,p_case_id text,p_case_snapshot jsonb,p_explanation text,p_decision uuid default null) returns uuid language sql set search_path='' as $$ select lubricenter_private.tunnel_explain(p_session,p_case_id,p_case_snapshot,p_explanation,p_decision) $$;
create or replace function public.tunnel_record_ai(p_decision uuid,p_model text,p_prompt_tokens integer,p_completion_tokens integer,p_tools jsonb,p_result jsonb,p_error text) returns uuid language sql set search_path='' as $$ select lubricenter_private.tunnel_record_ai(p_decision,p_model,p_prompt_tokens,p_completion_tokens,p_tools,p_result,p_error) $$;
create or replace function public.tunnel_close_session(p_session uuid,p_status text,p_balance jsonb,p_note text default null) returns jsonb language sql set search_path='' as $$ select lubricenter_private.tunnel_close_session(p_session,p_status,p_balance,p_note) $$;
create or replace function public.tunnel_create_rule(p_key text,p_condition jsonb,p_outcome jsonb,p_description text,p_source_decision uuid default null) returns jsonb language sql set search_path='' as $$ select lubricenter_private.tunnel_create_rule(p_key,p_condition,p_outcome,p_description,p_source_decision) $$;
create or replace function public.tunnel_update_rule(p_id uuid,p_description text default null,p_condition jsonb default null,p_outcome jsonb default null,p_status text default null) returns jsonb language sql set search_path='' as $$ select lubricenter_private.tunnel_update_rule(p_id,p_description,p_condition,p_outcome,p_status) $$;
create or replace function public.tunnel_delete_rule(p_id uuid) returns void language sql set search_path='' as $$ select lubricenter_private.tunnel_delete_rule(p_id) $$;
create or replace function public.tunnel_overview() returns jsonb language sql stable set search_path='' as $$ select lubricenter_private.tunnel_overview() $$;

do $$ declare f text; begin
 foreach f in array array[
  'tunnel_require(text)','tunnel_lock_session(uuid)','tunnel_apply_action(text,jsonb)','tunnel_revert_action(text,jsonb,jsonb)',
  'tunnel_rule_status_for_new(text)'] loop
  execute format('revoke all on function lubricenter_private.%s from public,anon,authenticated',f);
 end loop;
 foreach f in array array[
  'tunnel_open_session(text,text,integer)','tunnel_decide(uuid,text,jsonb,text,jsonb,text,uuid)','tunnel_undo(uuid)',
  'tunnel_explain(uuid,text,jsonb,text,uuid)','tunnel_record_ai(uuid,text,integer,integer,jsonb,jsonb,text)',
  'tunnel_close_session(uuid,text,jsonb,text)','tunnel_create_rule(text,jsonb,jsonb,text,uuid)',
  'tunnel_update_rule(uuid,text,jsonb,jsonb,text)','tunnel_delete_rule(uuid)','tunnel_overview()'] loop
  execute format('revoke all on function lubricenter_private.%s from public,anon,authenticated',f);
  execute format('grant execute on function lubricenter_private.%s to authenticated',f);
  execute format('revoke all on function public.%s from public,anon',f);
  execute format('grant execute on function public.%s to authenticated',f);
 end loop;
end $$;
