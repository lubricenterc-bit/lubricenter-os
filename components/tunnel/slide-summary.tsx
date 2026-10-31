"use client";

import { useState } from "react";
import type { DecisionRecord } from "@/lib/tunnels/engine";
import type { TunnelBalance } from "@/lib/tunnels/types";

/** Closing slide: the balance with its control number, and every decision with "Modificar". */
export function SlideSummary({ balance, balanceError, decisions, pending, busy, closed, onModify, onContinue, onClose, onRestart, onExit }: {
  balance: TunnelBalance | null;
  balanceError: string | null;
  decisions: DecisionRecord[];
  pending: number;
  busy: boolean;
  closed: boolean;
  onModify: (record: DecisionRecord) => void;
  onContinue: () => void;
  onClose: (note: string) => void;
  onRestart: () => void;
  onExit: () => void;
}) {
  const [note, setNote] = useState("");
  const skipped = decisions.filter(d => d.answer === "SKIP").length;
  const canClose = !!balance && (balance.ok || note.trim().length >= 5) && pending === 0;

  if (closed) {
    return <>
      <div className="tn-slide-body">
        <p className="tn-eyebrow">Listo</p>
        <h1 className="tn-cover-title">Cerraste el túnel</h1>
        {balance && <p className="tn-question">{balance.title}: <span className="tn-num">{balance.total}</span></p>}
      </div>
      <div className="tn-actions"><button type="button" className="tn-btn tn-btn-primary" onClick={onExit} autoFocus>Volver a Túneles pendientes</button></div>
    </>;
  }

  return <>
    <div className="tn-slide-body">
      <p className="tn-eyebrow">Cierre</p>
      <h1 className="tn-summary-title">{balance?.title || "Calculando el cuadre…"}</h1>
      {balanceError && <p className="tn-field-error" role="alert">{balanceError}</p>}
      {balance && <div className="tn-balance">
        <table>
          <tbody>
            {balance.rows.map(row => <tr key={row.label} className={row.emphasis ? "is-emphasis" : undefined}><th scope="row">{row.label}</th><td className="tn-num">{row.value}</td></tr>)}
          </tbody>
          <tfoot>
            <tr><th scope="row">Total</th><td className="tn-num">{balance.total}</td></tr>
            {balance.control && <tr className="tn-control"><th scope="row" colSpan={2}>{balance.control}</th></tr>}
          </tfoot>
        </table>
        {balance.ok ? <p className="tn-ok">El cuadre da.</p> : <p className="tn-diff">{balance.diff || "El cuadre no da."}</p>}
      </div>}
      {pending > 0 && <p className="tn-question">Quedan {pending} {pending === 1 ? "decisión" : "decisiones"} por contestar.</p>}

      {decisions.length > 0 && <section className="tn-decisions" aria-labelledby="tn-decisions-title">
        <h2 id="tn-decisions-title">Tus decisiones{skipped ? ` · ${skipped} ${skipped === 1 ? "apartada" : "apartadas"}` : ""}</h2>
        <ol>
          {decisions.map(record => <li key={record.decisionId}>
            <span><small>{record.eyebrow}</small><strong className="tn-num">{record.headline}</strong><em>{record.label}{record.ruleCreatedId ? " · creó una regla" : ""}</em></span>
            <button type="button" className="tn-link" onClick={() => onModify(record)} disabled={busy}>Modificar</button>
          </li>)}
        </ol>
      </section>}

      {balance && !balance.ok && pending === 0 && <div className="tn-field">
        <label htmlFor="tn-close-note">Explica la diferencia para poder cerrar</label>
        <textarea id="tn-close-note" className="tn-textarea" rows={2} value={note} onChange={e => setNote(e.target.value)} maxLength={2000} />
      </div>}
    </div>
    <div className="tn-actions">
      {pending > 0
        ? <button type="button" className="tn-btn tn-btn-primary" onClick={onContinue}>Seguir con lo pendiente</button>
        : <button type="button" className="tn-btn tn-btn-primary" onClick={() => onClose(note)} disabled={busy || !canClose}>Cerrar</button>}
      <button type="button" className="tn-btn" onClick={onRestart} disabled={busy}>Volver a revisar</button>
    </div>
  </>;
}
