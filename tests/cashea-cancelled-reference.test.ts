import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";

const migration=readFileSync("supabase/migrations/20261014121000_cashea_cancelled_reference_reuse.sql","utf8");
const number=(n:number)=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
async function setup(){
 const db=new PGlite();
 await db.exec([
  "create schema lubricenter_private;",
  "create table public.orders(id uuid primary key,customer_id uuid,vehicle_id uuid,status text);",
  "create table public.cashea_sales(id uuid primary key default gen_random_uuid(),order_id uuid not null references public.orders(id),cashea_reference text,status text not null,created_at timestamptz not null default now());",
  "create table public.payments(id uuid primary key default gen_random_uuid(),method text,reference text,amount_original numeric not null);",
  "create table public.audit_events(id uuid primary key default gen_random_uuid(),event_type text,entity_type text,entity_id uuid,data jsonb);",
 ].join("\n"));
 await db.exec(migration);
 await db.exec([
  "create trigger finance_cashea_reference before insert or update of cashea_reference on public.cashea_sales for each row execute function lubricenter_private.finance_reference_guard();",
  "create trigger finance_payment_reference before insert or update of reference on public.payments for each row execute function lubricenter_private.finance_reference_guard();",
 ].join("\n"));
 const a="11111111-1111-4111-8111-111111111111";
 const b="22222222-2222-4222-8222-222222222222";
 const c="33333333-3333-4333-8333-333333333333";
 const d="44444444-4444-4444-8444-444444444444";
 const orders=[
  [1,a,b,"CANCELLED"],[2,a,b,"OPEN"],[3,c,b,"OPEN"],
  [4,a,d,"OPEN"],[5,a,b,"OPEN"],[6,a,b,"CANCELLED"]
 ];
 for(const [id,customer,vehicle,status] of orders) await db.query(
  "insert into public.orders(id,customer_id,vehicle_id,status) values($1,$2,$3,$4)",
  [number(Number(id)),customer,vehicle,status]);
 return db;
}
async function sale(db:PGlite,order:number,status:string,ref="230210768"){
 return db.query<{id:string}>(
  "insert into public.cashea_sales(order_id,status,cashea_reference) values ($1,$2,$3) returning id",
  [number(order),status,ref]);
}
describe("Cashea: reuse canceled reference securely",()=>{
 it("preserves history, reuses only after cancellation, audits, blocks duplicates",async()=>{
  const db=await setup();
  try{
   const prior=await sale(db,1,"CANCELLED");
   const current=await sale(db,2,"ACTIVE");
   expect(prior.rows[0].id).not.toBe(current.rows[0].id);
   const count=await db.query<{n:number}>("select count(*)::int n from public.cashea_sales where cashea_reference='230210768'");
   expect(count.rows[0].n).toBe(2);
   const audits=await db.query<{event_type:string}>("select event_type from public.audit_events where entity_id=$1",[current.rows[0].id]);
   expect(audits.rows[0].event_type).toBe("cashea.reference_reused_after_cancellation");
   await expect(sale(db,5,"ACTIVE")).rejects.toThrow();
   await expect(sale(db,3,"ACTIVE")).rejects.toThrow();
   await expect(sale(db,4,"ACTIVE")).rejects.toThrow();
   await expect(db.query("update public.cashea_sales set status='ACTIVE' where id=$1",[prior.rows[0].id])).rejects.toThrow();
  }finally{await db.close();}
 });
 it("rejects reuse for a different customer or vehicle",async()=>{
  const db=await setup();
  try{
   await sale(db,1,"CANCELLED");
   await expect(sale(db,3,"ACTIVE")).rejects.toThrow();
   await expect(sale(db,4,"ACTIVE")).rejects.toThrow();
  }finally{await db.close();}
 });
 it("rejects an old canceled Cashea entry if parent order is not canceled",async()=>{
  const db=await setup();
  try{
   await sale(db,5,"CANCELLED");
   await expect(sale(db,2,"ACTIVE")).rejects.toThrow();
  }finally{await db.close();}
 });
 it("preserves bank reference validation",async()=>{
  const db=await setup();
  try{
   await expect(db.exec("insert into public.payments(method,reference,amount_original) values('TRANSFER_BNC','12',100)")).rejects.toThrow();
   await db.exec("insert into public.payments(method,reference,amount_original) values('TRANSFER_BNC','8368',100)");
   const count=await db.query<{n:number}>("select count(*)::int n from public.payments");
   expect(count.rows[0].n).toBe(1);
  }finally{await db.close();}
 });
});
