"use client";

import { useEffect, useState } from "react";
import { Gotin } from "@/components/gotin";
import { OsIcon } from "@/components/os-icon";

type DeferredPrompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
const KEY = "lubricenter:install-dismissed";

/**
 * Invita a instalar Lubricenter en el teléfono: sin barra del navegador, con su ícono y a
 * pantalla completa. Solo en pantallas táctiles, si aún no está instalada y si no se descartó.
 */
export function InstallPrompt() {
  const [mode, setMode] = useState<"hidden" | "android" | "ios">("hidden");
  const [deferred, setDeferred] = useState<DeferredPrompt | null>(null);

  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    let dismissed = false;
    try { dismissed = window.localStorage.getItem(KEY) === "1"; } catch { /* sin almacenamiento */ }
    if (standalone || dismissed || !window.matchMedia("(pointer: coarse)").matches) return;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent);
    if (ios) setMode("ios");
    const onPrompt = (event: Event) => { event.preventDefault(); setDeferred(event as DeferredPrompt); setMode("android"); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  function dismiss() {
    setMode("hidden");
    try { window.localStorage.setItem(KEY, "1"); } catch { /* sin almacenamiento */ }
  }
  async function install() {
    if (!deferred) return;
    await deferred.prompt();
    const choice = await deferred.userChoice;
    if (choice.outcome === "accepted") dismiss();
    setDeferred(null);
  }

  if (mode === "hidden") return null;
  return <aside className="os-install live" aria-label="Instalar la app">
    <span className="os-install-art" aria-hidden="true"><Gotin pose="wave" /></span>
    <span className="os-install-text">
      <strong>Lubricenter en tu pantalla de inicio</strong>
      {mode === "android"
        ? <small>Se abre como una app, a pantalla completa y sin la barra del navegador.</small>
        : <small>Toca <OsIcon name="arrow" size={13} className="os-install-share" /> Compartir y luego «Agregar a inicio».</small>}
    </span>
    {mode === "android" && <button type="button" className="btn btn-primary" onClick={() => void install()}>Instalar</button>}
    <button type="button" className="os-install-close" onClick={dismiss} aria-label="No mostrar más"><OsIcon name="close" size={16} /></button>
  </aside>;
}
