"use client";

import type { TunnelCase } from "@/lib/tunnels/types";
import { Key, SlideFrame } from "./slide-frame";

export function SlideChoice({ item, busy, onOption, onNo, onSkip, onDetail }: {
  item: TunnelCase; busy: boolean; onOption: (index: number) => void; onNo: () => void; onSkip: () => void; onDetail?: () => void;
}) {
  const suggested = item.proposal ? (item.options || []).findIndex(o => o.type === item.proposal!.type && JSON.stringify(o.payload) === JSON.stringify(item.proposal!.payload)) : -1;
  return <SlideFrame eyebrow={item.eyebrow} headline={item.headline} question={item.question} context={item.context}
    onDetail={onDetail} actions={<>
      <div className="tn-options" role="group" aria-label="Opciones">
        {(item.options || []).slice(0, 4).map((option, i) =>
          <button key={i} type="button" className={"tn-btn tn-option" + (i === suggested ? " tn-btn-primary" : "")} onClick={() => onOption(i)} disabled={busy}>
            <span className="tn-option-n">{i + 1}</span>{option.label}
          </button>)}
      </div>
      <button type="button" className="tn-btn" onClick={onNo} disabled={busy}>Ninguna, explicar <Key>N</Key></button>
      <button type="button" className="tn-btn tn-btn-quiet" onClick={onSkip} disabled={busy}>No sé, apartar <Key>A</Key></button>
    </>} />;
}
