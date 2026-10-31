"use client";

import type { BatchSlide } from "@/lib/tunnels/engine";
import { Key, SlideFrame } from "./slide-frame";

export function SlideBatch({ slide, busy, onYes, onReview, onSkip, onDetail }: {
  slide: BatchSlide; busy: boolean; onYes: () => void; onReview: () => void; onSkip: () => void; onDetail: () => void;
}) {
  const d = slide.description;
  return <SlideFrame eyebrow={d.eyebrow} headline={d.headline} question={d.question} context={d.context} onDetail={onDetail} actions={<>
    <button type="button" className="tn-btn tn-btn-primary" onClick={onYes} disabled={busy}>{d.label} <Key>Enter</Key></button>
    <button type="button" className="tn-btn" onClick={onReview} disabled={busy}>Revisar uno por uno <Key>N</Key></button>
    <button type="button" className="tn-btn tn-btn-quiet" onClick={onSkip} disabled={busy}>No sé, apartar <Key>A</Key></button>
  </>} />;
}
