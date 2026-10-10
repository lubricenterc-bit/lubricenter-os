import {describe,it,expect} from "vitest";
import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {
  casheaAutoAmount,casheaCurrency,casheaPaymentPreview,
  CASHEA_INITIAL_METHODS,type CasheaSplitLine
} from "../lib/cashea-split";

const id=(n:number)=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
function line(method:CasheaSplitLine["method"],amount:string,reference=""):CasheaSplitLine{
  return {id:method,method,amount,reference,autoFill:false};
}

describe("Cobros Cashea por cuenta",()=>{
  it("separa el BNC del Venezuela conservando sus referencias",()=>{
    const preview=casheaPaymentPreview([
      line("TRANSFER_BDV","1500.00","4321"),line("TRANSFER_BNC","2500.00","8765")
    ],4000,100);
    expect(preview.valid).toBe(true);
    expect(preview.payload).toEqual([
      {method:"TRANSFER_BDV",amount:"1500.00",reference:"4321"},
      {method:"TRANSFER_BNC",amount:"2500.00",reference:"8765"}
    ]);
  });
  it("convierte Zelle y Binance a la tasa BCV de Cashea",()=>{
    const preview=casheaPaymentPreview([line("ZELLE","10.00","ZE-1234"),
      line("CASH_VES","3000.00")],4000,100);
    expect(preview.paidVes).toBe(4000);
    expect(preview.valid).toBe(true);
    expect(casheaCurrency("ZELLE")).toBe("USD");
    expect(casheaCurrency("BINANCE")).toBe("USD");
    expect(casheaAutoAmount(2000,"CASH_USD",100)).toBe("20.00");
  });
  it("impide diferencias y referencias inválidas antes de cerrar",()=>{
    expect(casheaPaymentPreview([line("TRANSFER_BNC","3999.99","1234")],4000,100).error).toContain("Faltan");
    expect(casheaPaymentPreview([line("TRANSFER_BNC","4000.01","1234")],4000,100).error).toContain("Sobran");
    expect(casheaPaymentPreview([line("TRANSFER_BNC","4000.00","12")],4000,100).error).toContain("referencia bancaria");
    expect(casheaPaymentPreview([line("BINANCE","40.00","")],4000,100).valid).toBe(false);
    expect(casheaPaymentPreview([],0,100).valid).toBe(true);
    expect(CASHEA_INITIAL_METHODS.map(x=>x[0])).not.toContain("MOBILE_PAYMENT");
  });
});

const mockSchema=[
  "CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth; CREATE SCHEMA lubricenter_private;",
  "CREATE FUNCTION public.require_auth() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;",
  "CREATE TABLE orders(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_number text DEFAULT 'OS-TEST',status text DEFAULT 'OPEN',business_at timestamptz,closed_at timestamptz,total_ref numeric,total_ves numeric);",
  "CREATE TABLE order_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,charged_ref_amount numeric,charged_ves_amount numeric);",
  "CREATE TABLE financial_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text UNIQUE,currency text,active boolean DEFAULT true);",
  "CREATE TABLE payments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid,method text,currency text,amount_original numeric,bcv_rate_snapshot numeric,operative_rate_snapshot numeric,value_ves numeric,value_ref numeric,reference text,financial_account_id uuid,paid_at timestamptz);",
  "CREATE TABLE account_movements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid,source_payment_id uuid UNIQUE,currency text,amount_original numeric,value_ves numeric,reference text);",
  "CREATE TABLE cashea_sales(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),order_id uuid UNIQUE,status text,initial_percent numeric,commission_percent numeric,gross_ref numeric,gross_ves_snapshot numeric,initial_ref numeric,initial_ves_snapshot numeric,financed_ref numeric,commission_ref numeric,commission_ves_snapshot numeric,bcv_rate_snapshot numeric,initial_payment_method text NOT NULL CHECK(initial_payment_method IN ('CASH_USD','CASH_VES','MOBILE_PAYMENT','TRANSFER_BDV','TRANSFER_BNC')),cashea_reference text);",
  "CREATE TABLE cashea_installments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),cashea_sale_id uuid,installment_no int,due_date date);",
  "CREATE TABLE audit_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),event_type text,entity_type text,entity_id uuid,data jsonb);",
  "CREATE VIEW current_exchange_rates AS SELECT 100::numeric bcv_rate,250::numeric operative_rate;",
  "CREATE FUNCTION public.validate_order_ready_to_close(uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END; $$;",
  "INSERT INTO financial_accounts(code,currency) VALUES ('BDV','VES'),('BNC','VES'),('CASH_USD','USD'),('CASH_VES','VES'),('ZELLE','USD'),('BINANCE','USD');",
  "CREATE FUNCTION assign_payment_account_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN SELECT id INTO NEW.financial_account_id FROM public.financial_accounts WHERE code=CASE NEW.method WHEN 'TRANSFER_BDV' THEN 'BDV' WHEN 'TRANSFER_BNC' THEN 'BNC' ELSE NEW.method END AND active AND currency=NEW.currency; IF NEW.financial_account_id IS NULL THEN RAISE EXCEPTION 'Cuenta incorrecta'; END IF; RETURN NEW; END; $$;",
  "CREATE TRIGGER assign_payment_before BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION assign_payment_account_test();",
  "CREATE FUNCTION capture_payment_movement_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.account_movements(account_id,source_payment_id,currency,amount_original,value_ves,reference) VALUES(NEW.financial_account_id,NEW.id,NEW.currency,NEW.amount_original,NEW.value_ves,NEW.reference); RETURN NEW; END; $$;",
  "CREATE TRIGGER capture_payment_after AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION capture_payment_movement_test();",
  "CREATE FUNCTION lubricenter_private.close_order_cashea(p_id uuid,p_pct numeric,p_method text,p_ref text,p_cashea text,p_ves numeric,p_ref_total numeric,p_bcv numeric) RETURNS uuid LANGUAGE plpgsql AS $$ DECLARE sid uuid;v_paid numeric;BEGIN SELECT coalesce(sum(value_ves),0) INTO v_paid FROM public.payments WHERE order_id=p_id; IF v_paid<>round(round(p_ref_total*p_pct/100,4)*p_bcv,2) THEN RAISE EXCEPTION 'La inicial no cuadra'; END IF; INSERT INTO public.cashea_sales(order_id,status,initial_percent,commission_percent,gross_ref,gross_ves_snapshot,initial_ref,initial_ves_snapshot,financed_ref,commission_ref,commission_ves_snapshot,bcv_rate_snapshot,initial_payment_method,cashea_reference) VALUES(p_id,'ACTIVE',p_pct,4,p_ref_total,p_ves,round(p_ref_total*p_pct/100,4),v_paid,p_ref_total-round(p_ref_total*p_pct/100,4),round(p_ref_total*.04,4),round(p_ref_total*.04*p_bcv,2),p_bcv,p_method,p_cashea) RETURNING id INTO sid; UPDATE public.orders SET status='CLOSED',closed_at=now() WHERE id=p_id; INSERT INTO public.cashea_installments(cashea_sale_id,installment_no,due_date) VALUES(sid,1,current_date+14); RETURN sid; END; $$;",
  "CREATE FUNCTION lubricenter_private.quick_sale_dated(p_items jsonb,p_mode text,p_date timestamptz,p_method text,p_reference text,p_pct numeric,p_cashea text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE oid uuid;BEGIN IF p_mode<>'DRAFT' THEN RAISE EXCEPTION 'Solo DRAFT'; END IF; INSERT INTO public.orders(business_at,total_ref,total_ves) VALUES(p_date,100,10000) RETURNING id INTO oid; INSERT INTO public.order_items(order_id,charged_ref_amount,charged_ves_amount) VALUES(oid,100,10000); RETURN jsonb_build_object('order_id',oid); END; $$;"
].join("\n");
async function dbSetup(){
  const db=new PGlite();
  await db.exec(mockSchema);
  await db.exec(readFileSync("supabase/migrations/20261010_cashea_split_payments.sql","utf8"));
  return db;
}
async function newOrder(db:PGlite,n:number){
  await db.query("INSERT INTO public.orders(id,total_ref,total_ves) VALUES ($1,100,10000)",[id(n)]);
  await db.query("INSERT INTO public.order_items(order_id,charged_ref_amount,charged_ves_amount) VALUES ($1,100,10000)",[id(n)]);
  return id(n);
}
const closeSql="SELECT public.close_order_cashea_split($1,$2,$3::jsonb,$4,$5,$6,$7)";
function split(method:string,amount:string,reference:string|null){
  return {method,amount,reference};
}

describe("Cashea en PostgreSQL con simulación de disparadores contables",()=>{
  it("dos bancos generan dos movimientos de caja y una venta Cashea",async()=>{
    const db=await dbSetup();
    try{
      const order=await newOrder(db,1);
      const rows=[split("TRANSFER_BDV","1500.00","4321"),split("TRANSFER_BNC","2500.00","8765")];
      await db.query(closeSql,[order,40,JSON.stringify(rows),"12345",10000,100,100]);
      const entries=await db.query<{code:string;value_ves:number;reference:string}>(
        "SELECT f.code,m.value_ves,m.reference FROM account_movements m JOIN financial_accounts f ON f.id=m.account_id ORDER BY f.code");
      expect(entries.rows.map(r=>[r.code,Number(r.value_ves),r.reference]))
        .toEqual([["BDV",1500,"4321"],["BNC",2500,"8765"]]);
      const sale=await db.query<{initial_payment_method:string;financed_ref:number}>(
        "SELECT initial_payment_method,financed_ref FROM cashea_sales WHERE order_id=$1",[order]);
      expect(sale.rows[0].initial_payment_method).toBe("MIXED");
      expect(Number(sale.rows[0].financed_ref)).toBe(60);
      await expect(db.query(closeSql,[order,40,JSON.stringify(rows),"12345",10000,100,100]))
        .rejects.toThrow(/ya quedó registrada/);
      expect((await db.query("SELECT id FROM payments")).rows).toHaveLength(2);
    }finally{await db.close();}
  },30000);
  it("conserva abonos anteriores, cobra Zelle a BCV y evita duplicaciones",async()=>{
    const db=await dbSetup();
    try{
      const order=await newOrder(db,2);
      await db.query("INSERT INTO payments(order_id,method,currency,amount_original,bcv_rate_snapshot,operative_rate_snapshot,value_ves,value_ref,reference,paid_at) VALUES ($1,'TRANSFER_BDV','VES',1000,100,250,1000,10,'4567',now())",[order]);
      const rows=[split("ZELLE","10.00","ZE-5678"),split("CASH_VES","2000.00",null)];
      await db.query(closeSql,[order,40,JSON.stringify(rows),"321",10000,100,100]);
      const entries=await db.query<{code:string;value_ves:number}>(
        "SELECT f.code,m.value_ves FROM account_movements m JOIN financial_accounts f ON f.id=m.account_id ORDER BY f.code");
      expect(entries.rows.map(r=>[r.code,Number(r.value_ves)]))
        .toEqual([["BDV",1000],["CASH_VES",2000],["ZELLE",1000]]);
      expect((await db.query("SELECT id FROM payments")).rows).toHaveLength(3);
    }finally{await db.close();}
  },30000);
  it("si hay diferencia o referencia mala no deja abonos ni cierre parcial",async()=>{
    const db=await dbSetup();try{
      const order=await newOrder(db,3);
      for(const rows of [
        [split("TRANSFER_BNC","4000.00","123")],
        [split("TRANSFER_BNC","3999.99","1234")],
        [split("TRANSFER_BDV","4000.01","1234")]
      ]){
        await expect(db.query(closeSql,[order,40,JSON.stringify(rows),"123",10000,100,100])).rejects.toThrow();
        expect((await db.query("SELECT id FROM payments")).rows).toHaveLength(0);
        expect((await db.query("SELECT id FROM account_movements")).rows).toHaveLength(0);
      }
      expect((await db.query("SELECT status FROM orders WHERE id=$1",[order])).rows[0]).toHaveProperty("status","OPEN");
    }finally{await db.close();}
  },30000);
  it("reintento de venta rápida no crea otra orden ni vuelve a cobrar",async()=>{
    const db=await dbSetup();try{
      const req=id(500);
      const args=[req,JSON.stringify([{kind:"MANUAL",quantity:1,unit_ref:100}]),null,40,
        JSON.stringify([split("TRANSFER_BNC","4000.00","7722")]),"223344",10000,100,100];
      const sql="SELECT public.quick_sale_cashea_split($1,$2::jsonb,$3::timestamptz,$4,$5::jsonb,$6,$7,$8,$9) AS result";
      const x=await db.query<{result:{order_id:string}}>(sql,args);
      const y=await db.query<{result:{order_id:string}}>(sql,args);
      expect(x.rows[0].result.order_id).toBe(y.rows[0].result.order_id);
      expect((await db.query("SELECT id FROM orders")).rows).toHaveLength(1);
      expect((await db.query("SELECT id FROM payments")).rows).toHaveLength(1);
      expect((await db.query("SELECT id FROM account_movements")).rows).toHaveLength(1);
      const changed=[...args];changed[4]=JSON.stringify([split("TRANSFER_BDV","4000.00","7722")]);
      await expect(db.query(sql,changed)).rejects.toThrow(/otro desglose/);
    }finally{await db.close();}
  },30000);
});
