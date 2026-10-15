-- Stack on PR #60 after PR #59: bridge native catalog with directly sourced rates.
-- Never run this migration until the BCV Edge Function and Cron have been verified.
-- No product, inventory, historical order, payment or rate rows are modified.

DO $guard$
BEGIN
  IF to_regclass('public.bcv_rate_publications') IS NULL
     OR to_regprocedure('public.set_operative_manual(numeric,text)') IS NULL THEN
    RAISE EXCEPTION 'PR #59 must be installed before native catalog / direct rates integration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.integration_sync_state s
    WHERE s.source_key = 'bcv_direct'
      AND s.last_verified_at BETWEEN now() - interval '24 hours' AND now() + interval '5 minutes'
  ) THEN
    RAISE EXCEPTION 'Direct BCV sync not verified in the last 24 hours; do not cut off Notion yet';
  END IF;
END
$guard$;

-- Never require Notion when the database itself owns catalog entries. The
-- historic RPC name is retained for existing checkout callers.
CREATE OR REPLACE FUNCTION public.assert_notion_pricing_fresh()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE
  v_native boolean;
  v_catalog_at timestamptz;
  v_bcv numeric;
  v_op numeric;
  v_bcv_at timestamptz;
BEGIN
  SELECT coalesce((s.value #>> '{}') = 'LUBRICENTER_OS', false)
    INTO v_native FROM public.app_settings s WHERE s.key = 'catalog_authority';
  v_native := coalesce(v_native, false);

  IF v_native THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.products p
      WHERE p.active AND p.available AND p.cash_usd_base_price > 0
    ) THEN
      RAISE EXCEPTION 'No hay artículos publicados con precios válidos';
    END IF;
  ELSE
    SELECT coalesce(
      (SELECT s.last_verified_at FROM public.integration_sync_state s WHERE s.source_key = 'notion_catalog'),
      (SELECT max(p.catalog_synced_at) FROM public.products p WHERE p.catalog_source = 'Notion · Nuestros Productos')
    ) INTO v_catalog_at;
    IF v_catalog_at IS NULL OR v_catalog_at < now() - interval '24 hours' THEN
      RAISE EXCEPTION 'El catálogo de Notion está desactualizado';
    END IF;
  END IF;

  SELECT r.bcv_rate, r.operative_rate INTO v_bcv, v_op
  FROM public.current_exchange_rates r;
  IF v_bcv IS NULL OR v_bcv <= 0 OR v_op IS NULL OR v_op <= 0 THEN
    RAISE EXCEPTION 'Faltan tasas BCV u operativa válidas para vender';
  END IF;
  SELECT er.effective_at INTO v_bcv_at
  FROM public.exchange_rates er
  WHERE er.rate_type = 'BCV' AND er.effective_at <= now()
    AND CASE WHEN EXISTS(SELECT 1 FROM public.app_settings WHERE key='catalog_authority' AND value #>> '{}'='LUBRICENTER_OS') THEN er.source='BCV_API_DATE_VALUE' ELSE er.source IS DISTINCT FROM 'BCV_API_DATE_VALUE' END
  ORDER BY er.effective_at DESC, er.created_at DESC LIMIT 1;
  IF v_bcv_at IS NULL OR v_bcv_at < now() - interval '10 days' THEN
    RAISE EXCEPTION 'La tasa BCV está demasiado antigua. Revisa el captador';
  END IF;
END
$fn$;

-- Keep the legacy RPC schema used by quote/inventory/settings unchanged.
-- For a database-owned catalog, "synced at" means internally available now,
-- not the frozen Notion heartbeat. Unlike before the transition, the Notion
-- scheduler no longer has authority over either catalog or exchange rates.
CREATE OR REPLACE FUNCTION public.get_pricing_sync_status()
RETURNS TABLE (
  catalog_synced_at timestamptz, catalog_products bigint,
  bcv_rate numeric, bcv_effective_at timestamptz,
  operative_rate numeric, operative_effective_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $fn$
  SELECT
    CASE WHEN EXISTS (
      SELECT 1 FROM public.app_settings s
      WHERE s.key = 'catalog_authority' AND s.value #>> '{}' = 'LUBRICENTER_OS'
    ) THEN now()
    ELSE coalesce(
      (SELECT s.last_verified_at FROM public.integration_sync_state s WHERE s.source_key = 'notion_catalog'),
      (SELECT max(p.catalog_synced_at) FROM public.products p WHERE p.catalog_source = 'Notion · Nuestros Productos')
    ) END,
    (SELECT count(*) FROM public.products p WHERE p.active AND p.available),
    (SELECT er.value FROM public.exchange_rates er
     WHERE er.rate_type = 'BCV' AND er.effective_at <= now()
    AND CASE WHEN EXISTS(SELECT 1 FROM public.app_settings WHERE key='catalog_authority' AND value #>> '{}'='LUBRICENTER_OS') THEN er.source='BCV_API_DATE_VALUE' ELSE er.source IS DISTINCT FROM 'BCV_API_DATE_VALUE' END
     ORDER BY er.effective_at DESC, er.created_at DESC LIMIT 1),
    (SELECT er.effective_at FROM public.exchange_rates er
     WHERE er.rate_type = 'BCV' AND er.effective_at <= now()
    AND CASE WHEN EXISTS(SELECT 1 FROM public.app_settings WHERE key='catalog_authority' AND value #>> '{}'='LUBRICENTER_OS') THEN er.source='BCV_API_DATE_VALUE' ELSE er.source IS DISTINCT FROM 'BCV_API_DATE_VALUE' END
     ORDER BY er.effective_at DESC, er.created_at DESC LIMIT 1),
    (SELECT er.value FROM public.exchange_rates er
     WHERE er.rate_type = 'OPERATIVE' AND er.effective_at <= now()
     ORDER BY er.effective_at DESC, er.created_at DESC LIMIT 1),
    (SELECT er.effective_at FROM public.exchange_rates er
     WHERE er.rate_type = 'OPERATIVE' AND er.effective_at <= now()
     ORDER BY er.effective_at DESC, er.created_at DESC LIMIT 1);
$fn$;
