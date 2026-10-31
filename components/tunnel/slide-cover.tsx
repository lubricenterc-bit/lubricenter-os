"use client";

import { Key } from "./slide-frame";

export function SlideCover({ title, lines, decisions, estimate, previous, onStart, manualHref }: {
  title: string; lines: string[]; decisions: number; estimate: string; previous: number; onStart: () => void; manualHref?: string;
}) {
  const nothing = decisions === 0;
  return <>
    <div className="tn-slide-body">
      <p className="tn-eyebrow">Portada</p>
      <h1 className="tn-cover-title">{title}</h1>
      <div className="tn-context">{lines.map((line, i) => <p key={i}>{line}</p>)}</div>
      <dl className="tn-cover-facts">
        <div><dt>Decisiones pendientes</dt><dd className="tn-num">{decisions}</dd></div>
        <div><dt>Tiempo estimado</dt><dd>{estimate}</dd></div>
        {previous > 0 && <div><dt>Ya decididas en esta sesión</dt><dd className="tn-num">{previous}</dd></div>}
      </dl>
    </div>
    <div className="tn-actions">
      <button type="button" className="tn-btn tn-btn-primary" onClick={onStart} autoFocus>
        {nothing ? "Ver el cuadre" : previous > 0 ? "Continuar" : "Empezar"} <Key>Enter</Key>
      </button>
      {manualHref && <a className="tn-btn" href={manualHref}>Abrir la vista manual</a>}
    </div>
  </>;
}
