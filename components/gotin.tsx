"use client";

import { useCallback, useEffect, useRef } from "react";
import { BRAND_ICONS, gotinSvg, type BrandIconName, type GotinPose } from "@/lib/brand-art";

type GotinProps = {
  pose?: GotinPose;
  /** Texto para lectores de pantalla. Sin label, Gotín es decorativo. */
  label?: string;
  className?: string;
  /** Salta una vez al montarse (celebración). */
  jump?: boolean;
};

/** Gotín, la gota de Lubricenter. Las animaciones solo corren dentro de un contenedor `.live`. */
export function Gotin({ pose = "wave", label, className = "", jump = false }: GotinProps) {
  return <span className={"gotin-wrap " + className}
    dangerouslySetInnerHTML={{ __html: gotinSvg(pose, { label, decorative: !label, className: jump ? "jump" : undefined }) }} />;
}

/** Objetos del taller dibujados con la línea de Gotín. Siempre decorativos. */
export function BrandIcon({ name, className = "", color }: { name: BrandIconName; className?: string; color?: string }) {
  const html = name === "star" ? BRAND_ICONS.star(undefined, color) : BRAND_ICONS[name]();
  return <span className={"bi-wrap " + className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Marca el elemento con `.live` mientras está a la vista, para pausar las animaciones fuera de pantalla.
 *  Devuelve una ref de callback: funciona aunque el elemento aparezca después (diálogos, listas). */
export function useLive<T extends HTMLElement>() {
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(() => () => observer.current?.disconnect(), []);
  return useCallback((element: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!element) return;
    if (!("IntersectionObserver" in window)) { element.classList.add("live"); return; }
    observer.current = new IntersectionObserver(entries => {
      for (const entry of entries) entry.target.classList.toggle("live", entry.isIntersecting);
    }, { rootMargin: "60px" });
    observer.current.observe(element);
  }, []);
}

/** Vuelve a disparar una animación CSS de una sola vez (rebote, salto, aterrizaje). */
export function replay(element: Element | null | undefined, className: string, removeAfter = 0) {
  if (!element || prefersCalm()) return;
  element.classList.remove(className);
  void (element as HTMLElement).offsetWidth;
  element.classList.add(className);
  if (removeAfter) window.setTimeout(() => element.classList.remove(className), removeAfter);
}

export function prefersCalm() {
  return typeof window !== "undefined" && (window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
    document.documentElement.classList.contains("calm-motion"));
}
