"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

export function PricingStatus() {
  const [fresh, setFresh] = useState<boolean | null>(null);
  const lastVersion = useRef("");

  const check = useCallback(async () => {
    const { data, error } = await supabase.rpc("get_pricing_sync_status");
    if (error) return setFresh(false);
    const row = Array.isArray(data) ? data[0] : data;
    const catalogAt = row?.catalog_synced_at ? new Date(row.catalog_synced_at).getTime() : 0;
    const bcvAt = row?.bcv_effective_at ? new Date(row.bcv_effective_at).getTime() : 0;
    const operativeAt = row?.operative_effective_at ? new Date(row.operative_effective_at).getTime() : 0;
    setFresh(Date.now() - catalogAt <= 24 * 3600000 && Date.now() - Math.min(bcvAt, operativeAt) <= 3 * 3600000);
    const version = `${row?.catalog_synced_at ?? ""}:${row?.bcv_effective_at ?? ""}:${row?.operative_effective_at ?? ""}`;
    if (lastVersion.current && version !== lastVersion.current) {
      window.dispatchEvent(new CustomEvent("lubricenter:pricing-updated"));
    }
    lastVersion.current = version;
  }, []);

  useEffect(() => {
    check();
    const timer = window.setInterval(check, 60_000);
    const onFocus = () => check();
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  return <Link href="/settings" className={`pill ${fresh === false ? "warn" : "ok"}`} title="Estado de precios y tasas de Notion">
    {fresh === null ? "Precios…" : fresh ? "Precios al día ✓" : "Precios ⚠"}
  </Link>;
}

