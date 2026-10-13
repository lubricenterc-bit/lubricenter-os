import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";

let db: PGlite;
const owner="10000000-0000-0000-0000-000000000001";
const bdv="20000000-0000-0000-0000-000000000001";
const cash="20000000-0000-0000-0000-000000000002";
const binance="20000000-0000-0000-0000-000000000003";

async function asOwner(){
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
  await db.exec("set role authenticated");
}
async function root(){await db.exec("reset role")}
async function dashboard():Promise<any>{
  return (await db.query("select public.finance_currency_summary('2026-09-10','2026-09-11') as report")).rows[0] as any;
}
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(gunzipSync(readFileSync("tests/fixtures/production-structure.sql.gz")).toString());
  await db.exec(readFileSync("supabase/migrations/20261013170000_finance_three_currency_views.sql","utf8"));
  await db.exec("insert into auth.users values('"+owner+"','lubricenterc@gmail.com',now())");
  await db.exec("insert into public.financial_accounts(id,code,name,currency,account_type) values "+
    "('"+bdv+"','BDV','Banco de Venezuela','VES','BANK'),"+
    "('"+cash+"','CASH_USD','Caja USD','USD','CASH'),"+
    "('"+binance+"','BINANCE','Binance USDT','USD','CLEARING')");
  await db.exec("insert into public.exchange_rates(rate_type,value,effective_at) values "+
    "('BCV',800,'2026-09-10T00:00:00-04:00'),"+
    "('BCV',1000,'2026-09-11T00:00:00-04:00'),"+
    "('OPERATIVE',1000,'2026-09-10T00:00:00-04:00')");
},120000);
afterAll(async()=>{await db?.close()});
beforeEach(async()=>{await db.exec("begin");await asOwner()});
afterEach(async()=>{await db.exec("rollback");await root()});

describe("Separated finance currencies",()=>{
  it("uses the historical BCV rate of each VES collection and never converts USD collections into Bs",async()=>{
    await root();
    await db.exec("insert into public.account_movements(account_id,direction,movement_type,currency,amount_original,value_ves,occurred_at) values "+
      "('"+bdv+"','IN','PAYMENT','VES',10000,10000,'2026-09-10T12:00:00-04:00'),"+
      "('"+bdv+"','IN','PAYMENT','VES',10000,10000,'2026-09-11T12:00:00-04:00'),"+
      "('"+cash+"','IN','PAYMENT','USD',20,20000,'2026-09-10T12:00:00-04:00')");
    await asOwner();
    const r=(await dashboard()).report as any;
    expect(Number(r.bs.collections)).toBe(20000);
    expect(Number(r.bcv.collections)).toBe(22.5);
    expect(Number(r.usd.collections)).toBe(20);
    expect(Number(r.operative.external_entries)).toBe(20);
    expect(r.accounts.find((a:any)=>a.code==="CASH_USD").closing).toBe(20);
  });

  it("records an exchange as two linked transfers without creating any sale",async()=>{
    const group=(await db.query<{id:string}>("select public.finance_transfer_fx($1,$2,$3,$4,$5,$6) as id",
      [bdv,binance,10000,10,"Compra USDT","1234"])).rows[0].id;
    const raw=await db.query<{currency:string;amount_original:string;direction:string;movement_type:string}>(
      "select currency,amount_original,direction,movement_type from public.account_movements where transfer_group=$1 order by direction",[group]);
    expect(raw.rows).toHaveLength(2);
    expect(raw.rows.map(x=>x.movement_type)).toEqual(["TRANSFER","TRANSFER"]);
    const r=(await dashboard()).report as any;
    expect(Number(r.bs.outflows)).toBe(10000);
    expect(Number(r.usd.entries)).toBe(10);
    expect(Number(r.bs.collections)).toBe(0);
    expect(Number(r.usd.collections)).toBe(0);
    expect(Number(r.usd.external_entries)).toBe(0);
    expect(Number(r.bs.external_outflows)).toBe(0);
  });

  it("never grants the new finance RPC anonymously",async()=>{
    await root();
    const {rows}=await db.query<{allowed:boolean}>("select has_function_privilege('anon','public.finance_currency_summary(date,date)','EXECUTE') allowed");
    expect(rows[0].allowed).toBe(false);
    await asOwner();
  });
});