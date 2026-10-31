import Anthropic from "@anthropic-ai/sdk";
import {
  AI_MAX_TOOL_ROUNDS, AI_TIMEOUT_MS, FINAL_TOOL, FINAL_TOOL_NAME, buildSystemPrompt, buildUserMessage,
  serializeToolResult, validateAiAnswer,
} from "./ai";
import type { AiAnswer, TunnelCase, TunnelContext, TunnelDefinition } from "./types";

// Server only: runs the "no → explain to the AI" loop. Read-only tools, at most three rounds,
// 30 s in total, and the answer is validated before it reaches the person.

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaToolUnion = Anthropic.Beta.Messages.BetaToolUnion;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** Minimal surface used here, so tests can pass a fake. */
export type MessagesCreate = (body: CreateParams, options: { signal: AbortSignal }) => Promise<BetaMessage>;

export interface ExplainRun {
  answer: AiAnswer | null;
  error: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  toolsCalled: { name: string; input: unknown; error?: string }[];
  discarded: string[];
}

export function anthropicCreate(apiKey: string): MessagesCreate {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: AI_TIMEOUT_MS });
  return (body, options) => client.beta.messages.create(body, options);
}

export async function runExplain(args: {
  definition: TunnelDefinition;
  item: TunnelCase;
  explanation: string;
  ctx: TunnelContext;
  model: string;
  create: MessagesCreate;
  timeoutMs?: number;
  maxToolRounds?: number;
}): Promise<ExplainRun> {
  const { definition, item, explanation, ctx, model, create } = args;
  const maxRounds = args.maxToolRounds ?? AI_MAX_TOOL_ROUNDS;
  const run: ExplainRun = { answer: null, error: null, model, inputTokens: 0, outputTokens: 0, toolsCalled: [], discarded: [] };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? AI_TIMEOUT_MS);
  const readTools: BetaToolUnion[] = definition.aiTools.map(t => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  const finalTool = FINAL_TOOL as unknown as BetaToolUnion;
  const messages: BetaMessageParam[] = [{ role: "user", content: buildUserMessage(item, explanation, definition.aiExtraActions) }];
  let rounds = 0;
  let nudged = false;
  try {
    for (;;) {
      const response = await create({
        model,
        max_tokens: 4000,
        system: buildSystemPrompt(definition),
        messages,
        tools: rounds < maxRounds ? [...readTools, finalTool] : [finalTool],
        tool_choice: { type: "auto" },
        output_config: { effort: "medium" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      }, { signal: controller.signal });
      run.model = response.model || model;
      run.inputTokens += response.usage?.input_tokens || 0;
      run.outputTokens += response.usage?.output_tokens || 0;
      if (response.stop_reason === "refusal") { run.error = "La IA no quiso responder este caso"; break; }

      const uses = response.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
      const final = uses.find(u => u.name === FINAL_TOOL_NAME);
      if (final) {
        const checked = validateAiAnswer(final.input, item, definition.aiExtraActions);
        if (checked.ok) { run.answer = checked.answer; run.discarded = checked.discarded; }
        else run.error = checked.error;
        break;
      }
      messages.push({ role: "assistant", content: response.content });
      if (!uses.length) {
        if (nudged || response.stop_reason === "max_tokens") { run.error = "La IA no entregó una conclusión"; break; }
        nudged = true;
        messages.push({ role: "user", content: "Entrega tu conclusión llamando a proponer_solucion." });
        continue;
      }
      if (rounds >= maxRounds) { run.error = "La IA pidió más consultas de las permitidas"; break; }
      rounds += 1;
      const results = await Promise.all(uses.map(async use => {
        const tool = definition.aiTools.find(t => t.name === use.name);
        const input = (use.input && typeof use.input === "object" ? use.input : {}) as Record<string, unknown>;
        if (!tool) {
          run.toolsCalled.push({ name: use.name, input, error: "herramienta desconocida" });
          return { type: "tool_result" as const, tool_use_id: use.id, content: "Herramienta desconocida", is_error: true };
        }
        try {
          const value = await tool.run(input, ctx);
          run.toolsCalled.push({ name: use.name, input });
          return { type: "tool_result" as const, tool_use_id: use.id, content: serializeToolResult(value) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          run.toolsCalled.push({ name: use.name, input, error: message });
          return { type: "tool_result" as const, tool_use_id: use.id, content: `Error: ${message}`, is_error: true };
        }
      }));
      messages.push({ role: "user", content: results });
    }
  } catch (error) {
    if (controller.signal.aborted) run.error = "La IA tardó más de 30 segundos";
    else if (error instanceof Anthropic.AuthenticationError) run.error = "La clave de la IA no es válida";
    else if (error instanceof Anthropic.RateLimitError) run.error = "La IA está saturada; intenta en un momento";
    else if (error instanceof Anthropic.APIError) run.error = `Error de la IA (${error.status ?? "sin estado"})`;
    else run.error = error instanceof Error ? error.message.slice(0, 300) : "Error desconocido";
  } finally {
    clearTimeout(timer);
  }
  return run;
}
