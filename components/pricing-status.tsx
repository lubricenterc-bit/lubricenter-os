"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export function PricingStatus() {
  const [fresh, setFresh] = useState<boolean | null>(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase.rpc("get_pricing_sync_status");
      if (error) return setFresh(false);
      const row = Array.isArray(data) ? data[0] : data;
      const catalogAt = row?.catalog_synced_at ? new Date(row.catalog_synced_at).getTime() : 0;
      const rateAt = row?.operative_effective_at ? new Date(row.operative_effective_at).getTime() : 0;
      setFresh(Date.now() - catalogAt <= 24 * 3600000 && Date.now() - rateAt <= 3 * 3600000);
    })();
  }, []);

  return <Link href="/settings" className={`pill ${fresh === false ? "warn" : "ok"}`} title="Estado de precios y tasas de Notion">
    {fresh === null ? "Precios…" : fresh ? "Notion ✓" : "Precios ⚠"}
  </Link>;
}
