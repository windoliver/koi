/**
 * Event-trace middleware — records every model/tool call to a trajectory document.
 *
 * Phase: observe (pure observation, errors silently swallowed)
 * Priority: 100 (first among observers)
 * Flush: turn-based (onAfterTurn + onSessionEnd)
 *
 * Safety invariants:
 *   - Observer never throws into the request path (all trace capture in try-catch)
 *   - Step IDs assigned atomically by store during append() under per-doc lock
 *   - Transient flush failures retain pending steps for one retry on next flush
 *
 * Content capture (aligned with OTel GenAI, LangSmith, ATIF best practices):
 *   - Model requests: last user message + system prompt + model params + tool definitions
 *   - Model responses: full content + usage metrics + response metadata (finish reason)
 *   - Model reasoning: thinking/CoT content accumulated from stream chunks
 *   - Tool calls: name, arguments, result (truncated), duration
 *   - Errors: error message + type + cause chain
 *
 * NOT captured here (belongs in L3 harness compose layer):
 *   - Per-middleware spans (name, duration, nextCalled) — see DebugSpanResponse in v1
 *   - Middleware request modification deltas
 *   - Retry attempts from retry middleware
 */

import type { JsonObject } from "@koi/core/common";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import type {
  RichContent,
  RichStepMetrics,
  RichTrajectoryStep,
  TrajectoryDocumentStore,
} from "@koi/core/rich-trajectory";
import { pickDefined, truncateContent } from "./utils.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const DEFAULT_MAX_OUTPUT_BYTES = 8192;

export interface EventTraceConfig {
  /** Backing store for trajectory documents. */
  readonly store: TrajectoryDocumentStore;
  /** Document ID (typically session or conversation ID). */
  readonly docId: string;
  /** Agent name for ATIF metadata. */
  readonly agentName: string;
  /** Agent version for ATIF metadata. */
  readonly agentVersion?: string;
  /** Injectable clock for deterministic testing. Default: Date.now. */
  readonly clock?: () => number;
  /** Max bytes for tool output capture. Default: 8192. */
  readonly maxOutputBytes?: number;
  /** Called when trace data is dropped due to persistent store failures. */
  readonly onTraceLoss?: (stepCount: number, error: unknown) => void;
}

// ---------------------------------------------------------------------------
// Handle — returned by the factory
// ---------------------------------------------------------------------------

export interface EventTraceHandle {
  /** The KoiMiddleware instance to wire into the middleware chain. */
  readonly middleware: KoiMiddleware;
  /** Get the backing trajectory document store. */
  readonly getTrajectoryStore: () => TrajectoryDocumentStore;
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

interface SessionState {
  /** Steps accumulated within the current turn, flushed on onAfterTurn. */
  readonly pendingSteps: RichTrajectoryStep[];
  /** Relative step counter within this session's pending batch. */
  nextLocalIndex: number;
  /** Timestamp when the current turn started. */
  turnStartTime: number;
  /** True if the previous flush failed — pending steps are a retry batch. */
  lastFlushFailed: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create an event-trace middleware that records every model/tool call. */
export function createEventTraceMiddleware(config: EventTraceConfig): EventTraceHandle {
  const { store, docId } = config;
  const clock = config.clock ?? Date.now;
  const maxOutputBytes = config.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const onTraceLoss = config.onTraceLoss;

  const sessions = new Map<string, SessionState>();

  function getState(sessionId: string): SessionState | undefined {
    return sessions.get(sessionId);
  }

  /** Extract the last user message, skipping assistant and system messages. */
  function extractLastUserMessage(request: ModelRequest): RichContent {
    const messages = request.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg === undefined) continue;
      if (msg.senderId === "assistant" || msg.senderId === "system") continue;

      const textBlock = msg.content.find((block) => block.kind === "text");
      if (textBlock !== undefined && textBlock.kind === "text") {
        return {
          text: textBlock.text,
          data: { totalMessages: messages.length },
        };
      }
    }
    return { text: "", data: { totalMessages: messages.length } };
  }

  function extractSystemPrompt(request: ModelRequest): string | undefined {
    for (const msg of request.messages) {
      if (msg.senderId !== "system") continue;
      const textBlock = msg.content.find((block) => block.kind === "text");
      if (textBlock !== undefined && textBlock.kind === "text") {
        return textBlock.text;
      }
    }
    return undefined;
  }

  function extractModelRequestMetadata(request: ModelRequest): JsonObject {
    const meta: Record<string, unknown> = {
      totalMessages: request.messages.length,
    };
    if (request.model !== undefined) meta["requestModel"] = request.model;
    if (request.temperature !== undefined) meta["temperature"] = request.temperature;
    if (request.maxTokens !== undefined) meta["maxTokens"] = request.maxTokens;
    const systemPrompt = extractSystemPrompt(request);
    if (systemPrompt !== undefined) meta["systemPrompt"] = systemPrompt;
    if (request.tools !== undefined && request.tools.length > 0) {
      meta["toolCount"] = request.tools.length;
      meta["tools"] = request.tools.map((t) => ({ name: t.name, description: t.description }));
    }
    return meta as JsonObject;
  }

  function extractResponseMetadata(response: ModelResponse): Record<string, unknown> {
    const meta: Record<string, unknown> = { responseModel: response.model };
    if (response.metadata !== undefined) {
      for (const [key, value] of Object.entries(response.metadata)) {
        meta[key] = value;
      }
    }
    return meta;
  }

  /**
   * Safely serialize tool output. Handles circular references, BigInt, and other
   * non-JSON-safe values. Observer code must never throw into the request path.
   */
  function captureToolOutput(output: unknown): RichContent {
    try {
      const text = typeof output === "string" ? output : JSON.stringify(output);
      return truncateContent(text, maxOutputBytes);
    } catch {
      // Circular objects, BigInt, or other unserializable values
      return truncateContent(`[unserializable: ${typeof output}]`, maxOutputBytes);
    }
  }

  function extractUsageMetrics(response: ModelResponse): RichStepMetrics | undefined {
    if (response.usage === undefined) return undefined;
    return {
      promptTokens: response.usage.inputTokens,
      completionTokens: response.usage.outputTokens,
    };
  }

  function captureError(error: unknown): RichContent {
    if (error instanceof Error) {
      return {
        text: error.message,
        data: {
          errorType: error.constructor.name,
          ...(error.cause !== undefined ? { cause: String(error.cause) } : {}),
        },
      };
    }
    return { text: String(error) };
  }

  function buildModelStep(
    state: SessionState,
    startTime: number,
    request: ModelRequest,
    response: ModelResponse | undefined,
    caughtError: unknown,
    reasoningContent: string | undefined,
  ): RichTrajectoryStep {
    const durationMs = clock() - startTime;
    const stepIndex = state.nextLocalIndex;
    state.nextLocalIndex += 1;
    const requestMeta = extractModelRequestMetadata(request);
    const responseMeta = response !== undefined ? extractResponseMetadata(response) : {};
    const metadata = { ...requestMeta, ...responseMeta } as JsonObject;

    // Determine outcome: non-success stop reasons (error, hook_blocked) are failures
    // even when a ModelResponse is returned, since the response is a denial or error
    // signal rather than a real model completion.
    const stopReason = response?.stopReason;
    const isNonSuccessStop =
      stopReason !== undefined &&
      stopReason !== "stop" &&
      stopReason !== "length" &&
      stopReason !== "tool_use";
    const outcome = response === undefined || isNonSuccessStop ? "failure" : "success";

    return {
      stepIndex,
      timestamp: startTime,
      source: "agent",
      kind: "model_call",
      identifier: response?.model ?? request.model ?? "unknown",
      outcome,
      durationMs,
      request: extractLastUserMessage(request),
      metadata: {
        ...metadata,
        ...(isNonSuccessStop ? { modelStopReason: stopReason } : {}),
      } as JsonObject,
      ...pickDefined({
        response: response !== undefined ? { text: response.content } : undefined,
        metrics: response !== undefined ? extractUsageMetrics(response) : undefined,
        error: caughtError !== undefined ? captureError(caughtError) : undefined,
        reasoningContent,
      }),
    };
  }

  /**
   * Flush pending steps to the store. On transient failure, retains steps for
   * one more attempt. If the retry also fails, drops with onTraceLoss callback.
   */
  async function flushSteps(state: SessionState): Promise<void> {
    if (state.pendingSteps.length === 0) return;

    const stepsToFlush = [...state.pendingSteps];
    try {
      await store.append(docId, stepsToFlush);
      state.pendingSteps.length = 0;
      state.nextLocalIndex = 0;
      state.lastFlushFailed = false;
    } catch (e: unknown) {
      if (state.lastFlushFailed) {
        // Second consecutive failure — drop to prevent unbounded growth
        const droppedCount = state.pendingSteps.length;
        state.pendingSteps.length = 0;
        state.nextLocalIndex = 0;
        state.lastFlushFailed = false;
        onTraceLoss?.(droppedCount, e);
      } else {
        // First failure — retain for retry on next flush
        state.lastFlushFailed = true;
      }
    }
  }

  const middleware: KoiMiddleware = {
    name: "event-trace",
    priority: 100,
    phase: "observe" as const,

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const state = getState(ctx.session.sessionId as string);
      if (state === undefined) return undefined;
      return {
        label: "tracing",
        description: `Recording trajectory (${String(state.pendingSteps.length)} pending steps)`,
      };
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId as string, {
        pendingSteps: [],
        nextLocalIndex: 0,
        turnStartTime: 0,
        lastFlushFailed: false,
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const state = sessions.get(ctx.sessionId as string);
      if (state !== undefined) {
        await flushSteps(state);
        // If flush failed on shutdown, there's no next turn to retry —
        // surface the loss explicitly instead of silently discarding.
        if (state.pendingSteps.length > 0) {
          onTraceLoss?.(state.pendingSteps.length, new Error("session ended with pending steps"));
          state.pendingSteps.length = 0;
        }
      }
      sessions.delete(ctx.sessionId as string);
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const state = getState(ctx.session.sessionId as string);
      if (state === undefined) return;
      state.turnStartTime = clock();
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const state = getState(ctx.session.sessionId as string);
      if (state === undefined) return;
      await flushSteps(state);
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const state = getState(ctx.session.sessionId as string);
      if (state === undefined) return next(request);

      const startTime = clock();
      let response: ModelResponse | undefined;
      let caughtError: unknown;
      try {
        response = await next(request);
        return response;
      } catch (e: unknown) {
        caughtError = e;
        throw e;
      } finally {
        // Entire trace capture wrapped in try-catch — observer must never throw
        try {
          state.pendingSteps.push(
            buildModelStep(state, startTime, request, response, caughtError, undefined),
          );
        } catch {
          // Trace capture failed (should not happen, but safety net)
        }
      }
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const state = getState(ctx.session.sessionId as string);
      if (state === undefined) {
        yield* next(request);
        return;
      }

      const startTime = clock();
      let finalResponse: ModelResponse | undefined;
      let caughtError: unknown;
      const thinkingParts: string[] = [];

      try {
        for await (const chunk of next(request)) {
          if (chunk.kind === "done") {
            finalResponse = chunk.response;
          } else if (chunk.kind === "thinking_delta") {
            thinkingParts.push(chunk.delta);
          }
          yield chunk;
        }
      } catch (e: unknown) {
        caughtError = e;
        throw e;
      } finally {
        try {
          const reasoning = thinkingParts.length > 0 ? thinkingParts.join("") : undefined;
          state.pendingSteps.push(
            buildModelStep(state, startTime, request, finalResponse, caughtError, reasoning),
          );
        } catch {
          // Trace capture failed — safety net
        }
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const state = getState(ctx.session.sessionId as string);
      if (state === undefined) return next(request);

      const startTime = clock();
      let response: ToolResponse | undefined;
      let caughtError: unknown;
      try {
        response = await next(request);
        return response;
      } catch (e: unknown) {
        caughtError = e;
        throw e;
      } finally {
        // Entire trace capture wrapped in try-catch — observer must never throw.
        // Handles circular objects, BigInt, or any other serialization failure.
        try {
          const durationMs = clock() - startTime;
          const stepIndex = state.nextLocalIndex;
          state.nextLocalIndex += 1;

          const step: RichTrajectoryStep = {
            stepIndex,
            timestamp: startTime,
            source: "tool",
            kind: "tool_call",
            identifier: request.toolId,
            outcome: response !== undefined ? "success" : "failure",
            durationMs,
            request: { data: request.input },
            ...pickDefined({
              response: response !== undefined ? captureToolOutput(response.output) : undefined,
              error: caughtError !== undefined ? captureError(caughtError) : undefined,
            }),
          };
          state.pendingSteps.push(step);
        } catch {
          // Trace capture failed — safety net
        }
      }
    },
  };

  return {
    middleware,
    getTrajectoryStore: () => store,
  };
}
