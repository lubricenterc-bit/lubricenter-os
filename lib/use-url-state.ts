"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/** Lee de la URL las claves de `defaults`; las ausentes toman su valor por defecto. */
export function readUrlState<T extends Record<string, string>>(params: URLSearchParams | { get(key: string): string | null }, defaults: T): T {
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof T & string)[]) {
    const value = params.get(key);
    if (value !== null) result[key] = value as T[typeof key];
  }
  return result;
}

/**
 * Arma el `search` con el estado nuevo. Omite los valores iguales al default
 * y conserva los parámetros ajenos a este estado (p. ej. `preview`).
 */
export function writeUrlState<T extends Record<string, string>>(current: string, defaults: T, next: T): string {
  const params = new URLSearchParams(current);
  for (const key of Object.keys(defaults)) {
    const value = next[key];
    if (value === undefined || value === defaults[key]) params.delete(key);
    else params.set(key, value);
  }
  const text = params.toString();
  return text ? "?" + text : "";
}

/**
 * Estado de filtros guardado en la URL: sobrevive a recargar y a «Volver».
 * Escribe con `history.replaceState` (Next lo sincroniza con `useSearchParams`
 * sin pedir nada al servidor) y responde al instante con un estado local, así
 * el texto que se escribe en un buscador no se pierde mientras cambia la URL.
 * Usa `useSearchParams`, así que la página debe ir dentro de `<Suspense>`.
 */
export function useUrlState<T extends Record<string, string>>(defaults: T): [T, (patch: Partial<T>) => void] {
  const params = useSearchParams();
  const defaultsRef = useRef(defaults);
  const urlKey = params.toString();
  const [state, setLocal] = useState<T>(() => readUrlState(params, defaultsRef.current));
  const stateRef = useRef(state);
  const pending = useRef<string[]>([]);

  // Si la URL cambió desde fuera (atrás/adelante, un enlace), manda la URL.
  useEffect(() => {
    const mine = pending.current.indexOf(urlKey);
    if (mine >= 0) { pending.current.splice(0, mine + 1); return; }
    const fromUrl = readUrlState(new URLSearchParams(urlKey), defaultsRef.current);
    stateRef.current = fromUrl;
    setLocal(fromUrl);
  }, [urlKey]);

  const setState = useCallback((patch: Partial<T>) => {
    // Varias llamadas seguidas en el mismo evento se acumulan.
    const next = { ...stateRef.current, ...patch } as T;
    stateRef.current = next;
    setLocal(next);
    const search = writeUrlState(window.location.search, defaultsRef.current, next);
    if (search === window.location.search || (search === "" && !window.location.search)) return;
    pending.current.push(search.replace(/^\?/, ""));
    if (pending.current.length > 20) pending.current.shift();
    // Con estado null Next sincroniza useSearchParams (con su estado interno lo ignora).
    window.history.replaceState(null, "", window.location.pathname + search + window.location.hash);
  }, []);
  return [state, setState];
}
