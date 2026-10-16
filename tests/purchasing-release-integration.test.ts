import {PGlite} from "@electric-sql/pglite";
import {readFileSync,writeFileSync,mkdirSync} from "node:fs";
import {gunzipSync} from "node:zlib";
import {execFileSync} from "node:child_process";
import {it,expect} from "vitest";
const owner="10000000-0000-4000-8000-000000000001",operator="10000000-0000-4000-8000-000000000002";
const mig=(name:string)=>readFileSync("supabase/migrations/"+name,"utf8");
const scalar=async(db:PGlite,sql:string,args:unknown[]=[])=>Object.values((await db.query(sql,args)).rows[0] as object)[0] as any;

it.each(["OFFICIAL","NOTION"])("runs catalog → supplier → VES invoice → partial receipts/costs/history using %s rates",async(mode)=>{
 const db=new PGlite();try{
 await db.exec(gunzipSync(readFileSync("tests/fixtures/production-structure.sql.gz")).toString());
 await db.exec(mig("20260923145542_finance_core_v22.sql"));
 await db.exec(`create schema vault;
 create table vault.secrets(name text primary key,decrypted_secret text);
 create view vault.decrypted_secrets as select * from vault.secrets;
 create function public.gen_random_bytes(integer) returns bytea language sql as $$select decode(repeat('ab',$1),'hex')$$;
 create function vault.create_secret(text,text) returns uuid language plpgsql as $$begin insert into vault.secrets values($2,$1);return gen_random_uuid();end$$;
 create function auth.role() returns text language sql stable as $$select current_setting('app.role',true)$$;
 insert into auth.users values('${owner}','lubricenterc@gmail.com',now()),('${operator}','operator@example.test',now());
 insert into public.locations(code,name) values('CABUDARE','Cabudare'),('EL_CUJI','El Cují');
 insert into public.exchange_rates(rate_type,value,effective_at,source) values('BCV',879,now()-interval '1 day','Notion · Tasas'),('OPERATIVE',1061,now()-interval '20 days','Notion · Tasas');
 set app.role='service_role';`);
 await db.exec("insert into products(name,cash_usd_base_price,active,available,catalog_source) values('Filtro existente',5,true,true,'Notion · Nuestros Productos')");
 if(mode==="OFFICIAL") {
 await db.exec(mig("20261013220000_direct_bcv_manual_operative.sql"));
 await db.exec(mig("20261016141112_bcv_official_observer.sql"));
 await db.exec(mig("20261016143500_bcv_official_native_bridge.sql"));
 // Synthetic evidence exists only inside this disposable database. The bridge
 // must stage the native rate and verification before the cutover can proceed.
 await db.query("select public.bcv_official_record(879,(now() at time zone 'America/Caracas')::date,$1)",["<html>Official BCV fixture, disposable database only</html>"]);
 for(const name of ["20261013220500_exchange_rate_status.sql","20261013224000_native_catalog_cutover.sql","20261013224500_native_catalog_editing.sql","20261013225000_catalog_invoice_intake.sql","20261013225500_catalog_direct_rates_compatibility.sql","20261015214500_purchase_receipt_idempotency.sql"])await db.exec(mig(name));
 } else {
  await db.exec("insert into integration_sync_state(source_key,last_verified_at,updated_at) values('notion_rates',now(),now())");
  await db.exec(readFileSync("scripts/notion-rates-bootstrap.sql","utf8"));
  await db.exec(execFileSync(process.execPath,["scripts/build-native-notion-release.mjs","--stdout"],{encoding:"utf8"}));
  expect(await scalar(db,"select to_regclass('public.bcv_rate_publications') is null")).toBe(true);
 }
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
 await db.exec("set role authenticated");
 const product=await scalar(db,"select catalog_save_product(null,'Aceite de prueba','Aceites',null,10,null,null,true,true,null)");
 if(mode==="NOTION") {
  await db.exec("reset role");
  const priceBefore=await scalar(db,"select to_jsonb(p)-'updated_at' from products p where id='"+product.id+"'");
  await db.query("select lubricenter_private.apply_notion_pricing(879,1070,$1::jsonb,now())",[JSON.stringify([{name:"Aceite de prueba",base_usd:999,category:"No debe sustituir el catálogo"}])]);
  expect(await scalar(db,"select to_jsonb(p)-'updated_at' from products p where id='"+product.id+"'")).toEqual(priceBefore);
  await db.exec("select lubricenter_private.apply_notion_pricing(879,1070,'[]'::jsonb,now())");
  expect(Number(await scalar(db,"select operative_rate from current_exchange_rates"))).toBe(1070);
  expect(await scalar(db,"select public.exchange_rate_authority()")).toBe("NOTION");
  await db.exec("set role authenticated");
  await db.exec("select public.assert_notion_pricing_fresh()");
  const control=await scalar(db,"select public.get_exchange_rate_control_status()");
  expect(control.exchange_rate_authority).toBe("NOTION");expect(control.rates_fresh).toBe(true);
 }
 const sku=await scalar(db,"select catalog_prepare_inventory_item($1,'TEST-OIL','Prueba','UND')",[product.id]);
 expect(await scalar(db,"select catalog_prepare_inventory_item($1,'TEST-OIL','Prueba','UND')",[product.id])).toBe(sku);
 expect(Number(await scalar(db,"select count(*) from inventory_movements"))).toBe(0);
 const supplier=await scalar(db,"select upsert_supplier(null,'Proveedor de prueba',null,null,null,null,null,null,null,'VES',0,null,true)");
 const invoice=await scalar(db,"select create_supplier_invoice($1,'SIM-01',(now() at time zone 'America/Caracas')::date,null,'VES',$2::jsonb,0,0,0,null)",[supplier,JSON.stringify([{line_type:"INVENTORY",inventory_item_id:sku,description:"Aceite de prueba",quantity:12,unit_cost:3516}])]);
 const line=await scalar(db,"select id from supplier_invoice_items where supplier_invoice_id=$1",[invoice]);
 const cab=await scalar(db,"select id from locations where code='CABUDARE'"),cuji=await scalar(db,"select id from locations where code='EL_CUJI'");
 const exportUi=async(stage:string)=>{
  if(mode!=="NOTION"||!process.env.E2E_FIXTURE_DIR)return;
  const directory=process.env.E2E_FIXTURE_DIR;mkdirSync(directory,{recursive:true});
  const detail=await scalar(db,"select supplier_invoice_detail($1)",[invoice]);
  const data={invoiceId:invoice,skuId:sku,supplierId:supplier,productId:product.id,cab,cuji,owner,operator,
   detail,dashboard:await scalar(db,"select purchasing_dashboard(date_trunc('month',now())::date,(now() at time zone 'America/Caracas')::date)"),
   history:await scalar(db,"select purchase_receipt_history($1)",[invoice]),
   pricing:(await db.query("select * from get_pricing_sync_status()")).rows,
   control:await scalar(db,"select get_exchange_rate_control_status()"),
   catalog:(await db.query("select * from get_catalog_snapshot()")).rows,
   products:(await db.query("select * from products")).rows,inventory:(await db.query("select * from inventory_items")).rows,
   settings:(await db.query("select * from app_settings")).rows,locations:(await db.query("select * from locations order by code")).rows};
  writeFileSync(`${directory}/${stage}.json`,JSON.stringify(data));
 };
 await exportUi("before");
 const request="50000000-0000-4000-8000-000000000001";
 const receive="select inventory_receive_purchase($1,$2,$3,(now() at time zone 'America/Caracas')::date,$4::jsonb,null)";
 const args=[request,invoice,cab,JSON.stringify([{line_id:line,quantity:6}])];
 const receipt=await scalar(db,receive,args);
 expect(await scalar(db,receive,args)).toBe(receipt);
 await exportUi("partial");
 await scalar(db,receive,["50000000-0000-4000-8000-000000000002",invoice,cuji,JSON.stringify([{line_id:line,quantity:6}])]);
 await exportUi("full");
 expect(Number(await scalar(db,"select sum(quantity_delta) from inventory_movements where location_id=$1",[cab]))).toBe(6);
 expect(Number(await scalar(db,"select sum(quantity_delta) from inventory_movements where location_id=$1",[cuji]))).toBe(6);
 expect(Number(await scalar(db,"select average_cost_ref from inventory_items where id=$1",[sku]))).toBe(4);
 expect(Number(await scalar(db,"select cash_usd_base_price from products where id=$1",[product.id]))).toBe(10);
 expect(Number(await scalar(db,"select count(*) from account_movements"))).toBe(0);
 expect(await scalar(db,"select status from supplier_invoices where id=$1",[invoice])).toBe("OPEN");
 expect((await scalar(db,"select purchase_receipt_history($1)",[invoice])).map((x:any)=>x.location_name).sort()).toEqual(["Cabudare","El Cují"]);
 expect((await scalar(db,"select inventory_item_history($1,$2)",[sku,cab]))[0].unit_cost_ref).toBe(4);
 await expect(db.query("select inventory_set_count_at_location($1,$2,5,7,'Conteo desactualizado')",[sku,cab])).rejects.toThrow(/existencias cambiaron/);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[operator]);
 await expect(db.query(receive,args)).rejects.toThrow();
 await expect(db.query("select upsert_supplier(null,'No autorizado',null,null,null,null,null,null,null,'USD',0,null,true)")).rejects.toThrow();
 await expect(db.query("select set_operative_manual(1100,'No autorizado')")).rejects.toThrow();
 expect(await scalar(db,"select has_function_privilege('authenticated','receive_supplier_invoice(uuid,date,jsonb,uuid,text)','execute')")).toBe(false);
 if(mode==="NOTION") {
  await db.exec("reset role; update integration_sync_state set last_verified_at=now()-interval '4 hours' where source_key='notion_rates'");
  await expect(db.exec("select public.assert_notion_pricing_fresh()")).rejects.toThrow(/Tasas de Notion desactualizadas/);
 }
 }finally{await db.close();}
},120000);
