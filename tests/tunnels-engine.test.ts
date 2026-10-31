import { describe, expect, it } from "vitest";
import { memoryBackend } from "../lib/tunnels/backend";
import { demoTunnel } from "../lib/tunnels/demo";
import {
  batchAction, createState, estimateSeconds, expandBatch, inputAction, lastDecision, nextIndex, parseMoney, planSlides,
  progress, reapplyRules, recordDecision, removeDecision, reopenPrevious, snapshotOf, start, type BatchSlide, type CaseSlide, type DecisionRecord, type DecisionSlide,
} from "../lib/tunnels/engine";
import { applyRules, conditionMatches, ruleOutcomePayload } from "../lib/tunnels/rules";
import type { TunnelCase, TunnelContext, TunnelRule } from "../lib/tunnels/types";

const act = (type: string, payload: Record<string, string> = {}, label = "Sí") => ({ type, payload, label });
const c = (id: string, level: TunnelCase["level"], extra: Partial<TunnelCase> = {}): TunnelCase => ({
  id, level, eyebrow: id, headline: "1,00 Bs", question: "¿?", context: [], confidence: 0.5,
  proposal: level === "auto" || level === "confirm" ? act("x.assign", { id, branch: "CABUDARE" }) : undefined,
  options: level === "choice" ? [act("x.assign", { id, branch: "NORTE" }, "Norte"), act("x.assign", { id, branch: "LA_MORAN" }, "La Morán")] : undefined,
  input: level === "input" ? { label: "Monto", type: "money", action: "x.amount", basePayload: { id } } : undefined,
  ...extra,
});
const rule = (extra: Partial<TunnelRule> = {}): TunnelRule => ({
  id: "r1", tunnel_key: "x", status: "ACTIVE", times_used: 0, last_used_at: null, created_at: "", source_decision_id: null,
  description: "Las NT son de Norte", condition: { all: [{ fact: "invoice", op: "startsWith", value: "nt" }] },
  outcome: { action: { type: "x.assign", payload: { branch: "NORTE" } } }, ...extra,
});
const record = (slide: DecisionSlide, decisionId = "d-" + slide.id): DecisionRecord => ({
  slideId: slide.id, decisionId, answer: "YES", action: null, eyebrow: slide.id, headline: "", label: "Sí", snapshot: snapshotOf(slide),
});

describe("Motor de túneles: diapositivas", () => {
  it("ordena los casos, agrupa los automáticos en un lote y deja portada y resumen", () => {
    const slides = planSlides([c("a", "confirm"), c("b", "auto", { batchGroup: "ref" }), c("c", "choice"), c("d", "auto", { batchGroup: "ref" }), c("e", "auto", { batchGroup: "solo" }), c("f", "input")]);
    expect(slides.map(s => s.id)).toEqual(["cover", "a", "batch:ref", "c", "e", "f", "summary"]);
    const batch = slides[2];
    expect(batch.kind === "batch" && batch.items.map(i => i.id)).toEqual(["b", "d"]);
    expect(slides[4].kind).toBe("confirm");
    expect(estimateSeconds(slides)).toBe(12 + 15 + 20 + 12 + 30);
  });

  it("un lote se aplica como una sola acción y puede revisarse uno por uno", () => {
    const slides = planSlides([c("b", "auto"), c("d", "auto")]);
    const batch = slides[1] as BatchSlide;
    expect(batchAction(batch)).toMatchObject({ type: "tunnel.batch", payload: { items: [{ case_id: "b" }, { case_id: "d" }] } });
    const state = expandBatch(start(createState(slides)), batch.id);
    expect(state.slides.map(s => s.id)).toEqual(["cover", "b", "d", "summary"]);
    expect(state.slides[1].kind).toBe("confirm");
  });

  it("avanza a la siguiente pendiente, cuenta el progreso y termina en el resumen", () => {
    let state = start(createState(planSlides([c("a", "confirm"), c("b", "choice"), c("c", "input")])));
    expect(state.index).toBe(1);
    expect(progress(state)).toEqual({ position: 1, total: 3, answered: 0 });
    state = recordDecision(state, record(state.slides[1] as DecisionSlide));
    expect(progress(state)).toEqual({ position: 2, total: 3, answered: 1 });
    state = recordDecision(state, record(state.slides[2] as DecisionSlide));
    state = recordDecision(state, record(state.slides[3] as DecisionSlide));
    expect(state.slides[state.index].kind).toBe("summary");
  });

  it("deshacer vuelve a la diapositiva anterior y deja cambiar la respuesta (rehacer)", () => {
    let state = start(createState(planSlides([c("a", "confirm"), c("b", "choice")])));
    state = recordDecision(state, record(state.slides[1] as DecisionSlide, "d1"));
    expect(state.index).toBe(2);
    const last = lastDecision(state)!;
    expect(last.decisionId).toBe("d1");
    state = removeDecision(state, last.slideId);
    expect(state.index).toBe(1);
    expect(state.decisions.a).toBeUndefined();
    state = recordDecision(state, { ...record(state.slides[1] as DecisionSlide, "d2"), answer: "OPTION" });
    expect(state.decisions.a.decisionId).toBe("d2");
    expect(state.index).toBe(2);
  });

  it("modificar desde el resumen vuelve al resumen al contestar", () => {
    let state = start(createState(planSlides([c("a", "confirm"), c("b", "confirm")])));
    state = recordDecision(state, record(state.slides[1] as DecisionSlide));
    state = recordDecision(state, record(state.slides[2] as DecisionSlide));
    state = removeDecision(state, "a", { returnToSummary: true });
    expect(state.index).toBe(1);
    state = recordDecision(state, record(state.slides[1] as DecisionSlide, "again"));
    expect(state.slides[state.index].kind).toBe("summary");
  });

  it("al retomar marca lo ya contestado y reabre decisiones de antes de recargar", () => {
    const slides = planSlides([c("a", "confirm"), c("b", "confirm")]);
    const old = record(planSlides([c("z", "choice")])[1] as DecisionSlide, "old");
    let state = start(createState(slides, [record(slides[1] as DecisionSlide, "d-a"), old]));
    expect(state.index).toBe(2);
    expect(state.previous.map(p => p.decisionId)).toEqual(["old"]);
    state = reopenPrevious(state, old);
    expect(state.slides.map(s => s.id)).toEqual(["cover", "a", "b", "z", "summary"]);
    expect(state.slides[state.index].id).toBe("z");
    expect(state.returnToSummary).toBe(true);
    expect(nextIndex(state, 0)).toBe(2);
  });
});

describe("Reglas aprendidas", () => {
  it("evalúan condiciones sin importar mayúsculas ni acentos", () => {
    expect(conditionMatches({ all: [{ fact: "invoice", op: "startsWith", value: "nt" }] }, { invoice: "NT-0045" })).toBe(true);
    expect(conditionMatches({ all: [{ fact: "description", op: "contains", value: "anticipo" }] }, { description: "Adelanto" })).toBe(false);
    expect(conditionMatches({ all: [{ fact: "description", op: "contains", value: "adelanto" }] }, { description: "Adelánto" })).toBe(true);
    expect(conditionMatches({ all: [{ fact: "amount", op: "between", value: [100, 200] }] }, { amount: "150.5" })).toBe(true);
    expect(conditionMatches({ all: [{ fact: "otro", op: "eq", value: "x" }] }, { invoice: "x" })).toBe(false);
  });

  it("cambian la propuesta y suben el caso a sí o no, solo con acciones que el caso acepta", () => {
    const [changed, untouched, wrongAction] = applyRules([
      c("a", "choice", { facts: { invoice: "NT-0051" } }),
      c("b", "choice", { facts: { invoice: "OS-000300" } }),
      c("c", "input", { facts: { invoice: "NT-1" } }),
    ], [rule()]);
    expect(changed).toMatchObject({ level: "confirm", ruleId: "r1", proposal: { type: "x.assign", payload: { id: "a", branch: "NORTE" }, label: "Norte" } });
    expect(changed.context[0]).toContain("Regla aprendida");
    expect(untouched.ruleId).toBeUndefined();
    expect(wrongAction.ruleId).toBeUndefined();
    expect(applyRules([c("a", "choice", { facts: { invoice: "NT" } })], [rule({ status: "DISABLED" })])[0].ruleId).toBeUndefined();
    // A rule learned from another record never carries that record's identifiers.
    const leaked = rule({ outcome: { action: { type: "x.assign", payload: { id: "otro", branch: "NORTE" } } } });
    expect(applyRules([c("q", "choice", { facts: { invoice: "NT-9" }, subject: { id: "q" } })], [leaked])[0].proposal?.payload).toEqual({ id: "q", branch: "NORTE" });
    expect(ruleOutcomePayload(c("q", "choice"), act("x.assign", { id: "q", branch: "NORTE" }))).toEqual({ branch: "NORTE" });
  });

  it("una regla nueva cambia la propuesta del siguiente caso, no la de los ya contestados", () => {
    let state = start(createState(planSlides([c("a", "choice", { facts: { invoice: "NT-0045" } }), c("b", "choice", { facts: { invoice: "NT-0051" } })])));
    state = recordDecision(state, record(state.slides[1] as DecisionSlide));
    state = reapplyRules(state, [rule()]);
    const [, first, second] = state.slides as DecisionSlide[];
    expect(first.kind).toBe("choice");
    expect(second.kind === "confirm" && second.item.proposal?.payload.branch).toBe("NORTE");
    state = reapplyRules(state, []);
    expect((state.slides[2] as DecisionSlide).kind).toBe("choice");
  });
});

describe("Datos escritos", () => {
  it("entiende montos venezolanos", () => {
    expect(parseMoney("38.639,50")).toBe("38639.50");
    expect(parseMoney("39740.1")).toBe("39740.10");
    expect(parseMoney("1.234.567")).toBe("1234567.00");
    expect(parseMoney("Bs 12,5")).toBe("12.50");
    expect(parseMoney("doce")).toBeNull();
    expect(inputAction(c("f", "input"), "34.782,24")).toMatchObject({ type: "x.amount", payload: { id: "f", value: "34782.24" } });
    expect(inputAction(c("f", "input"), "")).toBeNull();
  });
});

describe("Túnel demo con backend en memoria", () => {
  it("aplica, deshace en tres tipos de acción y aprende una regla que cambia un caso posterior", async () => {
    const backend = memoryBackend(demoTunnel, { reset: true });
    const ctx: TunnelContext = { supabase: null, today: "2026-10-31", rules: [], memory: backend.db.memory };
    const cases = await demoTunnel.buildCases(ctx);
    let state = start(createState(planSlides(cases, { describeBatch: demoTunnel.describeBatch })));
    const { session } = await backend.open("demo", null, cases.length);
    const balanceBefore = await demoTunnel.balance(ctx);
    expect(balanceBefore.ok).toBe(false);

    // Batch.
    const batch = state.slides.find(s => s.kind === "batch") as BatchSlide;
    expect(batch.items).toHaveLength(6);
    const d1 = await backend.decide({ sessionId: session.id, caseId: batch.id, snapshot: snapshotOf(batch), answer: "YES", action: batchAction(batch) });
    expect((await demoTunnel.buildCases(ctx)).length).toBe(6);
    await backend.undo(d1.id);
    expect((await demoTunnel.buildCases(ctx)).length).toBe(12);

    // Input (money).
    const input = state.slides.find(s => s.kind === "input") as CaseSlide;
    const d2 = await backend.decide({ sessionId: session.id, caseId: input.id, snapshot: snapshotOf(input), answer: "INPUT", action: inputAction(input.item, "39.740,10") });
    await backend.undo(d2.id);
    expect((await demoTunnel.buildCases(ctx)).some(x => x.id === input.id)).toBe(true);

    // Choice, undone and answered differently.
    const choice = state.slides.find(s => s.kind === "choice") as CaseSlide;
    const d3 = await backend.decide({ sessionId: session.id, caseId: choice.id, snapshot: snapshotOf(choice), answer: "OPTION", action: choice.item.options![1] });
    await expect(backend.decide({ sessionId: session.id, caseId: choice.id, snapshot: snapshotOf(choice), answer: "OPTION", action: choice.item.options![0] })).rejects.toThrow("Deshazla");
    await backend.undo(d3.id);
    await expect(backend.undo(d3.id)).rejects.toThrow("ya se deshizo");
    await backend.decide({ sessionId: session.id, caseId: choice.id, snapshot: snapshotOf(choice), answer: "OPTION", action: choice.item.options![0] });

    // "No" on NT-0045, explained; the rule then changes NT-0051 further ahead.
    const nt45 = state.slides.find(s => s.id === "demo:l8") as CaseSlide;
    const explained = await backend.explain({ key: "demo", sessionId: session.id, item: nt45.item, snapshot: snapshotOf(nt45), explanation: "Las facturas NT son de Norte", decisionId: null });
    expect(explained.ok).toBe(false);
    const norte = nt45.item.options!.find(o => o.payload.branch === "NORTE")!;
    const final = await backend.decide({ sessionId: session.id, caseId: nt45.id, snapshot: snapshotOf(nt45), answer: "OPTION", action: norte, fromDecision: explained.decisionId });
    expect(final.user_explanation).toBe("Las facturas NT son de Norte");
    const condition = demoTunnel.ruleFromDecision!(nt45.item, norte)!;
    const created = await backend.createRule({ key: "demo", condition, outcome: { action: { type: norte.type, payload: ruleOutcomePayload(nt45.item, norte) } }, description: "Las facturas NT son de Norte", sourceDecision: final.id });
    state = recordDecision(state, { ...record(nt45, final.id), answer: "OPTION" });
    state = reapplyRules(state, await backend.rules("demo"));
    const nt51 = state.slides.find(s => s.id === "demo:l12") as DecisionSlide;
    expect(nt51.kind === "confirm" && nt51.item.proposal).toMatchObject({ payload: { line_id: "l12", branch: "NORTE" } });
    expect(nt51.kind === "confirm" && nt51.item.ruleId).toBe(created.id);
    await backend.decide({ sessionId: session.id, caseId: nt51.id, snapshot: snapshotOf(nt51), answer: "YES", action: (nt51 as CaseSlide).item.proposal! });
    expect((await backend.rules("demo"))[0].times_used).toBe(1);
  });

  it("si una acción del lote falla, no queda nada aplicado", async () => {
    const backend = memoryBackend(demoTunnel, { reset: true });
    const { session } = await backend.open("demo", null, 0);
    const bad = { type: "tunnel.batch", label: "x", payload: { items: [
      { case_id: "a", action: { type: "demo.assign_branch", payload: { line_id: "l1", branch: "NORTE" }, label: "" } },
      { case_id: "b", action: { type: "demo.assign_branch", payload: { line_id: "l2", branch: "MARTE" }, label: "" } }] } };
    await expect(backend.decide({ sessionId: session.id, caseId: "batch:x", snapshot: { kind: "batch", ruleIds: [] }, answer: "YES", action: bad as never })).rejects.toThrow("Sucursal inválida");
    const lines = (backend.db.memory as { lines: { id: string; branch: string | null }[] }).lines;
    expect(lines.find(l => l.id === "l1")?.branch).toBeNull();
  });
});
