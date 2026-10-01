-- A settlement fixes the salary in reference USD; payment fixes its BCV conversion.
create table public.payroll_salary_payments (
 id uuid primary key default gen_random_uuid(),
 payroll_run_id uuid not null unique references public.payroll_runs(id) on delete restrict,
 account_id uuid not null references public.financial_accounts(id) on delete restrict,
 account_movement_id uuid not null unique references public.account_movements(id) on delete restrict,
 paid_on date not null,
 salary_ref numeric(18,2) not null check (salary_ref > 0),
 bcv_rate numeric(18,6) not null check (bcv_rate > 0),
 bcv_effective_at timestamptz not null,
 amount_ves numeric(18,2) not null check (amount_ves > 0),
 reference text,
 created_at timestamptz not null default now(),
 created_by uuid default auth.uid()
);
create index payroll_salary_payments_paid_on_idx on public.payroll_salary_payments(paid_on);
alter table public.payroll_salary_payments enable row level security;
create policy owner_read on public.payroll_salary_payments for select to authenticated using(lubricenter_private.is_order_admin());
grant select on public.payroll_salary_payments to authenticated;

create function lubricenter_private.payroll_record_salary_payment(p_run_id uuid,p_account_id uuid,p_paid_on date,p_reference text default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare r public.payroll_runs; a public.financial_accounts; v_rate public.exchange_rates; v_amount numeric(18,2); v_movement uuid; v_id uuid; v_name text;
begin
 perform lubricenter_private.require_order_admin();
 perform pg_advisory_xact_lock(220033);
 if p_paid_on is null or p_paid_on>timezone('America/Caracas',now())::date then raise exception 'Selecciona una fecha de pago válida'; end if;
 select * into r from public.payroll_runs where id=p_run_id for update;
 if not found or r.status<>'SETTLED' or r.payroll_version<>2 then raise exception 'Selecciona una liquidación vigente de nómina'; end if;
 if r.fixed_ref<=0 then raise exception 'Esta liquidación no tiene sueldo fijo por pagar'; end if;
 if exists(select 1 from public.payroll_salary_payments where payroll_run_id=p_run_id) then raise exception 'El sueldo fijo de esta liquidación ya fue registrado'; end if;
 select * into a from public.financial_accounts where id=p_account_id and active and currency='VES' and account_type in ('BANK','CASH') for update;
 if not found then raise exception 'Selecciona una cuenta activa en bolívares'; end if;
 if a.account_type='BANK' and length(regexp_replace(coalesce(p_reference,''),'\D','','g'))<4 then raise exception 'Indica al menos los últimos 4 dígitos de la referencia bancaria'; end if;
 select * into v_rate from public.exchange_rates where rate_type='BCV' and effective_at<((p_paid_on+1)::timestamp at time zone 'America/Caracas') order by effective_at desc limit 1;
 if not found or v_rate.value<=0 then raise exception 'No hay tasa BCV disponible para la fecha de pago'; end if;
 v_amount:=round(r.fixed_ref*v_rate.value,2);
 if v_amount<=0 then raise exception 'El sueldo convertido no puede ser cero'; end if;
 select name into v_name from public.employees where id=r.employee_id;
 insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,category,payee,note,reference,occurred_at,finance_nature)
 values(a.id,'OUT','EXPENSE','VES',v_amount,v_amount,'Sueldo fijo',v_name,'Nómina '||r.period_start||' al '||r.period_end,nullif(trim(p_reference),''),(p_paid_on::timestamp+time '12:00') at time zone 'America/Caracas','PAYROLL') returning id into v_movement;
 insert into public.payroll_salary_payments(payroll_run_id,account_id,account_movement_id,paid_on,salary_ref,bcv_rate,bcv_effective_at,amount_ves,reference)
 values(r.id,a.id,v_movement,p_paid_on,r.fixed_ref,v_rate.value,v_rate.effective_at,v_amount,nullif(trim(p_reference),'')) returning id into v_id;
 insert into public.audit_events(event_type,entity_type,entity_id,data) values('payroll.salary_paid','payroll_salary_payment',v_id,jsonb_build_object('run_id',r.id,'movement_id',v_movement,'paid_on',p_paid_on,'salary_ref',r.fixed_ref,'bcv_rate',v_rate.value,'bcv_rate_id',v_rate.id,'amount_ves',v_amount,'account_id',a.id,'actor',auth.uid()));
 return v_id;
end $$;
create function public.payroll_record_salary_payment(p_run_id uuid,p_account_id uuid,p_paid_on date,p_reference text default null)
returns uuid language sql security invoker set search_path='' as $$select lubricenter_private.payroll_record_salary_payment(p_run_id,p_account_id,p_paid_on,p_reference)$$;
revoke all on function lubricenter_private.payroll_record_salary_payment(uuid,uuid,date,text) from public,anon;
revoke all on function public.payroll_record_salary_payment(uuid,uuid,date,text) from public,anon;
grant execute on function public.payroll_record_salary_payment(uuid,uuid,date,text) to authenticated;
grant execute on function lubricenter_private.payroll_record_salary_payment(uuid,uuid,date,text) to authenticated;
