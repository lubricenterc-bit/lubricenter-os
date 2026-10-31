import type { Facts, JsonValue, RuleClause, RuleCondition, TunnelAction, TunnelCase, TunnelRule } from "./types";

// Learned rules belong to the process, not to the tunnel: the manual view of a process can
// call `matchRule` with the same facts and get the same answer.

export const RULE_OPERATORS = ["eq", "neq", "in", "contains", "startsWith", "gte", "lte", "between"] as const;

export function normalizeFact(value: unknown): string {
  return String(value ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
}

export function clauseMatches(clause: RuleClause, facts: Facts): boolean {
  if (!(clause.fact in facts)) return false;
  const actual = facts[clause.fact];
  const text = normalizeFact(actual);
  const expected = clause.value;
  switch (clause.op) {
    case "eq": return text === normalizeFact(expected);
    case "neq": return text !== normalizeFact(expected);
    case "in": return Array.isArray(expected) && expected.some(v => normalizeFact(v) === text);
    case "contains": return normalizeFact(expected) !== "" && text.includes(normalizeFact(expected));
    case "startsWith": return normalizeFact(expected) !== "" && text.startsWith(normalizeFact(expected));
    case "gte": { const a = asNumber(actual), b = asNumber(expected); return a !== null && b !== null && a >= b; }
    case "lte": { const a = asNumber(actual), b = asNumber(expected); return a !== null && b !== null && a <= b; }
    case "between": {
      if (!Array.isArray(expected) || expected.length !== 2) return false;
      const a = asNumber(actual), lo = asNumber(expected[0]), hi = asNumber(expected[1]);
      return a !== null && lo !== null && hi !== null && a >= lo && a <= hi;
    }
    default: return false;
  }
}

export function conditionMatches(condition: RuleCondition, facts: Facts | undefined): boolean {
  if (!facts || !condition?.all?.length) return false;
  return condition.all.every(clause => clauseMatches(clause, facts));
}

/** Action types a case accepts as an answer. */
export function allowedActionTypes(item: TunnelCase): string[] {
  const types = new Set<string>();
  if (item.proposal) types.add(item.proposal.type);
  for (const option of item.options || []) types.add(option.type);
  if (item.input) types.add(item.input.action);
  return [...types];
}

/** First active rule that matches the case and proposes an action the case accepts. */
export function matchRule(item: TunnelCase, rules: TunnelRule[], matcher?: (rule: TunnelRule, item: TunnelCase) => boolean): TunnelRule | null {
  const allowed = allowedActionTypes(item);
  for (const rule of rules) {
    if (rule.status !== "ACTIVE") continue;
    if (!allowed.includes(rule.outcome?.action?.type)) continue;
    const hit = matcher ? matcher(rule, item) : conditionMatches(rule.condition, item.facts);
    if (hit) return rule;
  }
  return null;
}

/** Keys that identify the case's record: its subject, plus keys every same-type action shares. */
export function identityKeys(item: TunnelCase, type: string): Set<string> {
  const keys = new Set(Object.keys(item.subject || {}));
  if (item.input?.action === type) for (const k of Object.keys(item.input.basePayload || {})) keys.add(k);
  const same = [item.proposal, ...(item.options || [])].filter((a): a is TunnelAction => !!a && a.type === type);
  if (same.length >= 2) {
    for (const k of Object.keys(same[0].payload)) {
      if (same.every(a => JSON.stringify(a.payload[k]) === JSON.stringify(same[0].payload[k]))) keys.add(k);
    }
  }
  return keys;
}

/** What a learned rule stores from an answer: the decision, without the record's identifiers. */
export function ruleOutcomePayload(item: TunnelCase, action: TunnelAction): Record<string, JsonValue> {
  const identity = identityKeys(item, action.type);
  return Object.fromEntries(Object.entries(action.payload).filter(([k]) => !identity.has(k)));
}

function ruleAction(item: TunnelCase, rule: TunnelRule): TunnelAction {
  const type = rule.outcome.action.type;
  const base = [item.proposal, ...(item.options || [])].find(a => a?.type === type);
  const identity = identityKeys(item, type);
  const decided = Object.fromEntries(Object.entries(rule.outcome.action.payload || {}).filter(([k]) => !identity.has(k)));
  const own = Object.fromEntries(Object.entries(base?.payload || (item.input?.action === type ? item.input.basePayload : {}) || {}).filter(([k]) => identity.has(k)));
  const payload: Record<string, JsonValue> = { ...(base?.payload || {}), ...decided, ...own, ...(item.subject || {}) };
  const sameOption = (item.options || []).find(o => o.type === type && JSON.stringify(o.payload) === JSON.stringify(payload));
  return { type, payload, label: rule.outcome.action.label || sameOption?.label || "Sí, aplicar la regla" };
}

/**
 * A matching rule replaces the proposal and lifts the case to a yes/no question. Rules never
 * apply on their own: the person still confirms (or approves them in a batch).
 */
export function applyRules(cases: TunnelCase[], rules: TunnelRule[], matcher?: (rule: TunnelRule, item: TunnelCase) => boolean): TunnelCase[] {
  const active = rules.filter(r => r.status === "ACTIVE");
  if (!active.length) return cases;
  return cases.map(item => {
    const rule = matchRule(item, active, matcher);
    if (!rule) return item;
    const proposal = ruleAction(item, rule);
    return {
      ...item,
      level: item.level === "auto" ? "auto" : "confirm",
      proposal,
      confidence: Math.max(item.confidence, 0.9),
      ruleId: rule.id,
      ruleDescription: rule.description,
      question: `Una regla aprendida propone: ${proposal.label.replace(/^Sí,\s*/i, "")}. ¿La aplico?`,
      context: [`Regla aprendida: «${rule.description}»`, ...item.context].slice(0, 3),
    };
  });
}

/** Default rule built from a decision: match on every fact the case exposes as an identifier. */
export function defaultRuleCondition(item: TunnelCase, keys: string[]): RuleCondition | null {
  const all: RuleClause[] = [];
  for (const key of keys) {
    const value = item.facts?.[key];
    if (value === undefined || value === null || value === "") continue;
    all.push({ fact: key, op: "eq", value: value as JsonValue });
  }
  return all.length ? { all } : null;
}

export function describeCondition(condition: RuleCondition): string {
  const words: Record<string, string> = {
    eq: "es", neq: "no es", in: "es uno de", contains: "contiene", startsWith: "empieza con", gte: "es al menos", lte: "es como máximo", between: "está entre",
  };
  return (condition?.all || []).map(c => `${c.fact} ${words[c.op] || c.op} ${Array.isArray(c.value) ? c.value.join(" y ") : String(c.value)}`).join(", ");
}
