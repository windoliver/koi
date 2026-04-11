/**
 * OTel middleware — emits OpenTelemetry GenAI semantic convention spans.
 *
 * Integration pattern:
 *   1. createOtelMiddleware() returns an OtelHandle with two parts:
 *      - middleware: KoiMiddleware — wire into the agent middleware chain for
 *        session span lifecycle (onSessionStart / onSessionEnd)
 *      - onStep: callback — wire into EventTraceConfig.onStep so event-trace
 *        delivers each RichTrajectoryStep here after it is built
 *
 *   2. Span hierarchy per session:
 *        invoke_agent {agentName}   [INTERNAL] — root, lifetime = session
 *          chat {model}             [CLIENT]   — one per model call
 *            execute_tool {tool}    [INTERNAL] — tool spans parented to last model span
 *
 *   3. Cross-agent propagation (W3C traceparent across spawn boundaries) is
 *      NOT implemented in v1. Tracked for v2.
 *
 * Observer invariant:
 *   This middleware never throws into the request path. All OTel operations are
 *   wrapped in safeSpanOp — errors route to onSpanError callback, then swallowed.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import type { Meter } from "@opentelemetry/api";
import {
  type Context,
  context,
  type Histogram,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  ATTR_KOI_STEP_OUTCOME,
  EVENT_GEN_AI_CHOICE,
  EVENT_GEN_AI_USER_MESSAGE,
  METRIC_KOI_GEN_AI_COST,
} from "./semconv.js";
import {
  buildModelSpanAttrs,
  buildModelSpanName,
  buildSessionSpanAttrs,
  buildSessionSpanName,
  buildToolSpanAttrs,
  buildToolSpanName,
} from "./span-attrs.js";

// ---------------------------------------------------------------------------
// Config & Handle
// ---------------------------------------------------------------------------

export interface OtelMiddlewareConfig {
  /**
   * Tracer name passed to trace.getTracer(). Default: "@koi/middleware-otel".
   * Use your application name if you want traces grouped under a single tracer.
   */
  readonly tracerName?: string;

  /**
   * Whether to capture prompt/response text as span events.
   * Default: false — safe for production (prompts may contain PII).
   *
   * When true, emits:
   *   - gen_ai.user.message event on model call spans (prompt text)
   *   - gen_ai.choice event on model call spans (completion text)
   *
   * These can be filtered at the OTel Collector level without touching application code.
   */
  readonly captureContent?: boolean;

  /**
   * OTel Meter for emitting the koi.gen_ai.cost histogram.
   * If omitted, cost metrics are not emitted.
   *
   * @example
   *   meter: metrics.getMeter("my-app")
   */
  readonly meter?: Meter;

  /**
   * Called when an OTel span operation throws an unexpected error.
   * The error is always swallowed after this callback — the request path is unaffected.
   * Use for diagnostics/logging.
   */
  readonly onSpanError?: (error: unknown) => void;
}

/**
 * Handle returned by createOtelMiddleware.
 * Wire both parts into Koi to get full span coverage.
 */
export interface OtelHandle {
  /**
   * Wire into EventTraceConfig.onStep.
   *
   * Called synchronously after each RichTrajectoryStep is built by event-trace.
   * Creates and ends OTel spans with accurate retroactive timing.
   *
   * CONTRACT: This function is CPU-only and non-throwing (errors are swallowed).
   * Do NOT make it async or perform I/O — it fires in the hot step-recording path.
   */
  readonly onStep: (
    sessionId: string,
    step: RichTrajectoryStep,
  ) => Record<string, string> | undefined;

  /**
   * Wire into the agent middleware chain.
   * Handles onSessionStart (create root span) and onSessionEnd (end root span).
   */
  readonly middleware: KoiMiddleware;
}

// ---------------------------------------------------------------------------
// Internal session state
// ---------------------------------------------------------------------------

interface SessionOtelState {
  /** OTel context carrying the root session span. Parent for model call spans. */
  readonly sessionCtx: Context;
  /**
   * OTel context carrying the most recent completed model span.
   * Tool call spans are parented here so traces show tool ← model hierarchy.
   * Falls back to sessionCtx when no model span has been recorded yet.
   */
  lastModelCtx: Context;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_TRACER_NAME = "@koi/middleware-otel";

/** Provenance summary steps are internal bookkeeping — skip as OTel spans. */
function isInternalStep(step: RichTrajectoryStep): boolean {
  return step.identifier.startsWith("provenance:");
}

export function createOtelMiddleware(config?: OtelMiddlewareConfig): OtelHandle {
  const tracerName = config?.tracerName ?? DEFAULT_TRACER_NAME;
  const captureContent = config?.captureContent ?? false;
  const onSpanError = config?.onSpanError;

  // Cost histogram — only initialised when a Meter is provided (Issue 8A)
  const costHistogram: Histogram | undefined = config?.meter?.createHistogram(
    METRIC_KOI_GEN_AI_COST,
    {
      unit: "USD",
      description: "Cost of GenAI inference calls in USD",
    },
  );

  const sessions = new Map<string, SessionOtelState>();

  /** Wrap all span operations — observer-never-throws invariant (Issue 12A). */
  function safeSpanOp(op: () => void): void {
    try {
      op();
    } catch (e: unknown) {
      onSpanError?.(e);
    }
  }

  // ---------------------------------------------------------------------------
  // onStep — receives every RichTrajectoryStep from event-trace (Issue 1A)
  // ---------------------------------------------------------------------------

  function onStep(sessionId: string, step: RichTrajectoryStep): Record<string, string> | undefined {
    // Skip internal bookkeeping steps
    if (isInternalStep(step)) return;

    // Populated inside safeSpanOp, returned to event-trace for ATIF stamping
    let otelMeta: Record<string, string> | undefined;

    safeSpanOp(() => {
      const state = sessions.get(sessionId);
      // If session state is missing (OTel not wired into middleware chain), silently skip.
      if (state === undefined) return;

      const tracer = trace.getTracer(tracerName);

      if (step.kind === "model_call") {
        // Spans are created with retroactive timing from step metadata.
        // OTel supports explicit start/end times — accurate even though the span
        // is created after the model call completes.
        const spanName = buildModelSpanName(step);
        const attrs = buildModelSpanAttrs(step, sessionId);
        const startTime = step.timestamp;
        const endTime = step.timestamp + step.durationMs;

        const span = tracer.startSpan(
          spanName,
          { kind: SpanKind.CLIENT, startTime, attributes: attrs },
          state.sessionCtx,
        );

        if (step.outcome === "failure") {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }

        // Opt-in content capture as span events (Issue 5A)
        if (captureContent) {
          if (step.request?.text !== undefined) {
            span.addEvent(
              EVENT_GEN_AI_USER_MESSAGE,
              { "gen_ai.prompt": step.request.text },
              startTime,
            );
          }
          if (step.response?.text !== undefined) {
            span.addEvent(
              EVENT_GEN_AI_CHOICE,
              { "gen_ai.completion": step.response.text },
              endTime,
            );
          }
        }

        span.end(endTime);

        // Store context with the ended span as parent for subsequent tool calls
        state.lastModelCtx = trace.setSpan(context.active(), span);

        // Cost metric (Issue 8A) — histogram, not span attribute
        if (costHistogram !== undefined && step.metrics?.costUsd !== undefined) {
          costHistogram.record(step.metrics.costUsd, {
            [ATTR_KOI_STEP_OUTCOME]: step.outcome,
            ...attrs,
          });
        }

        // Stamp OTel coordinates into ATIF metadata so both systems share the
        // same trace identity. event-trace merges this return value before write.
        otelMeta = {
          "otel.traceId": span.spanContext().traceId,
          "otel.spanId": span.spanContext().spanId,
        };
      } else if (step.kind === "tool_call") {
        const spanName = buildToolSpanName(step);
        const attrs = buildToolSpanAttrs(step, sessionId);
        const startTime = step.timestamp;
        const endTime = step.timestamp + step.durationMs;

        // Parent: last model span (or session span if no model call yet)
        const span = tracer.startSpan(
          spanName,
          { kind: SpanKind.INTERNAL, startTime, attributes: attrs },
          state.lastModelCtx,
        );

        if (step.outcome === "failure") {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }

        span.end(endTime);

        // Stamp OTel coordinates into ATIF metadata
        otelMeta = {
          "otel.traceId": span.spanContext().traceId,
          "otel.spanId": span.spanContext().spanId,
        };
      }
    });

    return otelMeta;
  }

  // ---------------------------------------------------------------------------
  // Middleware — session span lifecycle
  // ---------------------------------------------------------------------------

  const middleware: KoiMiddleware = {
    name: "otel",
    priority: 150,
    phase: "observe",

    async onSessionStart(ctx: SessionContext): Promise<void> {
      safeSpanOp(() => {
        const tracer = trace.getTracer(tracerName);
        const sid = ctx.sessionId as string;
        const agentName = ctx.agentId;

        const spanName = buildSessionSpanName(agentName);
        const attrs = buildSessionSpanAttrs(agentName, sid);

        // Root session span — ends in onSessionEnd
        const sessionSpan = tracer.startSpan(spanName, {
          kind: SpanKind.INTERNAL,
          attributes: attrs,
        });

        const sessionCtx = trace.setSpan(context.active(), sessionSpan);
        sessions.set(sid, {
          sessionCtx,
          lastModelCtx: sessionCtx,
        });
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      safeSpanOp(() => {
        const sid = ctx.sessionId as string;
        const state = sessions.get(sid);
        if (state === undefined) return;

        const sessionSpan = trace.getSpan(state.sessionCtx);
        sessionSpan?.end();
        sessions.delete(sid);
      });
    },

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      // OTel middleware is transparent — no capability injected into model context
      return undefined;
    },
  };

  return { onStep, middleware };
}
