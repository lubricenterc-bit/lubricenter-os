import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {describe,it,expect} from "vitest";

const migration = readFileSync(
  "supabase/migrations/20261013225500_catalog_direct_rates_compatibility.sql",
  "utf8"
);

async function scenario(verified = true) {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE public.app_settings(key text primary key, value jsonb);
    CREATE TABLE public.products(
      id uuid primary key default gen_random_uuid(), name text not null,
      active boolean, available boolean, cash_usd_base_price numeric,
      catalog_source text, catalog_synced_at timestamptz
    );
    CREATE TABLE public.integration_sync_state(source_key text primary key, last_verified_at timestamptz);
    CREATE TABLE public.exchange_rates(
      rate_type text, value numeric, effective_at timestamptz,source text default 'BCV_API_DATE_VALUE',
      created_at timestamptz default now()
    );
    CREATE TABLE public.bcv_rate_publications(value_date date);
    CREATE FUNCTION public.set_operative_manual(numeric,text)
      RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$;
    CREATE VIEW public.current_exchange_rates AS
      SELECT
        (SELECT value FROM public.exchange_rates WHERE rate_type='BCV' AND effective_at<=now()
          ORDER BY effective_at DESC,created_at DESC LIMIT 1) bcv_rate,
        (SELECT value FROM public.exchange_rates WHERE rate_type='OPERATIVE' AND effective_at<=now()
          ORDER BY effective_at DESC,created_at DESC LIMIT 1) operative_rate;
    INSERT INTO public.app_settings VALUES('catalog_authority','"LUBRICENTER_OS"'::jsonb);
    INSERT INTO public.products(name,active,available,cash_usd_base_price,catalog_source,catalog_synced_at)
      VALUES('Aceite 15W-40',true,true,14,'Lubricenter OS',now()-interval '40 days');
    INSERT INTO public.exchange_rates(rate_type,value,effective_at) VALUES
      ('BCV',879.1225,now()-interval '1 day'),
      ('OPERATIVE',1061.32,now()-interval '20 days'),
      ('BCV',9900,now()+interval '2 days');
    INSERT INTO public.integration_sync_state VALUES
      ('notion_catalog',now()-interval '40 days'),
      ('notion_rates',now()-interval '40 days');
  `);
  const authoritySql=readFileSync("scripts/notion-rates-bootstrap.sql","utf8").match(/create or replace function public\.exchange_rate_authority\(\)[\s\S]*?\$\$;/)?.[0];
  if(!authoritySql)throw Error("Missing exchange-rate authority definition");
  await db.exec(authoritySql);
  if (verified) await db.exec(
    "INSERT INTO public.integration_sync_state VALUES('bcv_direct',now())"
  );
  return db;
}

describe("Native catalog + direct rates bridge", () => {
  it("rejects a cutover if the direct BCV feed has not been verified", async () => {
    const db = await scenario(false);
    try {
      await expect(db.exec(migration)).rejects.toThrow(/Direct BCV sync not verified/);
    } finally { await db.close(); }
  });
  it("does not block native sales for an old Notion heartbeat or unchanged manual rate", async () => {
    const db = await scenario();
    try {
      await db.exec(migration);
      await expect(db.exec("SELECT public.assert_notion_pricing_fresh()"))
        .resolves.toBeDefined();
      const rates = (await db.query<{
        catalog_products: number; bcv_rate: number; operative_rate: number;
        fresh: boolean;
      }>(`SELECT catalog_products::int,bcv_rate::float8,operative_rate::float8,
          (catalog_synced_at > now()-interval '1 minute') AS fresh
          FROM public.get_pricing_sync_status()`)).rows[0];
      expect(rates).toMatchObject({
        catalog_products:1, bcv_rate:879.1225, operative_rate:1061.32, fresh:true
      });
    } finally { await db.close(); }
  });
  it("retains a real freshness requirement for Notion while it owns the catalog", async () => {
    const db = await scenario();
    try {
      await db.exec(migration);
      await db.exec(`UPDATE public.app_settings SET value='"NOTION"'::jsonb
        WHERE key='catalog_authority'`);
      await expect(db.exec("SELECT public.assert_notion_pricing_fresh()"))
        .rejects.toThrow(/Notion/);
    } finally { await db.close(); }
  });
  it("blocks missing active BCV values, rather than activating a future rate early", async () => {
    const db = await scenario();
    try {
      await db.exec(migration);
      await db.exec("DELETE FROM public.exchange_rates WHERE rate_type='BCV' AND effective_at<=now()");
      await expect(db.exec("SELECT public.assert_notion_pricing_fresh()"))
        .rejects.toThrow(/Faltan tasas/);
    } finally { await db.close(); }
  });
});
