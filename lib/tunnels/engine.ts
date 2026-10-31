import { allowedActionTypes, applyRules } from "./rules";
import type { BatchDescription, JsonValue, TunnelAction, TunnelAnswer, TunnelCase, TunnelRule } from "./types";

// Pure tunnel engine: turns cases into slides and tracks answers, undo and reopening.
// No React, no network: the player calls the backend and feeds the results back here.

export type CaseSlide = { kind: "confirm" | "choice" | "input"; id: string; item: TunnelCase; original: TunnelCase };
export type BatchSlide = { kind: "batch"; id: string; group: string; items: TunnelCase[]; description: BatchDescription };
export type Slide = { kind: "cover"; id: "cover" } | CaseSlide | BatchSlide | { kind: "summary"; id: "summary" };
export type DecisionSlide = CaseSlide | BatchSlide;

export interface DecisionRecord {
  slideId: string;
  decisionId: string;
  answer: TunnelAnswer;
  action: TunnelAction | null;
  eyebrow: string;
  headline: string;
  /** What was decided, in words ("Sí, registrar el pago", "Apartado"). */
  label: string;
  /** Serialized slide, to rebuild it when the decision is reopened after a reload. */
  snapshot: SlideSnapshot;
  ruleCreatedId?: string | null;
}

export interface TunnelState {
  slides: Slide[];
  index: number;
  decisions: Record<string, DecisionRecord>;
  /** Slide ids in the order they were answered (for Ctrl+Z). */
  order: string[];
  /** After reopening a decision from the summary, the next answer returns there. */
  returnToSummary: boolean;
  /** Decisions of this session whose cases no longer come from the process (already applied before a reload). */
  previous: DecisionRecord[];
}

export type SlideSnapshot = {
  kind: DecisionSlide["kind"];
  item?: TunnelCase;
  group?: string;
  items?: TunnelCase[];
  description?: BatchDescription;
  ruleIds: string[];
};

export const SECONDS_PER_SLIDE: Record<DecisionSlide["kind"], number> = { batch: 15, confirm: 12, choice: 20, input: 30 };

export function defaultBatchDescription(group: string, items: TunnelCase[]): BatchDescription {
  return {
    eyebrow: `Lote automático · ${items.length} casos`,
    headline: String(items.length),
    question: `Casé ${items.length} casos con alta confianza. ¿Los apruebo?`,
    context: items.slice(0, 3).map(i => `${i.eyebrow}: ${i.headline}`),
    label: `Sí, aprobar los ${items.length}`,
  };
}

function caseSlide(item: TunnelCase, original: TunnelCase = item): CaseSlide {
  const kind = item.level === "auto" ? "confirm" : item.level;
  return { kind, id: item.id, item: item.level === "auto" ? { ...item, level: "confirm" } : item, original };
}

export interface PlanOptions {
  rules?: TunnelRule[];
  matcher?: (rule: TunnelRule, item: TunnelCase) => boolean;
  describeBatch?: (group: string, items: TunnelCase[]) => BatchDescription;
}

/**
 * Cover, one slide per decision and the summary. `auto` cases with a proposal are grouped by
 * `batchGroup`; the batch takes the place of its first case. A group of one is a plain yes/no.
 */
export function planSlides(cases: TunnelCase[], options: PlanOptions = {}): Slide[] {
  const originals = new Map(cases.map(c => [c.id, c]));
  const withRules = applyRules(cases, options.rules || [], options.matcher);
  const groups = new Map<string, TunnelCase[]>();
  for (const item of withRules) {
    if (item.level !== "auto" || !item.proposal) continue;
    const key = item.batchGroup || "auto";
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  const placed = new Set<string>();
  const slides: Slide[] = [{ kind: "cover", id: "cover" }];
  for (const item of withRules) {
    const original = originals.get(item.id) || item;
    if (item.level === "auto" && item.proposal) {
      const key = item.batchGroup || "auto";
      if (placed.has(key)) continue;
      placed.add(key);
      const items = groups.get(key) || [item];
      if (items.length === 1) { slides.push(caseSlide({ ...item, level: "confirm" }, original)); continue; }
      const describe = options.describeBatch || defaultBatchDescription;
      slides.push({ kind: "batch", id: `batch:${key}`, group: key, items, description: describe(key, items) });
      continue;
    }
    // An `auto` case without a proposal cannot be approved blindly: ask for it.
    const level = item.level === "auto" ? (item.options?.length ? "choice" : item.input ? "input" : "confirm") : item.level;
    slides.push(caseSlide({ ...item, level }, original));
  }
  slides.push({ kind: "summary", id: "summary" });
  return slides;
}

export function isDecisionSlide(slide: Slide | undefined): slide is DecisionSlide {
  return !!slide && slide.kind !== "cover" && slide.kind !== "summary";
}

export function snapshotOf(slide: DecisionSlide): SlideSnapshot {
  if (slide.kind === "batch") {
    return { kind: "batch", group: slide.group, items: slide.items, description: slide.description, ruleIds: [...new Set(slide.items.map(i => i.ruleId).filter(Boolean) as string[])] };
  }
  return { kind: slide.kind, item: slide.item, ruleIds: slide.item.ruleId ? [slide.item.ruleId] : [] };
}

export function slideFromSnapshot(id: string, snapshot: SlideSnapshot): DecisionSlide | null {
  if (snapshot.kind === "batch" && snapshot.items?.length && snapshot.description) {
    return { kind: "batch", id, group: snapshot.group || id, items: snapshot.items, description: snapshot.description };
  }
  if (snapshot.item) return { kind: snapshot.kind as CaseSlide["kind"], id, item: snapshot.item, original: snapshot.item };
  return null;
}

export function eyebrowOf(slide: DecisionSlide) { return slide.kind === "batch" ? slide.description.eyebrow : slide.item.eyebrow; }
export function headlineOf(slide: DecisionSlide) { return slide.kind === "batch" ? slide.description.headline : slide.item.headline; }

export function createState(slides: Slide[], resumed: DecisionRecord[] = []): TunnelState {
  const ids = new Set(slides.map(s => s.id));
  const decisions: Record<string, DecisionRecord> = {};
  const order: string[] = [];
  const previous: DecisionRecord[] = [];
  for (const record of resumed) {
    if (ids.has(record.slideId)) { decisions[record.slideId] = record; order.push(record.slideId); }
    else previous.push(record);
  }
  return { slides, index: 0, decisions, order, returnToSummary: false, previous };
}

export function summaryIndex(state: TunnelState) { return state.slides.length - 1; }

export function decisionSlides(state: TunnelState): DecisionSlide[] { return state.slides.filter(isDecisionSlide); }

export function pendingSlides(state: TunnelState): DecisionSlide[] {
  return decisionSlides(state).filter(s => !state.decisions[s.id]);
}

export function estimateSeconds(slides: Slide[]): number {
  return slides.filter(isDecisionSlide).reduce((sum, s) => sum + SECONDS_PER_SLIDE[s.kind], 0);
}

export function estimateLabel(seconds: number): string {
  if (seconds <= 0) return "nada pendiente";
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes === 1 ? "cerca de 1 minuto" : `cerca de ${minutes} minutos`;
}

/** "Decisión n de N" for the current slide, and how many are answered. */
export function progress(state: TunnelState) {
  const slides = decisionSlides(state);
  const current = state.slides[state.index];
  const position = isDecisionSlide(current) ? slides.findIndex(s => s.id === current.id) + 1 : 0;
  return { position, total: slides.length, answered: slides.filter(s => state.decisions[s.id]).length };
}

/** Next unanswered decision after `from`, wrapping to earlier ones; summary when none is left. */
export function nextIndex(state: TunnelState, from: number): number {
  for (let i = from + 1; i < state.slides.length; i++) if (isDecisionSlide(state.slides[i]) && !state.decisions[state.slides[i].id]) return i;
  for (let i = 1; i <= from && i < state.slides.length; i++) if (isDecisionSlide(state.slides[i]) && !state.decisions[state.slides[i].id]) return i;
  return summaryIndex(state);
}

export function start(state: TunnelState): TunnelState {
  return { ...state, index: nextIndex(state, 0) };
}

export function goTo(state: TunnelState, index: number): TunnelState {
  return { ...state, index: Math.max(0, Math.min(index, state.slides.length - 1)) };
}

export function recordDecision(state: TunnelState, record: DecisionRecord): TunnelState {
  const decisions = { ...state.decisions, [record.slideId]: record };
  const order = [...state.order.filter(id => id !== record.slideId), record.slideId];
  const next: TunnelState = { ...state, decisions, order };
  const at = state.slides.findIndex(s => s.id === record.slideId);
  return { ...next, returnToSummary: false, index: state.returnToSummary ? summaryIndex(next) : nextIndex(next, at < 0 ? state.index : at) };
}

/** The decision Ctrl+Z / "Deshacer" would revert. */
export function lastDecision(state: TunnelState): DecisionRecord | null {
  const id = state.order[state.order.length - 1];
  return id ? state.decisions[id] || null : null;
}

/** After the backend reverted a decision: forget it and show its slide again. */
export function removeDecision(state: TunnelState, slideId: string, opts: { returnToSummary?: boolean } = {}): TunnelState {
  const decisions = { ...state.decisions };
  delete decisions[slideId];
  const at = state.slides.findIndex(s => s.id === slideId);
  return {
    ...state, decisions, order: state.order.filter(id => id !== slideId),
    index: at >= 0 ? at : state.index, returnToSummary: !!opts.returnToSummary,
  };
}

/** A decision from before a reload was reverted: put its slide back right before the summary. */
export function reopenPrevious(state: TunnelState, record: DecisionRecord): TunnelState {
  const slide = slideFromSnapshot(record.slideId, record.snapshot);
  const previous = state.previous.filter(p => p.decisionId !== record.decisionId);
  if (!slide || state.slides.some(s => s.id === slide.id)) return { ...state, previous };
  const slides = [...state.slides.slice(0, -1), slide, state.slides[state.slides.length - 1]];
  return { ...state, slides, previous, index: slides.length - 2, returnToSummary: true };
}

/** "Revisar uno por uno": the batch becomes one yes/no slide per case. */
export function expandBatch(state: TunnelState, slideId: string): TunnelState {
  const at = state.slides.findIndex(s => s.id === slideId);
  const slide = state.slides[at];
  if (!slide || slide.kind !== "batch" || state.decisions[slideId]) return state;
  const expanded = slide.items.map(item => caseSlide({ ...item, level: "confirm" }, item));
  const slides = [...state.slides.slice(0, at), ...expanded, ...state.slides.slice(at + 1)];
  return { ...state, slides, index: at };
}

/** A new rule changes the proposal of every case still unanswered (never of answered ones). */
export function reapplyRules(state: TunnelState, rules: TunnelRule[], matcher?: (rule: TunnelRule, item: TunnelCase) => boolean): TunnelState {
  const slides = state.slides.map(slide => {
    if (slide.kind === "cover" || slide.kind === "summary" || slide.kind === "batch") return slide;
    if (state.decisions[slide.id]) return slide;
    const [item] = applyRules([slide.original], rules, matcher);
    const level = item.level === "auto" ? "confirm" : item.level;
    return { ...slide, kind: level, item: { ...item, level } } as CaseSlide;
  });
  return { ...state, slides };
}

export function batchAction(slide: BatchSlide): TunnelAction {
  return {
    type: "tunnel.batch",
    label: slide.description.label,
    payload: { items: slide.items.map(i => ({ case_id: i.id, action: { type: i.proposal!.type, payload: i.proposal!.payload, label: i.proposal!.label } })) as JsonValue },
  };
}

/** Parses "38.639,50" or "38639.50" to "38639.50". Returns null when it is not money. */
export function parseMoney(raw: string): string | null {
  const text = raw.trim().replace(/\s|Bs\.?|USD|\$/gi, "");
  if (!text) return null;
  let normalized = text;
  if (text.includes(",")) normalized = text.replace(/\./g, "").replace(",", ".");
  else if ((text.match(/\./g) || []).length > 1) normalized = text.replace(/\./g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Number(normalized).toFixed(2);
}

/** The action an input answer runs. */
export function inputAction(item: TunnelCase, raw: string): TunnelAction | null {
  if (!item.input) return null;
  const value = item.input.type === "money" ? parseMoney(raw) : raw.trim();
  if (!value) return null;
  if (item.input.type === "select" && item.input.choices && !item.input.choices.includes(value)) return null;
  return { type: item.input.action, payload: { ...(item.input.basePayload || {}), value }, label: `${item.input.label}: ${raw.trim()}` };
}

/** True when the action is one the case offers (used for AI proposals too). */
export function actionAllowed(item: TunnelCase, action: TunnelAction, extra: string[] = []): boolean {
  return allowedActionTypes(item).includes(action.type) || extra.includes(action.type);
}
