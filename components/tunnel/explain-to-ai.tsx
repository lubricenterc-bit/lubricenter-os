"use client";

import { useEffect, useRef, useState } from "react";
import type { ExplainResult } from "@/lib/tunnels/backend";
import { inputAction } from "@/lib/tunnels/engine";
import type { AiAnswer, TunnelAction, TunnelCase } from "@/lib/tunnels/types";
import { Key } from "./slide-frame";

export type ApplyFromExplain = {
  action: TunnelAction;
  answer: "YES" | "OPTION" | "INPUT";
  decisionId: string;
  remember: boolean;
  explanation: string;
  ruleSuggestion?: AiAnswer["ruleSuggestion"];
};

/**
 * "Explícale a la IA qué pasa". The AI comes back with a new yes/no proposal; it never applies
 * anything. If it cannot help, the case's own options (or its data field) are offered.
 */
export function ExplainToAi({ item, decisionId: initialDecision, busy, onExplain, onApply, onSkip, onClose }: {
  item: TunnelCase;
  decisionId: string | null;
  busy: boolean;
  onExplain: (text: string, decisionId: string | null) => Promise<ExplainResult>;
  onApply: (args: ApplyFromExplain) => Promise<void>;
  onSkip: (decisionId: string | null) => Promise<void>;
  onClose: (decisionId: string | null) => void;
}) {
  const [text, setText] = useState("");
  const [said, setSaid] = useState<string[]>([]);
  const [remember, setRemember] = useState(true);
  const [phase, setPhase] = useState<"write" | "thinking" | "proposal" | "failed">("write");
  const [decisionId, setDecisionId] = useState<string | null>(initialDecision);
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [message, setMessage] = useState("");
  const [inputValue, setInputValue] = useState("");
  const textRef = useRef<HTMLTextAreaElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  const explanation = said.join(". ");

  useEffect(() => { if (phase === "write") textRef.current?.focus(); if (phase === "proposal") yesRef.current?.focus(); }, [phase]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(decisionId); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [decisionId, onClose]);

  async function send() {
    const value = text.trim();
    if (value.length < 3) return;
    setPhase("thinking");
    setMessage("");
    try {
      const result = await onExplain(value, decisionId);
      setDecisionId(result.decisionId);
      setSaid(list => [...list, value]);
      setText("");
      if (result.ok && result.answer?.proposal) { setAnswer(result.answer); setPhase("proposal"); }
      else {
        setAnswer(result.answer || null);
        setMessage(result.answer?.summary ? `${result.answer.summary} No encontré una acción segura para proponerte.` : result.message || "No pude buscar una solución. Elige o escribe la respuesta");
        setPhase("failed");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "No pude buscar una solución. Elige o escribe la respuesta");
      setPhase("write");
    }
  }

  const apply = (action: TunnelAction, kind: ApplyFromExplain["answer"], suggestion?: AiAnswer["ruleSuggestion"]) => {
    if (!decisionId) return;
    void onApply({ action, answer: kind, decisionId, remember, explanation, ruleSuggestion: suggestion });
  };

  const rememberBox = <label className="tn-remember">
    <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} />
    <span><strong>Recordar esto como regla</strong><small>Los casos parecidos llegarán con esta respuesta propuesta. Puedes verla y borrarla en Reglas aprendidas.</small></span>
  </label>;

  return <div className="tn-sheet-scrim" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) onClose(decisionId); }}>
    <section className="tn-sheet" role="dialog" aria-modal="true" aria-labelledby="tn-explain-title">
      <header className="tn-sheet-head">
        <p className="tn-eyebrow">{item.eyebrow} · {item.headline}</p>
        <button type="button" className="tn-icon-btn" onClick={() => onClose(decisionId)} aria-label="Cerrar">×</button>
      </header>

      {phase === "write" && <>
        <h2 id="tn-explain-title" className="tn-sheet-title">{said.length ? "Explícale de nuevo" : "Explícale a la IA qué pasa"}</h2>
        <p className="tn-sheet-help">Dilo como se lo dirías a alguien de la tienda. La IA revisa los datos y vuelve con una propuesta; no cambia nada sin tu sí.</p>
        <textarea ref={textRef} className="tn-textarea" rows={4} value={text} onChange={e => setText(e.target.value)} maxLength={4000}
          placeholder="Por ejemplo: las facturas que empiezan con NT son de Norte"
          onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void send(); } }} />
        {message && <p className="tn-field-error" role="alert">{message}</p>}
        <div className="tn-actions tn-actions-inline">
          <button type="button" className="tn-btn tn-btn-primary" onClick={send} disabled={busy || text.trim().length < 3}>Buscar una solución <Key>Ctrl Enter</Key></button>
          <button type="button" className="tn-btn tn-btn-quiet" onClick={() => onSkip(decisionId)} disabled={busy}>No sé, apartar</button>
        </div>
      </>}

      {phase === "thinking" && <div className="tn-thinking" role="status" aria-live="polite">
        <span className="tn-spinner" aria-hidden="true" />
        <h2 id="tn-explain-title" className="tn-sheet-title">Revisando los datos…</h2>
        <p className="tn-sheet-help">Puede tardar hasta 30 segundos.</p>
      </div>}

      {phase === "proposal" && answer?.proposal && <>
        <p className="tn-eyebrow">Nueva propuesta</p>
        <h2 id="tn-explain-title" className="tn-sheet-title">{answer.summary}</h2>
        <div className="tn-context"><p>{answer.proposal.label}</p><p className="tn-quiet">Tú dijiste: «{explanation}»</p></div>
        {rememberBox}
        <div className="tn-actions tn-actions-inline">
          <button ref={yesRef} type="button" className="tn-btn tn-btn-primary" disabled={busy}
            onClick={() => apply(answer.proposal!, "YES", answer.ruleSuggestion)}>{answer.proposal.label}</button>
          <button type="button" className="tn-btn" onClick={() => { setPhase("write"); setAnswer(null); }} disabled={busy}>No, explicar de nuevo</button>
          <button type="button" className="tn-btn tn-btn-quiet" onClick={() => onSkip(decisionId)} disabled={busy}>No sé, apartar</button>
        </div>
      </>}

      {phase === "failed" && <>
        <h2 id="tn-explain-title" className="tn-sheet-title">{message}</h2>
        {(item.options?.length || 0) > 0 && <div className="tn-options" role="group" aria-label="Opciones">
          {item.options!.slice(0, 4).map((option, i) => <button key={i} type="button" className="tn-btn tn-option" disabled={busy}
            onClick={() => apply(option, "OPTION")}><span className="tn-option-n">{i + 1}</span>{option.label}</button>)}
        </div>}
        {item.input && <form className="tn-field" onSubmit={e => { e.preventDefault(); const a = inputAction(item, inputValue); if (a) apply(a, "INPUT"); }}>
          <label htmlFor="tn-explain-input">{item.input.label}</label>
          <input id="tn-explain-input" value={inputValue} onChange={e => setInputValue(e.target.value)} inputMode={item.input.type === "money" ? "decimal" : "text"} autoComplete="off" />
          <button type="submit" className="tn-btn" disabled={busy || !inputAction(item, inputValue)}>{item.input.submitLabel || "Guardar"}</button>
        </form>}
        {(item.options?.length || item.input) ? rememberBox : null}
        <div className="tn-actions tn-actions-inline">
          <button type="button" className="tn-btn" onClick={() => setPhase("write")} disabled={busy}>Explicar de nuevo</button>
          <button type="button" className="tn-btn tn-btn-quiet" onClick={() => onSkip(decisionId)} disabled={busy}>No sé, apartar</button>
        </div>
      </>}
    </section>
  </div>;
}
