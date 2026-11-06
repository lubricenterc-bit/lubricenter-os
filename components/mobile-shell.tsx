"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { gotinSvg } from "@/lib/brand-art";
import { haptic } from "@/lib/haptics";

/** Recuerda el recorrido de la pestaña para saber si la nueva pantalla es un avance o un regreso. */
const trail: string[] = [];
function directionFor(path: string): "forward" | "back" | "none" {
  if (!trail.length) { trail.push(path); return "none"; }
  if (trail[trail.length - 1] === path) return "none";
  if (trail.length > 1 && trail[trail.length - 2] === path) { trail.pop(); return "back"; }
  trail.push(path);
  if (trail.length > 40) trail.shift();
  return "forward";
}

/**
 * Escenario de cada pantalla: entra desde la derecha al avanzar y desde la izquierda al volver.
 * `refreshKey` vuelve a montar la pantalla (y repite sus consultas) tras «deslizar para refrescar».
 */
export function PageStage({ children, refreshKey }: { children: ReactNode; refreshKey: number }) {
  const pathname = usePathname();
  // Se decide al pintar la pantalla nueva, para que entre ya con la animación correcta.
  const seen = useRef<{ path: string; dir: "forward" | "back" | "none" } | null>(null);
  if (seen.current?.path !== pathname) seen.current = { path: pathname, dir: directionFor(pathname) };
  return <div key={pathname + ":" + refreshKey} className="os-page" data-dir={seen.current.dir}>{children}</div>;
}

/** En el teléfono la cabecera se esconde al bajar y vuelve al subir; con sombra en cuanto hay desplazamiento. */
export function useScrollChrome(shell: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    let lastY = window.scrollY, frame = 0;
    const narrow = window.matchMedia("(max-width: 900px)");
    const update = () => {
      frame = 0;
      const node = shell.current; if (!node) return;
      const y = window.scrollY, delta = y - lastY;
      node.classList.toggle("is-scrolled", y > 4);
      const typing = document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement;
      if (!narrow.matches || y < 120 || typing) node.classList.remove("is-head-away");
      else if (delta > 8) node.classList.add("is-head-away");
      else if (delta < -8) node.classList.remove("is-head-away");
      if (Math.abs(delta) > 8 || y < 120) lastY = y;
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    window.addEventListener("scroll", onScroll, { passive: true });
    update();
    return () => { window.removeEventListener("scroll", onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [shell]);
}

const PULL_LIMIT = 110;
const PULL_TRIGGER = 72;

/**
 * Deslizar hacia abajo para refrescar, con Gotín estirándose. Solo en pantallas táctiles, en la
 * parte superior de la página y fuera de hojas, menús y listas que se desplazan solas.
 */
export function PullToRefresh({ onRefresh }: { onRefresh: () => void }) {
  const [pull, setPull] = useState(0);
  const [state, setState] = useState<"idle" | "pulling" | "armed" | "refreshing">("idle");
  const start = useRef<{ y: number; x: number } | null>(null);
  const armed = useRef(false);

  useEffect(() => {
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    const blocked = (target: EventTarget | null) => target instanceof Element &&
      !!target.closest(".overlay, .sheet, .os-drawer-scrim, .os-command-scrim, [data-no-pull], .os-board-wrap, .os-lanes, input, textarea, select");
    const onStart = (event: TouchEvent) => {
      if (window.scrollY > 0 || event.touches.length !== 1 || blocked(event.target)) { start.current = null; return; }
      start.current = { y: event.touches[0].clientY, x: event.touches[0].clientX };
    };
    const onMove = (event: TouchEvent) => {
      if (!start.current) return;
      const dy = event.touches[0].clientY - start.current.y, dx = Math.abs(event.touches[0].clientX - start.current.x);
      if (dy <= 0 || dx > dy || window.scrollY > 0) { setPull(0); setState("idle"); return; }
      // Resistencia: cuanto más se tira, menos avanza (como una goma).
      const eased = Math.min(PULL_LIMIT, dy * 0.5);
      setPull(eased);
      const isArmed = eased >= PULL_TRIGGER;
      if (isArmed !== armed.current) { armed.current = isArmed; if (isArmed) haptic("tick"); }
      setState(isArmed ? "armed" : "pulling");
    };
    const onEnd = () => {
      if (!start.current) return;
      start.current = null;
      if (armed.current) {
        armed.current = false;
        setState("refreshing"); setPull(PULL_TRIGGER);
        onRefresh();
        window.setTimeout(() => { setState("idle"); setPull(0); }, 900);
      } else { setState("idle"); setPull(0); }
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    window.addEventListener("touchcancel", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
      window.removeEventListener("touchend", onEnd);
      window.removeEventListener("touchcancel", onEnd);
    };
  }, [onRefresh]);

  const progress = Math.min(1, pull / PULL_TRIGGER);
  // Gotín solo se anima mientras se ve (clase live), nunca escondido arriba.
  return <div className={"os-ptr is-" + state + (state === "idle" ? "" : " live")} aria-hidden={state === "idle"} role="status"
    style={{ transform: `translate(-50%, ${pull - 64}px)`, opacity: state === "idle" ? 0 : 1 }}>
    <span className="os-ptr-drop" style={{ transform: `scale(${0.6 + progress * 0.4}, ${0.6 + progress * 0.55}) rotate(${(1 - progress) * -24}deg)` }}
      dangerouslySetInnerHTML={{ __html: gotinSvg(state === "refreshing" ? "cheer" : "idle", { decorative: true }) }} />
    <span className="os-ptr-label">{state === "refreshing" ? "Actualizando…" : state === "armed" ? "Suelta para actualizar" : "Desliza para actualizar"}</span>
  </div>;
}
