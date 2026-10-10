"use client";
import { useCallback, useEffect, useState } from "react";
import { CasheaSplitEditor } from "@/components/cashea-split-editor";
import { casheaPaymentPreview, newCasheaSplitLine, type CasheaSplitLine } from "@/lib/cashea-split";
import { supabase } from "@/lib/supabase";
import { fmtRef, fmtVes } from "@/lib/format";

export function OrderCasheaSheet({ orderId, totalRef, totalVes, paidVes, onDone, onCancel }: {
  orderId: string; totalRef: number; totalVes: number; paidVes: number;
  onDone: () => Promise<void>; onCancel: () => void;
}) {
  const [percent, setPercent] = useState("40");
  const [splits, setSplits] = useState<CasheaSplitLine[]>([newCasheaSplitLine()]);
  const updateSplits = useCallback((next: CasheaSplitLine[]) => { setSplits(next); setConfirmed(false); setError(""); }, []);
  const [casheaReference, setCasheaReference] = useState("");
  const [bcv, setBcv] = useState(0);
  const [commission, setCommission] = useState(4);
  const [minimum, setMinimum] = useState(25);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [r, s] = await Promise.all([supabase.rpc("get_current_rates"), supabase.from("app_settings").select("key,value").in("key", ["cashea_commission_percent", "cashea_minimum_ref"])]);
        if (r.error || s.error) throw r.error || s.error;
        const rate = Array.isArray(r.data) ? r.data[0] : r.data;
        if (active) { setBcv(Number(rate?.bcv_rate ?? 0)); for (const row of s.data ?? []) { if (row.key === "cashea_commission_percent") setCommission(Number(row.value)); if (row.key === "cashea_minimum_ref") setMinimum(Number(row.value)); } }
      } catch (e: any) { if (active) setError(e.message); }
      finally { if (active) setLoading(false); }
    })();
    return () => { active = false; };
  }, []);
  const pct = Number(percent);
  const initialRef = Math.round(totalRef * pct / 100 * 10000) / 10000;
  const initialVes = Math.round(initialRef * bcv * 100) / 100;
  const extraVes = Math.max(Math.round((initialVes - paidVes) * 100) / 100, 0);
  const financed = Math.max(totalRef - initialRef, 0);
  const splitPreview = casheaPaymentPreview(splits, extraVes, bcv);
  const valid = !loading && bcv > 0 && totalRef >= minimum && Number.isFinite(pct) && pct > 0 && pct <= 100 && paidVes <= initialVes + .01 && splitPreview.valid;
  async function save() {
    if (!valid || !confirmed || busy) return;
    if (!/^\d{1,32}$/.test(casheaReference.trim())) return setError("Escribe el número de orden Cashea.");
    if (!splitPreview.valid) return setError(splitPreview.error || "Revisa cómo recibiste la inicial.");
    setBusy(true); setError("");
    try {
      const result = await supabase.rpc("close_order_cashea_split", { p_order_id: orderId, p_initial_percent: pct, p_initial_payments: splitPreview.payload, p_cashea_reference: casheaReference.trim(), p_expected_total_ves: totalVes, p_expected_total_ref: totalRef, p_expected_bcv: bcv });
      if (result.error) throw result.error;
      await onDone();
    } catch (e: any) { setError(e.message ?? "No pude confirmar el cierre. Recarga la orden antes de reintentar."); }
    finally { setBusy(false); }
  }
  return <div className="overlay"><div className="sheet stack" role="dialog" aria-modal="true" aria-labelledby="cashea-title">
    <div className="row-between"><h2 id="cashea-title">Cobrar con Cashea</h2><button className="btn btn-ghost" disabled={busy} onClick={onCancel}>Volver</button></div>
    <p className="muted">La inicial puede llegar en varios pagos: BDV, BNC, efectivo, Zelle o Binance. Cada movimiento quedará en su cuenta; las cuotas de Cashea se controlan aparte.</p>
    {loading ? <div role="status">Cargando tasas y condiciones…</div> : <>
      <div className="row-between"><strong>Total de la orden</strong><strong>{fmtRef(totalRef)}</strong></div>
      <fieldset disabled={busy} className="form-fields stack">
        <div className="grid grid-3">{[40,50,60].map(n => <button key={n} className={`btn ${pct === n ? "btn-primary" : ""}`} onClick={() => { setPercent(String(n)); setConfirmed(false); setError(""); }}>{n}% inicial</button>)}</div>
        <label>Inicial personalizada (%)<input className="input" type="number" min="0.01" max="100" step="0.01" value={percent} onChange={e => { setPercent(e.target.value); setConfirmed(false); setError(""); }} /></label>
        <div className="card stack"><div className="row-between"><span>Inicial total</span><strong>{fmtRef(initialRef)} · {fmtVes(initialVes)}</strong></div><div className="row-between"><span>Pagos ya registrados</span><strong>{fmtVes(paidVes)}</strong></div><div className="row-between"><strong>Recibir ahora</strong><strong>{fmtVes(extraVes)}</strong></div></div>
        <CasheaSplitEditor lines={splits} onChange={updateSplits} requiredVes={extraVes} bcv={bcv} previouslyPaidVes={paidVes} disabled={busy}/>
        <label>Número de orden Cashea · obligatorio<input className="input" value={casheaReference} onChange={e => {setCasheaReference(e.target.value);setError("");setConfirmed(false);}} /></label>
        <div className="card stack"><div>Por recibir de Cashea: <strong>{fmtRef(financed)}</strong></div><div>3 cuotas de aproximadamente {fmtRef(financed / 3)} · a 14, 28 y 42 días.</div><div>Comisión {commission}%: {fmtRef(totalRef * commission / 100)}. No aumenta el cobro al cliente.</div></div>
        <label className="row"><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Confirmo que verifiqué los cobros en sus bancos o cajas, y que la compra figura aprobada en Cashea.</label>
      </fieldset>
      {totalRef < minimum && <div className="error">El mínimo configurado es {fmtRef(minimum)}.</div>}
      {paidVes > initialVes + .01 && <div className="error">Los pagos registrados superan esta inicial. Aumenta el porcentaje o vuelve a la orden para corregir el pago.</div>}
    </>}
    {error && <div className="error" role="alert">{error}</div>}
    <button className="btn btn-primary btn-block" disabled={busy || !valid || !confirmed} onClick={save}>{busy ? "Registrando…" : "Registrar inicial y cerrar con Cashea"}</button>
  </div></div>;
}
