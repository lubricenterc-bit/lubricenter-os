import { PGlite } from "@electric-sql/pglite";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { readFileSync } from "node:fs";
import { emptyTechnicalSpec,normalizeTechnicalSpec,suggestedFamily,technicalSearchText } from "../lib/catalog-taxonomy";

let db:PGlite;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec("create role authenticated; create role anon; create schema if not exists auth;");
  await db.exec("create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;");
  await db.exec("create table public.products(id uuid primary key default gen_random_uuid()); create table public.inventory_items(id uuid primary key default gen_random_uuid());");
  await db.exec(readFileSync("supabase/migrations/20261013213000_catalog_technical_taxonomy.sql","utf8"));
},30000);
afterAll(async()=>{await db?.close();});

describe("Clasificación técnica independiente",()=>{
  it("distingue filtros y aceites sin asignar especificaciones ficticias",()=>{
    expect(suggestedFamily("Filtro Aceite")).toBe("FILTER");
    expect(suggestedFamily("Aceite Motor")).toBe("OIL");
    expect(suggestedFamily("Otros")).toBeNull();
    const oil=emptyTechnicalSpec(null,"00000000-0000-0000-0000-000000000001","OIL");
    oil.viscosity="15W-40";
    oil.lubricant_base="SEMI";
    oil.lubricant_system="ENGINE";
    oil.fuel_application="DIESEL";
    expect(technicalSearchText({sku:"DK9-1540",brand:"DK9"},oil)).toContain("15w-40");
    expect(technicalSearchText({sku:"DK9-1540",brand:"DK9"},oil)).toContain("diesel");
  });
  it("normalizes tags and forbids mixed oil/filter attributes",()=>{
    const s=emptyTechnicalSpec(null,"00000000-0000-0000-0000-000000000001","FILTER");
    s.filter_thread=" M20x1.5 ";
    s.filter_type="OIL";
    s.lubricant_base="SEMI";
    s.additional_tags=[" Alta rotación ","Alta rotación","Caja superior"];
    const normalized=normalizeTechnicalSpec(s);
    expect(normalized.filter_thread).toBe("M20x1.5");
    expect(normalized.lubricant_base).toBeNull();
    expect(normalized.additional_tags).toEqual(["Alta rotación","Caja superior"]);
  });
  it("keeps annotations separate from products, inventory stock and prices",async()=>{
    const items=await db.query<{id:string}>("insert into public.inventory_items default values returning id");
    const id=items.rows[0].id;
    const spec=await db.query<{id:string}>("insert into public.catalog_technical_specs(inventory_item_id,family,filter_type,filter_thread) values($1,'FILTER','OIL','M20x1.5') returning id",[id]);
    expect(spec.rows).toHaveLength(1);
    const inventory=await db.query<{id:string}>("select id from public.inventory_items where id=$1",[id]);
    expect(inventory.rows).toHaveLength(1);
    const refs=await db.query<{verification_status:string}>("insert into public.filter_cross_references(technical_spec_id,reference_brand,reference_code) values($1,'Millard','MF-111') returning verification_status",[spec.rows[0].id]);
    expect(refs.rows[0].verification_status).toBe("PENDING");
  });
  it("prevents two kinds of source on one spec and prevents anonymous reads",async()=>{
    const prod=await db.query<{id:string}>("insert into public.products default values returning id");
    const inv=await db.query<{id:string}>("insert into public.inventory_items default values returning id");
    await expect(db.query("insert into public.catalog_technical_specs(product_id,inventory_item_id,family) values($1,$2,'FILTER')",[prod.rows[0].id,inv.rows[0].id])).rejects.toThrow();
    const permissions=await db.query<{auth:boolean;anon:boolean}>("select has_table_privilege('authenticated','public.catalog_technical_specs','SELECT') auth,has_table_privilege('anon','public.catalog_technical_specs','SELECT') anon");
    expect(permissions.rows[0]).toEqual({auth:true,anon:false});
  });
});
