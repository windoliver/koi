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
  /** Read the current consecutive-filler block count for a given outer run. */
  readonly getBlockCount: (runId: string) => number;
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
      store.recordTurn(ctx.session.sessionId, ctx.session.runId, {
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
          store.recordTurn(ctx.session.sessionId, ctx.session.runId, {
            toolCallCount: mergedToolCallCount,
            outputText: mergedText,
          });
          recorded = true;
        }
        yield chunk;
      }
      // Fallback for adapters that close the stream without emitting `done`.
      if (!recorded) {
        store.recordTurn(ctx.session.sessionId, ctx.session.runId, {
          toolCallCount,
          outputText: text,
        });
      }
    },

    async onBeforeStop(ctx: TurnContext): Promise<StopGateResult> {
      if (!resolved.enabled) return { kind: "continue" };
      const turn = store.readTurn(ctx.session.runId);
      if (!turn) return { kind: "continue" };

      const result = classifyTurn(turn, resolved);

      if (result.kind !== "filler") {
        // Non-filler completion: clear this turn's cache + reset the run
        // counter so state does not leak into the next run. onAfterTurn does
        // not fire on a successful terminal `done` in the engine contract —
        // relying on it alone would leak one turn entry per successful run().
        store.clearTurn(ctx.session.runId);
        store.resetBlocks(ctx.session.runId);
        return { kind: "continue" };
      }

      // Counter is keyed by runId (stable within a single runtime.run() call,
      // new per call) so it accumulates across engine re-prompts within the
      // same outer request and is naturally fresh for the next request — a
      // stale count from an exhausted prior run cannot poison later work.
      const blocks = store.incrementBlocks(ctx.session.sessionId, ctx.session.runId);
      // Trip on `blocks > maxFillerRetries`: a value of N means "block N
      // times, release on attempt N+1." So maxFillerRetries=1 blocks once
      // before releasing, maxFillerRetries=2 (default) blocks twice, etc.
      // The default of 2 aligns with engine DEFAULT_MAX_STOP_RETRIES=3 so
      // the release path (and its telemetry signal) fire within the engine's
      // stop-gate budget.
      if (blocks > resolved.maxFillerRetries) {
        // Circuit breaker tripped — fail open so the agent can stop, but emit a
        // structured signal so operators can distinguish breaker release from a
        // legitimate non-filler completion. reportDecision is the standard
        // trace-recording path; absent in prod hot paths without tracing, so
        // use optional-call.
        ctx.reportDecision?.({
          event: "strict-agentic:circuit-broken",
          sessionId: ctx.session.sessionId as unknown as string,
          runId: ctx.session.runId as unknown as string,
          consecutiveBlocks: blocks,
          maxFillerRetries: resolved.maxFillerRetries,
        });
        // Clear terminal state so the released run does not retain its counter
        // or turn entry indefinitely in long-lived runtimes.
        store.clearTurn(ctx.session.runId);
        store.resetBlocks(ctx.session.runId);
        return { kind: "continue" };
      }

      return {
        kind: "block",
        reason: resolved.feedbackMessage ?? DEFAULT_FEEDBACK,
        blockedBy: MIDDLEWARE_NAME,
      };
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      // Do NOT clear turn state here — the engine fires onAfterTurn between
      // the model call and the stop-gate check, so clearing would race with
      // onBeforeStop reading the same state (bug seen in TUI manual testing).
      // Turn state is overwritten on the next wrapModelCall / wrapModelStream
      // and purged on session end; this is sufficient.
      //
      // A turn that ends WITHOUT a stop-gate veto is a success signal for
      // the run — reset the counter so filler blocks earlier in the run
      // do not leak into later unrelated filler turns.
      if (ctx.stopBlocked !== true) {
        store.resetBlocks(ctx.session.runId);
      }
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
    getBlockCount(runId: string): number {
      return store.getBlockCount(runId);
    },
  };
}
