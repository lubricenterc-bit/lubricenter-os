"use client";

import type { ReactNode } from "react";

/** Every slide: eyebrow → big figure → one question → context box → actions. */
export function SlideFrame({ eyebrow, headline, question, context, onDetail, children, actions }: {
  eyebrow: string; headline: string; question: string; context: string[]; rule?: string;
  onDetail?: () => void; children?: ReactNode; actions: ReactNode;
}) {
  return <>
    <div className="tn-slide-body">
      <p className="tn-eyebrow">{eyebrow}</p>
      <h1 className="tn-headline">{headline}</h1>
      <p className="tn-question">{question}</p>
      {(context.length > 0 || onDetail) && <div className="tn-context">
        {context.slice(0, 3).map((line, i) => <p key={i}>{line}</p>)}
        {onDetail && <button type="button" className="tn-link" onClick={onDetail}>Ver detalle</button>}
      </div>}
      {children}
    </div>
    <div className="tn-actions">{actions}</div>
  </>;
}

export function Key({ children }: { children: ReactNode }) {
  return <kbd className="tn-kbd" aria-hidden="true">{children}</kbd>;
}
