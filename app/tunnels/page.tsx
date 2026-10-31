"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { tunnelSummary, type TunnelSummary } from "@/lib/tunnels/client";
import { estimateLabel } from "@/lib/tunnels/engine";
import { listTunnels } from "@/lib/tunnels/registry";

type Overview = {
  open: { id: string; tunnel_key: string; started_at: string; decisions: number }[];
  last_closed: { tunnel_key: string; finished_at: string; balance: { total?: string } | null }[];
  rules: Record<string, number>;
};

const dateLabel = (iso: string) => new Intl.DateTimeFormat("es-VE", { dateStyle: "medium", timeStyle: "short", timeZone: "America/Caracas" }).format(new Date(iso));

/** "Túneles pendientes": which tunnels have work, how much and how long it takes. */
export default function TunnelsPage() {
  const tunnels = listTunnels();
  const [summaries, setSummaries] = useState<Record<string, TunnelSummary>>({});
  const [overview, setOverview] = useState<Overview | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    supabase.rpc("tunnel_overview").then(({ data, error }) => {
      if (!active) return;
      if (error) setOverviewError(error.message); else setOverview(data as Overview);
    });
    for (const t of tunnels) void tunnelSummary(t, supabase).then(s => { if (active) setSummaries(m => ({ ...m, [t.key]: s })); });
    return () => { active = false; };
  }, [tunnels]);

  const ordered = [...tunnels].sort((a, b) => (summaries[b.key]?.decisions || 0) - (summaries[a.key]?.decisions || 0));

  return <div className="container tn-list-page">
    <header className="tn-list-head">
      <div>
        <p className="tn-eyebrow">Modo túnel</p>
        <h1>Túneles pendientes</h1>
        <p className="muted">El sistema prepara el trabajo y te guía una decisión a la vez. Cada proceso conserva su vista manual.</p>
      </div>
      <Link className="btn btn-ghost" href="/tunnels/rules">Reglas aprendidas</Link>
    </header>
    {overviewError && <p className="tn-field-error" role="alert">{overviewError}</p>}
    {!tunnels.length && <div className="card"><p>Todavía no hay túneles disponibles.</p></div>}
    <div className="tn-list">
      {ordered.map(t => {
        const s = summaries[t.key];
        const open = overview?.open.find(o => o.tunnel_key === t.key);
        const last = overview?.last_closed.find(l => l.tunnel_key === t.key);
        const rules = overview?.rules[t.key] || 0;
        const work = !!s && s.decisions > 0;
        return <article key={t.key} className={"tn-list-card" + (work ? " has-work" : "")}>
          <div className="tn-list-card-main">
            <h2>{t.title}</h2>
            <p className="muted">{t.description}</p>
            <dl>
              <div><dt>Decisiones pendientes</dt><dd className="tn-num">{s ? (s.error ? "—" : s.decisions) : "…"}</dd></div>
              <div><dt>Tiempo estimado</dt><dd>{s && !s.error ? estimateLabel(s.estimateSeconds) : "…"}</dd></div>
              <div><dt>Último cierre</dt><dd>{last ? `${dateLabel(last.finished_at)}${last.balance?.total ? ` · ${last.balance.total}` : ""}` : "Nunca"}</dd></div>
              {rules > 0 && <div><dt>Reglas activas</dt><dd className="tn-num">{rules}</dd></div>}
            </dl>
            {s?.error && <p className="tn-field-error">{s.error}</p>}
          </div>
          <div className="tn-list-card-actions">
            <Link className={"btn" + (work || open ? " btn-primary" : " btn-ghost")} href={`/tunnels/${t.key}`}>
              {open ? `Continuar (${open.decisions} ${open.decisions === 1 ? "decidida" : "decididas"})` : work ? "Empezar" : "Ver el cuadre"}
            </Link>
            {t.manualHref && <Link className="btn btn-ghost" href={t.manualHref}>Vista manual</Link>}
          </div>
        </article>;
      })}
    </div>
  </div>;
}
