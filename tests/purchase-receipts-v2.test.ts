import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";

const migration=readFileSync("supabase/migrations/20261015214500_purchase_receipt_idempotency.sql","utf8");
const invoice="10000000-0000-4000-8000-000000000001",loc="20000000-0000-4000-8000-000000000001",
  loc2="20000000-0000-4000-8000-000000000002",sku="30000000-0000-4000-8000-000000000001",
  line="40000000-0000-4000-8000-000000000001",line2="40000000-0000-4000-8000-000000000002",
  exp="40000000-0000-4000-8000-000000000003",key="50000000-0000-4000-8000-000000000001",
  key2="50000000-0000-4000-8000-000000000002";

async function dbSetup(){
 const db=new PGlite();
 await db.exec([
  "create role anon; create role authenticated; create schema auth; create schema lubricenter_private;",
  "create function auth.uid() returns uuid language sql stable as $$select case when current_setting('app.identity',true)='OWNER' then '11111111-1111-4111-8111-111111111111'::uuid else null::uuid end$$;",
  "create function lubricenter_private.require_order_admin() returns void language plpgsql security definer as $$begin if auth.uid() is null then raise exception 'Solo propietario'; end if;end$$;",
  "create table locations(id uuid primary key,active boolean,code text);",
  "create table supplier_invoices(id uuid primary key,invoice_number text,status text);",
  "create table inventory_items(id uuid primary key,active boolean default true,average_cost_ref numeric default 0,last_purchase_cost_ref numeric,last_purchased_at timestamptz,cost_missing boolean default true,updated_at timestamptz default now());",
  "create table supplier_invoice_items(id uuid primary key,supplier_invoice_id uuid references supplier_invoices(id),inventory_item_id uuid references inventory_items(id),line_type text,description text,quantity numeric,received_quantity numeric default 0,unit_cost_ref numeric,check(received_quantity between 0 and quantity));",
  "create table supplier_receipts(id uuid primary key default gen_random_uuid(),supplier_invoice_id uuid references supplier_invoices(id),location_id uuid references locations(id),received_on date,notes text,status text default 'POSTED');",
  "create table supplier_receipt_items(id uuid primary key default gen_random_uuid(),supplier_receipt_id uuid references supplier_receipts(id),supplier_invoice_item_id uuid references supplier_invoice_items(id),inventory_item_id uuid references inventory_items(id),quantity numeric,unit_cost_ref numeric);",
  "create table inventory_movements(id uuid primary key default gen_random_uuid(),inventory_item_id uuid references inventory_items(id),location_id uuid references locations(id),quantity_delta numeric,movement_type text,note text,occurred_at timestamptz,supplier_receipt_item_id uuid);",
  "create table audit_events(id uuid primary key default gen_random_uuid(),event_type text,entity_type text,entity_id uuid,data jsonb);",
  "create function public.receive_supplier_invoice(uuid,date,jsonb,uuid,text) returns uuid language sql as $$select null::uuid$$;",
  "insert into locations values ('"+loc+"',true,'CABUDARE'),('"+loc2+"',true,'EL_CUJI');",
  "insert into supplier_invoices values ('"+invoice+"','FACT-01','OPEN');",
  "insert into inventory_items(id) values ('"+sku+"'),('30000000-0000-4000-8000-000000000002');",
  "insert into supplier_invoice_items(id,supplier_invoice_id,inventory_item_id,line_type,description,quantity,unit_cost_ref) values ('"+line+"','"+invoice+"','"+sku+"','INVENTORY','Aceite',12,4),('"+line2+"','"+invoice+"','30000000-0000-4000-8000-000000000002','INVENTORY','Filtro',7,2),('"+exp+"','"+invoice+"',null,'EXPENSE','Flete',1,10);",
  "set app.identity='OWNER';"
 ].join("\n"));
 await db.exec(migration);
 return db;
}
async function scalar(db:PGlite,sql:string,params:unknown[]=[]){
 const r=await db.query(sql,params);
 return Object.values(r.rows[0] as Record<string,unknown>)[0] as any;
}
async function receive(db:PGlite,requestId:string,items:Array<{line_id:string;quantity:number}>,location=loc,notes="Entrega"){
 return scalar(db,"select inventory_receive_purchase($1::uuid,$2::uuid,$3::uuid,current_date,$4::jsonb,$5)",
  [requestId,invoice,location,JSON.stringify(items),notes]);
}
describe("Compras - recepción segura",()=>{
 it("recibe parcialmente en dos sedes y registra auditoría sin crear pagos",async()=>{
  const db=await dbSetup();try{
   await receive(db,key,[{line_id:line,quantity:6},{line_id:line2,quantity:3}]);
   await receive(db,key2,[{line_id:line,quantity:6}],loc2);
   expect(Number(await scalar(db,"select sum(quantity_delta) from inventory_movements where location_id=$1",[loc]))).toBe(9);
   expect(Number(await scalar(db,"select sum(quantity_delta) from inventory_movements where location_id=$1",[loc2]))).toBe(6);
   expect(Number(await scalar(db,"select received_quantity from supplier_invoice_items where id=$1",[line]))).toBe(12);
   expect(Number(await scalar(db,"select count(*) from supplier_receipts"))).toBe(2);
   expect(Number(await scalar(db,"select count(*) from audit_events where event_type='supplier_receipt.posted_v2'"))).toBe(2);
  }finally{await db.close();}
 });
 it("reintento idéntico devuelve mismo comprobante sin sumar dos veces",async()=>{
  const db=await dbSetup();try{
   const data=[{line_id:line,quantity:6},{line_id:line2,quantity:3}];
   const id=await receive(db,key,data);
   expect(await receive(db,key,data.slice().reverse())).toBe(id);
   expect(Number(await scalar(db,"select count(*) from inventory_movements"))).toBe(2);
   await expect(receive(db,key,[{line_id:line,quantity:1}])).rejects.toThrow(/datos distintos/);
   expect(Number(await scalar(db,"select count(*) from supplier_receipts"))).toBe(1);
  }finally{await db.close();}
 });
 it("rechaza exceso, gasto como mercancía, duplicados y números negativos sin stock fantasma",async()=>{
  const db=await dbSetup();try{
   await expect(receive(db,key,[{line_id:line,quantity:6},{line_id:line2,quantity:8}])).rejects.toThrow(/superior/);
   await expect(receive(db,key,[{line_id:line,quantity:6},{line_id:exp,quantity:1}])).rejects.toThrow(/no corresponde/);
   await expect(receive(db,key,[{line_id:line,quantity:3},{line_id:line,quantity:3}])).rejects.toThrow(/duplicada/);
   await expect(receive(db,key,[{line_id:line,quantity:-1}])).rejects.toThrow(/positivas/);
   expect(Number(await scalar(db,"select count(*) from supplier_receipts"))).toBe(0);
   expect(Number(await scalar(db,"select count(*) from inventory_movements"))).toBe(0);
  }finally{await db.close();}
 });
 it("recalcula costo medio ponderado sin reescribir los movimientos iniciales",async()=>{
  const db=await dbSetup();try{
   await db.exec("update inventory_items set average_cost_ref=2 where id='"+sku+"'");
   await db.exec("insert into inventory_movements(inventory_item_id,location_id,quantity_delta,movement_type) values('"+sku+"','"+loc+"',10,'OPENING_IMPORT')");
   await receive(db,key,[{line_id:line,quantity:10}]);
   expect(Number(await scalar(db,"select average_cost_ref from inventory_items where id=$1",[sku]))).toBe(3);
   expect(Number(await scalar(db,"select sum(quantity_delta) from inventory_movements where inventory_item_id=$1",[sku]))).toBe(20);
  }finally{await db.close();}
 });
 it("rechaza usuarios no autorizados incluso con token previamente recibido",async()=>{
  const db=await dbSetup();try{
   await receive(db,key,[{line_id:line,quantity:4}]);
   await db.exec("set app.identity='GUEST'");
   await expect(receive(db,key,[{line_id:line,quantity:4}])).rejects.toThrow(/Solo propietario/);
   await expect(receive(db,key2,[{line_id:line2,quantity:1}])).rejects.toThrow(/Solo propietario/);
   expect(Number(await scalar(db,"select count(*) from supplier_receipts"))).toBe(1);
  }finally{await db.close();}
 });
 it("revoca API anterior y limita exposición directa de tokens",async()=>{
  const db=await dbSetup();try{
   expect(await scalar(db,"select has_function_privilege('authenticated','public.inventory_receive_purchase(uuid,uuid,uuid,date,jsonb,text)','EXECUTE')")).toBe(true);
   expect(await scalar(db,"select has_function_privilege('anon','public.inventory_receive_purchase(uuid,uuid,uuid,date,jsonb,text)','EXECUTE')")).toBe(false);
   expect(await scalar(db,"select has_function_privilege('authenticated','public.receive_supplier_invoice(uuid,date,jsonb,uuid,text)','EXECUTE')")).toBe(false);
   expect(await scalar(db,"select has_table_privilege('authenticated','public.purchase_receipt_requests','INSERT')")).toBe(false);
  }finally{await db.close();}
 });
});
