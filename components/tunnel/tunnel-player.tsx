"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { readAttendant } from "@/components/attendant-picker";
import { supabase } from "@/lib/supabase";
import { recordFromRow, type DecisionRow, type TunnelBackend } from "@/lib/tunnels/backend";
import { backendFor, forgetPendingCount, tunnelContext } from "@/lib/tunnels/client";
import {
  batchAction, createState, decisionSlides, estimateLabel, estimateSeconds, expandBatch, goTo, inputAction, isDecisionSlide,
  lastDecision, pendingSlides, planSlides, progress, reapplyRules, recordDecision, removeDecision, reopenPrevious, snapshotOf,
  start, summaryIndex, type DecisionRecord, type DecisionSlide, type TunnelState,
} from "@/lib/tunnels/engine";
import { defaultRuleCondition, ruleOutcomePayload } from "@/lib/tunnels/rules";
import type { JsonValue, TunnelAction, TunnelAnswer, TunnelBalance, TunnelCase, TunnelContext, TunnelDefinition } from "@/lib/tunnels/types";
import { ExplainToAi, type ApplyFromExplain } from "./explain-to-ai";
import { ProgressSegments } from "./progress-segments";
import { SlideBatch } from "./slide-batch";
import { SlideChoice } from "./slide-choice";
import { SlideConfirm } from "./slide-confirm";
import { SlideCover } from "./slide-cover";
import { SlideInput } from "./slide-input";
import { SlideSummary } from "./slide-summary";

const SWIPE = 80;
const THEME_KEY = "lubricenter:tunnel-theme";

type Loaded = { backend: TunnelBackend; ctx: TunnelContext; sessionId: string; coverLines: string[] };
type Detail = { title: string; data: Record<string, JsonValue> | Record<string, JsonValue>[] } | null;

function typing(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

/** Full-screen player of one tunnel. The process gives cases; this gives everything else. */
export function TunnelPlayer({ definition }: { definition: TunnelDefinition }) {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [state, setState] = useState<TunnelState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [explain, setExplain] = useState<{ slideId: string } | null>(null);
  const [pendingNo, setPendingNo] = useState<Record<string, string>>({});
  const [detail, setDetail] = useState<Detail>(null);
  const [confirmExit, setConfirmExit] = useState(false);
  const [balance, setBalance] = useState<TunnelBalance | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [dir, setDir] = useState<"fwd" | "back">("fwd");
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [drag, setDrag] = useState(0);
  const dragRef = useRef<{ id: number; x: number; y: number; active: boolean } | null>(null);
  const prevIndex = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { const t = window.localStorage.getItem(THEME_KEY); if (t === "light" || t === "dark") setTheme(t); } catch { /* sin almacenamiento */ }
  }, []);
  const toggleTheme = () => {
    const dark = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    setTheme(next);
    try { window.localStorage.setItem(THEME_KEY, next); } catch { /* sin almacenamiento */ }
  };

  const load = useCallback(async () => {
    setLoadError(null); setError(null); setBalance(null); setClosed(false);
    try {
      const backend = backendFor(definition, supabase);
      const ctx = await tunnelContext(definition, backend, supabase);
      const [cases, coverLines] = await Promise.all([definition.buildCases(ctx), definition.coverLines(ctx)]);
      const slides = planSlides(cases, { rules: ctx.rules, matcher: definition.ruleMatcher, describeBatch: definition.describeBatch });
      const opened = await backend.open(definition.key, readAttendant() || null, slides.length - 2);
      const live = opened.decisions as DecisionRow[];
      const nos: Record<string, string> = {};
      for (const row of live) if (row.answer === "NO") nos[row.case_id] = row.id;
      setPendingNo(nos);
      setLoaded({ backend, ctx, sessionId: opened.session.id, coverLines });
      setState(createState(slides, live.filter(r => r.answer !== "NO").map(recordFromRow)));
      prevIndex.current = 0;
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "No pude preparar el túnel");
    }
  }, [definition]);
  useEffect(() => { void load(); }, [load]);

  const slide = state ? state.slides[state.index] : null;
  useEffect(() => {
    if (!state) return;
    setDir(state.index >= prevIndex.current ? "fwd" : "back");
    prevIndex.current = state.index;
    stageRef.current?.focus({ preventScroll: true });
  }, [state?.index, slide?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The balance is recalculated every time the summary is shown.
  useEffect(() => {
    if (!loaded || slide?.kind !== "summary" || closed) return;
    let active = true;
    setBalanceError(null);
    definition.balance(loaded.ctx).then(b => { if (active) setBalance(b); })
      .catch(e => { if (active) setBalanceError(e instanceof Error ? e.message : "No pude calcular el cuadre"); });
    return () => { active = false; };
  }, [loaded, slide?.kind, closed, definition, state?.order.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = useCallback(async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); forgetPendingCount(); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo completar"); }
    finally { setBusy(false); }
  }, []);

  const decide = useCallback(async (target: DecisionSlide, answer: TunnelAnswer, action: TunnelAction | null, fromDecision?: string | null) => {
    if (!loaded) return null;
    const from = fromDecision ?? pendingNo[target.id] ?? null;
    const row = await loaded.backend.decide({ sessionId: loaded.sessionId, caseId: target.id, snapshot: snapshotOf(target), answer, action, fromDecision: from });
    if (from) setPendingNo(map => { const next = { ...map }; delete next[target.id]; return next; });
    const record = recordFromRow(row);
    setState(s => s && recordDecision(s, record));
    return row;
  }, [loaded, pendingNo]);

  const current = isDecisionSlide(slide ?? undefined) ? slide as DecisionSlide : null;
  const yes = () => current && run(async () => {
    if (current.kind === "batch") await decide(current, "YES", batchAction(current));
    else if (current.kind === "confirm" && current.item.proposal) await decide(current, "YES", current.item.proposal);
  });
  const option = (i: number) => current?.kind === "choice" && current.item.options?.[i] && run(async () => { await decide(current, "OPTION", current.item.options![i]); });
  const submitInput = (raw: string) => current?.kind === "input" && run(async () => {
    const action = inputAction(current.item, raw);
    if (!action) throw new Error("Revisa el dato escrito");
    await decide(current, "INPUT", action);
  });
  const skip = () => current && run(async () => { await decide(current, "SKIP", null); });
  const no = () => {
    if (!current) return;
    if (current.kind === "batch") { setState(s => s && expandBatch(s, current.id)); return; }
    setExplain({ slideId: current.id });
  };

  const undoRecord = useCallback((record: DecisionRecord, toSummary: boolean) => run(async () => {
    if (!loaded || !state) return;
    await loaded.backend.undo(record.decisionId);
    if (state.slides.some(s => s.id === record.slideId)) setState(s => s && removeDecision(s, record.slideId, { returnToSummary: toSummary }));
    else setState(s => s && reopenPrevious(s, record));
  }), [loaded, state, run]);
  const undo = () => { const last = state && lastDecision(state); if (last && !busy) void undoRecord(last, false); };

  const explainSlide = explain && state ? state.slides.find(s => s.id === explain.slideId) as DecisionSlide | undefined : undefined;
  const explainItem: TunnelCase | null = explainSlide && explainSlide.kind !== "batch" ? explainSlide.item : null;

  const onExplain = async (text: string, decisionId: string | null) => {
    if (!loaded || !explainSlide || !explainItem) throw new Error("Caso no disponible");
    const result = await loaded.backend.explain({ key: definition.key, sessionId: loaded.sessionId, item: explainItem, snapshot: snapshotOf(explainSlide), explanation: text, decisionId: decisionId ?? pendingNo[explainSlide.id] ?? null });
    setPendingNo(map => ({ ...map, [explainSlide.id]: result.decisionId }));
    return result;
  };
  const onApplyFromExplain = async (args: ApplyFromExplain) => {
    if (!explainSlide || !explainItem || !loaded) return;
    await run(async () => {
      const row = await decide(explainSlide, args.answer, args.action, args.decisionId);
      setExplain(null);
      if (!args.remember || !row) return;
      const condition = args.ruleSuggestion?.condition
        ?? definition.ruleFromDecision?.(explainItem, args.action)
        ?? defaultRuleCondition(explainItem, Object.keys(explainItem.facts || {}).slice(0, 1));
      if (!condition) { setError("La respuesta quedó aplicada, pero no pude convertirla en regla."); return; }
      const outcome = args.ruleSuggestion?.outcome ?? { action: { type: args.action.type, payload: ruleOutcomePayload(explainItem, args.action) } };
      const rule = await loaded.backend.createRule({ key: definition.key, condition, outcome, description: args.explanation, sourceDecision: row.id });
      const rules = [...loaded.ctx.rules.filter(r => r.id !== rule.id), ...(rule.status === "ACTIVE" ? [rule] : [])];
      loaded.ctx.rules = rules;
      setState(s => {
        if (!s) return s;
        const withRule = { ...s, decisions: { ...s.decisions, [explainSlide.id]: { ...s.decisions[explainSlide.id], ruleCreatedId: rule.id } } };
        return reapplyRules(withRule, rules, definition.ruleMatcher);
      });
      if (rule.status !== "ACTIVE") setError("La regla quedó esperando la aprobación del dueño.");
    });
  };
  const onSkipFromExplain = async (decisionId: string | null) => {
    if (!explainSlide) return;
    await run(async () => { await decide(explainSlide, "SKIP", null, decisionId); setExplain(null); });
  };

  const closeTunnel = (note: string) => run(async () => {
    if (!loaded || !balance) return;
    const action = definition.closeAction ? await definition.closeAction(loaded.ctx, balance) : null;
    if (action) await loaded.backend.decide({ sessionId: loaded.sessionId, caseId: "close", snapshot: { kind: "confirm", ruleIds: [] }, answer: "YES", action });
    await loaded.backend.close(loaded.sessionId, "CLOSED", balance, note || null);
    setClosed(true);
  });

  const exit = () => router.push("/tunnels");
  const requestExit = () => {
    if (state && Object.keys(state.decisions).length > 0 && !closed) setConfirmExit(true);
    else exit();
  };

  // Keyboard (PC): Enter yes, N no, 1–4 options, A apartar, Ctrl+Z undo, Esc exit.
  useEffect(() => {
    if (!state) return;
    function onKey(event: KeyboardEvent) {
      if (explain || detail) { if (event.key === "Escape" && detail) { event.preventDefault(); setDetail(null); } return; }
      if (confirmExit) { if (event.key === "Escape") setConfirmExit(false); return; }
      if (event.key === "Escape") { event.preventDefault(); requestExit(); return; }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { if (!typing(event.target)) { event.preventDefault(); undo(); } return; }
      if (typing(event.target) || event.altKey || event.ctrlKey || event.metaKey || busy) return;
      const k = event.key.toLowerCase();
      if (slide?.kind === "cover" && k === "enter") { event.preventDefault(); setState(s => s && start(s)); return; }
      if (!current) return;
      if (k === "enter" && (current.kind === "confirm" || current.kind === "batch")) {
        if ((event.target as HTMLElement)?.tagName === "BUTTON" && !(event.target as HTMLElement).classList.contains("tn-btn-primary")) return;
        event.preventDefault(); void yes();
      } else if (k === "n") { event.preventDefault(); no(); }
      else if (k === "a") { event.preventDefault(); void skip(); }
      else if (/^[1-4]$/.test(k) && current.kind === "choice") { event.preventDefault(); void option(Number(k) - 1); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Touch: the card follows the finger; past 80 px right = yes, left = no/explain; otherwise it springs back.
  const canSwipeRight = !!current && (current.kind === "batch" || (current.kind === "confirm" && !!current.item.proposal));
  const onPointerDown = (e: ReactPointerEvent) => {
    if (e.pointerType === "mouse" || !current || busy || typing(e.target) || (e.target as HTMLElement).closest("button,a,input,textarea,select,label")) return;
    dragRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, active: false };
  };
  const onPointerMove = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.active) {
      if (Math.abs(dx) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) { dragRef.current = null; return; }
      d.active = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    setDrag(dx > 0 && !canSwipeRight ? dx / 4 : dx);
  };
  const onPointerUp = (e: ReactPointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d?.active) { setDrag(0); return; }
    const dx = e.clientX - d.x;
    setDrag(0);
    if (dx >= SWIPE && canSwipeRight) void yes();
    else if (dx <= -SWIPE) no();
  };

  const ids = useMemo(() => state ? decisionSlides(state).map(s => s.id) : [], [state]);
  const done = useMemo(() => new Set(state ? Object.keys(state.decisions) : []), [state]);
  const prog = state ? progress(state) : null;
  const allDecisions = state ? [...state.previous, ...state.order.map(id => state.decisions[id]).filter(Boolean)] : [];

  const showDetail = (target: DecisionSlide) => setDetail(target.kind === "batch"
    ? { title: target.description.eyebrow, data: target.items.map(i => ({ caso: i.eyebrow, monto: i.headline, propuesta: i.proposal?.label || "", ...(i.detail || {}) })) }
    : { title: target.item.eyebrow, data: target.item.detail || {} });

  return <div className="tn-root" data-tn-theme={theme || undefined}>
    <header className="tn-top">
      <button type="button" className="tn-icon-btn" onClick={requestExit} aria-label="Salir del túnel" title="Salir (Esc)">×</button>
      <div className="tn-top-title">
        <strong>{definition.title}</strong>
        <span className="tn-num">{prog && prog.position > 0 ? `Decisión ${prog.position} de ${prog.total}` : slide?.kind === "summary" ? "Cierre" : prog ? `${prog.total} decisiones` : ""}</span>
      </div>
      <div className="tn-top-tools">
        <button type="button" className="tn-btn tn-btn-small" onClick={undo} disabled={busy || !state || !lastDecision(state)} title="Deshacer (Ctrl+Z)">Deshacer</button>
        <button type="button" className="tn-icon-btn" onClick={toggleTheme} aria-label="Cambiar entre modo claro y noche" title="Modo claro o noche">◐</button>
      </div>
    </header>
    <ProgressSegments ids={ids} done={done} current={current?.id || null} />

    <main className="tn-stage" ref={stageRef} tabIndex={-1} aria-live="polite">
      {loadError && <article className="tn-card"><div className="tn-slide-body">
        <p className="tn-eyebrow">No pude preparar el túnel</p><h1 className="tn-summary-title">{loadError}</h1>
      </div><div className="tn-actions"><button type="button" className="tn-btn tn-btn-primary" onClick={load}>Intentar de nuevo</button><Link className="tn-btn" href="/tunnels">Volver</Link></div></article>}
      {!loadError && (!state || !loaded) && <article className="tn-card is-loading"><div className="tn-slide-body"><p className="tn-eyebrow">Preparando</p><h1 className="tn-summary-title">Revisando los datos…</h1></div></article>}

      {state && loaded && slide && <article key={slide.id} className={`tn-card tn-enter-${dir}`}
        style={drag ? { transform: `translateX(${drag}px) rotate(${drag / 40}deg)`, transition: "none" } : undefined}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => { dragRef.current = null; setDrag(0); }}>
        {drag !== 0 && <span className={"tn-swipe-hint " + (drag > 0 ? "is-yes" : "is-no")} aria-hidden="true">{drag > 0 ? (canSwipeRight ? "Sí" : "") : current?.kind === "batch" ? "Revisar" : "Explicar"}</span>}
        {slide.kind === "cover" && <SlideCover title={definition.coverTitle} lines={loaded.coverLines} decisions={pendingSlides(state).length}
          estimate={estimateLabel(estimateSeconds(pendingSlides(state)))} previous={allDecisions.length}
          onStart={() => setState(s => s && start(s))} manualHref={definition.manualHref} />}
        {slide.kind === "batch" && <SlideBatch slide={slide} busy={busy} onYes={() => void yes()} onReview={no} onSkip={() => void skip()} onDetail={() => showDetail(slide)} />}
        {slide.kind === "confirm" && <SlideConfirm item={slide.item} busy={busy} onYes={() => void yes()} onNo={no} onSkip={() => void skip()} onDetail={slide.item.detail ? () => showDetail(slide) : undefined} />}
        {slide.kind === "choice" && <SlideChoice item={slide.item} busy={busy} onOption={i => void option(i)} onNo={no} onSkip={() => void skip()} onDetail={slide.item.detail ? () => showDetail(slide) : undefined} />}
        {slide.kind === "input" && <SlideInput item={slide.item} busy={busy} onSubmit={v => void submitInput(v)} onNo={no} onSkip={() => void skip()} onDetail={slide.item.detail ? () => showDetail(slide) : undefined} />}
        {slide.kind === "summary" && <SlideSummary balance={balance} balanceError={balanceError} decisions={allDecisions} pending={pendingSlides(state).length}
          busy={busy} closed={closed} onModify={r => void undoRecord(r, true)} onContinue={() => setState(s => s && goTo(s, pendingSlides(s)[0] ? s.slides.findIndex(x => x.id === pendingSlides(s)[0].id) : summaryIndex(s)))}
          onClose={note => void closeTunnel(note)} onRestart={() => void load()} onExit={exit} />}
      </article>}
    </main>

    {error && <div className="tn-toast" role="alert"><span>{error}</span><button type="button" className="tn-link" onClick={() => setError(null)}>Cerrar</button></div>}

    {explain && explainItem && <ExplainToAi key={explain.slideId} item={explainItem} decisionId={pendingNo[explain.slideId] ?? null} busy={busy}
      onExplain={onExplain} onApply={onApplyFromExplain} onSkip={onSkipFromExplain} onClose={() => setExplain(null)} />}

    {detail && <div className="tn-sheet-scrim" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setDetail(null); }}>
      <section className="tn-sheet" role="dialog" aria-modal="true" aria-labelledby="tn-detail-title">
        <header className="tn-sheet-head"><h2 id="tn-detail-title" className="tn-eyebrow">{detail.title}</h2>
          <button type="button" className="tn-icon-btn" onClick={() => setDetail(null)} aria-label="Cerrar detalle" autoFocus>×</button></header>
        <div className="tn-detail">
          {(Array.isArray(detail.data) ? detail.data : [detail.data]).map((entry, i) => <dl key={i}>
            {Object.entries(entry).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className="tn-num">{v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v)}</dd></div>)}
          </dl>)}
        </div>
      </section>
    </div>}

    {confirmExit && <div className="tn-sheet-scrim" role="presentation">
      <section className="tn-sheet tn-sheet-small" role="alertdialog" aria-modal="true" aria-labelledby="tn-exit-title">
        <h2 id="tn-exit-title" className="tn-sheet-title">¿Salir del túnel?</h2>
        <p className="tn-sheet-help">Lo que ya contestaste quedó guardado. Puedes continuar después desde Túneles pendientes.</p>
        <div className="tn-actions tn-actions-inline">
          <button type="button" className="tn-btn tn-btn-primary" onClick={exit} autoFocus>Salir</button>
          <button type="button" className="tn-btn" onClick={() => setConfirmExit(false)}>Seguir aquí</button>
        </div>
      </section>
    </div>}
  </div>;
}
