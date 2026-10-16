import {readFileSync} from "node:fs";
import {PGlite} from "@electric-sql/pglite";
import {describe,it,expect} from "vitest";
import {parseOfficialBcv,readOfficialHtml} from "../supabase/functions/_shared/bcv-official";
const sample=(value="880,11590000",date="2026-10-16")=>`<div id="dolar"><strong>${value}</strong></div>Fecha Valor: <span class="date-display-single" content="${date}T00:00:00-04:00">Fecha</span>`;

describe("official BCV parser",()=>{
 it("requires n8n to confirm the persisted official result",()=>{
  const workflow=JSON.parse(readFileSync("automations/n8n-bcv-official.json","utf8"));
  const verify=new Function("$input",workflow.nodes.find((node:{id:string})=>node.id==="verify").parameters.jsCode);
  const result={ok:true,provider:"BCV_OFFICIAL",mode:"OBSERVER",evidence_sha256:"a".repeat(64),fecha_valor:"2026-10-16",usd_ves:880.1159};
  expect(verify({first:()=>({json:result})})).toEqual([{json:result}]);
  for(const invalid of [{...result,ok:false},{...result,provider:"BCV_TODAY"},{...result,evidence_sha256:null}])expect(()=>verify({first:()=>({json:invalid})})).toThrow(/captador/);
 });
 it("uses the USD block and Fecha Valor rather than another currency or capture date",()=>{
  const data=parseOfficialBcv(`<div id="euro"><strong>999,99000000</strong></div>${sample()}`,new Date("2026-10-16T15:00:00Z"));
  expect(data.value).toBe("880.11590000");expect(data.valueDate).toBe("2026-10-16");expect(data.effectiveAt).toBe("2026-10-16T04:00:00.000Z");
 });
 it("rejects duplicates, changed HTML, impossible/stale dates and invalid amounts",()=>{
  const now=new Date("2026-10-16T15:00:00Z");
  for(const html of [sample()+sample(),sample().replace('id="dolar"','id="otro"'),sample("0,00"),sample("-1,00"),sample("NaN"),sample("880,11","2026-09-01"),sample("880,11","2026-02-30")])expect(()=>parseOfficialBcv(html,now)).toThrow();
 });
 it("rejects HTTP errors and oversized responses",async()=>{
  await expect(readOfficialHtml(new Response("error",{status:503}))).rejects.toThrow();
  await expect(readOfficialHtml(new Response("x".repeat(2_000_001),{headers:{"content-type":"text/html"}}))).rejects.toThrow(/tamaño/);
 });
});

it("stores official evidence once per date, rejects conflicts and leaves operational tables unchanged",async()=>{
 const db=new PGlite();try {
  await db.exec(`create role anon;create role authenticated;create role service_role;
   create schema auth;create schema lubricenter_private;create schema vault;
   create function auth.uid() returns uuid language sql as $$select nullif(current_setting('app.uid',true),'')::uuid$$;
   create function auth.role() returns text language sql as $$select current_setting('app.role',true)$$;
   create table vault.secrets(name text primary key,decrypted_secret text);
   create view vault.decrypted_secrets as select * from vault.secrets;
   create function public.gen_random_bytes(integer) returns bytea language sql as $$select decode(repeat('ab',$1),'hex')$$;
   create function vault.create_secret(text,text) returns uuid language plpgsql as $$begin insert into vault.secrets values($2,$1);return gen_random_uuid();end$$;
   create table exchange_rates(value numeric);insert into exchange_rates values(879);
   create table inventory_movements(id integer);insert into inventory_movements values(1);
   set app.role='service_role';`);
  await db.exec(readFileSync("supabase/migrations/20261016143000_bcv_official_observer.sql","utf8"));
  const sql="select public.bcv_official_record($1,(now() at time zone 'America/Caracas')::date,$2) as result";
  await db.exec("set role service_role");
  const first=(await db.query<{result:{mode:string,evidence_sha256:string}}>(sql,[880.1159,sample()])).rows[0].result;
  expect(first.mode).toBe("OBSERVER");expect(first.evidence_sha256).toMatch(/^[a-f0-9]{64}$/);
  await db.query(sql,[880.1159,sample()]);
  await expect(db.query(sql,[881,sample()])).rejects.toThrow(/Conflicto/);
  await db.exec("reset role");
  expect((await db.query("select * from lubricenter_private.bcv_official_observations")).rows).toHaveLength(1);
  expect((await db.query<{capture_count:number}>("select capture_count from lubricenter_private.bcv_official_observations")).rows[0].capture_count).toBe(2);
  expect((await db.query("select * from exchange_rates")).rows).toEqual([{value:"879"}]);
  expect((await db.query("select * from inventory_movements")).rows).toEqual([{id:1}]);
  await db.exec("select public.bcv_official_record_failure('Fallo TLS de prueba')");
  expect((await db.query<{last_success_at:Date,last_error:string}>("select * from lubricenter_private.bcv_official_observer_state")).rows[0]).toMatchObject({last_error:"Fallo TLS de prueba",last_success_at:expect.any(Date)});
  await db.exec("set app.role='authenticated'");
  await expect(db.query(sql,[880.1159,sample()])).rejects.toThrow(/captador/);
  for(const role of ['anon','authenticated'])expect((await db.query<{allowed:boolean}>("select has_function_privilege($1,'public.bcv_official_record(numeric,date,text)','execute') as allowed",[role])).rows[0].allowed).toBe(false);
  await expect(db.query("select public.get_bcv_official_status()")).rejects.toThrow(/sesión/);
 }finally{await db.close();}
});
