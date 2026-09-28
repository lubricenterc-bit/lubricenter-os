import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;

async function scalar<T>(query: string, params: unknown[] = []): Promise<T> {
  const result = await db.query(query, params);
  return Object.values(result.rows[0] as object)[0] as T;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(gunzipSync(readFileSync("tests/fixtures/production-structure.sql.gz")).toString());
  await db.exec(readFileSync("supabase/migrations/20260928120000_crm_messages_oil_type.sql", "utf8"));
}, 120000);

afterAll(async () => { await db?.close(); });

describe("post-service message", () => {
  it("shows oil specifics, additional work and courtesy without repeating billed oil products", async () => {
    const customer = await scalar<string>("insert into customers(name) values('María Pérez') returning id");
    const vehicle = await scalar<string>("insert into vehicles(customer_id,plate,make,model) values($1,'ABC123','Toyota','Corolla') returning id", [customer]);
    const order = await scalar<string>("insert into orders(customer_id,vehicle_id,crm_additional_services,crm_bonuses) values($1,$2,array['Chequeo de fluidos'],array['Relleno de líquido limpiaparabrisas']) returning id", [customer, vehicle]);
    await db.query(`insert into order_items(order_id,item_type,business_area,description,quantity,charged_ves_amount,charged_ref_amount,bcv_rate_snapshot,operative_rate_snapshot,service_odometer,oil_brand,oil_viscosity,oil_base_type,oil_filter_code,next_service_odometer,next_service_date)
      values($1,'SERVICE','OIL_CHANGE','Cambio de aceite',1,0,0,800,800,80000,'INCA','25W-60','MINERAL','W 712/52',85000,'2026-11-15')`, [order]);
    await db.query(`insert into order_items(order_id,item_type,business_area,description,quantity,charged_ves_amount,charged_ref_amount,bcv_rate_snapshot,operative_rate_snapshot)
      values($1,'PRODUCT','OIL_CHANGE','INCA 25W60 MINERAL',1,1000,1.25,800,800)`, [order]);
    const message = await scalar<string>("select build_post_service_message($1)", [order]);
    expect(message).toContain("*Aceite:* *INCA* · *25W-60* · *mineral*");
    expect(message).toContain("*Filtro de aceite:* W 712/52");
    expect(message).toContain("*También hicimos*");
    expect(message).toContain("Chequeo de fluidos");
    expect(message).toContain("*De cortesía*");
    expect(message).toContain("Relleno de líquido limpiaparabrisas");
    expect(message).toContain("85");
    expect(message).not.toContain("*Productos / repuestos:*");
    expect(message.match(/INCA/g)?.length).toBe(1);
    await db.query("update order_items set oil_brand='INCA 25W60 MINERAL',oil_base_type=null where order_id=$1 and item_type='SERVICE'", [order]);
    const legacyMessage = await scalar<string>("select build_post_service_message($1)", [order]);
    expect(legacyMessage).toContain("*Aceite:* *INCA* · *25W-60* · *mineral*");
  });

  it("omits empty optional sections and never invents a workshop review", async () => {
    const customer = await scalar<string>("insert into customers(name) values('José Pérez') returning id");
    const vehicle = await scalar<string>("insert into vehicles(customer_id,plate,make,model) values($1,'DEF456','Chevrolet','Aveo') returning id", [customer]);
    const order = await scalar<string>("insert into orders(customer_id,vehicle_id,crm_bonuses) values($1,$2,array['Limpieza bajo el capó con ducha marina']) returning id", [customer, vehicle]);
    await db.query(`insert into order_items(order_id,item_type,business_area,description,quantity,charged_ves_amount,charged_ref_amount,bcv_rate_snapshot,operative_rate_snapshot)
      values($1,'SERVICE','WORKSHOP','Cambio de pastillas de freno delanteras',1,1000,1.25,800,800)`, [order]);
    const message = await scalar<string>("select build_post_service_message($1)", [order]);
    expect(message).toContain("Cambio de pastillas de freno delanteras");
    expect(message).toContain("Limpieza bajo el capó con ducha marina");
    expect(message).not.toContain("Próxima revisión");
    expect(message).not.toContain("Para tener en cuenta");
    expect(message).not.toMatch(/\n{3,}/);
  });

  it("records the selected oil type atomically with a manual oil package", async () => {
    const user = "10000000-0000-0000-0000-000000000099";
    await db.exec(`insert into auth.users values('${user}','operator@example.test',now());
      insert into exchange_rates(rate_type,value,effective_at) values('OPERATIVE',850,'2026-09-28'),('BCV',800,'2026-09-28');`);
    const customer = await scalar<string>("insert into customers(name) values('María Test') returning id");
    const vehicle = await scalar<string>("insert into vehicles(customer_id,plate,make,model) values($1,'TEST99','Toyota','Corolla') returning id", [customer]);
    const order = await scalar<string>("insert into orders(customer_id,vehicle_id) values($1,$2) returning id", [customer, vehicle]);
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
    await db.exec("set role authenticated");
    const item = await scalar<string>(`select add_oil_change_package_with_type(
      $1,80000,'Cambio de aceite',0,0,'MANUAL',null,null,'INCA 25W60 MINERAL',1,10,
      'INCA','25W-60',4,'NONE',null,null,null,1,null,null,5000,3,'MINERAL')`, [order]);
    await db.exec("reset role");
    expect(await scalar<string>("select oil_base_type from order_items where id=$1", [item])).toBe("MINERAL");
    expect(await scalar<string>("select build_post_service_message($1)", [order])).toContain("*INCA* · *25W-60* · *mineral*");
  });
});
