import { bs } from "./format";
import type { JsonValue, TunnelCase, TunnelContext, TunnelDefinition } from "./types";

// Demo tunnel: synthetic bank lines, kept in memory. It exercises every slide type, undo and
// learned rules without touching real data. Registered only outside production builds.

type DemoLine = {
  id: string; date: string; reference: string; amount: number; description: string;
  invoice: string | null; cedula: string | null; kind: "ABONO" | "RETIRO";
  matched: string | null; branch: string | null; osAmount?: number;
};
type DemoMemory = { lines: DemoLine[] };

const BRANCHES: Record<string, string> = {
  CABUDARE: "Cabudare", NORTE: "Norte", LA_MORAN: "La Morán", AFUERA: "Afuera (sin nomenclatura)",
  AFUERA_SIN_ASIGNAR: "Afuera (sin asignar)", POR_CONFIRMAR: "Por confirmar",
};

function seed(): DemoMemory {
  const auto = (i: number, amount: number, invoice: string, branch: string): DemoLine => ({
    id: `l${i}`, date: "2026-10-2" + (i % 6 + 2), reference: String(11980000 + i * 7), amount,
    description: "Abono Pago Movil BNC", invoice, cedula: null, kind: "ABONO", matched: branch, branch: null,
  });
  return {
    lines: [
      auto(1, 12450.2, "OS-000301", "CABUDARE"), auto(2, 8300, "NT-0031", "NORTE"), auto(3, 15220.75, "OS-000305", "CABUDARE"),
      auto(4, 4410, "LM118", "LA_MORAN"), auto(5, 22918.4, "05512", "AFUERA"), auto(6, 9870.1, "OS-000309", "CABUDARE"),
      { id: "l7", date: "2026-10-25", reference: "0011987", amount: 38639.5, description: "Abono Pago Movil BNC", invoice: null, cedula: null, kind: "ABONO", matched: null, branch: null },
      { id: "l8", date: "2026-10-25", reference: "0045121", amount: 18200, description: "Abono Pago Movil BNC", invoice: "NT-0045", cedula: null, kind: "ABONO", matched: null, branch: null },
      { id: "l9", date: "2026-10-26", reference: "34990", amount: 150000, description: "Crédito Inmediato Emitido CED.:V012306298", invoice: null, cedula: "V12306298", kind: "RETIRO", matched: null, branch: null },
      { id: "l10", date: "2026-10-25", reference: "0077310", amount: 3549.21, description: "Adelanto", invoice: null, cedula: "V10779824", kind: "ABONO", matched: null, branch: null },
      { id: "l11", date: "2026-10-26", reference: "0039740", amount: 39740.1, description: "Abono Pago Movil BNC", invoice: "OS-000326", cedula: null, kind: "ABONO", matched: null, branch: null, osAmount: 34782.24 },
      { id: "l12", date: "2026-10-27", reference: "0051002", amount: 9400, description: "Abono Pago Movil BNC", invoice: "NT-0051", cedula: null, kind: "ABONO", matched: null, branch: null },
    ],
  };
}

const mem = (ctx: TunnelContext | Record<string, unknown>) => ((("memory" in ctx ? (ctx as TunnelContext).memory : ctx) || { lines: [] }) as unknown as DemoMemory);
const assign = (line: DemoLine, branch: string, label?: string) => ({ type: "demo.assign_branch", payload: { line_id: line.id, branch }, label: label || `Sí, es de ${BRANCHES[branch]}` });
const facts = (l: DemoLine) => ({ invoice: l.invoice, reference: l.reference, amount: l.amount, cedula: l.cedula, description: l.description, kind: l.kind });
const branchOptions = (l: DemoLine, codes: string[]) => codes.map(code => assign(l, code, BRANCHES[code]));

function caseFor(l: DemoLine): TunnelCase {
  const eyebrow = `${l.kind === "RETIRO" ? "Retiro" : "Abono"} BNC · ${l.date.slice(8, 10)}/${l.date.slice(5, 7)} · ref ${l.reference}`;
  const base = { id: `demo:${l.id}`, eyebrow, headline: bs(l.amount), facts: facts(l), subject: { line_id: l.id }, detail: { ...l } as unknown as Record<string, JsonValue> };
  if (l.matched) {
    return { ...base, level: "auto", batchGroup: "ref", confidence: 0.99, question: "La referencia coincide con un pago de Cashea.",
      context: [`Factura ${l.invoice}`], proposal: assign(l, l.matched) };
  }
  if (l.id === "l7") {
    return { ...base, level: "confirm", confidence: 0.8, question: "Creo que es el inicial de OS-000312, que no está registrado. ¿Lo asigno a Cabudare?",
      context: ["Pago en caja 43,60 USD × tasa 886,23 = 38.639,50 Bs", "Compra Cashea del 24/10"], proposal: assign(l, "CABUDARE"),
      options: branchOptions(l, ["NORTE", "LA_MORAN", "POR_CONFIRMAR"]) };
  }
  if (l.kind === "RETIRO") {
    return { ...base, level: "choice", confidence: 0.4, question: "¿De qué sucursal es este retiro?",
      context: ["Destino: cédula V-12306298, cuenta 0108…071576", "La comisión de 600 Bs sigue al retiro"],
      options: branchOptions(l, ["AFUERA_SIN_ASIGNAR", "NORTE", "LA_MORAN"]) };
  }
  if (l.id === "l11") {
    return { ...base, level: "input", confidence: 0.3, question: "El OS registra 34.782,24 Bs y el banco recibió 39.740,10 Bs. ¿Cuánto debió cobrar el OS?",
      context: ["Factura OS-000326", "Diferencia: 4.957,86 Bs"],
      input: { label: "Monto correcto en Bs", type: "money", action: "demo.fix_amount", basePayload: { line_id: l.id }, placeholder: "39.740,10" } };
  }
  if (l.invoice?.startsWith("NT")) {
    return { ...base, level: "confirm", confidence: 0.55, question: `La factura ${l.invoice} no tiene nomenclatura conocida. ¿La dejo en Afuera?`,
      context: [`Factura ${l.invoice}`, "Sin enlace en el OS"], proposal: assign(l, "AFUERA", "Sí, dejar en Afuera"),
      options: branchOptions(l, ["NORTE", "LA_MORAN", "AFUERA"]) };
  }
  return { ...base, level: "choice", confidence: 0.2, question: "Abono sin pista. ¿De qué sucursal es?",
    context: [`Descripción: «${l.description}»`, l.cedula ? `Cédula ${l.cedula}` : "Sin cédula"],
    options: branchOptions(l, ["CABUDARE", "NORTE", "LA_MORAN", "POR_CONFIRMAR"]) };
}

export const demoTunnel: TunnelDefinition = {
  key: "demo",
  title: "Túnel de prueba",
  description: "Datos inventados para probar el motor. Solo existe en desarrollo.",
  permission: "tunnels.use",
  coverTitle: "Vamos a probar el túnel",
  backend: "memory",
  seedMemory: () => seed() as unknown as Record<string, unknown>,
  async coverLines(ctx) {
    const lines = mem(ctx).lines;
    return [`Revisé ${lines.filter(l => l.kind === "ABONO").length} abonos y ${lines.filter(l => l.kind === "RETIRO").length} retiro inventados.`, "Nada de esto toca datos reales."];
  },
  async buildCases(ctx) {
    return mem(ctx).lines.filter(l => !l.branch).map(caseFor);
  },
  describeBatch(_group, items) {
    const total = items.reduce((s, i) => s + Number(i.facts?.amount || 0), 0);
    const by = new Map<string, number>();
    for (const i of items) { const b = String(i.proposal?.payload.branch || ""); by.set(b, (by.get(b) || 0) + Number(i.facts?.amount || 0)); }
    return {
      eyebrow: `Lote automático · referencia exacta`, headline: bs(total), question: `Casé ${items.length} abonos por referencia. ¿Los apruebo?`,
      context: [...by].map(([b, v]) => `${BRANCHES[b] || b}: ${bs(v)}`).slice(0, 3), label: `Sí, aprobar los ${items.length}`,
    };
  },
  async balance(ctx) {
    const lines = mem(ctx).lines;
    const sums = new Map<string, number>();
    for (const l of lines) if (l.branch) sums.set(l.branch, (sums.get(l.branch) || 0) + (l.kind === "RETIRO" ? -l.amount : l.amount));
    const bank = lines.reduce((s, l) => s + (l.kind === "RETIRO" ? -l.amount : l.amount), 0);
    const assigned = [...sums.values()].reduce((s, v) => s + v, 0);
    const pending = lines.filter(l => !l.branch).length;
    const diff = Math.round((bank - assigned) * 100) / 100;
    return {
      ok: diff === 0, title: "Así queda repartido el banco de prueba", total: bs(assigned),
      rows: Object.keys(BRANCHES).filter(b => sums.has(b)).map(b => ({ label: BRANCHES[b], value: bs(sums.get(b) || 0) })),
      control: `Saldo del banco de prueba: ${bs(bank)}`,
      diff: diff === 0 ? undefined : `Diferencia de ${bs(Math.abs(diff))}: faltan por repartir (${pending} ${pending === 1 ? "movimiento" : "movimientos"})`,
    };
  },
  aiInstructions: "Es un túnel de prueba con movimientos inventados de un banco que reciben varias sucursales (Cabudare, Norte, La Morán y otras). Las facturas OS- son de Cabudare, NT de Norte y LM de La Morán.",
  aiTools: [{
    name: "buscar_movimientos",
    description: "Busca movimientos del banco de prueba por texto (referencia, factura, cédula o descripción) o por monto aproximado.",
    input_schema: { type: "object", properties: { texto: { type: "string" }, monto: { type: "number" } } },
    async run(input, ctx) {
      const text = String(input.texto || "").toLowerCase();
      const amount = Number(input.monto || 0);
      return mem(ctx).lines.filter(l => (text && JSON.stringify(l).toLowerCase().includes(text)) || (amount && Math.abs(l.amount - amount) <= Math.max(1, amount * 0.01))).slice(0, 20);
    },
  }],
  ruleFromDecision(item) {
    const invoice = String(item.facts?.invoice || "");
    const prefix = invoice.match(/^[A-Za-z]{2,3}/)?.[0];
    if (prefix) return { all: [{ fact: "invoice", op: "startsWith", value: prefix.toUpperCase() }] };
    if (item.facts?.cedula) return { all: [{ fact: "cedula", op: "eq", value: String(item.facts.cedula) }] };
    return null;
  },
  localHandlers: {
    "demo.assign_branch": {
      apply(payload, memory) {
        const line = mem(memory).lines.find(l => l.id === payload.line_id);
        if (!line) throw new Error("Movimiento no encontrado");
        if (!BRANCHES[String(payload.branch)]) throw new Error("Sucursal inválida");
        const previous = line.branch;
        line.branch = String(payload.branch);
        return { line_id: line.id, previous };
      },
      revert(revert, memory) {
        const line = mem(memory).lines.find(l => l.id === revert.line_id);
        if (!line) throw new Error("Movimiento no encontrado");
        line.branch = (revert.previous as string | null) ?? null;
      },
    },
    "demo.fix_amount": {
      apply(payload, memory) {
        const line = mem(memory).lines.find(l => l.id === payload.line_id);
        if (!line) throw new Error("Movimiento no encontrado");
        const previous = line.osAmount ?? null;
        line.osAmount = Number(payload.value);
        line.branch = "CABUDARE";
        return { line_id: line.id, previous };
      },
      revert(revert, memory) {
        const line = mem(memory).lines.find(l => l.id === revert.line_id);
        if (!line) throw new Error("Movimiento no encontrado");
        line.osAmount = (revert.previous as number | null) ?? undefined;
        line.branch = null;
      },
    },
  },
};
