import type { SupabaseClient } from "@supabase/supabase-js";
import type { DecisionRecord, SlideSnapshot } from "./engine";
import type {
  AiAnswer, JsonValue, RuleCondition, RuleOutcome, TunnelAction, TunnelAnswer, TunnelBalance, TunnelCase, TunnelDefinition, TunnelRule,
} from "./types";

// Where sessions, decisions and rules live. Real tunnels use Supabase RPCs (applying an action and
// recording the decision is one transaction there). Memory tunnels (demo, tests) keep everything
// in this browser tab and run the definition's local handlers.

export interface SessionInfo { id: string; tunnel_key: string; started_at: string; status: string }
export interface DecisionRow {
  id: string; case_id: string; case_snapshot: SlideSnapshot; answer: TunnelAnswer; action: TunnelAction | null;
  rule_created_id: string | null; user_explanation: string | null; created_at: string;
}
export interface ExplainResult { decisionId: string; ok: boolean; message?: string; answer?: AiAnswer }
export interface DecideArgs {
  sessionId: string; caseId: string; snapshot: SlideSnapshot; answer: TunnelAnswer; action: TunnelAction | null;
  explanation?: string | null; fromDecision?: string | null;
}
export interface CreateRuleArgs { key: string; condition: RuleCondition; outcome: RuleOutcome; description: string; sourceDecision?: string | null }

export interface TunnelBackend {
  open(key: string, attendant: string | null, caseCount: number): Promise<{ session: SessionInfo; decisions: DecisionRow[] }>;
  decide(args: DecideArgs): Promise<DecisionRow>;
  undo(decisionId: string): Promise<void>;
  explain(args: { key: string; sessionId: string; item: TunnelCase; snapshot: SlideSnapshot; explanation: string; decisionId: string | null }): Promise<ExplainResult>;
  close(sessionId: string, status: "CLOSED" | "ABANDONED", balance: TunnelBalance | null, note?: string | null): Promise<void>;
  rules(key: string): Promise<TunnelRule[]>;
  createRule(args: CreateRuleArgs): Promise<TunnelRule>;
  updateRule(id: string, patch: { description?: string; condition?: RuleCondition; outcome?: RuleOutcome; status?: TunnelRule["status"] }): Promise<void>;
  deleteRule(id: string): Promise<void>;
}

export const ANSWER_WORDS: Record<TunnelAnswer, string> = { YES: "Aprobado", NO: "Explicado a la IA", OPTION: "Elegido", INPUT: "Dato escrito", SKIP: "Apartado" };

export function recordFromRow(row: DecisionRow): DecisionRecord {
  const snap = row.case_snapshot || ({ kind: "confirm", ruleIds: [] } as SlideSnapshot);
  const eyebrow = snap.kind === "batch" ? snap.description?.eyebrow || "Lote" : snap.item?.eyebrow || row.case_id;
  const headline = snap.kind === "batch" ? snap.description?.headline || "" : snap.item?.headline || "";
  return {
    slideId: row.case_id, decisionId: row.id, answer: row.answer, action: row.action, eyebrow, headline,
    label: row.answer === "SKIP" ? "Apartado" : row.action?.label || ANSWER_WORDS[row.answer], snapshot: snap,
    ruleCreatedId: row.rule_created_id,
  };
}

function rpcError(error: { message?: string } | null): never {
  throw new Error(error?.message?.replace(/^.*?ERROR:\s*/, "") || "No se pudo completar la acción");
}

export async function postExplain(token: string | null, key: string, body: Record<string, unknown>): Promise<ExplainResult> {
  const response = await fetch(`/api/tunnels/${encodeURIComponent(key)}/explain`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null) as (ExplainResult & { error?: string }) | null;
  if (!response.ok || !data) throw new Error(data?.error || "No pude hablar con la IA");
  return data;
}

export function supabaseBackend(supabase: SupabaseClient): TunnelBackend {
  return {
    async open(key, attendant, caseCount) {
      const { data, error } = await supabase.rpc("tunnel_open_session", { p_key: key, p_attendant: attendant, p_case_count: caseCount });
      if (error) rpcError(error);
      return data as { session: SessionInfo; decisions: DecisionRow[] };
    },
    async decide(a) {
      const { data, error } = await supabase.rpc("tunnel_decide", {
        p_session: a.sessionId, p_case_id: a.caseId, p_case_snapshot: a.snapshot, p_answer: a.answer,
        p_action: a.action, p_explanation: a.explanation ?? null, p_from_decision: a.fromDecision ?? null,
      });
      if (error) rpcError(error);
      return data as DecisionRow;
    },
    async undo(id) {
      const { error } = await supabase.rpc("tunnel_undo", { p_decision: id });
      if (error) rpcError(error);
    },
    async explain(a) {
      const { data } = await supabase.auth.getSession();
      return postExplain(data.session?.access_token || null, a.key, {
        session_id: a.sessionId, case: a.item, snapshot: a.snapshot, explanation: a.explanation, decision_id: a.decisionId,
      });
    },
    async close(id, status, balance, note) {
      const { error } = await supabase.rpc("tunnel_close_session", { p_session: id, p_status: status, p_balance: balance, p_note: note ?? null });
      if (error) rpcError(error);
    },
    async rules(key) {
      const { data, error } = await supabase.from("tunnel_rules").select("*").eq("tunnel_key", key).order("created_at", { ascending: false });
      if (error) rpcError(error);
      return (data || []) as TunnelRule[];
    },
    async createRule(a) {
      const { data, error } = await supabase.rpc("tunnel_create_rule", {
        p_key: a.key, p_condition: a.condition, p_outcome: a.outcome, p_description: a.description, p_source_decision: a.sourceDecision ?? null,
      });
      if (error) rpcError(error);
      return data as TunnelRule;
    },
    async updateRule(id, patch) {
      const { error } = await supabase.rpc("tunnel_update_rule", {
        p_id: id, p_description: patch.description ?? null, p_condition: patch.condition ?? null, p_outcome: patch.outcome ?? null, p_status: patch.status ?? null,
      });
      if (error) rpcError(error);
    },
    async deleteRule(id) {
      const { error } = await supabase.rpc("tunnel_delete_rule", { p_id: id });
      if (error) rpcError(error);
    },
  };
}

type MemorySession = SessionInfo & { decisions: (DecisionRow & { revert: Record<string, JsonValue> | null; undone: boolean })[] };
type MemoryDb = { memory: Record<string, unknown>; sessions: MemorySession[]; rules: TunnelRule[] };
const memoryDbs = new Map<string, MemoryDb>();

const uid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/** In-memory store of a memory tunnel; survives navigation inside the tab. */
export function memoryDb(definition: TunnelDefinition, reset = false): MemoryDb {
  if (reset || !memoryDbs.has(definition.key)) memoryDbs.set(definition.key, { memory: definition.seedMemory?.() || {}, sessions: [], rules: [] });
  return memoryDbs.get(definition.key)!;
}

export function memoryBackend(definition: TunnelDefinition, opts: { explain?: TunnelBackend["explain"]; reset?: boolean } = {}): TunnelBackend & { db: MemoryDb } {
  const db = memoryDb(definition, opts.reset);
  const handlers = definition.localHandlers || {};
  const session = (id: string) => {
    const s = db.sessions.find(x => x.id === id);
    if (!s) throw new Error("Sesión de túnel no encontrada");
    if (s.status !== "OPEN") throw new Error("Esta sesión ya está cerrada");
    return s;
  };
  const apply = (action: TunnelAction): Record<string, JsonValue> => {
    if (action.type === "tunnel.batch") {
      const items = (action.payload.items as unknown as { case_id: string; action: TunnelAction }[]) || [];
      const done: JsonValue[] = [];
      try {
        for (const item of items) done.push({ action: item.action as unknown as JsonValue, revert: apply(item.action) });
      } catch (error) {
        for (const d of [...done].reverse() as unknown as { action: TunnelAction; revert: Record<string, JsonValue> }[]) revert(d.action, d.revert);
        throw error;
      }
      return { items: done };
    }
    const handler = handlers[action.type];
    if (!handler) throw new Error(`Acción no permitida en este túnel: ${action.type}`);
    return handler.apply(action.payload, db.memory);
  };
  const revert = (action: TunnelAction, data: Record<string, JsonValue> | null) => {
    if (action.type === "tunnel.batch") {
      for (const d of [...((data?.items as unknown as { action: TunnelAction; revert: Record<string, JsonValue> }[]) || [])].reverse()) revert(d.action, d.revert);
      return;
    }
    const handler = handlers[action.type];
    if (!handler) throw new Error(`No sé cómo deshacer la acción ${action.type}`);
    handler.revert(data || {}, db.memory);
  };
  const live = (s: MemorySession) => s.decisions.filter(d => !d.undone);
  const strip = (d: MemorySession["decisions"][number]): DecisionRow => {
    const { revert: _r, undone: _u, ...row } = d;
    return row;
  };
  return {
    db,
    async open(key) {
      let s = db.sessions.find(x => x.status === "OPEN");
      if (!s) { s = { id: uid(), tunnel_key: key, started_at: new Date().toISOString(), status: "OPEN", decisions: [] }; db.sessions.push(s); }
      return { session: { id: s.id, tunnel_key: s.tunnel_key, started_at: s.started_at, status: s.status }, decisions: live(s).map(strip) };
    },
    async decide(a) {
      const s = session(a.sessionId);
      let existing = a.fromDecision ? s.decisions.find(d => d.id === a.fromDecision && !d.undone && d.answer === "NO") : undefined;
      if (a.fromDecision && !existing) throw new Error("La explicación previa ya no está disponible");
      if (!existing && live(s).some(d => d.case_id === a.caseId)) throw new Error("Este caso ya tiene una respuesta. Deshazla para cambiarla");
      const revertData = a.action ? apply(a.action) : null;
      if (!existing) {
        existing = { id: uid(), case_id: a.caseId, case_snapshot: a.snapshot, answer: a.answer, action: a.action, rule_created_id: null, user_explanation: a.explanation ?? null, created_at: new Date().toISOString(), revert: revertData, undone: false };
        s.decisions.push(existing);
      } else Object.assign(existing, { answer: a.answer, action: a.action, revert: revertData });
      for (const ruleId of a.snapshot.ruleIds || []) {
        const rule = db.rules.find(r => r.id === ruleId);
        if (rule && a.action) { rule.times_used += 1; rule.last_used_at = new Date().toISOString(); }
      }
      return strip(existing);
    },
    async undo(id) {
      const s = db.sessions.find(x => x.decisions.some(d => d.id === id));
      const d = s?.decisions.find(x => x.id === id);
      if (!s || !d) throw new Error("Decisión no encontrada");
      session(s.id);
      if (d.undone) throw new Error("Esta decisión ya se deshizo");
      if (d.action) revert(d.action, d.revert);
      d.undone = true;
    },
    async explain(a) {
      const s = session(a.sessionId);
      let decision = a.decisionId ? s.decisions.find(d => d.id === a.decisionId && !d.undone) : undefined;
      if (!decision) {
        if (live(s).some(d => d.case_id === a.item.id)) throw new Error("Este caso ya tiene una respuesta. Deshazla para cambiarla");
        decision = { id: uid(), case_id: a.item.id, case_snapshot: a.snapshot, answer: "NO", action: null, rule_created_id: null, user_explanation: a.explanation, created_at: new Date().toISOString(), revert: null, undone: false };
        s.decisions.push(decision);
      } else decision.user_explanation = [decision.user_explanation, a.explanation].filter(Boolean).join("\n---\n");
      if (!opts.explain) return { decisionId: decision.id, ok: false };
      const result = await opts.explain({ ...a, decisionId: decision.id });
      return { ...result, decisionId: decision.id };
    },
    async close(id, status) {
      const s = session(id);
      s.status = status;
    },
    async rules() { return db.rules; },
    async createRule(a) {
      const rule: TunnelRule = {
        id: uid(), tunnel_key: a.key, condition: a.condition, outcome: a.outcome, description: a.description, status: "ACTIVE",
        times_used: 0, last_used_at: null, created_at: new Date().toISOString(), source_decision_id: a.sourceDecision ?? null,
      };
      db.rules.unshift(rule);
      for (const s of db.sessions) for (const d of s.decisions) if (d.id === a.sourceDecision) d.rule_created_id = rule.id;
      return rule;
    },
    async updateRule(id, patch) {
      const rule = db.rules.find(r => r.id === id);
      if (!rule) throw new Error("Regla no encontrada");
      Object.assign(rule, Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
    },
    async deleteRule(id) { db.rules = db.rules.filter(r => r.id !== id); },
  };
}
