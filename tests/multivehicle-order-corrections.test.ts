import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
const migration=(name:string)=>readFileSync("supabase/migrations/"+name,"utf8");
const C1="33333333-3333-4333-8333-333333333333";
const C2="44444444-4444-4444-8444-444444444444";
const V1="11111111-1111-4111-8111-111111111111";
const V2="22222222-2222-4222-8222-222222222222";
const O1="55555555-5555-4555-8555-555555555555";
const O2="66666666-6666-4666-8666-666666666666";

async function dbSetup(){
 const db=new PGlite();
 await db.exec([
  "create role anon;create role authenticated;create schema auth;create schema lubricenter_private;",
  "create function auth.uid() returns uuid language sql stable as $$select case when current_setting('app.test_identity',true)='OWNER' then '"+C1+"'::uuid else null::uuid end$$;",
  "create function public.require_auth() returns void language plpgsql as $$begin if auth.uid() is null then raise exception 'Not authenticated';end if;end$$;",
  "create function lubricenter_private.require_order_admin() returns void language plpgsql as $$begin if auth.uid() is null then raise exception 'No es administrador';end if;end$$;",
  "create table public.customers(id uuid primary key,name text);",
  "create table public.inventory_items(id uuid primary key,sku text,brand text,description text,active boolean,quantity_on_hand numeric);",
  "create table public.products(id uuid primary key,name text,available boolean,active boolean);",
  "create table public.vehicles(id uuid primary key,customer_id uuid references public.customers(id),plate text,make text,model text,current_odometer integer,updated_at timestamptz default now());",
  "create table public.orders(id uuid primary key,order_number text,status text not null,customer_id uuid references public.customers(id),vehicle_id uuid references public.vehicles(id),is_walk_in boolean not null default false,closed_at timestamptz,created_at timestamptz default now(),created_by uuid,total_ref numeric default 0,total_ves numeric default 0);",
  "create table public.order_items(id uuid primary key default gen_random_uuid(),order_id uuid references public.orders(id),item_type text,business_area text,description text,quantity numeric default 1,pricing_mode text default 'STANDARD',base_ref_amount numeric,customer_ref_amount numeric,charged_ves_amount numeric,charged_ref_amount numeric,bcv_rate_snapshot numeric,operative_rate_snapshot numeric,service_odometer integer,oil_brand text,oil_viscosity text,oil_quantity_liters numeric,oil_filter_code text,next_service_odometer integer,next_service_date date,created_at timestamptz default now());",
  "create table public.service_records(id uuid primary key default gen_random_uuid(),order_id uuid,order_item_id uuid unique,customer_id uuid,vehicle_id uuid not null,service_type text,description text,odometer integer,oil_brand text,oil_viscosity text,oil_quantity_liters numeric,oil_filter_code text,next_service_odometer integer,next_service_date date,charged_ref_amount numeric,charged_ves_amount numeric,performed_at timestamptz default now(),created_by uuid);",
  "create table public.customer_followups(id uuid primary key default gen_random_uuid(),order_id uuid not null,customer_id uuid,vehicle_id uuid,followup_type text not null default 'POST_SERVICE',channel text default 'WHATSAPP',status text default 'PENDING',message text not null,sent_at timestamptz,snoozed_until date,created_at timestamptz default now(),updated_at timestamptz default now(),unique(order_id,followup_type));",
  "create table public.integration_events(id uuid primary key default gen_random_uuid(),event_type text,aggregate_type text,aggregate_id uuid,payload jsonb,created_at timestamptz default now());",
  "create table public.audit_events(id uuid primary key default gen_random_uuid(),event_type text,entity_type text,entity_id uuid,actor_id uuid,data jsonb,created_at timestamptz default now());",
  "create table public.payments(id uuid primary key default gen_random_uuid(),order_id uuid,amount_original numeric,reference text);",
  "create table public.cashea_sales(id uuid primary key default gen_random_uuid(),order_id uuid,cashea_reference text,gross_ref numeric,status text);",
  "create table public.inventory_movements(id uuid primary key default gen_random_uuid(),order_item_id uuid,quantity_delta numeric);",
  "create table public.app_settings(key text primary key,value jsonb);",
  "create view public.current_exchange_rates as select 100::numeric bcv_rate,125::numeric operative_rate;",
  "create function public.round_to_step(v numeric,s numeric,m text) returns numeric language sql immutable as $$select v$$;",
  "create function public.assert_order_open(p_order_id uuid) returns void language plpgsql as $$begin if not exists(select 1 from public.orders where id=p_order_id and status='OPEN') then raise exception 'Orden no abierta';end if;end$$;",
  "create function public.build_post_service_message(p_order_id uuid) returns text language sql as $$select 'Historial de mantenimiento ('||p_order_id||')'$$;",
  "create function public.add_manual_product_item(p_order_id uuid,p_description text,p_quantity numeric,p_unit_ref numeric) returns uuid language plpgsql as $$declare r uuid;begin insert into public.order_items(order_id,item_type,business_area,description,quantity,charged_ref_amount,charged_ves_amount,base_ref_amount,customer_ref_amount,bcv_rate_snapshot,operative_rate_snapshot) values(p_order_id,'PRODUCT','STORE',p_description,p_quantity,p_quantity*p_unit_ref,p_quantity*p_unit_ref*100,p_quantity*p_unit_ref,p_quantity*p_unit_ref,100,125) returning id into r;return r;end$$;",
  "set app.test_identity='OWNER';"
 ].join("\n"));
 for(const name of ["20261014163000_multivehicle_oil_package.sql",
 "20261014163500_multivehicle_crm.sql",
 "20261014164000_closed_order_oil_service_correction.sql"])await db.exec(migration(name));
 await db.exec([
  "create trigger trg_capture_service_records_on_close after update on public.orders for each row execute function public.capture_service_records_on_close();",
  "create trigger trg_queue_post_service_followup after update on public.orders for each row execute function public.queue_post_service_followup();"
 ].join("\n"));
 await db.query("insert into public.customers(id,name) values($1,'Cliente pagador'),($2,'Dueño de otro carro')",[C1,C2]);
 await db.query("insert into public.vehicles(id,customer_id,plate,make,model,current_odometer) values($1,$2,'ABC123','Renault','Clio',10000),($3,$4,'DEF456','Chevrolet','Optra',20000)",[V1,C1,V2,C2]);
 await db.query("insert into public.orders(id,order_number,status,customer_id,vehicle_id) values($1,'OS-MULTI','OPEN',$2,$3),($4,'OS-CORRECTION','OPEN',$2,$3)",[O1,C1,V1,O2]);
 return db;
}
const addPackage="select public.add_oil_change_package_for_vehicle($1::uuid,$2::integer,$3::text,$4::numeric,$5::numeric,$6::text,$7::uuid,$8::uuid,$9::text,$10::numeric,$11::numeric,$12::text,$13::text,$14::numeric,$15::text,$16::uuid,$17::uuid,$18::text,$19::numeric,$20::numeric,$21::text,$22::integer,$23::integer,$24::uuid)";
const packageArgs=(order:string,car:string,km:number,oil:string)=>[
 order,km,"Cambio de aceite",0,0,"MANUAL",null,null,oil,4,10,oil,"15W-40",4,"NONE",null,null,null,1,null,null,5000,3,car
];
const correct="select public.correct_closed_oil_service($1::uuid,$2::uuid,$3::uuid,$4::integer,$5::text,$6::text,$7::numeric,$8::text,$9::integer,$10::date,$11::text) response";
describe("One Cashea order, two vehicles, two independent CRMs",()=>{
 it("keeps a single payment and creates separate history and messages per car owner",async()=>{
  const db=await dbSetup();try{
   await db.query(addPackage,packageArgs(O1,V1,10100,"Aceite Clio"));
   await db.query(addPackage,packageArgs(O1,V2,20100,"Aceite Optra"));
   const lines=await db.query<{item_type:string;service_vehicle_id:string}>("select item_type,service_vehicle_id from public.order_items where order_id=$1",[O1]);
   expect(lines.rows).toHaveLength(4);
   expect(new Set(lines.rows.map(x=>x.service_vehicle_id))).toEqual(new Set([V1,V2]));
   await db.query("insert into public.cashea_sales(order_id,cashea_reference,gross_ref,status) values($1,'230210768',80,'ACTIVE')",[O1]);
   await db.query("insert into public.payments(order_id,amount_original,reference) values($1,4000,'8368')",[O1]);
   await db.query("update public.orders set status='CLOSED',closed_at=now(),total_ref=80,total_ves=8000 where id=$1",[O1]);
   const history=await db.query<{vehicle_id:string;customer_id:string}>("select vehicle_id,customer_id from public.service_records where order_id=$1",[O1]);
   expect(history.rows).toHaveLength(2);
   expect(history.rows.find(x=>x.vehicle_id===V2)?.customer_id).toBe(C2);
   const crm=await db.query<{vehicle_id:string;customer_id:string;message:string}>("select vehicle_id,customer_id,message from public.customer_followups where order_id=$1",[O1]);
   expect(crm.rows).toHaveLength(2);
   const second=crm.rows.find(x=>x.vehicle_id===V2);
   expect(second?.customer_id).toBe(C2);
   expect(second?.message).toContain("Aceite Optra");
   expect(second?.message).not.toContain("Aceite Clio");
   const checks=await db.query<{n:number}>("select (select count(*)::int from public.cashea_sales where order_id=$1)+(select count(*)::int from public.payments where order_id=$1) n",[O1]);
   expect(checks.rows[0].n).toBe(2);
  }finally{await db.close();}
 },120000);
 it("corrects a closed generic sale into oil service without changing prices, Cashea or cash",async()=>{
  const db=await dbSetup();try{
   await db.query("insert into public.order_items(order_id,item_type,business_area,description,quantity,charged_ref_amount,charged_ves_amount,bcv_rate_snapshot,operative_rate_snapshot) values($1,'PRODUCT','STORE','Aceite + filtro',1,65.07,6507,100,125)",[O2]);
   await db.query("insert into public.cashea_sales(order_id,cashea_reference,gross_ref,status) values($1,'230999111',65.07,'ACTIVE')",[O2]);
   await db.query("insert into public.payments(order_id,amount_original,reference) values($1,2602.8,'8368')",[O2]);
   await db.query("update public.orders set status='CLOSED',closed_at=now(),total_ref=65.07,total_ves=6507 where id=$1",[O2]);
   const before=await db.query("select o.total_ref,(select sum(amount_original) from public.payments where order_id=o.id) paid,(select cashea_reference from public.cashea_sales where order_id=o.id) ref from public.orders o where o.id=$1",[O2]);
   const call=[O2,null,V1,15200,"Brava 15W40","15W-40",4,"AL-3387",20200,null,"Omití registrar el cambio de aceite en CRM"];
   const saved=await db.query<{response:{created_service:boolean}}>(correct,call);
   expect(saved.rows[0].response.created_service).toBe(true);
   const after=await db.query("select o.total_ref,(select sum(amount_original) from public.payments where order_id=o.id) paid,(select cashea_reference from public.cashea_sales where order_id=o.id) ref from public.orders o where o.id=$1",[O2]);
   expect(after.rows).toEqual(before.rows);
   expect((await db.query("select * from public.inventory_movements")).rows).toHaveLength(0);
   expect((await db.query("select * from public.service_records where order_id=$1",[O2])).rows).toHaveLength(1);
   await expect(db.query(correct,call)).rejects.toThrow();
   const item=await db.query<{id:string}>("select id from public.order_items where order_id=$1 and item_type='SERVICE'",[O2]);
   await db.query("update public.customer_followups set status='SENT' where order_id=$1",[O2]);
   await db.query(correct,[O2,item.rows[0].id,V1,15210,"Brava 15W40","15W-40",4,"AL-3387",20210,null,"Corrijo el kilometraje después de enviar el mensaje"]);
   const crm=await db.query<{followup_type:string;status:string}>("select followup_type,status from public.customer_followups where order_id=$1 order by followup_type",[O2]);
   expect(crm.rows).toEqual([{followup_type:"POST_SERVICE",status:"SENT"},{followup_type:"POST_SERVICE_CORRECTION",status:"PENDING"}]);
  }finally{await db.close();}
 },120000);
 it("refuses unauthorized edits and edits to open sales",async()=>{
  const db=await dbSetup();try{
   const call=[O1,null,V1,10100,"Aceite Clio","15W-40",4,"AL-3387",15100,null,"Corrección no autorizada"];
   await expect(db.query(correct,call)).rejects.toThrow();
   await db.exec("set app.test_identity='GUEST'");
   await expect(db.query(correct,[O2,...call.slice(1)])).rejects.toThrow();
  }finally{await db.close();}
 },120000);
});
