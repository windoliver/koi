/**
 * E2E driver — runs a realistic agent turn lifecycle through the debug
 * middleware without needing the real L1 engine or an LLM.
 *
 * Simulates: onBeforeTurn → wrapModelStream (emits chunks) → wrapToolCall
 * (executes tools) → onAfterTurn, across multiple turns. Matches the call
 * shape the turn-runner produces in production.
 */

import type {
  Agent,
  AgentManifest,
  JsonObject,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ProcessId,
  ProcessState,
  SubsystemToken,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { agentId, toolCallId as toolCallIdBrand } from "@koi/core";

/** Per-turn script: what the "model" emits and what tools do. */
export interface TurnScript {
  readonly textDeltas?: readonly string[];
  readonly thinkingDeltas?: readonly string[];
  readonly toolCalls?: readonly {
    readonly toolId: string;
    readonly input: JsonObject;
    readonly output: unknown;
    readonly throws?: Error;
  }[];
  readonly modelThrows?: Error;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number };
}

/** Build a minimal Agent with arbitrary components. */
export function buildAgent(
  id: string,
  components: Map<string, unknown> = new Map(),
): Agent & { state: ProcessState } {
  const aid = agentId(id);
  const pid: ProcessId = { id: aid, name: id, type: "worker", depth: 0 };
  const agent: Agent & { state: ProcessState } = {
    pid,
    manifest: {} as AgentManifest,
    state: "running" as ProcessState,
    component: <T>(token: SubsystemToken<T>) => components.get(token as string) as T | undefined,
    has: (token) => components.has(token as string),
    hasAll: (...tokens) => tokens.every((t) => components.has(t as string)),
    query: () => new Map(),
    components: () => components,
  };
  return agent;
}

/** Drive one turn through the middleware. Public so tests can interleave. */
export async function runTurn(
  middleware: KoiMiddleware,
  turnIndex: number,
  script: TurnScript,
): Promise<void> {
  const ctx = { turnIndex } as TurnContext;

  await middleware.onBeforeTurn?.(ctx);

  // Phase 1: model stream (announces tool calls + emits text/thinking deltas)
  if (middleware.wrapModelStream !== undefined) {
    const chunks: ModelChunk[] = [];
    for (const d of script.textDeltas ?? []) {
      chunks.push({ kind: "text_delta", delta: d });
    }
    for (const d of script.thinkingDeltas ?? []) {
      chunks.push({ kind: "thinking_delta", delta: d });
    }
    for (const tc of script.toolCalls ?? []) {
      const cid = toolCallIdBrand(`announce-${tc.toolId}-${turnIndex}`);
      chunks.push({ kind: "tool_call_start", toolName: tc.toolId, callId: cid });
      chunks.push({ kind: "tool_call_end", callId: cid });
    }
    if (script.usage !== undefined) {
      chunks.push({ kind: "usage", ...script.usage });
    }
    chunks.push({ kind: "done", response: { content: [] } as unknown as ModelResponse });

    const next = async function* (): AsyncIterable<ModelChunk> {
      if (script.modelThrows !== undefined) throw script.modelThrows;
      for (const c of chunks) yield c;
    };

    const iter = middleware.wrapModelStream(ctx, {} as ModelRequest, next);
    for await (const _ of iter) {
      /* consume */
    }
  }

  // Phase 2: execute tool calls sequentially (matches turn-runner)
  for (const tc of script.toolCalls ?? []) {
    const request: ToolRequest = {
      toolId: tc.toolId,
      input: tc.input,
      callId: toolCallIdBrand(`exec-${tc.toolId}-${turnIndex}`),
    };
    const next = async (_req: ToolRequest): Promise<ToolResponse> => {
      if (tc.throws !== undefined) throw tc.throws;
      return { toolId: tc.toolId, output: tc.output } as ToolResponse;
    };
    try {
      await middleware.wrapToolCall?.(ctx, request, next);
    } catch {
      // Tool errors are re-emitted via the debug middleware's custom events;
      // the driver lets the error propagate no further so subsequent tools in
      // the script can still run.
    }
  }

  await middleware.onAfterTurn?.(ctx);
}

/** Drive a sequence of turns. */
export async function runScript(
  middleware: KoiMiddleware,
  scripts: readonly TurnScript[],
): Promise<void> {
  for (let i = 0; i < scripts.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded iteration
    await runTurn(middleware, i, scripts[i]!);
  }
}

/** Microtask flush helper — equivalent to awaiting a setTimeout(0). */
export function flush(ms = 0): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
