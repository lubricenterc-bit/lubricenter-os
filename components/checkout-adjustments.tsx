"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef } from "@/lib/format";
import {
  DISCOUNT_REASONS, ROUNDING_OPTIONS, previewAdjustments, roundTarget, type RoundingMode,
} from "@/lib/domain/economics";

export type AdjustmentState = { discountPercent: number; reason: string; mode: RoundingMode };
export const NO_ADJUSTMENT: AdjustmentState = { discountPercent: 0, reason: "", mode: "NONE" };

/** Lee el tope de descuento libre configurado por el dueño. */
export function useDiscountLimit() {
  const [limit, setLimit] = useState(10);
  useEffect(() => {
    let active = true;
    supabase.from("app_settings").select("value").eq("key", "discount_free_limit_percent").maybeSingle()
      .then(({ data }) => { if (active && data?.value != null) setLimit(Number(data.value)); });
    return () => { active = false; };
  }, []);
  return limit;
}

/**
 * Controles de redondeo y descuento. No guarda nada: avisa con onApply(estado, pin).
 * Lo usan la Orden (que guarda en la base) y la Venta rápida (que ajusta el carrito).
 */
export function AdjustmentControls({
  subtotal, current, limit, disabled, disabledReason, busy, casheaSurcharge = 0, onApply,
}: {
  subtotal: number; current: AdjustmentState; limit: number; disabled?: boolean; disabledReason?: string;
  busy?: boolean; casheaSurcharge?: number; onApply: (next: AdjustmentState, pin: string | null) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [pctText, setPctText] = useState(current.discountPercent ? String(current.discountPercent) : "5");
  const [reason, setReason] = useState(current.reason || DISCOUNT_REASONS[0]);
  const [otherReason, setOtherReason] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  const preview = previewAdjustments(subtotal, current.discountPercent, current.mode, casheaSurcharge);
  const afterDiscount = previewAdjustments(subtotal, current.discountPercent, "NONE", casheaSurcharge).total;
  const pct = Number(pctText.replace(",", "."));
  const draft = previewAdjustments(subtotal, Number.isFinite(pct) ? pct : 0, current.mode, casheaSurcharge);
  const needsPin = Number.isFinite(pct) && pct > limit;
  const finalReason = reason === "Otro" ? otherReason.trim() : reason;

  function toggleRounding(mode: RoundingMode) {
    if (disabled || busy) return;
    void onApply({ ...current, mode: current.mode === mode ? "NONE" : mode }, null);
  }
  async function applyDiscount() {
    setError("");
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return setError("Escribe un porcentaje entre 0 y 100.");
    if (!finalReason) return setError("Escribe el motivo del descuento.");
    if (needsPin && !/^\d{4,8}$/.test(pin)) return setError(`Más de ${limit}% necesita el PIN del dueño.`);
    await onApply({ discountPercent: pct, reason: finalReason, mode: current.mode }, needsPin ? pin : null);
    setPin(""); setOpen(false);
  }

  return <div className="stack" style={{ gap: 10 }}>
    <div className="row-between"><span className="label" style={{ margin: 0 }}>Ajustar el total en $</span>
      {(current.mode !== "NONE" || current.discountPercent > 0) && !disabled &&
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void onApply(NO_ADJUSTMENT, null)}>Quitar ajustes</button>}
    </div>
    <div className="grid grid-3" style={{ gap: 8 }}>
      {ROUNDING_OPTIONS.map(o => {
        const value = roundTarget(afterDiscount, o.mode);
        const active = current.mode === o.mode;
        return <button key={o.mode} type="button" title={o.hint} aria-pressed={active}
          className={`btn ${active ? "btn-primary" : ""}`} style={{ minHeight: 52, flexDirection: "column" }}
          disabled={disabled || busy} onClick={() => toggleRounding(o.mode)}>
          <span>{o.label}</span><small>{fmtRef(value)}</small>
        </button>;
      })}
    </div>
    <button type="button" className={`btn ${current.discountPercent > 0 ? "btn-primary" : "btn-ghost"} btn-block`}
      disabled={disabled || busy} onClick={() => { setOpen(v => !v); setError(""); }}>
      {current.discountPercent > 0 ? `Descuento ${current.discountPercent}% · ${current.reason}` : "Dar un descuento"}
    </button>
    {open && !disabled && <div className="card stack" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {[5, 10].map(n => <button key={n} type="button" className={`btn ${pct === n ? "btn-primary" : ""}`} style={{ minHeight: 48 }} onClick={() => setPctText(String(n))}>{n}%</button>)}
        <label className="row" style={{ gap: 6 }}><span className="muted small">Otro</span>
          <input className="input" style={{ width: 90 }} inputMode="decimal" value={pctText} onChange={e => setPctText(e.target.value)} aria-label="Porcentaje de descuento" />%</label>
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <span className="muted small">Motivo</span>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {DISCOUNT_REASONS.map(r => <button key={r} type="button" className={`btn ${reason === r ? "btn-primary" : "btn-ghost"}`} onClick={() => setReason(r)}>{r}</button>)}
        </div>
        {reason === "Otro" && <input className="input" value={otherReason} onChange={e => setOtherReason(e.target.value)} placeholder="Escribe el motivo" />}
      </div>
      {needsPin && <label className="stack" style={{ gap: 6 }}>
        <span className="label">PIN del dueño (más de {limit}%)</span>
        <input className="input" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ""))} />
      </label>}
      <div className="muted small">El cliente ahorra {fmtRef(draft.discount)}. Sale de la parte de Lubricenter: lo de Cheo y Alexis no cambia.</div>
      {error && <div className="error" role="alert">{error}</div>}
      <button type="button" className="btn btn-primary btn-block" style={{ minHeight: 48 }} disabled={busy} onClick={() => void applyDiscount()}>
        {needsPin ? "Aprobar con PIN y aplicar" : `Aplicar ${Number.isFinite(pct) ? pct : 0}% · total ${fmtRef(draft.total)}`}
      </button>
    </div>}
    {(preview.discount !== 0 || preview.rounding !== 0) && <div className="muted small">
      Lista {fmtRef(preview.subtotal)}
      {preview.discount !== 0 && <> · descuento −{fmtRef(preview.discount)}</>}
      {preview.rounding !== 0 && <> · redondeo {preview.rounding > 0 ? "+" : "−"}{fmtRef(Math.abs(preview.rounding))}</>}
      {" "}· <strong>total {fmtRef(preview.total)}</strong>
    </div>}
    {disabled && disabledReason && <div className="muted small">{disabledReason}</div>}
  </div>;
}

/** Versión de la Orden: guarda los ajustes en la base de datos. */
export function OrderAdjustments({ orderId, subtotal, current, casheaSurcharge, hasPayments, onChanged }: {
  orderId: string; subtotal: number; current: AdjustmentState; casheaSurcharge: number; hasPayments: boolean;
  onChanged: (message: string) => void | Promise<void>;
}) {
  const limit = useDiscountLimit();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function apply(next: AdjustmentState, pin: string | null) {
    setBusy(true); setError("");
    const { data, error } = await supabase.rpc("apply_order_adjustments", {
      p_order_id: orderId, p_discount_percent: next.discountPercent, p_discount_reason: next.reason || null,
      p_rounding_mode: next.mode, p_owner_pin: pin,
    });
    setBusy(false);
    if (error) return setError(error.message);
    const total = Number((data as { total_ref?: number } | null)?.total_ref ?? 0);
    await onChanged(next.mode === "NONE" && next.discountPercent === 0 ? "Ajustes quitados." : `Total ajustado a ${fmtRef(total)}.`);
  }
  return <section className="card stack">
    <AdjustmentControls subtotal={subtotal} current={current} limit={limit} busy={busy} casheaSurcharge={casheaSurcharge}
      disabled={hasPayments} disabledReason="Ya hay pagos registrados. Para ajustar el total, quita los pagos primero."
      onApply={apply} />
    {error && <div className="error" role="alert">{error}</div>}
  </section>;
}
