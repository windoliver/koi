/**
 * Factory for @koi/middleware-strict-agentic.
 *
 * Wires together the config, classifier, state store, and feedback modules
 * into a KoiMiddleware with five active hooks:
 *   wrapModelCall, wrapModelStream, onBeforeStop, onAfterTurn, onSessionEnd.
 *
 * Both wrapModelCall and wrapModelStream populate the same per-turn state so
 * the stop gate works on streaming adapters (the runtime's preferred path
 * when the adapter exposes `modelStream`) as well as non-streaming calls.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelContentBlock,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  StopGateResult,
  TurnContext,
} from "@koi/core";
import { classifyTurn } from "./classifier.js";
import type { StrictAgenticConfig } from "./config.js";
import { resolveStrictAgenticConfig, validateStrictAgenticConfig } from "./config.js";
import { DEFAULT_FEEDBACK } from "./feedback.js";
import { createStateStore } from "./state.js";

const MIDDLEWARE_NAME = "strict-agentic";
/** Priority 410: runs outside semantic-retry (420). Phase "intercept" matches the stop-gate role. */
const MIDDLEWARE_PRIORITY = 410;

export interface StrictAgenticHandle {
  readonly middleware: KoiMiddleware;
  readonly getBlockCount: (sessionId: string) => number;
}

function countToolCalls(rich: readonly ModelContentBlock[] | undefined): number {
  if (!rich) return 0;
  let n = 0;
  for (const block of rich) {
    if (block.kind === "tool_call") n += 1;
  }
  return n;
}

export function createStrictAgenticMiddleware(
  config: Partial<StrictAgenticConfig> = {},
): StrictAgenticHandle {
  // Fail fast on malformed config. Guardrail middleware must not accept
  // callable-typed fields that would TypeError later when classifyTurn invokes them.
  const validation = validateStrictAgenticConfig(config);
  if (!validation.ok) {
    throw new Error(`Invalid @koi/middleware-strict-agentic config: ${validation.error.message}`, {
      cause: validation.error,
    });
  }
  const resolved = resolveStrictAgenticConfig(validation.value);
  const store = createStateStore();

  const middleware: KoiMiddleware = {
    name: MIDDLEWARE_NAME,
    priority: MIDDLEWARE_PRIORITY,
    phase: "intercept",

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const resp = await next(request);
      if (!resolved.enabled) return resp;
      store.recordTurn(ctx.session.sessionId, ctx.turnId, {
        toolCallCount: countToolCalls(resp.richContent),
        outputText: resp.content,
      });
      return resp;
    },

    // Streaming path — runtime prefers this when the adapter implements `stream`.
    // Passes every chunk through unmodified and accumulates facts for classification.
    //
    // Flush-eagerly pattern (see packages/lib/middleware-goal/src/goal.ts:783):
    // consumeModelStream calls iterator.return() after processing the terminal
    // `done` chunk, which aborts upstream generators before their for-await
    // loop exits naturally. We therefore record turn state when we observe
    // `done` — BEFORE yielding it — and also have a post-loop fallback for
    // adapters that omit `done`. Tool-call count merges streamed chunks with
    // any richContent the terminal response carries.
    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      if (!resolved.enabled) {
        yield* next(request);
        return;
      }
      let toolCallCount = 0;
      let text = "";
      let recorded = false;
      for await (const chunk of next(request)) {
        if (chunk.kind === "text_delta") {
          text += chunk.delta;
        } else if (chunk.kind === "tool_call_start") {
          toolCallCount += 1;
        } else if (chunk.kind === "done") {
          const mergedToolCallCount = Math.max(
            toolCallCount,
            countToolCalls(chunk.response.richContent),
          );
          const mergedText = text.length > 0 ? text : chunk.response.content;
          store.recordTurn(ctx.session.sessionId, ctx.turnId, {
            toolCallCount: mergedToolCallCount,
            outputText: mergedText,
          });
          recorded = true;
        }
        yield chunk;
      }
      // Fallback for adapters that close the stream without emitting `done`.
      if (!recorded) {
        store.recordTurn(ctx.session.sessionId, ctx.turnId, {
          toolCallCount,
          outputText: text,
        });
      }
    },

    async onBeforeStop(ctx: TurnContext): Promise<StopGateResult> {
      if (!resolved.enabled) return { kind: "continue" };
      const turn = store.readTurn(ctx.turnId);
      if (!turn) return { kind: "continue" };

      const result = classifyTurn(turn, resolved);

      if (result.kind !== "filler") {
        store.resetBlocks(ctx.session.sessionId);
        return { kind: "continue" };
      }

      const blocks = store.incrementBlocks(ctx.session.sessionId);
      if (blocks > resolved.maxFillerRetries) {
        // Circuit breaker tripped — fail open so the agent can stop, but emit a
        // structured signal so operators can distinguish breaker release from a
        // legitimate non-filler completion. reportDecision is the standard
        // trace-recording path; absent in prod hot paths without tracing, so
        // use optional-call.
        ctx.reportDecision?.({
          event: "strict-agentic:circuit-broken",
          sessionId: ctx.session.sessionId as unknown as string,
          consecutiveBlocks: blocks,
          maxFillerRetries: resolved.maxFillerRetries,
        });
        return { kind: "continue" };
      }

      return {
        kind: "block",
        reason: resolved.feedbackMessage ?? DEFAULT_FEEDBACK,
        blockedBy: MIDDLEWARE_NAME,
      };
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      store.clearTurn(ctx.turnId);
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      store.clearSession(ctx.sessionId);
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return {
        label: MIDDLEWARE_NAME,
        description:
          "Blocks completion on filler/plan-only turns — must call a tool, ask a question, or declare done.",
      };
    },
  };

  return {
    middleware,
    getBlockCount(sessionId: string): number {
      return store.getBlockCount(sessionId);
    },
  };
}
