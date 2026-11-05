"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { pageLabelForPath, parentForPath } from "@/lib/navigation";
import { pop, previous, pushEntry, takeRestore, updateScroll } from "@/lib/nav-history";

type Target = { href: string; label: string; fromHistory: boolean };

function isTyping(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) return false;
  const tag = element.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable;
}

/** Restaura el scroll guardado; reintenta mientras la página crece (datos que llegan). */
function restoreScroll(y: number) {
  if (y <= 0) return;
  const started = performance.now();
  const attempt = () => {
    const reachable = document.documentElement.scrollHeight - window.innerHeight >= y - 2;
    window.scrollTo({ top: y, behavior: "instant" as ScrollBehavior });
    if (!reachable && performance.now() - started < 1500) requestAnimationFrame(attempt);
  };
  requestAnimationFrame(attempt);
}

/**
 * Registra cada pantalla en el historial interno y muestra «← Volver a …».
 * Va dentro de <Suspense> en el shell porque usa useSearchParams.
 */
export function BackButton() {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const router = useRouter();
  const [target, setTarget] = useState<Target | null>(null);
  const targetRef = useRef<Target | null>(null);

  useEffect(() => {
    pushEntry({ path: pathname, search, title: pageLabelForPath(pathname) });
    const prev = previous(pathname);
    let next: Target | null = null;
    if (pathname !== "/") {
      if (prev) next = { href: prev.path + prev.search, label: "Volver a " + prev.title, fromHistory: true };
      else {
        const parent = parentForPath(pathname);
        if (parent) next = { href: parent.href, label: parent.label, fromHistory: false };
      }
    }
    targetRef.current = next;
    setTarget(next);
  }, [pathname, search]);

  // Al llegar con «Volver», recupera el scroll que tenía esa pantalla.
  useEffect(() => {
    const y = takeRestore(pathname);
    if (y !== null) restoreScroll(y);
  }, [pathname]);

  // Guarda el scroll de esta pantalla, como mucho una vez cada 200 ms.
  useEffect(() => {
    let timer: number | null = null;
    const onScroll = () => {
      if (timer !== null) return;
      timer = window.setTimeout(() => { timer = null; updateScroll(pathname, window.scrollY); }, 200);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pathname]);

  const goBack = useCallback(() => {
    const current = targetRef.current;
    if (!current) return;
    updateScroll(pathname, window.scrollY);
    if (current.fromHistory) pop(pathname);
    router.push(current.href, { scroll: false });
  }, [pathname, router]);

  // Alt + ← vuelve, salvo mientras se escribe en un campo.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!event.altKey || event.key !== "ArrowLeft" || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTyping(event.target) || !targetRef.current) return;
      event.preventDefault();
      goBack();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goBack]);

  if (!target) return null;
  return <div className="os-back">
    <a href={target.href} className="os-back-link" title="Volver (Alt + ←)"
      onClick={event => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        event.preventDefault();
        goBack();
      }}>
      <span aria-hidden="true">←</span> {target.label}
    </a>
  </div>;
}
