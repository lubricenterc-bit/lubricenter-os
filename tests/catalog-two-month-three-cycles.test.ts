import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
import {parseInvoiceCaptureLines,validateCatalogPrice} from "../lib/catalog-management";

const uid=(i:number)=>"00000000-0000-4000-8000-"+String(i).padStart(12,"0");
const day=(i:number)=>new Date(Date.parse("2026-08-01T12:00:00Z")+i*86400000).toISOString().slice(0,10);
const one=(r:{rows:any[]})=>r.rows[0];
const saveSql="select public.catalog_save_product($1::uuid,$2::text,$3::text,$4::text,$5::numeric,$6::text,$7::text,$8::boolean,$9::boolean,$10::timestamptz) result";
const invoiceSql="select public.catalog_register_invoice_items($1::text,$2::text,$3::text,$4::date,$5::jsonb,$6::text) result";
async function setup(){
 const db=new PGlite();
 await db.exec([
  "create role authenticated;create role anon;create role service_role;",
  "create schema auth;create schema lubricenter_private;",
  "create function auth.uid() returns uuid language sql stable as $$select case when current_setting('app.test_identity',true)='OWNER' then '11111111-1111-4111-8111-111111111111'::uuid else null::uuid end$$;",
  "create function lubricenter_private.is_order_admin() returns boolean language sql stable as $$select auth.uid() is not null$$;",
  "create function lubricenter_private.require_order_admin() returns void language plpgsql as $$begin if auth.uid() is null then raise exception 'Solo propietario';end if;end$$;",
  "create function public.touch_updated_at() returns trigger language plpgsql as $$begin new.updated_at=clock_timestamp();return new;end$$;",
  "create table public.app_settings(key text primary key,value jsonb not null,updated_at timestamptz default now());",
  "create table public.integration_sync_state(source_key text primary key,last_verified_at timestamptz,last_success_payload jsonb,updated_at timestamptz);",
  "create table public.products(id uuid primary key default gen_random_uuid(),name text not null,category text,filter_code text,available boolean not null default true,active boolean not null default true,cash_usd_base_price numeric not null default 0,notes text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),image_url text,catalog_source text,catalog_synced_at timestamptz);",
  "create unique index products_unique_name on public.products((lower(btrim(name))));",
  "create trigger products_touch before update on public.products for each row execute function public.touch_updated_at();",
  "create table public.inventory_items(id uuid primary key default gen_random_uuid(),product_id uuid,quantity_on_hand numeric default 0,source_stock_imported numeric default 999);",
  "create table public.inventory_movements(id uuid primary key default gen_random_uuid(),inventory_item_id uuid,quantity_delta numeric);",
  "create table public.exchange_rates(id uuid primary key default gen_random_uuid(),rate_type text,value numeric,effective_at timestamptz,source text,created_by uuid,created_at timestamptz default now());",
  "create table public.audit_events(id uuid primary key default gen_random_uuid(),event_type text,entity_type text,entity_id uuid,data jsonb,actor_id uuid,created_at timestamptz default now());",
  "create table public.orders_demo(id uuid primary key default gen_random_uuid(),order_date date,product_id uuid,price_snapshot numeric);",
  "create view public.current_exchange_rates as select (select value from public.exchange_rates where rate_type='BCV' order by effective_at desc,created_at desc limit 1) bcv_rate,(select value from public.exchange_rates where rate_type='OPERATIVE' order by effective_at desc,created_at desc limit 1) operative_rate;",
  "insert into public.exchange_rates(rate_type,value,effective_at,source) values ('BCV',800,now()-interval '1 day','Notion · Tasas'),('OPERATIVE',1000,now()-interval '1 day','Notion · Tasas');",
  "set app.test_identity='OWNER';"
 ].join("\n"));
 const original=Array.from({length:76},(_,i)=>"('"+uid(i+1)+"','Item "+String(i+1).padStart(3,"0")+"','Lubricantes',true,true,"+(10+i)+",'Notion · Nuestros Productos',now())").join(",");
 await db.exec("insert into public.products(id,name,category,available,active,cash_usd_base_price,catalog_source,catalog_synced_at) values "+original);
 await db.exec("insert into public.products(id,name,category,available,active,cash_usd_base_price) values ('88888888-8888-4888-8888-888888888881','Demo 3387','Filtro',false,false,0),('88888888-8888-4888-8888-888888888882','Demo 3600','Filtro',false,false,0)");
 const inventories=Array.from({length:433},(_,i)=>"('"+uid(500+i)+"',"+(i<64?"'"+uid(i+1)+"'":"null")+","+(i%4)+",999)").join(",");
 await db.exec("insert into public.inventory_items(id,product_id,quantity_on_hand,source_stock_imported) values "+inventories);
 await db.exec("insert into public.integration_sync_state(source_key,last_verified_at) values('notion_catalog',now()),('notion_rates',now())");
 for(const file of [
  "supabase/migrations/20261013224000_native_catalog_cutover.sql",
  "supabase/migrations/20261013224500_native_catalog_editing.sql",
  "supabase/migrations/20261013225000_catalog_invoice_intake.sql"
 ])await db.exec(readFileSync(file,"utf8"));
 return db;
}
describe("Tres ciclos independientes de dos meses de uso de catálogo",()=>{
 for(let cycle=1;cycle<=3;cycle++){
 it("ciclo "+cycle+": 60 días con facturas, altas, modificaciones, ventas y Notion adversarial",async()=>{
  const db=await setup();
  try{
   const before=one(await db.query<{n:number;backup:number;linked:number}>(
    "select (select count(*)::int from public.products where available) n,(select count(*)::int from lubricenter_private.catalog_cutover_backups) backup,(select count(*)::int from public.inventory_items where product_id is not null) linked"));
   expect(before).toEqual({n:76,backup:1,linked:64});
   // Regression: the legacy rate sync reads catalog_synced_at to decide when to
   // fetch rates. After cutover it must reflect REAL last rate fetch, not now().
   await db.exec("update public.integration_sync_state set last_verified_at=now()-interval '1 hour' where source_key='notion_rates'");
   const heartbeat=one(await db.query<{minutes_old:number}>(
     "select extract(epoch from now()-catalog_synced_at)/60::numeric as minutes_old from public.get_pricing_sync_status()"));
   expect(Number(heartbeat.minutes_old)).toBeGreaterThan(55);
   expect(Number(heartbeat.minutes_old)).toBeLessThan(65);
   await db.exec("update public.integration_sync_state set last_verified_at=now() where source_key='notion_rates'");
   const physicalBefore=one(await db.query<{stock:number;excel:number}>(
    "select sum(quantity_on_hand)::int stock,sum(source_stock_imported)::int excel from public.inventory_items"));
   let captures=0;
   for(let i=0;i<60;i++){
    const id=uid(i%70+1);
    const original=one(await db.query<{name:string;updated_at:string;price:number}>(
     "select name,updated_at,cash_usd_base_price::float8 price from public.products where id=$1",[id]));
    const price=Number((original.price+0.1).toFixed(2));
    const saved=one(await db.query<{result:any}>(saveSql,[id,original.name,"Aceites","15W-40",price,
       "Ciclo "+cycle,null,true,true,original.updated_at])).result;
    expect(saved.id).toBe(id);
    await db.query("insert into public.orders_demo(order_date,product_id,price_snapshot) values($1,$2,$3)",[day(i),id,price]);
    if(i%7===0){
     const details=[
       {name:"Item 002",sku:"OL-002",category:"Lubricantes",quantity:12,unit_cost:4.2},
       {name:"Factura nueva "+cycle+"-"+i,sku:"NEW-"+cycle+"-"+i,category:"Filtros",quantity:6,unit_cost:2.15}
     ];
     const payload=JSON.stringify(details),invoiceNo="SIM-"+cycle+"-"+i;
     const captured=one(await db.query<{result:any}>(invoiceSql,["Proveedor simulación",invoiceNo,"USD",day(i),payload,"Carga aislada"])).result;
     expect(captured).toMatchObject({created:1,matched:1,stock_changed:false,prices_changed:false});
     captures++;
     if(i===0||i===28)await expect(db.query(invoiceSql,["Proveedor simulación",invoiceNo,"USD",day(i),payload,null])).rejects.toThrow();
    }
    if(i%10===0){
      // Try to overwrite native items through the previously scheduled Notion feed.
      const adversary=Array.from({length:76},(_,x)=>({
       name:"Notion overwritten "+x,base_usd:1,category:"Malicioso",description:"Intento",image_url:""
      }));
      const outcome=one(await db.query<{result:any}>(
       "select lubricenter_private.apply_notion_pricing($1,$2,$3::jsonb,now()) result",
       [801+i,1001+i,JSON.stringify(adversary)])).result;
      expect(outcome.product_changes).toBe(0);
      const intact=one(await db.query<{name:string;price:number}>(
       "select name,cash_usd_base_price::float8 price from public.products where id=$1",[id]));
      expect(intact).toEqual({name:original.name,price});
    }
   }
   const after=one(await db.query<{products:number;drafts:number;intakes:number;lines:number;edits:number;orders:number;stock:number;excel:number;movements:number;overwrites:number;bcv:number}>(
    "select (select count(*)::int from public.products) products,"+
    "(select count(*)::int from public.products where name like 'Factura nueva %' and not available) drafts,"+
    "(select count(*)::int from public.catalog_invoice_intakes) intakes,"+
    "(select count(*)::int from public.catalog_invoice_intake_lines) lines,"+
    "(select count(*)::int from public.catalog_product_changes) edits,"+
    "(select count(*)::int from public.orders_demo) orders,"+
    "(select sum(quantity_on_hand)::int from public.inventory_items) stock,"+
    "(select sum(source_stock_imported)::int from public.inventory_items) excel,"+
    "(select count(*)::int from public.inventory_movements) movements,"+
    "(select count(*)::int from public.products where name like 'Notion overwritten %') overwrites,"+
    "(select value::float8 from public.exchange_rates where rate_type='BCV' order by effective_at desc limit 1) bcv"));
   expect(after.products).toBe(78+captures);
   expect(after.drafts).toBe(captures);
   expect(after.intakes).toBe(captures);
   expect(after.lines).toBe(captures*2);
   expect(after.edits).toBe(60+captures);
   expect(after.orders).toBe(60);
   expect(after.stock).toBe(physicalBefore.stock);
   expect(after.excel).toBe(physicalBefore.excel);
   expect(after.movements).toBe(0);
   expect(after.overwrites).toBe(0);
   expect(after.bcv).toBeGreaterThan(800);
   expect(one(await db.query<{price:number}>("select price_snapshot::float8 price from public.orders_demo order by order_date limit 1")).price).toBe(10.1);
   const p=one(await db.query<{updated_at:string;name:string}>("select updated_at,name from public.products where id=$1",[uid(1)]));
   await expect(db.query(saveSql,[uid(1),p.name,null,null,20,null,null,true,true,"2020-01-01T00:00:00Z"])).rejects.toThrow();
   await expect(db.query(saveSql,[uid(1),p.name,null,null,0,null,null,true,true,p.updated_at])).rejects.toThrow();
   const invalid=JSON.stringify([{name:"No crear",quantity:1,unit_cost:5},{name:"Línea inválida",quantity:0,unit_cost:2}]);
   await expect(db.query(invoiceSql,["Proveedor simulación","INVALID-"+cycle,"USD",day(1),invalid,null])).rejects.toThrow();
   expect(one(await db.query<{n:number}>("select count(*)::int n from public.products where name='No crear'")).n).toBe(0);
   await db.exec("set app.test_identity='GUEST';");
   await expect(db.query(saveSql,[uid(1),p.name,null,null,20,null,null,true,true,p.updated_at])).rejects.toThrow();
   await expect(db.query(invoiceSql,["Proveedor simulación","NO-"+cycle,"USD",day(1),
     JSON.stringify([{name:"Sin permiso",quantity:1,unit_cost:3}]),null])).rejects.toThrow();
  }finally{await db.close();}
 },120000);
 }
 it("validates pasted invoice columns and sale publication",()=>{
  expect(parseInvoiceCaptureLines("Filtro 3387;3387;Filtros;12;2,50")[0].unit_cost).toBe(2.5);
  expect(parseInvoiceCaptureLines("Aceite 15W-40\tL40\tAceites\t3\t4.5")).toHaveLength(1);
  expect(()=>parseInvoiceCaptureLines("Filtro;3;Filtro;0;3")).toThrow();
  expect(()=>parseInvoiceCaptureLines("Filtro;3;Filtro;1;2\nFiltro;3;Filtro;1;2")).toThrow();
  expect(validateCatalogPrice(0,true,true)).toBeTruthy();
  expect(validateCatalogPrice(0,false,false)).toBeNull();
 });
});
