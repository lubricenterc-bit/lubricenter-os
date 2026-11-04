"use client";

import "../receipt-print.css";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import { receiptShareText, type ReceiptData } from "@/lib/receipt";
import { Receipt58 } from "@/components/receipt/receipt-58";

/** Ajusta la hoja al largo real del recibo (rollo de 58 mm) solo mientras se imprime. */
function printRoll() {
  const roll = document.querySelector<HTMLElement>(".lc-print-roll");
  const heightMm = Math.max(60, Math.ceil(((roll?.scrollHeight ?? 600) * 25.4) / 96) + 4);
  const style = document.createElement("style");
  style.textContent = `@page { size: 58mm ${heightMm}mm; margin: 0; } @media print { html, body { margin: 0; padding: 0; background: #fff; } }`;
  document.head.appendChild(style);
  const cleanup = () => { style.remove(); window.removeEventListener("afterprint", cleanup); };
  window.addEventListener("afterprint", cleanup);
  window.print();
}

export default function PrintReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [data, setData] = useState<ReceiptData | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const printed = useRef(false);

  useEffect(() => {
    let alive = true;
    void supabase.rpc("order_receipt", { p_order_id: id }).then(({ data: d, error: e }) => {
      if (!alive) return;
      if (e) setError(e.message);
      else setData(d as ReceiptData);
    });
    return () => { alive = false; };
  }, [id]);

  const print = useCallback(() => { printRoll(); }, []);

  // ?auto=1: imprime cuando las fuentes y el logo están listos.
  useEffect(() => {
    if (!data || printed.current) return;
    if (new URLSearchParams(window.location.search).get("auto") !== "1") return;
    printed.current = true;
    const logo = document.querySelector<HTMLImageElement>(".lc-r-logo");
    const logoReady = logo && !logo.complete ? new Promise(r => { logo.onload = logo.onerror = r; }) : Promise.resolve();
    void Promise.all([document.fonts?.ready, logoReady]).then(() => requestAnimationFrame(() => printRoll()));
  }, [data]);

  async function share() {
    if (!data) return;
    const text = receiptShareText(data);
    try {
      if (navigator.share) await navigator.share({ title: `Lubricenter · ${data.order.number}`, text });
      else { await navigator.clipboard.writeText(text); setNote("Copiado. Pégalo en WhatsApp."); }
    } catch (e) {
      if ((e as { name?: string })?.name !== "AbortError") setNote("No pude compartir. Usa Imprimir.");
    }
  }

  return <main className="lc-print">
    <div className="lc-print-actions no-print">
      <button type="button" onClick={() => (window.history.length > 1 ? router.back() : router.push(`/orders/${id}`))}>← Volver</button>
      <button type="button" disabled={!data} onClick={() => void share()}>Compartir</button>
      <button type="button" className="lc-print-primary" disabled={!data} onClick={print}>Imprimir</button>
    </div>
    {note && <p className="lc-print-msg no-print" role="status">{note}</p>}
    {error && <p className="lc-print-msg no-print" role="alert">No pude cargar el recibo: {error}</p>}
    {!data && !error && <p className="lc-print-msg no-print">Preparando recibo…</p>}
    {data && <div className="lc-print-roll"><Receipt58 data={data} /></div>}
  </main>;
}
