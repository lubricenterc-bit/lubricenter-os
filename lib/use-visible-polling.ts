"use client";

import { useEffect, useRef } from "react";

/**
 * Sondeo periódico que no desperdicia red ni batería:
 * - no consulta mientras la pestaña/PWA está en segundo plano;
 * - al volver a primer plano consulta una sola vez (focus + visibilitychange
 *   llegan juntos y antes disparaban dos rondas de peticiones);
 * - nunca solapa dos ejecuciones: si la anterior no terminó, se omite.
 */
export function useVisiblePolling(
  task: () => Promise<unknown> | unknown,
  intervalMs: number,
  { enabled = true, immediate = true, minGapMs = 5_000 }: { enabled?: boolean; immediate?: boolean; minGapMs?: number } = {},
) {
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    if (!enabled) return;
    let running = false;
    let lastRun = 0;
    let disposed = false;

    async function run(force = false) {
      if (disposed || running) return;
      if (document.visibilityState === "hidden") return;
      if (!force && Date.now() - lastRun < minGapMs) return;
      running = true;
      lastRun = Date.now();
      try { await taskRef.current(); } catch { /* el componente decide cómo mostrar errores */ } finally { running = false; }
    }

    if (immediate) void run(true);
    const timer = window.setInterval(() => void run(true), intervalMs);
    const onWake = () => void run();
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onWake);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onWake);
    };
  }, [enabled, immediate, intervalMs, minGapMs]);
}
