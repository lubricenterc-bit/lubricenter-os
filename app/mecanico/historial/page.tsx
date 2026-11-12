"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { SkelCards } from "@/components/skeleton";
import { shortDate, type MechanicOrder } from "@/lib/mechanic";

const RANGES = [
  { days: 7, label: "7 días" },
  { days: 30, label: "30 días" },
  { days: 90, label: "3 meses" },
] as const;

/** Historial: los trabajos del mecánico en órdenes ya cerradas (sin montos). */
export default function MechanicHistoryPage() {
  const [days, setDays] = useState<number>(30);
  const [rows, setRows] = useState<MechanicOrder[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let active = true;
    setLoaded(false);
    supabase.rpc("mechanic_history", { p_days: days }).then(({ data, error }) => {
      if (!active) return;
      setLoaded(true);
      if (error) { setError(error.message); return; }
      setError("");
      setRows((data ?? []) as MechanicOrder[]);
    });
    return () => { active = false; };
  }, [days]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase().replace(/\s/g, "");
    if (!term) return rows;
    return rows.filter(row => [row.plate, row.vehicle, row.customer, row.order_number, ...row.my_jobs.map(job => job.description)]
      .some(value => (value || "").toLowerCase().replace(/\s/g, "").includes(term)));
  }, [rows, search]);
  const jobs = filtered.reduce((sum, row) => sum + row.my_jobs.length, 0);

  return <div className="os-mech-page">
    <header className="os-mech-title">
      <h1>Historial</h1>
      <p>{loaded ? `${filtered.length} vehículos · ${jobs} trabajos` : "Cargando…"}</p>
    </header>
    <div className="os-mech-filters">
      <div className="os-mech-seg" role="group" aria-label="Período">
        {RANGES.map(range => <button key={range.days} type="button" className={days === range.days ? "is-on" : undefined}
          aria-pressed={days === range.days} onClick={() => setDays(range.days)}>{range.label}</button>)}
      </div>
      <input className="input" type="search" placeholder="Buscar placa, carro o trabajo" value={search}
        onChange={e => setSearch(e.target.value)} aria-label="Buscar en el historial" />
    </div>
    {error && <div className="error" role="alert">{error}</div>}
    {!loaded && <SkelCards count={3} />}
    {loaded && filtered.map(row => <article key={row.order_id} className="os-mech-card is-compact">
      <div className="os-mech-card-top">
        {row.plate ? <span className="os-plate"><small>VENEZUELA</small><b>{row.plate}</b></span> : <span className="os-plate is-walkin"><b>Sin placa</b></span>}
        <span className="os-mech-date">{shortDate(row.date)}</span>
      </div>
      <h3>{row.vehicle || "Vehículo sin datos"}</h3>
      <p className="os-mech-meta">{[row.customer, row.order_number].filter(Boolean).join(" · ")}</p>
      <ul className="os-mech-jobs">{row.my_jobs.map((job, index) => <li key={index}>{job.description}{job.helper && <em> (ayudante)</em>}</li>)}</ul>
    </article>)}
    {loaded && !filtered.length && !error && <div className="os-mech-empty"><p>No hay trabajos en este período.</p></div>}
  </div>;
}
