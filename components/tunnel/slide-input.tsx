"use client";

import { useState } from "react";
import { parseMoney } from "@/lib/tunnels/engine";
import type { TunnelCase } from "@/lib/tunnels/types";
import { Key, SlideFrame } from "./slide-frame";

export function SlideInput({ item, busy, onSubmit, onNo, onSkip, onDetail }: {
  item: TunnelCase; busy: boolean; onSubmit: (value: string) => void; onNo: () => void; onSkip: () => void; onDetail?: () => void;
}) {
  const input = item.input!;
  const [value, setValue] = useState("");
  const invalid = value.trim() !== "" && input.type === "money" && parseMoney(value) === null;
  const ready = value.trim() !== "" && !invalid;
  return <SlideFrame eyebrow={item.eyebrow} headline={item.headline} question={item.question} context={item.context}
    onDetail={onDetail} actions={<>
      <button type="submit" form={`tn-input-${item.id}`} className="tn-btn tn-btn-primary" disabled={busy || !ready}>{input.submitLabel || "Guardar"} <Key>Enter</Key></button>
      <button type="button" className="tn-btn" onClick={onNo} disabled={busy}>Explicar a la IA</button>
      <button type="button" className="tn-btn tn-btn-quiet" onClick={onSkip} disabled={busy}>No sé, apartar</button>
    </>}>
    <form id={`tn-input-${item.id}`} className="tn-field" onSubmit={e => { e.preventDefault(); if (ready && !busy) onSubmit(value); }}>
      <label htmlFor={`tn-input-field-${item.id}`}>{input.label}</label>
      {input.type === "select"
        ? <select id={`tn-input-field-${item.id}`} value={value} onChange={e => setValue(e.target.value)} autoFocus>
            <option value="">Elige…</option>
            {(input.choices || []).map(choice => <option key={choice} value={choice}>{choice}</option>)}
          </select>
        : <input id={`tn-input-field-${item.id}`} value={value} onChange={e => setValue(e.target.value)} autoFocus
            inputMode={input.type === "money" ? "decimal" : "text"} placeholder={input.placeholder} autoComplete="off"
            className={input.type === "money" ? "tn-num" : undefined} aria-invalid={invalid} />}
      {invalid && <p className="tn-field-error">Escribe un monto, por ejemplo 38.639,50</p>}
    </form>
  </SlideFrame>;
}
