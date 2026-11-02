"use client";

import Link from "next/link";
import { useCallback, useRef, useState } from "react";
import { catalogIsFresh, normalizeCatalogSync } from "@/lib/catalog";
import { supabase } from "@/lib/supabase";
import { useVisiblePolling } from "@/lib/use-visible-polling";

export function PricingStatus() {
  const [fresh, setFresh] = useState<boolean | null>(null);
  const lastVersion = useRef("");

  const check = useCallback(async () => {
    const [{ data, error },control]=await Promise.all([supabase.rpc("get_pricing_sync_status"),supabase.rpc("get_exchange_rate_control_status")]);
    if (error||control.error) return setFresh(false);
    const row = Array.isArray(data) ? data[0] : data;
    setFresh(control.data?.rates_fresh !== false && catalogIsFresh(normalizeCatalogSync(row)));
    const version = `${control.data?.catalog_version ?? row?.catalog_products ?? ""}:${row?.bcv_effective_at ?? ""}:${row?.operative_effective_at ?? ""}`;
    if (lastVersion.current && version !== lastVersion.current) {
      window.dispatchEvent(new CustomEvent("lubricenter:pricing-updated"));
    }
    lastVersion.current = version;
  }, []);

  // Una consulta por minuto solo con la app visible; al volver a primer plano, una sola vez.
  useVisiblePolling(check, 60_000);

  return <Link href="/settings" className={`pill os-pricing ${fresh === false ? "warn" : "ok"}`} title="Estado del catálogo y tasas">
    <span className="os-pricing-dot" aria-hidden="true" />{fresh === null ? "Precios…" : fresh ? "Precios al día" : "Revisar precios"}
  </Link>;
}

