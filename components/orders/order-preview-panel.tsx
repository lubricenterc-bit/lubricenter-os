"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import "./order-preview.css";
import { fmtDate, fmtRef, fmtVes } from "@/lib/format";
import {
  KIND_LABEL, PAYMENT_LABEL, STATUS_LABEL, collectedShare, createPreviewCache, installmentLabel,
  type OrderPreview,
} from "@/lib/order-preview";

async function fetchOrderPreview(id: string): Promise<OrderPreview> {
  const { data, error } = await supabase.rpc("order_preview", { p_order_id: id });
  if (error) throw new Error(error.message);
  return data as OrderPreview;
}

/** Una caché por pantalla (se crea con la pantalla, se pierde al salir). */
export function useOrderPreviewCache() {
  return useMemo(() => createPreviewCache(fetchOrderPreview), []);
}
type Cache = ReturnType<typeof useOrderPreviewCache>;

/** Precarga al dejar el ratón 150 ms sobre una fila. */
export function usePreviewPrefetch(cache: Cache) {
  const timer = useRef<number | null>(null);
  const start = useCallback((id: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void cache.load(id).catch(() => undefined); }, 150);
  }, [cache]);
  const cancel = useCallback(() => { if (timer.current) window.clearTimeout(timer.current); timer.current = null; }, []);
  useEffect(() => cancel, [cancel]);
  return { onPointerEnter: start, onPointerLeave: cancel };
}

function reducedMotion() {
  if (typeof window === "undefined") return true;
  return document.documentElement.classList.contains("calm-motion")
    || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Cuenta hasta el valor nuevo en 320 ms (sin animación si se pidió movimiento reducido). */
function useCountUp(value: number) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const start = from.current;
    if (reducedMotion() || start === value) { from.current = value; setShown(value); return; }
    let frame = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / 320);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(start + (value - start) * eased);
      if (k < 1) frame = requestAnimationFrame(step); else from.current = value;
    };
    frame = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(frame); from.current = value; };
  }, [value]);
  return shown;
}

function Money({ value, ves }: { value: number; ves?: boolean }) {
  const shown = useCountUp(Number(value) || 0);
  return <span className="op-num">{ves ? fmtVes(shown) : fmtRef(shown)}</span>;
}

const SECTIONS_KEY = "lubricenter:preview-sections";
function readSections(): Record<string, boolean> {
  try { return JSON.parse(window.sessionStorage.getItem(SECTIONS_KEY) || "{}"); } catch { return {}; }
}
function Section({ id, title, aside, children, defaultOpen = true }: { id: string; title: string; aside?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { const saved = readSections()[id]; if (typeof saved === "boolean") setOpen(saved); }, [id]);
  function toggle() {
    const next = !open;
    setOpen(next);
    try { window.sessionStorage.setItem(SECTIONS_KEY, JSON.stringify({ ...readSections(), [id]: next })); } catch { /* sin almacenamiento */ }
  }
  return <section className="op-section">
    <button type="button" className="op-section-head" aria-expanded={open} onClick={toggle}>
      <span>{title}</span>{aside && <span className="op-section-aside">{aside}</span>}<span className={"op-chevron" + (open ? " is-open" : "")} aria-hidden="true">⌄</span>
    </button>
    {open && <div className="op-section-body">{children}</div>}
  </section>;
}

type Props = {
  orderId: string;
  cache: Cache;
  onClose: () => void;
  /** Orden anterior / siguiente de la lista (↑/↓). */
  onStep?: (direction: 1 | -1) => void;
  position?: { index: number; total: number } | null;
};

export function OrderPreviewPanel({ orderId, cache, onClose, onStep, position }: Props) {
  const [data, setData] = useState<OrderPreview | null>(() => cache.peek(orderId));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!cache.peek(orderId));
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback((force = false) => {
    setError("");
    const cached = cache.peek(orderId);
    if (cached && !force) { setData(cached); setLoading(false); }
    else setLoading(true);
    let active = true;
    cache.load(orderId, force).then(value => { if (active) { setData(value); setLoading(false); } })
      .catch((e: Error) => { if (active) { setError(e.message || "No pude cargar la orden."); setLoading(false); } });
    return () => { active = false; };
  }, [cache, orderId]);

  useEffect(() => load(), [load]);

  // Al volver a la ventana, refresca si los datos tienen más de 60 s.
  useEffect(() => {
    const onFocus = () => { if (cache.age(orderId) > 60_000) load(true); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [cache, orderId, load]);

  // Teclado: Esc cierra; ↑/↓ recorre la lista.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (onStep && (event.key === "ArrowDown" || event.key === "ArrowUp") && !event.altKey && !event.metaKey && !event.ctrlKey) {
        event.preventDefault();
        onStep(event.key === "ArrowDown" ? 1 : -1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onStep]);

  // Foco al abrir y devuelto al cerrar.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = overflow; if (previous?.isConnected) previous.focus(); };
  }, []);

  // Mientras llega la orden nueva se ve la anterior: las cifras cuentan hasta el valor nuevo.
  const p = data;
  return <div className="overlay op-overlay" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panelRef} className="sheet op-panel" role="dialog" aria-modal="true" aria-label={p ? `Vista previa de ${p.order.number}` : "Vista previa de la orden"} tabIndex={-1} aria-busy={loading}>
      <header className="op-head">
        <div className="op-head-top">
          <div>
            <h2>{p?.order.number ?? "Orden"}</h2>
            {p && <p>{fmtDate(p.order.at)}{p.order.attendant ? ` · Atendió ${p.order.attendant}` : ""}</p>}
          </div>
          <div className="op-head-actions">
            {onStep && <>
              <button type="button" className="op-icon" onClick={() => onStep(-1)} aria-label="Orden anterior (↑)" disabled={!!position && position.index <= 0}>↑</button>
              <button type="button" className="op-icon" onClick={() => onStep(1)} aria-label="Orden siguiente (↓)" disabled={!!position && position.index >= position.total - 1}>↓</button>
            </>}
            <button type="button" className="op-icon" onClick={onClose} aria-label="Cerrar (Esc)">✕</button>
          </div>
        </div>
        {p && <div className="op-tags">
          <span className={"op-tag op-status-" + p.order.status.toLowerCase()}>{STATUS_LABEL[p.order.status]}</span>
          <span className="op-tag is-strong">{KIND_LABEL[p.order.kind]}</span>
          <span className="op-tag">{PAYMENT_LABEL[p.order.payment_type]}</span>
          {position && <span className="op-position">{position.index + 1} de {position.total}</span>}
        </div>}
      </header>

      {error && <div className="error" role="alert">{error} <button type="button" className="btn btn-ghost" onClick={() => load(true)}>Reintentar</button></div>}
      {!p && loading && <div className="op-skeleton" aria-label="Cargando"><span /><span /><span /></div>}

      {p && <div className="op-body">
        {p.order.status === "CANCELLED" && <div className="op-note is-danger">Anulada{p.order.cancellation_reason ? `: ${p.order.cancellation_reason}` : ""}</div>}

        <div className="op-total">
          <div><small>Total</small><strong><Money value={p.totals.ref} /></strong><span className="op-total-sub">{fmtVes(p.totals.ves)}{p.totals.bcv_rate ? ` · BCV ${Number(p.totals.bcv_rate).toLocaleString("es-VE", { maximumFractionDigits: 2 })}` : ""}</span></div>
        </div>

        <Section id="who" title="Cliente y vehículo">
          {p.customer || p.vehicle ? <div className="op-who">
            {p.customer && <Link href={`/customers/${p.customer.id}`} className="op-link"><strong>{p.customer.name || "Cliente sin nombre"}</strong>{p.customer.phone && <small>{p.customer.phone}</small>}</Link>}
            {p.vehicle && <div><strong>{[p.vehicle.label, p.vehicle.plate].filter(Boolean).join(" · ") || "Vehículo"}</strong>{p.vehicle.odometer ? <small>{p.vehicle.odometer.toLocaleString("es-VE")} km</small> : null}</div>}
          </div> : <p className="op-muted">Mostrador · sin datos del cliente.</p>}
        </Section>

        <Section id="sold" title="Lo vendido" aside={<Money value={p.groups.store.subtotal_ref + p.groups.workshop.subtotal_ref} />}>
          {p.groups.store.lines.length > 0 && <div className="op-group">
            <div className="op-group-head"><span>Tienda</span><Money value={p.groups.store.subtotal_ref} /></div>
            {p.groups.store.lines.map((l, i) => <div className="op-line" key={"s" + i}>
              <span><b>{l.name}</b><small>{l.qty} × {l.unit_price_ref != null ? fmtRef(l.unit_price_ref) : "—"}{l.area === "OIL_CHANGE" ? " · cambio de aceite" : ""}</small></span>
              <span className="op-num">{fmtRef(l.total_ref)}</span>
            </div>)}
          </div>}
          {p.groups.workshop.lines.length > 0 && <div className="op-group">
            <div className="op-group-head"><span>Taller</span><Money value={p.groups.workshop.subtotal_ref} /></div>
            {p.groups.workshop.lines.map((l, i) => <div className="op-line" key={"w" + i}>
              <span><b>{l.name}</b><small>{l.kind === "SERVICE" ? "Mano de obra" : `${l.qty} u · repuesto`}{l.mechanic ? ` · ${l.mechanic}` : ""}{l.area === "ELECTROAUTO" ? " · Electroauto" : ""}</small></span>
              <span className="op-num">{fmtRef(l.total_ref)}</span>
            </div>)}
          </div>}
          {!p.groups.store.lines.length && !p.groups.workshop.lines.length && <p className="op-muted">La orden no tiene líneas.</p>}
          {p.groups.internal.length > 0 && <details className="op-internal">
            <summary>Líneas internas ({p.groups.internal.length})</summary>
            {p.groups.internal.map((l, i) => <div className="op-line" key={"i" + i}><span><b>{l.name}</b><small>{l.role === "CASHEA_SURCHARGE" ? "Recargo Cashea" : "Ajuste de Cashea"} · no sale en el recibo</small></span><span className="op-num">{fmtRef(l.total_ref)}</span></div>)}
          </details>}
        </Section>

        <Section id="pay" title="Pago" aside={p.totals.pending_ref > 0 ? <span className="op-pending">Pendiente {fmtRef(p.totals.pending_ref)}</span> : <span className="op-ok">Cobrado</span>}>
          <div className="op-bar" role="img" aria-label={`Cobrado ${Math.round(collectedShare(p) * 100)} %`}><span style={{ transform: `scaleX(${collectedShare(p)})` }} /></div>
          <div className="op-bar-legend"><span>Cobrado <b><Money value={p.totals.collected_ref} /></b></span><span>Pendiente <b><Money value={p.totals.pending_ref} /></b></span></div>
          {p.payments.map((x, i) => <div className="op-line" key={"p" + i}>
            <span><b>{x.label}</b><small>{x.paid_at ? fmtDate(x.paid_at) : "Fecha pendiente"}{x.ref_tail ? ` · ref. …${x.ref_tail}` : ""}</small></span>
            <span className="op-num">{x.currency === "VES" ? fmtVes(x.amount) : fmtRef(x.amount)}{x.currency === "VES" && x.equivalent_ref != null && <small>{fmtRef(x.equivalent_ref)}</small>}</span>
          </div>)}
          {!p.payments.length && <p className="op-muted">Sin pagos registrados.</p>}
          {p.cashea && <div className="op-cashea">
            <div className="op-group-head"><span>Cashea{p.cashea.reference ? ` · N.º ${p.cashea.reference}` : " · sin número"}</span><span>Inicial {p.cashea.initial_percent} % · {fmtRef(p.cashea.initial_ref)}</span></div>
            {p.cashea.installments.map(c => <div className={"op-line op-cuota" + (installmentLabel(c) === "Vencida" ? " is-overdue" : installmentLabel(c) === "Pagada" ? " is-paid" : "")} key={c.no}>
              <span><b>Cuota {c.no}</b><small>{new Date(c.due + "T12:00:00").toLocaleDateString("es-VE", { day: "2-digit", month: "2-digit", year: "numeric" })} · {installmentLabel(c)}</small></span>
              <span className="op-num">{fmtRef(c.amount_ref)}</span>
            </div>)}
          </div>}
          {p.credit && <div className="op-note">Crédito LC · {p.credit.status === "OPEN" ? `saldo ${fmtRef(p.credit.outstanding_ref)} (${fmtVes(p.credit.outstanding_ves)})` : "pagado"}</div>}
        </Section>

        {(p.adjustments.discount_ref !== 0 || p.adjustments.rounding_ref !== 0) && <Section id="adj" title="Ajustes">
          {p.adjustments.discount_ref !== 0 && <div className="op-line"><span><b>Descuento{p.adjustments.discount_pct ? ` ${p.adjustments.discount_pct} %` : ""}</b><small>{p.adjustments.owner_approved ? "Con PIN del dueño" : "Sin PIN"}{p.adjustments.discount_reason ? ` · ${p.adjustments.discount_reason}` : ""}</small></span><span className="op-num">− {fmtRef(p.adjustments.discount_ref)}</span></div>}
          {p.adjustments.rounding_ref !== 0 && <div className="op-line"><span><b>Redondeo</b></span><span className="op-num">{p.adjustments.rounding_ref > 0 ? "+ " : "− "}{fmtRef(Math.abs(p.adjustments.rounding_ref))}</span></div>}
        </Section>}

        {p.profit && <Section id="profit" title="Ganancia" aside={<Money value={p.profit.total_ref} />} defaultOpen={false}>
          <div className="op-line"><span><b>Tienda</b></span><span className="op-num">{fmtRef(p.profit.store_ref)}</span></div>
          <div className="op-line"><span><b>Taller</b></span><span className="op-num">{fmtRef(p.profit.workshop_ref)}</span></div>
          {p.profit.mechanics.map(m => <div className="op-line" key={m.name}><span><b>{m.name}</b><small>Comisión del mecánico</small></span><span className="op-num">{fmtRef(m.ref)}</span></div>)}
          {p.profit.cashea_commission_ref > 0 && <div className="op-line"><span><b>Comisión Cashea</b></span><span className="op-num">{fmtRef(p.profit.cashea_commission_ref)}</span></div>}
          {p.profit.estimated_cost && <p className="op-muted">Costo estimado en algún artículo sin costo (precio ÷ 1,35).</p>}
        </Section>}
      </div>}

      <footer className="op-foot">
        <Link className="btn btn-primary" href={`/orders/${orderId}`}>Abrir orden</Link>
        <Link className="btn" href={`/print/receipt/${orderId}`}>Recibo</Link>
        <Link className="btn btn-ghost" href={`/orders/${orderId}/history`}>Historial</Link>
      </footer>
    </div>
  </div>;
}

/** Botón «Vista previa» para pantallas que listan órdenes sueltas (Cashea, Crédito, cliente). */
export function OrderPreviewButton({ orderId, cache, label = "Vista previa" }: { orderId: string; cache: Cache; label?: string }) {
  const [open, setOpen] = useState(false);
  const prefetch = usePreviewPrefetch(cache);
  return <>
    <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}
      onPointerEnter={() => prefetch.onPointerEnter(orderId)} onPointerLeave={prefetch.onPointerLeave}>{label}</button>
    {open && <OrderPreviewPanel orderId={orderId} cache={cache} onClose={() => setOpen(false)} />}
  </>;
}
