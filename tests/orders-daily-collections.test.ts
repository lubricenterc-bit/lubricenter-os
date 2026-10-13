import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {afterAll,beforeAll,describe,expect,it} from "vitest";

let db:PGlite;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec([
    "create role authenticated; create role anon;",
    "create table public.orders(id uuid primary key,order_number text,status text,customer_id uuid,vehicle_id uuid,business_at timestamptz,closed_at timestamptz,opened_at timestamptz,cancellation_reason text);",
    "create table public.customers(id uuid primary key,name text,phone text);",
    "create table public.vehicles(id uuid primary key,plate text,make text,model text);",
    "create table public.order_items(order_id uuid,item_type text,charged_ref_amount numeric,charged_ves_amount numeric,description text,created_at timestamptz default now());",
    "create table public.cashea_sales(id uuid primary key,order_id uuid,created_at timestamptz,status text,ownership_status text,initial_percent numeric,initial_ref numeric,initial_ves_snapshot numeric,financed_ref numeric,gross_ref numeric,bcv_rate_snapshot numeric,cashea_reference text,initial_payment_method text);",
    "create table public.receivables(order_id uuid,debtor_type text);",
    "create table public.payments(id uuid primary key,order_id uuid,method text,currency text,amount_original numeric,value_ves numeric,bcv_rate_snapshot numeric,reference text,paid_at timestamptz);",
    "grant select on all tables in schema public to authenticated;",
  ].join("\n"));
  await db.exec(readFileSync("supabase/migrations/20261013202000_orders_daily_collections_v2.sql","utf8"));
  await db.exec([
    "insert into orders(id,order_number,status,business_at) values",
    "('00000000-0000-4000-8000-000000000001','OS-A','CLOSED','2026-10-12T12:00:00-04:00'),",
    "('00000000-0000-4000-8000-000000000002','OS-B','CLOSED','2026-10-12T17:00:00-04:00'),",
    "('00000000-0000-4000-8000-000000000003','OS-C','CLOSED','2026-10-13T09:00:00-04:00');",
    "insert into order_items(order_id,item_type,charged_ref_amount,charged_ves_amount,description) values",
    "('00000000-0000-4000-8000-000000000001','SERVICE',100,90000,'Cambio de aceite'),",
    "('00000000-0000-4000-8000-000000000002','PRODUCT',50,45000,'Filtro'),",
    "('00000000-0000-4000-8000-000000000003','PRODUCT',10,9000,'Aceite');",
    "insert into cashea_sales(id,order_id,created_at,status,ownership_status,initial_percent,initial_ref,initial_ves_snapshot,financed_ref,gross_ref,bcv_rate_snapshot,cashea_reference,initial_payment_method) values",
    "('10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',now(),'ACTIVE','OWN',40,40,36000,60,100,900,'CAS-88','MIXED');",
    "insert into payments(id,order_id,method,currency,amount_original,value_ves,bcv_rate_snapshot,reference,paid_at) values",
    "('20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001','TRANSFER_BDV','VES',18000,18000,900,'ABC1234','2026-10-12T12:05:00-04:00'),",
    "('20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000001','ZELLE','USD',20,18000,900,'Z123456','2026-10-12T12:06:00-04:00'),",
    "('20000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000002','TRANSFER_BDV','VES',45000,45000,900,'DEF9876','2026-10-12T17:10:00-04:00');",
  ].join("\n"));
},30000);
afterAll(async()=>{await db?.close();});

describe("Órdenes y cobranza diaria",()=>{
  it("filters by Caracas business date, sums Cashea initial once, and separates native currencies",async()=>{
    const q=await db.query<{report:any}>("select public.search_order_collection_v2('', 'CLOSED', '2026-10-12','2026-10-12',0,'ALL') report");
    const data=q.rows[0].report;
    expect(Number(data.count)).toBe(2);
    expect(Number(data.summary.closed)).toBe(2);
    expect(Number(data.summary.cashea)).toBe(1);
    expect(Number(data.summary.sales_ref)).toBe(150);
    expect(Number(data.summary.cashea_initial_bcv)).toBe(40);
    expect(Number(data.summary.cashea_initial_ves)).toBe(36000);
    expect(Number(data.summary.cashea_financed_bcv)).toBe(60);
    expect(Number(data.summary.collected_ves)).toBe(63000);
    expect(Number(data.summary.collected_usd)).toBe(20);
    expect(data.rows[1].services).toBe("Cambio de aceite");
  });

  it("filters Cashea only and shows both payment methods without counting the financed part as money",async()=>{
    const q=await db.query<{report:any}>("select public.search_order_collection_v2('', 'CLOSED', '2026-10-12','2026-10-12',0,'CASHEA') report");
    const data=q.rows[0].report;
    expect(Number(data.count)).toBe(1);
    expect(data.rows[0].cashea.reference).toBe("CAS-88");
    expect(Number(data.rows[0].cashea.initial_ves)).toBe(36000);
    expect(data.rows[0].payment_details.map((p:any)=>p.method)).toEqual(["TRANSFER_BDV","ZELLE"]);
    expect(data.rows[0].payment_details[0].reference_tail).toBe("1234");
    expect(Number(data.summary.collected_ves)).toBe(18000);
    expect(Number(data.summary.collected_usd)).toBe(20);
    expect(Number(data.summary.sales_ref)).toBe(100);
  });

  it("does not let anonymous users execute the collection overview",async()=>{
    const q=await db.query<{anon:boolean;auth:boolean}>("select has_function_privilege('anon','public.search_order_collection_v2(text,text,date,date,integer,text)','EXECUTE') anon, has_function_privilege('authenticated','public.search_order_collection_v2(text,text,date,date,integer,text)','EXECUTE') auth");
    expect(q.rows[0]).toEqual({anon:false,auth:true});
  });
});
