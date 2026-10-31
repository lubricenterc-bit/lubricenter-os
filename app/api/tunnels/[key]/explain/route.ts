import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { AI_DEFAULT_MODEL, AI_FAILURE_MESSAGE } from "@/lib/tunnels/ai";
import { anthropicCreate, runExplain } from "@/lib/tunnels/ai-server";
import { todayCaracas } from "@/lib/tunnels/format";
import { getTunnel } from "@/lib/tunnels/registry";
import type { TunnelCase, TunnelContext, TunnelRule } from "@/lib/tunnels/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// "No → explain to the AI". The person's explanation is stored first (as a "NO" decision), then
// the AI investigates with the tunnel's read-only tools, with the person's own database session.
// The AI never applies anything: its answer goes back to the person as a yes/no slide.

type Body = { session_id?: string; case?: TunnelCase; snapshot?: unknown; explanation?: string; decision_id?: string | null };

const isCase = (v: unknown): v is TunnelCase => {
  const c = v as TunnelCase;
  return !!c && typeof c.id === "string" && typeof c.headline === "string" && typeof c.question === "string" && Array.isArray(c.context);
};

export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const definition = getTunnel(key);
  if (!definition) return NextResponse.json({ error: "Túnel no encontrado" }, { status: 404 });

  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!token || !url || !anon) return NextResponse.json({ error: "Inicia sesión de nuevo" }, { status: 401 });
  const supabase = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } });
  const user = await supabase.auth.getUser(token);
  if (user.error || !user.data.user) return NextResponse.json({ error: "Inicia sesión de nuevo" }, { status: 401 });

  const body = await request.json().catch(() => null) as Body | null;
  const explanation = String(body?.explanation || "").trim();
  if (!body || !isCase(body.case) || !body.session_id) return NextResponse.json({ error: "Solicitud incompleta" }, { status: 400 });
  if (explanation.length < 3 || explanation.length > 4000) return NextResponse.json({ error: "Explica en una o dos frases qué pasa" }, { status: 400 });
  const item = body.case;
  const memoryTunnel = definition.backend === "memory";

  let decisionId = body.decision_id || null;
  let rules: TunnelRule[] = [];
  if (!memoryTunnel) {
    const stored = await supabase.rpc("tunnel_explain", {
      p_session: body.session_id, p_case_id: item.id, p_case_snapshot: body.snapshot ?? {}, p_explanation: explanation, p_decision: decisionId,
    });
    if (stored.error) return NextResponse.json({ error: stored.error.message }, { status: 400 });
    decisionId = stored.data as string;
    const loaded = await supabase.from("tunnel_rules").select("*").eq("tunnel_key", key).eq("status", "ACTIVE");
    rules = (loaded.data || []) as TunnelRule[];
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model = process.env.TUNNEL_AI_MODEL || AI_DEFAULT_MODEL;
  const record = async (result: unknown, error: string | null, usage = { input: 0, output: 0 }, tools: unknown[] = [], usedModel = model) => {
    if (memoryTunnel || !decisionId) return;
    await supabase.rpc("tunnel_record_ai", {
      p_decision: decisionId, p_model: usedModel, p_prompt_tokens: usage.input, p_completion_tokens: usage.output,
      p_tools: tools, p_result: result, p_error: error,
    });
  };
  if (!apiKey) {
    await record(null, "Falta ANTHROPIC_API_KEY en el servidor");
    return NextResponse.json({ decisionId, ok: false, message: AI_FAILURE_MESSAGE });
  }

  const ctx: TunnelContext = {
    supabase: memoryTunnel ? null : supabase, today: todayCaracas(), rules,
    memory: memoryTunnel ? definition.seedMemory?.() : undefined,
  };
  const run = await runExplain({ definition, item, explanation, ctx, model, create: anthropicCreate(apiKey) });
  await record(run.answer, run.error, { input: run.inputTokens, output: run.outputTokens }, run.toolsCalled, run.model);
  if (!run.answer) return NextResponse.json({ decisionId, ok: false, message: AI_FAILURE_MESSAGE, detail: run.error });
  return NextResponse.json({ decisionId, ok: true, answer: run.answer, discarded: run.discarded });
}
