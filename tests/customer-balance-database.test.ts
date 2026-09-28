import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let db: PGlite;
const owner = "10000000-0000-0000-0000-000000000101";
const operator = "10000000-0000-0000-0000-000000000102";

async function one<T>(query: string, params: unknown[] = []): Promise<T> {
  const result = await db.query(query, params);
  return Object.values(result.rows[0] as object)[0] as T;
}
async function asUser(id = owner) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
  await db.exec("set role authenticated");
}
async function root() { await db.exec("reset role"); }

beforeAll(async () => {
  db = new PGlite();
  await db.exec(gunzipSync(readFileSync("tests/fixtures/production-structure.sql.gz")).toString());
  await db.exec(readFileSync("supabase/migrations/20260924145617_usd_pricing_payroll_review.sql", "utf8"));
  for (const file of readdirSync("supabase/migrations").filter(f => f.includes("v22")).sort()) {
    await db.exec(readFileSync(`supabase/migrations/${file}`, "utf8"));
  }
  await db.exec(readFileSync("supabase/migrations/20260925103000_finance_cashea_mixed_accounts_usd_quick_sale.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260928150000_customer_balances.sql", "utf8"));
  await db.exec(readFileSync("supabase/migrations/20260928160000_customer_balance_sale_origins.sql", "utf8"));
  await db.exec(`insert into auth.users values
    ('${owner}','lubricenterc@gmail.com',now()),
    ('${operator}','operator@example.test',now());
    insert into exchange_rates(rate_type,value,effective_at)
    values ('BCV',100,'2026-09-01'),('OPERATIVE',200,'2026-09-01');
    insert into financial_accounts(code,name,currency,account_type)
    values ('CASH_USD','Caja USD','USD','CASH'),('CASH_VES','Caja Bs','VES','CASH'),
      ('BDV','Banco de Venezuela','VES','BANK'),('BNC','BNC','VES','BANK'),
      ('ZELLE','Zelle','USD','BANK'),('BINANCE','Binance','USD','CLEARING') on conflict (code) do nothing;`);
  await asUser();
}, 120000);
afterAll(async () => { await db?.close(); });

async function customer() {
  await root();
  const id = await one<string>("insert into customers(name) values('Cliente saldo') returning id");
  await asUser();
  return id;
}
async function order(customerId: string, totalVes = 2000) {
  await root();
  const id = await one<string>("insert into orders(customer_id) values($1) returning id", [customerId]);
  await db.query(`insert into order_items(order_id,item_type,business_area,description,quantity,
    charged_ves_amount,charged_ref_amount,bcv_rate_snapshot,operative_rate_snapshot)
    values($1,'PRODUCT','STORE','Producto',1,$2,$3,100,200)`, [id, totalVes, totalVes / 100]);
  await asUser();
  return id;
}
async function assertLedgerBalance(customerId: string, pocket: "USD" | "VES_BCV") {
  const balance = Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket=$2", [customerId,pocket]));
  const entries = Number(await one("select coalesce(sum(delta_usd),0) from customer_balance_movements where customer_id=$1 and pocket=$2", [customerId,pocket]));
  expect(balance).toBe(entries);
}

describe("customer balance liability", () => {
  it("indexes bolivar deposits at deposit BCV and applies them at redemption BCV without cash twice", async () => {
    const c = await customer();
    const depositRequest = randomUUID();
    const deposit = await one<string>("select record_customer_balance_deposit($1,'CASH_VES',1000,null,'Anticipo',$2)", [c, depositRequest]);
    expect(await one<string>("select record_customer_balance_deposit($1,'CASH_VES',1000,null,'Anticipo',$2)", [c, depositRequest])).toBe(deposit);
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='VES_BCV'", [c]))).toBe(10);
    expect(Number(await one("select amount_original from account_movements where category='CUSTOMER_BALANCE_DEPOSIT'"))).toBe(1000);
    await root();
    await db.exec("insert into exchange_rates(rate_type,value,effective_at) values ('BCV',200,'2026-09-28')");
    await asUser();
    const o = await order(c, 2000);
    const useRequest = randomUUID();
    const result = await one<{ payment_id: string; used_usd: number; value_ves: number }>(
      "select apply_customer_balance($1,'VES_BCV',5,$2)", [o, useRequest]);
    const retry = await one<{ payment_id: string }>("select apply_customer_balance($1,'VES_BCV',5,$2)", [o, useRequest]);
    expect(retry.payment_id).toBe(result.payment_id);
    expect(Number(result.value_ves)).toBe(1000);
    expect(Number(result.used_usd)).toBe(5);
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='VES_BCV'", [c]))).toBe(5);
    await assertLedgerBalance(c,"VES_BCV");
    expect(Number(await one("select count(*) from account_movements"))).toBe(1);
    expect(await one("select currency from payments where id=$1", [result.payment_id])).toBe("VES");
    await one("select add_payment($1,'CASH_VES',1000,null)", [o]);
    await one("select close_order($1)", [o]);
    expect(await one("select status from orders where id=$1", [o])).toBe("CLOSED");
    const dashboard = await one<{ collections: { total_ves: number }; customer_balance_cash: { deposits_ves: number }; net_cash_ves: number }>("select finance_dashboard('2026-09-28','2026-09-28')");
    expect(Number(dashboard.collections.total_ves)).toBe(1000);
    expect(Number(dashboard.customer_balance_cash.deposits_ves)).toBe(1000);
    expect(Number(dashboard.net_cash_ves)).toBe(2000);
    expect(Number(await one("select collected_ves_today from dashboard_overview()"))).toBe(1000);
  });

  it("keeps dollar deposits in dollars and permits only dollar refunds", async () => {
    const c = await customer();
    await one("select record_customer_balance_deposit($1,'CASH_USD',20,null,'Anticipo',$2)", [c, randomUUID()]);
    await expect(one("select refund_customer_balance($1,'USD',5,'CASH_VES',null,'Solicitud cliente',$2)", [c, randomUUID()]))
      .rejects.toThrow();
    const refund = await one<string>("select refund_customer_balance($1,'USD',5,'CASH_USD',null,'Solicitud cliente',$2)", [c, randomUUID()]);
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='USD'", [c]))).toBe(15);
    expect(await one("select currency from account_movements where id=(select account_movement_id from customer_balance_movements where id=$1)", [refund])).toBe("USD");
    const o = await order(c, 2000);
    const used = await one<{ used_usd: number; value_ves: number }>("select apply_customer_balance($1,'USD',10,$2)", [o, randomUUID()]);
    expect(Number(used.value_ves)).toBe(2000);
    expect(await one("select status from orders where id=$1", [o])).toBe("OPEN");
    await one("select close_order($1)", [o]);
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='USD'", [c]))).toBe(5);
    await assertLedgerBalance(c,"USD");
  });

  it("returns a removed or cancelled application exactly once", async () => {
    const c = await customer();
    await one("select record_customer_balance_deposit($1,'CASH_USD',10,null,'Anticipo',$2)", [c, randomUUID()]);
    const o = await order(c, 1000);
    const result = await one<{ payment_id: string }>("select apply_customer_balance($1,'USD',5,$2)", [o, randomUUID()]);
    await one("select delete_payment($1)", [result.payment_id]);
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='USD'", [c]))).toBe(10);
    expect(Number(await one("select count(*) from customer_balance_movements where payment_id=$1 and movement_type='RELEASE'", [result.payment_id]))).toBe(1);
    const used = await one<{ payment_id: string }>("select apply_customer_balance($1,'USD',5,$2)", [o, randomUUID()]);
    await one("select close_order($1)", [o]);
    await one("select cancel_order($1,'Venta cancelada por solicitud del cliente')", [o]);
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='USD'", [c]))).toBe(10);
    expect(Number(await one("select count(*) from customer_balance_movements where payment_id=$1 and movement_type='RELEASE'", [used.payment_id]))).toBe(1);
    await assertLedgerBalance(c,"USD");
  });

  it("blocks overdrafts and restricts refunds to finance administrators", async () => {
    const c = await customer();
    await one("select record_customer_balance_deposit($1,'CASH_USD',2,null,'Anticipo',$2)", [c, randomUUID()]);
    const o = await order(c, 2000);
    await expect(one("select apply_customer_balance($1,'USD',3,$2)", [o, randomUUID()])).rejects.toThrow(/Saldo insuficiente/);
    await asUser(operator);
    await expect(one("select refund_customer_balance($1,'USD',1,'CASH_USD',null,'Solicitud cliente',$2)", [c, randomUUID()])).rejects.toThrow();
    await expect(one("insert into customer_balance_accounts(customer_id,pocket,balance_usd) values($1,'USD',1000)", [c])).rejects.toThrow();
    await asUser();
  });
  it("requires four transfer reference digits and never lets a second customer consume the credit", async () => {
    const c = await customer();
    await expect(one("select record_customer_balance_deposit($1,'TRANSFER_BDV',1000,'12','Anticipo',$2)", [c,randomUUID()])).rejects.toThrow(/últimos 4/);
    await one("select record_customer_balance_deposit($1,'TRANSFER_BDV',1000,'1234','Anticipo',$2)", [c,randomUUID()]);
    const another = await customer();
    const o = await order(another,2000);
    await expect(one("select apply_customer_balance($1,'VES_BCV',1,$2)", [o,randomUUID()])).rejects.toThrow(/Saldo insuficiente/);
    await assertLedgerBalance(c,"VES_BCV");
  });

  it("splits an overpayment into sale cash and an auditable balance without closing excess", async () => {
    const c = await customer();
    const o = await order(c,2000);
    const bcv = Number(await one("select bcv_rate from current_exchange_rates"));
    const payment = await one<string>("select add_payment($1,'CASH_VES',2500,null)",[o]);
    expect(Number(await one("select amount_original from payments where id=$1",[payment]))).toBe(2000);
    const credit = (await db.query<{ origin: string; amount_original: number; order_id: string; payment_id: string }>(
      "select origin,amount_original,order_id,payment_id from customer_balance_movements where payment_id=$1 and origin='OVERPAYMENT'",[payment])).rows[0];
    expect(credit.origin).toBe("OVERPAYMENT");
    expect(Number(credit.amount_original)).toBe(500);
    expect(credit.order_id).toBe(o);
    expect(Number(await one("select sum(amount_original) from account_movements where source_payment_id=$1 or category='CUSTOMER_BALANCE_DEPOSIT' and id=(select account_movement_id from customer_balance_movements where payment_id=$1 and origin='OVERPAYMENT')",[payment]))).toBe(2500);
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='VES_BCV'",[c]))).toBe(Math.round(500/bcv*100)/100);
    await one("select close_order($1)",[o]);
    await assertLedgerBalance(c,"VES_BCV");
    const dollarOrder = await order(c,2000);
    const dollarPayment = await one<string>("select add_payment($1,'CASH_USD',12,null)",[dollarOrder]);
    expect(Number(await one("select amount_original from payments where id=$1",[dollarPayment]))).toBe(10);
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='USD'",[c]))).toBe(2);
    expect(Number(await one("select amount_original from customer_balance_movements where payment_id=$1 and origin='OVERPAYMENT'",[dollarPayment]))).toBe(2);
    await one("select close_order($1)",[dollarOrder]);
    await assertLedgerBalance(c,"USD");
  });

  it("reverses an unused excess with its mistaken payment, but blocks removal after reuse", async () => {
    const c = await customer();
    const o = await order(c,2000);
    const payment = await one<string>("select add_payment($1,'CASH_VES',2500,null)",[o]);
    await one("select delete_payment($1)",[payment]);
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='VES_BCV'",[c]))).toBe(0);
    expect(Number(await one("select count(*) from customer_balance_movements where order_id=$1 and movement_type='REVERSAL'",[o]))).toBe(1);
    await assertLedgerBalance(c,"VES_BCV");
    const second = await order(c,2000);
    const secondPayment = await one<string>("select add_payment($1,'CASH_VES',2500,null)",[second]);
    const next = await order(c,2000);
    await one("select apply_customer_balance($1,'VES_BCV',1,$2)",[next,randomUUID()]);
    await expect(one("select delete_payment($1)",[secondPayment])).rejects.toThrow(/ya se usó/);
    expect(Number(await one("select count(*) from payments where id=$1",[secondPayment]))).toBe(1);
  });

  it("retains a cancelled sale's physical dollars as a liability without inventing cash", async () => {
    const c = await customer();
    const o = await order(c,2000);
    const payment = await one<string>("select add_payment($1,'CASH_USD',10,null)",[o]);
    await one("select close_order($1)",[o]);
    const cashBefore = Number(await one("select count(*) from account_movements where source_payment_id=$1",[payment]));
    const dashboardBefore = await one<{ collections: { total_ves: number }; retained_cancelled_cash_ves: number; net_cash_ves: number }>(
      "select finance_dashboard((now() at time zone 'America/Caracas')::date,(now() at time zone 'America/Caracas')::date)");
    await one("select cancel_order_to_customer_balance($1,'Cliente conserva pago para otra compra')",[o]);
    await one("select cancel_order_to_customer_balance($1,'Cliente conserva pago para otra compra')",[o]);
    expect(await one("select status from orders where id=$1",[o])).toBe("CANCELLED");
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='USD'",[c]))).toBe(10);
    expect(Number(await one("select count(*) from account_movements where source_payment_id=$1",[payment]))).toBe(cashBefore);
    expect(Number(await one("select count(*) from account_movements where category='ORDER_REVERSAL' and reference=(select id::text from account_movements where source_payment_id=$1)",[payment]))).toBe(0);
    expect(Number(await one("select count(*) from customer_balance_movements where origin='CANCELLED_SALE' and payment_id=$1",[payment]))).toBe(1);
    const dashboardAfter = await one<typeof dashboardBefore>(
      "select finance_dashboard((now() at time zone 'America/Caracas')::date,(now() at time zone 'America/Caracas')::date)");
    expect(Number(dashboardBefore.collections.total_ves)-Number(dashboardAfter.collections.total_ves)).toBe(2000);
    expect(Number(dashboardAfter.retained_cancelled_cash_ves)-Number(dashboardBefore.retained_cancelled_cash_ves)).toBe(2000);
    expect(Number(dashboardAfter.net_cash_ves)).toBe(Number(dashboardBefore.net_cash_ves));
    await assertLedgerBalance(c,"USD");
  });

  it("restores a redeemed advance and retains only new cash on cancellation", async () => {
    const c = await customer();
    await one("select record_customer_balance_deposit($1,'CASH_USD',5,null,'Anticipo',$2)",[c,randomUUID()]);
    const o = await order(c,2000);
    await one("select apply_customer_balance($1,'USD',5,$2)",[o,randomUUID()]);
    await one("select add_payment($1,'CASH_VES',1000,null)",[o]);
    await one("select close_order($1)",[o]);
    const bcv = Number(await one("select bcv_rate from current_exchange_rates"));
    await one("select cancel_order_to_customer_balance($1,'Cliente conserva pago para otra compra')",[o]);
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='USD'",[c]))).toBe(5);
    expect(Number(await one("select balance_usd from customer_balance_accounts where customer_id=$1 and pocket='VES_BCV'",[c]))).toBe(Math.round(1000/bcv*100)/100);
    expect(Number(await one("select count(*) from customer_balance_movements where order_id=$1 and origin='CANCELLED_SALE'",[o]))).toBe(1);
    await assertLedgerBalance(c,"USD");
    await assertLedgerBalance(c,"VES_BCV");
  });

  it("requires an identified customer for excess and reserves retained-sale cancellation to the owner", async () => {
    await root();
    const anonymousOrder = await one<string>("insert into orders default values returning id");
    await db.query(`insert into order_items(order_id,item_type,business_area,description,quantity,
      charged_ves_amount,charged_ref_amount,bcv_rate_snapshot,operative_rate_snapshot)
      values($1,'PRODUCT','STORE','Producto',1,2000,20,100,200)`,[anonymousOrder]);
    await asUser();
    await expect(one("select add_payment($1,'CASH_VES',2500,null)",[anonymousOrder]))
      .rejects.toThrow(/Asocia un cliente/);
    expect(Number(await one("select count(*) from payments where order_id=$1",[anonymousOrder]))).toBe(0);
    const c = await customer();
    const o = await order(c,2000);
    await one("select add_payment($1,'CASH_VES',2000,null)",[o]);
    await one("select close_order($1)",[o]);
    await asUser(operator);
    await expect(one("select cancel_order_to_customer_balance($1,'Conservar pago para otra venta')",[o]))
      .rejects.toThrow(/Solo lubricenterc/);
    await asUser();
    expect(await one("select status from orders where id=$1",[o])).toBe("CLOSED");
  });
});
