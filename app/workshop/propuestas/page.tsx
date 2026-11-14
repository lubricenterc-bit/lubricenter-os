"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtRef } from "@/lib/format";
import { OsIcon } from "@/components/os-icon";
import { SkelCards } from "@/components/skeleton";
import { PROPOSAL_LABEL, since, type LaborProposal } from "@/lib/mechanic";

type Filter = "PENDING" | "ACCEPTED" | "REJECTED";

/** Propuestas de mano de obra que mandan Cheo y Alexis desde su teléfono. */
export default function LaborProposalsPage() {
  const [filter, setFilter] = useState<Filter>("PENDING");
  const [rows, setRows] = useState<LaborProposal[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoaded(false);
    const { data, error } = await supabase.rpc("labor_proposals_list", { p_status: filter });
    setLoaded(true);
    if (error) { setError(error.message); return; }
    setError("");
    setRows(((data ?? []) as LaborProposal[]).map(row => ({ ...row, amount_ref: Number(row.amount_ref) })));
  }, [filter]);
  useEffect(() => { void load(); }, [load]);

  async function review(row: LaborProposal, status: Filter) {
    let note: string | null = null;
    if (status === "REJECTED") {
      note = window.prompt("¿Por qué no se acepta? (lo verá el mecánico)", "") ?? null;
      if (note === null) return;
    }
    setBusy(row.id); setError("");
    const { error } = await supabase.rpc("labor_proposal_review", { p_id: row.id, p_status: status, p_note: note });
    setBusy(null);
    if (error) { setError(error.message); return; }
    await load();
  }

  return <main className="container stack">
    <header className="os-page-head">
      <div><h1>Cotizaciones de los mecánicos</h1>
        <p>Precios de mano de obra que proponen Cheo y Alexis. Acéptala y agrégala a la orden como trabajo de taller o electroauto; la orden no cambia sola.</p></div>
      <Link className="btn btn-ghost" href="/workshop"><OsIcon name="workshop" size={18} /> Tablero del taller</Link>
    </header>
    <div className="os-mech-seg" role="group" aria-label="Estado">
      {(["PENDING", "ACCEPTED", "REJECTED"] as Filter[]).map(key => <button key={key} type="button" className={filter === key ? "is-on" : undefined}
        aria-pressed={filter === key} onClick={() => setFilter(key)}>{key === "PENDING" ? "Pendientes" : key === "ACCEPTED" ? "Aceptadas" : "No aceptadas"}</button>)}
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {!loaded && <SkelCards count={2} />}
    <div className="os-proposals">
      {loaded && rows.map(row => <article key={row.id} className="card os-proposal">
        <div className="row-between">
          <strong>{row.mechanic} · {[row.plate, row.vehicle].filter(Boolean).join(" · ") || "Sin vehículo"}</strong>
          <span className={"os-mech-proposal is-" + row.status.toLowerCase()}>{PROPOSAL_LABEL[row.status]}</span>
        </div>
        <p>{row.description}</p>
        {row.notes && <p className="muted">Nota: {row.notes}</p>}
        {row.review_note && <p className="muted">Respuesta: {row.review_note}</p>}
        <div className="row-between os-proposal-foot">
          <span><b className="os-proposal-amount">{fmtRef(row.amount_ref)}</b> <small className="muted">{since(row.created_at)}</small></span>
          <span className="row">
            {row.order_id && <Link className="btn btn-ghost" href={`/orders/${row.order_id}`}>Abrir {row.order_number}</Link>}
            {row.status === "PENDING" && <>
              <button type="button" className="btn btn-ghost" disabled={busy === row.id} onClick={() => review(row, "REJECTED")}>No aceptar</button>
              <button type="button" className="btn btn-primary" disabled={busy === row.id} onClick={() => review(row, "ACCEPTED")}>Aceptar</button>
            </>}
            {row.status !== "PENDING" && <button type="button" className="btn btn-ghost" disabled={busy === row.id} onClick={() => review(row, "PENDING")}>Volver a pendiente</button>}
          </span>
        </div>
      </article>)}
      {loaded && !rows.length && !error && <p className="muted">No hay cotizaciones {filter === "PENDING" ? "pendientes" : filter === "ACCEPTED" ? "aceptadas" : "rechazadas"}.</p>}
    </div>
  </main>;
}
