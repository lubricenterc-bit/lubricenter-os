"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtDate, fmtRef } from "@/lib/format";

type Candidate = {
  order_item_id: string; order_id: string; order_number: string; business_at: string;
  description: string; charged_ref: number; role_now: string; suggested_role: string; reason: string;
};

/**
 * Revisión de líneas viejas para que el reporte de ganancias sea correcto.
 * Solo cambia la clasificación: montos, pagos, inventario y nómina quedan igual.
 */
export default function ProfitReviewPage() {
  const [rows, setRows] = useState<Candidate[]>([]);
  const [costs, setCosts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function load() {
    setLoading(true); setError("");
    const { data, error } = await supabase.rpc("profit_review_candidates");
    if (error) setError(error.message); else setRows((data ?? []) as Candidate[]);
    setLoading(false);
  }
  useEffect(() => { void load(); }, []);

  async function decide(row: Candidate, role: string, cost: number | null) {
    setBusy(row.order_item_id); setError(""); setNotice("");
    const { error } = await supabase.rpc("reclassify_order_item", { p_order_item_id: row.order_item_id, p_role: role, p_cost_ref: cost });
    setBusy(null);
    if (error) return setError(error.message);
    setNotice(`${row.order_number} · ${row.description}: listo.`);
    setRows(r => r.filter(x => x.order_item_id !== row.order_item_id));
  }

  return <main className="container stack">
    <div className="row-between" style={{ flexWrap: "wrap", gap: 12 }}>
      <div>
        <h1 style={{ marginBottom: 4 }}>Revisar ventas viejas</h1>
        <div className="muted">Líneas que pudieron cargarse con el tipo equivocado antes de este cambio. Solo cambia cómo se cuenta la ganancia: no toca montos, pagos, inventario ni nómina.</div>
      </div>
      <Link className="btn btn-ghost" href="/finance/profit">Volver a Ganancias</Link>
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="success" role="status">{notice}</div>}
    {loading ? <div className="card muted">Buscando líneas para revisar…</div> : !rows.length ? <div className="card">No queda nada por revisar.</div> :
      <section className="stack">{rows.map(row => {
        const isOil = row.suggested_role === "OIL_LABOR";
        const cost = costs[row.order_item_id] ?? "";
        const costNum = Number(cost.replace(",", "."));
        return <article className="card stack" key={row.order_item_id}>
          <div className="row-between">
            <div><Link href={`/orders/${row.order_id}`} className="muted small">{row.order_number} · {fmtDate(row.business_at)}</Link>
              <div className="money-lg">{row.description}</div></div>
            <strong>{fmtRef(row.charged_ref)}</strong>
          </div>
          <div className="muted small">{row.reason}</div>
          {isOil ? <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-primary" disabled={busy === row.order_item_id} onClick={() => void decide(row, "OIL_LABOR", null)}>Sí, fue un cambio de aceite</button>
            <button className="btn btn-ghost" disabled={busy === row.order_item_id} onClick={() => void decide(row, "LABOR", null)}>No, fue trabajo de taller</button>
          </div> : <div className="stack" style={{ gap: 8 }}>
            <label className="stack" style={{ gap: 4 }}><span className="label">Si lo compraste afuera, ¿cuánto pagaste? ($ BCV)</span>
              <input className="input" inputMode="decimal" value={cost} placeholder={`Máximo ${row.charged_ref.toFixed(2)}`}
                onChange={e => setCosts(c => ({ ...c, [row.order_item_id]: e.target.value }))} /></label>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn btn-primary" disabled={busy === row.order_item_id || !(costNum >= 0) || cost === ""}
                onClick={() => void decide(row, "PASS_THROUGH", costNum)}>Sí, fue compra para el trabajo</button>
              <button className="btn" disabled={busy === row.order_item_id} onClick={() => void decide(row, "PASS_THROUGH", row.charged_ref)}>Compra al costo (sin ganancia)</button>
              <button className="btn btn-ghost" disabled={busy === row.order_item_id} onClick={() => void decide(row, "PRODUCT", null)}>No, era mercancía de la tienda</button>
            </div>
          </div>}
        </article>;
      })}</section>}
  </main>;
}
