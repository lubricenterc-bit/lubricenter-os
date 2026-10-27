"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export type InventorySalePolicy = {
  /** Inventario estricto activo: toda mercancía se vende desde un artículo con stock. */
  strict: boolean;
  /** El usuario tiene el permiso inventory.override (vender a mano, con auditoría). */
  canOverride: boolean;
};

/** Mientras carga se asume el modo permisivo para no bloquear la pantalla; la base valida igual. */
export const PERMISSIVE_POLICY: InventorySalePolicy = { strict: false, canOverride: true };

export function allowsManualSale(policy: InventorySalePolicy): boolean {
  return !policy.strict || policy.canOverride;
}

export function useInventorySalePolicy(): InventorySalePolicy {
  const [policy, setPolicy] = useState<InventorySalePolicy>(PERMISSIVE_POLICY);
  useEffect(() => {
    let alive = true;
    supabase.rpc("inventory_sale_policy").then(({ data, error }) => {
      if (!alive || error || !data) return;
      const value = data as { strict?: boolean; can_override?: boolean };
      setPolicy({ strict: value.strict === true, canOverride: value.can_override === true });
    });
    return () => { alive = false; };
  }, []);
  return policy;
}
