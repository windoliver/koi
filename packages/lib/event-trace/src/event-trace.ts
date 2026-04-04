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
 * Retry support:
 *   - When a RetrySignalReader is configured, steps recorded during active retry
 *     signals get outcome: "retry" and metadata.retryOf/retryAttempt/retryReason
 *   - Coordination with @koi/middleware-semantic-retry via L0 RetrySignalBroker
 *
 * NOT captured here (belongs in L3 harness compose layer):
 *   - Per-middleware spans (name, duration, nextCalled) — see DebugSpanResponse in v1
 *   - Middleware request modification deltas
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
import type { RetrySignalReader } from "@koi/core/retry-signal";
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
  /**
   * Optional retry signal reader for cross-middleware retry coordination.
   * When provided, steps recorded while a retry signal is active will have
   * `outcome: "retry"` and retry metadata (retryOf, retryAttempt, etc.).
   */
  readonly signalReader?: RetrySignalReader;
}

// ---------------------------------------------------------------------------
// Handle — returned by the factory
// ---------------------------------------------------------------------------

export interface EventTraceHandle {
  /** The KoiMiddleware instance to wire into the middleware chain. */
  readonly middleware: KoiMiddleware;
  /** Get the backing trajectory document store. */
  readonly getTrajectoryStore: () => TrajectoryDocumentStore;
  /**
   * Emit an externally-produced trajectory step (e.g., approval decisions from
   * middleware-permissions). Assigns a proper stepIndex and writes to the store.
   */
  readonly emitExternalStep: (sessionId: string, step: RichTrajectoryStep) => void;
}

// ---------------------------------------------------------------------------
// Per-session state
// ---------------------------------------------------------------------------

/** Provenance entry for a single external system consulted during a turn. */
interface ProvenanceEntry {
  readonly system: string;
  readonly server?: string;
  readonly tools: string[];
  count: number;
}

interface SessionState {
  /** Step counter within this session. */
  nextLocalIndex: number;
  /** Timestamp when the current turn started. */
  turnStartTime: number;
  /** Steps that failed to write — retried on next recordStep call. */
  readonly retryQueue: RichTrajectoryStep[];
  /** Provenance entries accumulated during the current turn, keyed by system+server. */
  readonly turnProvenance: Map<string, ProvenanceEntry>;
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
  const signalReader = config.signalReader;

  const sessions = new Map<string, SessionState>();
  /** In-flight write promises — awaited on session end to ensure all data lands. */
  const pendingWrites = new Set<Promise<void>>();

  function getState(sessionId: string): SessionState | undefined {
    return sessions.get(sessionId);
  }

  /**
   * Record a step to the store without blocking the request path.
   * Fire-and-forget: the store write runs concurrently so observer I/O
   * cannot add latency to model/tool completions. Each step gets its
   * own retry budget.
   */
  function recordStep(state: SessionState, step: RichTrajectoryStep): void {
    // Fire-and-forget — runs concurrently, never blocks the caller
    const p = writeStep(state, step);
    pendingWrites.add(p);
    void p.finally(() => pendingWrites.delete(p));
  }

  async function writeStep(state: SessionState, step: RichTrajectoryStep): Promise<void> {
    // Drain retry queue independently — stale failures don't consume fresh step's budget
    if (state.retryQueue.length > 0) {
      const stale = [...state.retryQueue];
      state.retryQueue.length = 0;
      try {
        await store.append(docId, stale);
      } catch {
        onTraceLoss?.(stale.length, new Error("retry queue flush failed"));
      }
    }

    // Write the fresh step with its own retry allowance
    try {
      await store.append(docId, [step]);
    } catch {
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

  /**
   * Check for an active retry signal and return retry-annotated outcome + metadata.
   * Returns undefined when no retry signal is active.
   */
  function applyRetrySignal(
    sessionId: string,
    _baseOutcome: "success" | "failure" | "retry",
    baseMetadata: JsonObject,
  ):
    | { readonly outcome: "success" | "failure" | "retry"; readonly metadata: JsonObject }
    | undefined {
    const signal = signalReader?.getRetrySignal(sessionId);
    if (signal === undefined) return undefined;
    return {
      outcome: "retry",
      metadata: {
        ...baseMetadata,
        retryOfTurn: signal.originTurnIndex,
        retryAttempt: signal.attemptNumber,
        retryReason: signal.reason,
        retryFailureClass: signal.failureClass,
      } as JsonObject,
    };
  }

  function buildModelStep(
    state: SessionState,
    startTime: number,
    request: ModelRequest,
    response: ModelResponse | undefined,
    caughtError: unknown,
    reasoningContent: string | undefined,
    sessionId?: string,
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
    const baseOutcome = response === undefined || isNonSuccessStop ? "failure" : "success";
    const baseMetadata = {
      ...metadata,
      ...(isNonSuccessStop ? { modelStopReason: stopReason } : {}),
    } as JsonObject;

    // Apply retry signal if active — overrides outcome to "retry" and adds linking metadata
    const retryOverride =
      sessionId !== undefined ? applyRetrySignal(sessionId, baseOutcome, baseMetadata) : undefined;
    const outcome = retryOverride?.outcome ?? baseOutcome;
    const finalMetadata = retryOverride?.metadata ?? baseMetadata;

    return {
      stepIndex,
      timestamp: startTime,
      source: "agent",
      kind: "model_call",
      identifier: response?.model ?? request.model ?? "unknown",
      outcome,
      durationMs,
      request: extractLastUserMessage(request),
      metadata: finalMetadata,
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
        turnProvenance: new Map(),
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      // Wait for all in-flight writes to complete before session cleanup
      if (pendingWrites.size > 0) {
        await Promise.allSettled([...pendingWrites]);
      }
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
          const step = buildModelStep(
            state,
            startTime,
            request,
            response,
            caughtError,
            undefined,
            ctx.session.sessionId as string,
          );
          recordStep(state, step);
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
                ctx.session.sessionId as string,
              );
              recordStep(state, step);
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
              ctx.session.sessionId as string,
            );
            recordStep(state, step);
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

          // Tool responses with blockedByHook metadata are policy denials,
          // not successful executions — trace them as failures.
          const blockedByHook =
            response?.metadata !== undefined &&
            (response.metadata as Record<string, unknown>).blockedByHook === true;
          const baseToolOutcome = response === undefined || blockedByHook ? "failure" : "success";
          const baseToolMetadata = blockedByHook
            ? ((response?.metadata ?? {}) as JsonObject)
            : ({} as JsonObject);

          // Apply retry signal if active
          const toolRetryOverride = applyRetrySignal(
            ctx.session.sessionId as string,
            baseToolOutcome,
            baseToolMetadata,
          );
          const toolOutcome = toolRetryOverride?.outcome ?? baseToolOutcome;
          const toolMetadata = toolRetryOverride?.metadata ?? baseToolMetadata;
          const hasMetadata = Object.keys(toolMetadata).length > 0;

          // Extract provenance from response metadata (#1464)
          const responseMeta =
            response?.metadata !== undefined
              ? (response.metadata as Record<string, unknown>)
              : undefined;
          const provenance = responseMeta?.provenance as
            | { readonly system: string; readonly server?: string }
            | undefined;

          // Persist full response metadata (preserves provenance, correlation IDs, etc.)
          const stepMeta =
            response?.metadata !== undefined ? (response.metadata as JsonObject) : undefined;

          // Merge retry metadata (if any) on top of full response metadata (preserves provenance)
          const finalToolMetadata =
            toolRetryOverride !== undefined
              ? ({ ...(stepMeta ?? {}), ...toolRetryOverride.metadata } as JsonObject)
              : stepMeta;

          const step: RichTrajectoryStep = {
            stepIndex,
            timestamp: startTime,
            source: "tool",
            kind: "tool_call",
            identifier: request.toolId,
            outcome: toolOutcome,
            durationMs,
            request: { data: request.input },
            ...pickDefined({
              response: response !== undefined ? captureToolOutput(response.output) : undefined,
              error: caughtError !== undefined ? captureError(caughtError) : undefined,
              metadata: finalToolMetadata,
            }),
          };
          recordStep(state, step);

          // Accumulate provenance for per-turn summary (#1464)
          if (provenance !== undefined) {
            const key = `${provenance.system}:${provenance.server ?? ""}`;
            const existing = state.turnProvenance.get(key);
            if (existing !== undefined) {
              existing.tools.push(request.toolId);
              existing.count += 1;
            } else {
              state.turnProvenance.set(key, {
                system: provenance.system,
                ...(provenance.server !== undefined ? { server: provenance.server } : {}),
                tools: [request.toolId],
                count: 1,
              });
            }
          }
        } catch {
          // Trace capture failed
        }
      }
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const state = getState(ctx.session.sessionId as string);
      if (state === undefined) return;

      // Emit per-turn provenance summary if any systems were consulted (#1464)
      if (state.turnProvenance.size > 0) {
        try {
          const stepIndex = state.nextLocalIndex;
          state.nextLocalIndex += 1;
          const summaryStep: RichTrajectoryStep = {
            stepIndex,
            timestamp: clock(),
            source: "system",
            kind: "tool_call",
            identifier: "provenance:turn_summary",
            outcome: "success",
            durationMs: 0,
            metadata: {
              type: "provenance_summary",
              turnIndex: ctx.turnIndex,
              systemsConsulted: [...state.turnProvenance.values()].map((entry) => ({
                system: entry.system,
                ...(entry.server !== undefined ? { server: entry.server } : {}),
                tools: entry.tools,
                count: entry.count,
              })),
            } as JsonObject,
          };
          recordStep(state, summaryStep);
        } catch {
          // Trace capture failed
        }
        state.turnProvenance.clear();
      }
    },
  };

  return {
    middleware,
    getTrajectoryStore: () => store,
    emitExternalStep(sessionId: string, step: RichTrajectoryStep): void {
      const state = getState(sessionId);
      if (state === undefined) return;
      const stepIndex = state.nextLocalIndex;
      state.nextLocalIndex += 1;
      const indexed: RichTrajectoryStep = { ...step, stepIndex };
      recordStep(state, indexed);
    },
  };
}
