"use client";

import type { TunnelCase } from "@/lib/tunnels/types";
import { Key, SlideFrame } from "./slide-frame";

export function SlideConfirm({ item, busy, onYes, onNo, onSkip, onDetail }: {
  item: TunnelCase; busy: boolean; onYes: () => void; onNo: () => void; onSkip: () => void; onDetail?: () => void;
}) {
  return <SlideFrame eyebrow={item.eyebrow} headline={item.headline} question={item.question} context={item.context}
    onDetail={onDetail} actions={<>
      <button type="button" className="tn-btn tn-btn-primary" onClick={onYes} disabled={busy || !item.proposal}>{item.proposal?.label || "Sí"} <Key>Enter</Key></button>
      <button type="button" className="tn-btn" onClick={onNo} disabled={busy}>No, explicar <Key>N</Key></button>
      <button type="button" className="tn-btn tn-btn-quiet" onClick={onSkip} disabled={busy}>No sé, apartar <Key>A</Key></button>
    </>} />;
}
