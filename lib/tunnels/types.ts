import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Modo túnel: a process hands the engine its cases, reversible actions and a final balance;
 * the engine supplies slides, progress, keyboard and gestures, "no → explain to the AI",
 * learned rules, undo and the summary. See docs/tunnels.md.
 */

/** How much effort a case needs. `auto` cases are grouped into one batch slide. */
export type CaseLevel = "auto" | "confirm" | "choice" | "input";
export type SlideKind = "batch" | "confirm" | "choice" | "input";
export type TunnelAnswer = "YES" | "NO" | "OPTION" | "INPUT" | "SKIP";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type Facts = Record<string, string | number | boolean | null>;

export interface TunnelAction {
  /** Registered action type, e.g. `cashea.assign_branch`. */
  type: string;
  payload: Record<string, JsonValue>;
  /** Button text, e.g. "Sí, registrar el pago". */
  label: string;
}

export interface TunnelInput {
  label: string;
  type: "money" | "text" | "select";
  choices?: string[];
  /** Action type to run with `{ ...basePayload, value }`. */
  action: string;
  basePayload?: Record<string, JsonValue>;
  /** Button text; defaults to "Guardar". */
  submitLabel?: string;
  placeholder?: string;
}

export interface TunnelCase {
  /** Stable across reloads (derived from the source record). */
  id: string;
  level: CaseLevel;
  /** Small label: what it is and where it comes from. */
  eyebrow: string;
  /** Big number or datum. */
  headline: string;
  /** One sentence. */
  question: string;
  /** One to three lines of evidence. */
  context: string[];
  /** Shown in "Ver detalle" without leaving the tunnel. */
  detail?: Record<string, JsonValue>;
  /** 0–1. */
  confidence: number;
  proposal?: TunnelAction;
  options?: TunnelAction[];
  input?: TunnelInput;
  /** Cases with the same group and level `auto` become one batch slide. */
  batchGroup?: string;
  /** Data learned rules can match on (invoice, cedula, amount…). */
  facts?: Facts;
  /**
   * Payload keys that identify this case's record (e.g. `{ line_id }`). A learned rule never
   * stores them; when it applies to another case, that case's own subject is used.
   */
  subject?: Record<string, JsonValue>;
  /** Set by the engine when a learned rule produced the proposal. */
  ruleId?: string;
  ruleDescription?: string;
}

export type RuleOperator = "eq" | "neq" | "in" | "contains" | "startsWith" | "gte" | "lte" | "between";
export interface RuleClause { fact: string; op: RuleOperator; value: JsonValue }
export interface RuleCondition { all: RuleClause[] }
export interface RuleOutcome { action: { type: string; payload: Record<string, JsonValue>; label?: string } }
export type RuleStatus = "ACTIVE" | "DISABLED" | "PENDING_APPROVAL";

export interface TunnelRule {
  id: string;
  tunnel_key: string;
  condition: RuleCondition;
  outcome: RuleOutcome;
  description: string;
  status: RuleStatus;
  times_used: number;
  last_used_at: string | null;
  created_at: string;
  source_decision_id: string | null;
}

export interface BalanceRow { label: string; value: string; emphasis?: boolean }
export interface TunnelBalance {
  ok: boolean;
  title: string;
  total: string;
  rows: BalanceRow[];
  /** Shown in red when the balance does not close. */
  diff?: string;
  /** Control line, e.g. "Saldo del BNC: 652.859,68 Bs". */
  control?: string;
}

export interface BatchDescription { eyebrow: string; headline: string; question: string; context: string[]; label: string }

export interface TunnelContext {
  supabase: SupabaseClient | null;
  /** YYYY-MM-DD in Venezuela. */
  today: string;
  /** Active learned rules of this process. */
  rules: TunnelRule[];
  /** In-memory store for tunnels that do not touch the database (demo, tests). */
  memory?: Record<string, unknown>;
}

export interface AiToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Read only. Returns data for the model; never applies anything. */
  run(input: Record<string, unknown>, ctx: TunnelContext): Promise<unknown>;
}

/** Local implementation of an action, for tunnels backed by memory. */
export interface LocalHandler {
  apply(payload: Record<string, JsonValue>, memory: Record<string, unknown>): Record<string, JsonValue>;
  revert(revert: Record<string, JsonValue>, memory: Record<string, unknown>): void;
}

export interface TunnelDefinition {
  key: string;
  title: string;
  /** One line for the "Túneles pendientes" card. */
  description: string;
  /** Permission key checked by the database (`tunnels.<key>`). */
  permission: string;
  /** Link to the manual view of the same process. */
  manualHref?: string;
  /** "Vamos a cuadrar Cashea". */
  coverTitle: string;
  /** What the system reviewed, one line each. */
  coverLines(ctx: TunnelContext): Promise<string[]>;
  /** Ordered cases. Resolved cases must not come back. */
  buildCases(ctx: TunnelContext): Promise<TunnelCase[]>;
  describeBatch?(group: string, items: TunnelCase[]): BatchDescription;
  balance(ctx: TunnelContext): Promise<TunnelBalance>;
  /** Optional reversible closing action (e.g. save the cut-off). */
  closeAction?(ctx: TunnelContext, balance: TunnelBalance): Promise<TunnelAction | null>;
  /** Read-only tools the AI may use. */
  aiTools: AiToolDef[];
  /** Short process explanation for the AI system prompt. */
  aiInstructions: string;
  /** Extra action types the AI may propose for any case (besides the case's own). */
  aiExtraActions?: string[];
  /** Overrides the generic rule matcher. */
  ruleMatcher?(rule: TunnelRule, item: TunnelCase): boolean;
  /** Builds the condition of a learned rule when the AI did not suggest one. */
  ruleFromDecision?(item: TunnelCase, action: TunnelAction): RuleCondition | null;
  /** `memory` tunnels never touch the database (demo and tests). */
  backend: "supabase" | "memory";
  localHandlers?: Record<string, LocalHandler>;
  /** Initial memory for `memory` tunnels. */
  seedMemory?(): Record<string, unknown>;
}

/** Shape the AI must answer with (validated before use). */
export interface AiAnswer {
  summary: string;
  proposal: TunnelAction | null;
  ruleSuggestion?: { condition: RuleCondition; outcome: RuleOutcome; description: string };
}
