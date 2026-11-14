"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useVisiblePolling } from "@/lib/use-visible-polling";
import { haptic } from "@/lib/haptics";
import { OsIcon } from "@/components/os-icon";
import { SkelCards } from "@/components/skeleton";
import { MECHANIC_STAGES, STAGE_LABEL, quantity, since, type MechanicOrder, type MechanicStage } from "@/lib/mechanic";

/** Mis trabajos: los vehículos abiertos donde el mecánico tiene trabajo asignado. */
export default function MechanicJobsPage() {
  const [rows, setRows] = useState<MechanicOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("mechanic_my_jobs");
    setLoaded(true);
    if (error) { setError(error.message); return; }
    setError("");
    setRows((data ?? []) as MechanicOrder[]);
  }, []);
  useVisiblePolling(load, 60_000);

  async function setStage(row: MechanicOrder, stage: MechanicStage) {
    if (row.workflow_status === stage) return;
    setBusy(row.order_id); setError(""); setNotice("");
    const { error } = await supabase.rpc("mechanic_set_stage", { p_order_id: row.order_id, p_status: stage });
    setBusy(null);
    if (error) { setError(error.message); return; }
    haptic("success");
    setNotice(`${row.plate || row.order_number}: ${STAGE_LABEL[stage]}`);
    await load();
  }

  const working = rows.filter(row => row.workflow_status !== "READY");
  const ready = rows.filter(row => row.workflow_status === "READY");

  return <div className="os-mech-page">
    <header className="os-mech-title">
      <h1>Mis trabajos</h1>
      <p>{loaded ? rows.length === 0 ? "No tienes vehículos asignados ahora." : `${working.length} por trabajar · ${ready.length} listos` : "Cargando…"}</p>
    </header>
    {error && <div className="error" role="alert">{error}</div>}
    {notice && <div className="success" role="status">{notice}</div>}
    {!loaded && <SkelCards count={2} />}
    {working.map(row => <JobCard key={row.order_id} row={row} busy={busy === row.order_id} onStage={setStage} />)}
    {ready.length > 0 && <h2 className="os-mech-section">Listos para entregar</h2>}
    {ready.map(row => <JobCard key={row.order_id} row={row} busy={busy === row.order_id} onStage={setStage} />)}
    {loaded && rows.length === 0 && !error && <div className="os-mech-empty">
      <OsIcon name="check" size={28} />
      <p>Cuando en el mostrador te asignen un trabajo en una orden, aparece aquí.</p>
    </div>}
  </div>;
}

function JobCard({ row, busy, onStage }: { row: MechanicOrder; busy: boolean; onStage: (row: MechanicOrder, stage: MechanicStage) => void }) {
  return <article className={"os-mech-card" + (row.workflow_status === "READY" ? " is-ready" : "")}>
    <div className="os-mech-card-top">
      {row.plate ? <span className="os-plate"><small>VENEZUELA</small><b>{row.plate}</b></span> : <span className="os-plate is-walkin"><b>Sin placa</b></span>}
      <span className={"os-mech-stage is-" + row.workflow_status.toLowerCase()}>{STAGE_LABEL[row.workflow_status]}</span>
    </div>
    <h3>{row.vehicle || "Vehículo sin datos"}</h3>
    <p className="os-mech-meta">{[row.customer, row.order_number, since(row.workflow_updated_at || row.opened_at)].filter(Boolean).join(" · ")}</p>

    <div className="os-mech-block">
      <span className="label">Tu trabajo</span>
      <ul>{row.my_jobs.map((job, index) => <li key={index}>{job.description}{job.helper && <em> (ayudante)</em>}</li>)}</ul>
    </div>
    {row.parts.length > 0 && <div className="os-mech-block">
      <span className="label">Repuestos y productos en la orden</span>
      <ul>{row.parts.map((part, index) => <li key={index}>{quantity(part.quantity)} × {part.description}</li>)}</ul>
    </div>}
    {row.notes && <p className="os-mech-notes"><OsIcon name="alert" size={16} /> {row.notes}</p>}

    <div className="os-mech-stages" role="group" aria-label={"Avance de " + (row.plate || row.order_number)}>
      {MECHANIC_STAGES.map(stage => <button key={stage} type="button" disabled={busy}
        className={row.workflow_status === stage ? "is-on" : undefined} aria-pressed={row.workflow_status === stage}
        onClick={() => onStage(row, stage)}>{STAGE_LABEL[stage]}</button>)}
    </div>
    <Link className="os-mech-link" href={`/mecanico/cotizar?orden=${row.order_id}`}>
      <OsIcon name="plus" size={16} /> Proponer mano de obra para este vehículo
    </Link>
  </article>;
}
