import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";
const migration=readFileSync("supabase/migrations/20261013220000_direct_bcv_manual_operative.sql","utf8");
async function setup(){
 const db=new PGlite();
 await db.exec(`
 create role anon;create role authenticated;create role service_role;
 create schema auth;create schema lubricenter_private;create schema vault;
 grant usage on schema auth to service_role;
 create function auth.uid() returns uuid language sql as $$select '11111111-1111-4111-8111-111111111111'::uuid$$;
 create function auth.role() returns text language sql stable as $$select current_setting('app.role',true)$$;
 create function lubricenter_private.finance_require(text) returns void language plpgsql as $$begin if current_setting('app.identity',true)<>'OWNER' then raise exception 'Solo propietario';end if;end$$;
 create table vault.secrets(name text primary key,decrypted_secret text);
 create view vault.decrypted_secrets as select * from vault.secrets;
 create function public.gen_random_bytes(integer) returns bytea language sql as $$select decode(repeat('ab',$1),'hex')$$;
 create function vault.create_secret(text,text) returns uuid language plpgsql as $$begin insert into vault.secrets values($2,$1);return gen_random_uuid();end$$;
 create table public.app_settings(key text primary key,value jsonb);
 create table public.products(id uuid default gen_random_uuid(),active boolean,available boolean,catalog_source text,catalog_synced_at timestamptz);
 create table public.exchange_rates(id uuid primary key default gen_random_uuid(),rate_type text,value numeric,effective_at timestamptz,source text,created_at timestamptz default now(),created_by uuid);
 create table public.integration_sync_state(source_key text primary key,last_verified_at timestamptz,last_success_payload jsonb,updated_at timestamptz);
 create table public.audit_events(id uuid default gen_random_uuid(),event_type text,entity_type text,entity_id uuid,data jsonb,actor_id uuid);
 insert into public.exchange_rates(rate_type,value,effective_at,source) values('BCV',879,now()-interval '1 day','Notion · Tasas'),('OPERATIVE',1061,now()-interval '20 days','Notion · Tasas');
 set app.role='service_role';set app.identity='OWNER';
 `);
 await db.exec(migration);return db;
}
const capture="select public.bcv_accept_publication($1,(now() at time zone 'America/Caracas')::date+$2::integer,now())";
describe("BCV SQL and transition safety",()=>{
 it("accepts the dated publication twice without duplicate rates and rejects conflicting values",async()=>{
  const db=await setup();try{
   await db.exec("set role service_role");
   await db.query(capture,[879,0]);await db.query(capture,[879,0]);
   await db.exec("reset role");
   expect((await db.query("select * from bcv_rate_publications")).rows).toHaveLength(1);
   expect((await db.query("select * from exchange_rates where source='BCV_API_DATE_VALUE'")).rows).toHaveLength(1);
   await expect(db.query(capture,[880,0])).rejects.toThrow(/Conflicto/);
   await db.exec("set app.role='authenticated'");
   await expect(db.query(capture,[879,0])).rejects.toThrow(/captador interno/);
  }finally{await db.close();}
 });
 it("keeps the old feed until activation, then chooses the direct current rate and excludes tomorrow",async()=>{
  const db=await setup();try{
   await db.query(capture,[879,0]);await db.query(capture,[880,1]);
   await db.exec("insert into exchange_rates(rate_type,value,effective_at,source) values('BCV',890,now(),'Notion · Tasas')");
   expect(Number((await db.query<{bcv_rate:number}>("select * from current_exchange_rates")).rows[0].bcv_rate)).toBe(890);
   await db.exec(`insert into app_settings values('catalog_authority','"LUBRICENTER_OS"');`);
   expect(Number((await db.query<{bcv_rate:number}>("select * from current_exchange_rates")).rows[0].bcv_rate)).toBe(879);
   await db.exec("insert into exchange_rates(rate_type,value,effective_at,source) values('BCV',999,now(),'Notion · Tasas')");
   expect((await db.query("select * from exchange_rates where value=999")).rows).toHaveLength(0);
  }finally{await db.close();}
 });
 it("refuses native cutover before official evidence and preserves the original catalog",async()=>{
  const db=await setup();try{
   await db.query(capture,[879,0]);
   const cutover=readFileSync("supabase/migrations/20261013224000_native_catalog_cutover.sql","utf8");
   await expect(db.exec(cutover)).rejects.toThrow(/publicación oficial BCV/);
   expect((await db.query("select * from app_settings where key='catalog_authority'")).rows).toHaveLength(0);
  }finally{await db.close();}
 });
 it("only allows the owner to set the operative rate, and an unchanged value adds no history",async()=>{
  const db=await setup();try{
   await db.query("select set_operative_manual(1061,'Sin cambios')");
   expect((await db.query("select * from audit_events")).rows).toHaveLength(0);
   await db.query("select set_operative_manual(1070,'Ajuste de prueba')");
   expect((await db.query("select * from audit_events")).rows).toHaveLength(1);
   await db.exec("set app.identity='OPERATOR'");
   await expect(db.query("select set_operative_manual(1080,'No autorizado')")).rejects.toThrow(/propietario/);
   expect((await db.query<{allowed:boolean}>("select has_function_privilege('anon','set_operative_manual(numeric,text)','execute') allowed")).rows[0].allowed).toBe(false);
  }finally{await db.close();}
 });
});
