import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const migration=readFileSync("supabase/migrations/20261014190000_manual_crm_deferred_service_cases.sql","utf8");
const customer="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const payer="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const vehicle="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const order="dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const req="eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const save="select public.crm_manual_case_save($1::uuid,$2::jsonb,$3::integer) id";
const transition="select public.crm_manual_case_transition($1::uuid,$2::text,$3::integer,$4::jsonb) result";
function payload(extra:Record<string,unknown>={}){
 return JSON.stringify({request_id:req,vehicle_id:vehicle,payer_customer_id:payer,
  payment_context:"UNVERIFIED",scheduled_for:null,next_contact_on:"2026-10-20",
  payment_note:null,notes:"Aceite prepagado para atender otro día",linked_order_id:null,...extra});
}
async function setup(){
 const db=new PGlite();
 await db.exec([
  "create role anon;create role authenticated;create schema auth;create schema lubricenter_private;",
  "create function auth.uid() returns uuid language sql stable as $$select case when current_setting('app.test_identity',true)='OWNER' then 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid else null::uuid end$$;",
  "create function lubricenter_private.require_order_admin() returns void language plpgsql as $$begin if auth.uid() is null then raise exception 'Acceso administrativo requerido';end if;end$$;",
  "create table public.customers(id uuid primary key,name text);",
  "create table public.vehicles(id uuid primary key,customer_id uuid references public.customers(id),plate text,make text,model text,current_odometer integer,updated_at timestamptz default now());",
  "create table public.orders(id uuid primary key,customer_id uuid,status text);",
  "create table public.payments(id uuid primary key default gen_random_uuid(),order_id uuid,amount_original numeric);",
  "create table public.cashea_sales(id uuid primary key default gen_random_uuid(),order_id uuid,cashea_reference text,gross_ref numeric,status text);",
  "create table public.inventory_movements(id uuid primary key default gen_random_uuid(),quantity_delta numeric);",
  "create table public.account_movements(id uuid primary key default gen_random_uuid(),value_ves numeric);",
  "create table public.crm_contact_permissions(customer_id uuid primary key,status text);",
  "create table public.service_records(id uuid primary key default gen_random_uuid(),order_id uuid,order_item_id uuid,customer_id uuid,vehicle_id uuid,service_type text,description text,odometer integer,oil_brand text,oil_viscosity text,oil_quantity_liters numeric,oil_filter_code text,next_service_odometer integer,next_service_date date,charged_ref_amount numeric,charged_ves_amount numeric,performed_at timestamptz,created_by uuid,source_system text,source_key text,service_notes text,source_payload jsonb default '{}'::jsonb);",
  "set app.test_identity='OWNER';"
 ].join("\n"));
 await db.exec(migration);
 await db.query("insert into public.customers(id,name) values($1,'Propietario'),($2,'Pagador Cashea')",[customer,payer]);
 await db.query("insert into public.vehicles(id,customer_id,plate,make,model,current_odometer) values($1,$2,'AB123CD','Renault','Clio',88000)",[vehicle,customer]);
 await db.query("insert into public.orders(id,customer_id,status) values($1,$2,'CLOSED')",[order,payer]);
 await db.query("insert into public.payments(order_id,amount_original) values($1,2400)",[order]);
 await db.query("insert into public.cashea_sales(order_id,cashea_reference,gross_ref,status) values($1,'230210768',60,'ACTIVE')",[order]);
 return db;
}
async function snapshot(db:PGlite){
 return (await db.query<{payments:number;cashea:number;stock:number;bank:number;history:number}>(
  "select (select count(*)::int from public.payments) payments,"+
  "(select count(*)::int from public.cashea_sales) cashea,"+
  "(select count(*)::int from public.inventory_movements) stock,"+
  "(select count(*)::int from public.account_movements) bank,"+
  "(select count(*)::int from public.service_records) history")).rows[0];
}
describe("CRM manual sin orden y sin ingresos ficticios",()=>{
 it("creates independently as PENDING, marks SCHEDULED but does not book service prematurely",async()=>{
  const db=await setup();try{
   const before=await snapshot(db);
   const result=await db.query<{id:string}>(save,[null,payload(),null]);
   const id=result.rows[0].id;
   expect((await snapshot(db))).toEqual(before);
   const row=(await db.query<{status:string;linked_order_id:string|null;version:number}>(
    "select status,linked_order_id,version from public.crm_manual_cases where id=$1",[id])).rows[0];
   expect(row).toEqual({status:"PENDING_SERVICE",linked_order_id:null,version:1});
   const repeated=await db.query<{id:string}>(save,[null,payload(),null]);
   expect(repeated.rows[0].id).toBe(id);
   expect((await db.query("select id from public.crm_manual_cases")).rows).toHaveLength(1);
   await db.query(save,[id,payload({scheduled_for:"2026-10-21T14:00:00Z",request_id:"11111111-1111-4111-8111-111111111111"}),1]);
   const scheduled=(await db.query<{status:string;version:number}>("select status,version from public.crm_manual_cases where id=$1",[id])).rows[0];
   expect(scheduled).toEqual({status:"SCHEDULED",version:2});
   expect((await snapshot(db))).toEqual(before);
   await expect(db.query(save,[id,payload(),1])).rejects.toThrow();
  }finally{await db.close();}
 },120000);
 it("links optional previous Cashea order and completes exactly one historical service without new money",async()=>{
  const db=await setup();try{
   const before=await snapshot(db);
   const {rows}=await db.query<{id:string}>(save,[null,payload({
    payment_context:"ORDER_LINKED",linked_order_id:order}),null]);
   const id=rows[0].id;
   const done=JSON.stringify({odometer:88050,oil_brand:"Valvoline 15W40",oil_viscosity:"15W-40",
    oil_quantity_liters:4,oil_filter_code:"AL-3387",next_service_odometer:93050,
    next_service_date:"2027-01-14"});
   const processed=await db.query<{result:{service_record_id:string}}>(
    transition,[id,"COMPLETE",1,done]);
   const saved=processed.rows[0].result.service_record_id;
   const after=await snapshot(db);
   expect({...after,history:before.history}).toEqual(before);
   expect(after.history).toBe(before.history+1);
   const record=(await db.query<{customer_id:string;vehicle_id:string;order_id:string;charged_ref_amount:number;source_system:string}>(
    "select customer_id,vehicle_id,order_id,charged_ref_amount::float8 charged_ref_amount,source_system from public.service_records where id=$1",[saved])).rows[0];
   expect(record).toEqual({customer_id:customer,vehicle_id:vehicle,order_id:order,
    charged_ref_amount:0,source_system:"LUBRICENTER_CRM_MANUAL"});
   const repeated=await db.query<{result:{service_record_id:string;already_completed:boolean}}>(
     transition,[id,"COMPLETE",1,done]);
   expect(repeated.rows[0].result).toMatchObject({service_record_id:saved,already_completed:true});
   expect((await db.query("select id from public.service_records")).rows).toHaveLength(1);
  }finally{await db.close();}
 },120000);
 it("rejects fake link, wrong payer, unauthorized access and cancellation without reason",async()=>{
  const db=await setup();try{
   await expect(db.query(save,[null,payload({payment_context:"ORDER_LINKED",linked_order_id:null}),null])).rejects.toThrow();
   await expect(db.query(save,[null,payload({payment_context:"ORDER_LINKED",linked_order_id:order,payer_customer_id:customer}),null])).rejects.toThrow();
   const r=await db.query<{id:string}>(save,[null,payload(),null]);
   await expect(db.query(transition,[r.rows[0].id,"CANCEL",1,JSON.stringify({reason:""})])).rejects.toThrow();
   await db.exec("set app.test_identity='GUEST';");
   await expect(db.query(save,[null,payload({request_id:"11111111-1111-4111-8111-111111111111"}),null])).rejects.toThrow();
   await expect(db.query(transition,[r.rows[0].id,"COMPLETE",1,JSON.stringify({odometer:90,oil_brand:"SKY",next_service_odometer:5090})])).rejects.toThrow();
  }finally{await db.close();}
 },120000);
 it("authenticated admin can call the restricted facade but cannot mutate CRM tables directly",async()=>{
  const db=await setup();try{
   await db.exec("grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;");
   await db.exec("set role authenticated;");
   const r=await db.query<{id:string}>(save,[null,payload(),null]);
   expect(r.rows[0].id).toBeTruthy();
   await expect(db.exec("delete from public.crm_manual_cases")).rejects.toThrow();
  }finally{await db.close();}
 },120000);
 it("requires opt-in to record a real WhatsApp send and retains an audit event",async()=>{
  const db=await setup();try{
   const r=await db.query<{id:string}>(save,[null,payload(),null]);const id=r.rows[0].id;
   const msg={message:"Hola, por favor confirma cuándo podrás realizar tu cambio de aceite pendiente."};
   await expect(db.query(transition,[id,"MARK_CONTACT_SENT",1,JSON.stringify(msg)])).rejects.toThrow();
   await db.query("insert into public.crm_contact_permissions(customer_id,status) values($1,'OPT_IN')",[customer]);
   await db.query(transition,[id,"MARK_CONTACT_SENT",1,JSON.stringify(msg)]);
   const state=(await db.query<{version:number;sent:boolean}>(
    "select version,(crm_message_sent_at is not null) sent from public.crm_manual_cases where id=$1",[id])).rows[0];
   expect(state).toEqual({version:2,sent:true});
   const events=await db.query<{event_type:string}>("select event_type from public.crm_manual_case_events where case_id=$1 order by occurred_at",[id]);
   expect(events.rows.map(e=>e.event_type)).toEqual(["CREATED","CONTACT_SENT"]);
  }finally{await db.close();}
 },120000);
});
