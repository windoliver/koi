/**
 * Event-trace middleware — records every model/tool call to a trajectory document.
 *
 * Phase: observe (pure observation, errors silently swallowed)
 * Priority: 100 (first among observers)
 * Flush: immediate (each step written to store as it completes)
 *
 * Safety invariants:
 *   - Observer never throws into the request path (all trace capture in try-catch)
 *   - Step IDs assigned atomically by store during append() under per-doc lock
 *   - Failed writes are retried once on next capture, then dropped with onTraceLoss
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
  /** Step counter within this session. */
  nextLocalIndex: number;
  /** Timestamp when the current turn started. */
  turnStartTime: number;
  /** Steps that failed to write — retried on next recordStep call. */
  readonly retryQueue: RichTrajectoryStep[];
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

  /**
   * Record a step immediately to the store. Each step gets its own retry budget.
   * Observer code — must never throw into the request path.
   */
  async function recordStep(state: SessionState, step: RichTrajectoryStep): Promise<void> {
    // Drain retry queue independently — stale failures don't consume fresh step's budget
    if (state.retryQueue.length > 0) {
      const stale = [...state.retryQueue];
      state.retryQueue.length = 0;
      try {
        await store.append(docId, stale);
      } catch {
        // Stale retries failed again — drop them
        onTraceLoss?.(stale.length, new Error("retry queue flush failed"));
      }
    }

    // Write the fresh step with its own retry allowance
    try {
      await store.append(docId, [step]);
    } catch {
      // First failure for this step — queue for one retry
      state.retryQueue.push(step);
    }
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
    if (request.model !== undefined) meta.requestModel = request.model;
    if (request.temperature !== undefined) meta.temperature = request.temperature;
    if (request.maxTokens !== undefined) meta.maxTokens = request.maxTokens;
    const systemPrompt = extractSystemPrompt(request);
    if (systemPrompt !== undefined) meta.systemPrompt = systemPrompt;
    if (request.tools !== undefined && request.tools.length > 0) {
      meta.toolCount = request.tools.length;
      meta.tools = request.tools.map((t) => ({ name: t.name, description: t.description }));
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

    return {
      stepIndex,
      timestamp: startTime,
      source: "agent",
      kind: "model_call",
      identifier: response?.model ?? request.model ?? "unknown",
      outcome: response !== undefined ? "success" : "failure",
      durationMs,
      request: extractLastUserMessage(request),
      metadata,
      ...pickDefined({
        response: response !== undefined ? { text: response.content } : undefined,
        metrics: response !== undefined ? extractUsageMetrics(response) : undefined,
        error: caughtError !== undefined ? captureError(caughtError) : undefined,
        reasoningContent,
      }),
    };
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
        description: `Recording trajectory (${String(state.retryQueue.length)} pending retries)`,
      };
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId as string, {
        nextLocalIndex: 0,
        turnStartTime: 0,
        retryQueue: [],
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const state = sessions.get(ctx.sessionId as string);
      if (state !== undefined && state.retryQueue.length > 0) {
        // Last chance to flush retries
        try {
          await store.append(docId, [...state.retryQueue]);
          state.retryQueue.length = 0;
        } catch {
          onTraceLoss?.(state.retryQueue.length, new Error("session ended with pending retries"));
        }
      }
      sessions.delete(ctx.sessionId as string);
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const state = getState(ctx.session.sessionId as string);
      if (state === undefined) return;
      state.turnStartTime = clock();
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
        try {
          const step = buildModelStep(state, startTime, request, response, caughtError, undefined);
          await recordStep(state, step);
        } catch {
          // Trace capture failed
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
      // let: mutable — set true once the step is recorded
      let recorded = false;
      let caughtError: unknown;
      const thinkingParts: string[] = [];
      const textParts: string[] = [];

      try {
        for await (const chunk of next(request)) {
          if (chunk.kind === "thinking_delta") {
            thinkingParts.push(chunk.delta);
          } else if (chunk.kind === "text_delta") {
            textParts.push(chunk.delta);
          } else if (chunk.kind === "done") {
            // Record immediately when done chunk arrives — during iteration,
            // before onAfterTurn. Generator finally blocks execute after the
            // engine's flush, so deferring loses the step on single-turn queries.
            try {
              let response: ModelResponse = chunk.response;
              if (response.content === "" && textParts.length > 0) {
                response = { ...response, content: textParts.join("") };
              }
              const reasoning = thinkingParts.length > 0 ? thinkingParts.join("") : undefined;
              const step = buildModelStep(
                state,
                startTime,
                request,
                response,
                undefined,
                reasoning,
              );
              await recordStep(state, step);
              recorded = true;
            } catch {
              // Trace capture failed
            }
          }
          yield chunk;
        }
      } catch (e: unknown) {
        caughtError = e;
        throw e;
      } finally {
        // Error/abort path: record if we never saw a done chunk
        if (!recorded) {
          try {
            const reasoning = thinkingParts.length > 0 ? thinkingParts.join("") : undefined;
            const step = buildModelStep(
              state,
              startTime,
              request,
              undefined,
              caughtError,
              reasoning,
            );
            await recordStep(state, step);
          } catch {
            // Trace capture failed
          }
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
          await recordStep(state, step);
        } catch {
          // Trace capture failed
        }
      }
    },
  };

  return {
    middleware,
    getTrajectoryStore: () => store,
  };
}
