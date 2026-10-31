"use client";

import { useEffect, useState } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryBackend, postExplain, supabaseBackend, type TunnelBackend } from "./backend";
import { estimateSeconds, planSlides } from "./engine";
import { todayCaracas } from "./format";
import { listTunnels } from "./registry";
import type { TunnelContext, TunnelDefinition } from "./types";

export function backendFor(definition: TunnelDefinition, supabase: SupabaseClient): TunnelBackend {
  if (definition.backend === "supabase") return supabaseBackend(supabase);
  return memoryBackend(definition, {
    explain: async a => {
      const { data } = await supabase.auth.getSession();
      return postExplain(data.session?.access_token || null, a.key, {
        session_id: a.sessionId, case: a.item, snapshot: a.snapshot, explanation: a.explanation, decision_id: null,
      });
    },
  });
}

export async function tunnelContext(definition: TunnelDefinition, backend: TunnelBackend, supabase: SupabaseClient): Promise<TunnelContext> {
  const rules = (await backend.rules(definition.key)).filter(r => r.status === "ACTIVE");
  const memory = "db" in backend ? (backend as ReturnType<typeof memoryBackend>).db.memory : undefined;
  return { supabase: definition.backend === "supabase" ? supabase : null, today: todayCaracas(), rules, memory };
}

export type TunnelSummary = { key: string; decisions: number; estimateSeconds: number; error?: string };

/** How much work a tunnel has right now (same planning the tunnel itself uses). */
export async function tunnelSummary(definition: TunnelDefinition, supabase: SupabaseClient): Promise<TunnelSummary> {
  try {
    const backend = backendFor(definition, supabase);
    const ctx = await tunnelContext(definition, backend, supabase);
    const slides = planSlides(await definition.buildCases(ctx), { rules: ctx.rules, matcher: definition.ruleMatcher, describeBatch: definition.describeBatch });
    return { key: definition.key, decisions: slides.length - 2, estimateSeconds: estimateSeconds(slides) };
  } catch (error) {
    return { key: definition.key, decisions: 0, estimateSeconds: 0, error: error instanceof Error ? error.message : "No pude revisar este túnel" };
  }
}

const CACHE_KEY = "lubricenter:tunnels-pending";
const CACHE_MS = 10 * 60_000;

/** Total pending decisions for the navigation badge; recalculated at most every 10 minutes. */
export function usePendingTunnelCount(supabase: SupabaseClient, enabled: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    try {
      const cached = JSON.parse(window.sessionStorage.getItem(CACHE_KEY) || "null") as { at: number; count: number } | null;
      if (cached && Date.now() - cached.at < CACHE_MS) { setCount(cached.count); return; }
    } catch { /* sin almacenamiento */ }
    const timer = window.setTimeout(async () => {
      const results = await Promise.all(listTunnels().map(t => tunnelSummary(t, supabase)));
      const total = results.reduce((sum, r) => sum + r.decisions, 0);
      if (!active) return;
      setCount(total);
      try { window.sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), count: total })); } catch { /* sin almacenamiento */ }
    }, 1500);
    return () => { active = false; window.clearTimeout(timer); };
  }, [enabled, supabase]);
  return count;
}

export function forgetPendingCount() {
  try { window.sessionStorage.removeItem(CACHE_KEY); } catch { /* sin almacenamiento */ }
}
