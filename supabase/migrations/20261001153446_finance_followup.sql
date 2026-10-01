-- Work tracking is separate from reconciliation: notes never settle money.
alter table public.reconciliation_cases
 add column work_status text not null default 'READY' check(work_status in ('READY','NEEDS_INFO','WAITING')),
 add column assigned_to uuid references auth.users(id),
 add column review_on date,
 add column work_note text,
 add column work_version integer not null default 1;

create function public.finance_followup(p_id uuid,p_version integer,p_status text,p_assignee uuid,p_review_on date,p_note text)
returns void language plpgsql security definer set search_path='' as $$
declare c public.reconciliation_cases;
begin
 perform lubricenter_private.finance_require('ADMIN');
 select * into c from public.reconciliation_cases where id=p_id for update;
 if not found or c.status<>'OPEN' then raise exception 'Este pendiente ya cambió o fue resuelto; actualiza la lista'; end if;
 if p_version is distinct from c.work_version then raise exception 'Otra persona cambió el seguimiento; actualiza antes de guardar'; end if;
 if p_status is null or p_status not in ('READY','NEEDS_INFO','WAITING') then raise exception 'Selecciona un estado válido'; end if;
 if length(trim(coalesce(p_note,'')))<5 then raise exception 'Explica el siguiente paso con una nota'; end if;
 if p_status<>'READY' and (p_review_on is null or p_review_on<timezone('America/Caracas',now())::date) then raise exception 'Selecciona cuándo volverás a revisar este pendiente'; end if;
 if p_assignee is not null and not exists(select 1 from auth.users u left join public.finance_memberships m on m.user_id=u.id where u.id=p_assignee and (lower(u.email)='lubricenterc@gmail.com' or m.role='ADMIN')) then raise exception 'Asigna al dueño o a un administrador'; end if;
 update public.reconciliation_cases set work_status=p_status,assigned_to=p_assignee,review_on=p_review_on,work_note=trim(p_note),work_version=work_version+1,updated_at=now() where id=c.id;
end $$;

create function public.finance_tasks(p_state text default 'READY',p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 perform lubricenter_private.finance_require('ADMIN');
 if p_state is null or p_state not in ('READY','NEEDS_INFO','WAITING','RESOLVED') or p_offset is null or p_offset<0 then raise exception 'Filtro inválido'; end if;
 with tasks as (
  select c.*,case when c.status<>'OPEN' then 'RESOLVED' when c.work_status<>'READY' and c.review_on<=timezone('America/Caracas',now())::date then 'READY' else c.work_status end as task_state,
  coalesce(c.assigned_to,(select user_id from public.finance_memberships where role='ADMIN' order by user_id limit 1),(select id from auth.users where lower(email)='lubricenterc@gmail.com' limit 1)) as responsible,
  case when c.kind in ('SOURCE_CONFLICT','SOURCE_AMOUNT') then 1 when c.kind in ('COVERAGE','CASH_VARIANCE') then 2 else 3 end as priority
  from public.reconciliation_cases c
 ), page as(select * from tasks where task_state=p_state order by priority,review_on nulls last,created_at,id limit 20 offset p_offset)
 select jsonb_build_object('total',(select count(*) from tasks where task_state=p_state),
 'counts',coalesce((select jsonb_object_agg(state,n) from (select task_state as state,count(*) as n from tasks group by task_state)s),'{}'::jsonb),
 'rows',coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('responsible_email',u.email) order by p.priority,p.review_on nulls last,p.created_at,p.id) from page p left join auth.users u on u.id=p.responsible),'[]'::jsonb),
 'assignees',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'email',u.email) order by u.email),'[]'::jsonb) from auth.users u left join public.finance_memberships m on m.user_id=u.id where lower(u.email)='lubricenterc@gmail.com' or m.role='ADMIN')) into result;
 return result;
end $$;
revoke all on function public.finance_followup(uuid,integer,text,uuid,date,text),public.finance_tasks(text,integer) from public,anon;
grant execute on function public.finance_followup(uuid,integer,text,uuid,date,text),public.finance_tasks(text,integer) to authenticated;

-- Deferred work does not create daily notification noise before its review date.
create or replace function public.finance_push_digest(p_user uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare cash jsonb; reports jsonb; exceptions integer:=0; missing integer:=0; refunds integer; role text; previous_sub text; today_due integer:=0; sources_needed boolean:=false;
begin
 previous_sub:=current_setting('request.jwt.claim.sub',true);
 perform set_config('request.jwt.claim.sub',p_user::text,true);
 perform lubricenter_private.finance_require('OPERATOR');
 role:=lubricenter_private.finance_role(); cash:=lubricenter_private.finance_cash_due(0);
 if cash->>'status'='ACTIVE' and extract(hour from timezone('America/Caracas',now()))>=18 and not exists(select 1 from public.cash_closings where business_date=timezone('America/Caracas',now())::date and location_id=(select id from public.locations where active order by created_at limit 1) and status='CLOSED') then today_due:=1; end if;
 if role in ('OWNER','ADMIN') then
  select count(*) into exceptions from public.reconciliation_cases where status='OPEN' and (work_status='READY' or review_on<=timezone('America/Caracas',now())::date);
  reports:=public.finance_report_coverage((date_trunc('month',timezone('America/Caracas',now()))-interval '1 month')::date,(date_trunc('month',timezone('America/Caracas',now()))-interval '1 day')::date);
  select count(*) into missing from jsonb_array_elements(reports->'sources') s where s->>'status' not in ('COVERAGE_VERIFIED','SNAPSHOT_AVAILABLE');
  sources_needed:=jsonb_array_length(reports->'sources')=0;
 end if;
 select count(*) into refunds from public.order_tenders where change_usd>returned_usd;
 perform set_config('request.jwt.claim.sub',coalesce(previous_sub,''),true);
 return jsonb_build_object('cash',coalesce((cash->>'total')::integer,0)+today_due,'opening_needed',cash->>'status'<>'ACTIVE','exceptions',exceptions,'reports',missing,'sources_needed',sources_needed,'refunds',refunds,'role',role);
end $$;
