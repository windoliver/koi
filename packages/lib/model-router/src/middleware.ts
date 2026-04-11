/**
 * KoiMiddleware adapter for ModelRouter.
 *
 * Intercepts both non-streaming (wrapModelCall) and streaming (wrapModelStream)
 * model calls, routing them through the router's failover pipeline.
 *
 * Priority 900: outermost middleware layer — runs before audit, permissions, etc.
 *
 * Telemetry: emits router.* keys via ctx.reportDecision, which the trace-wrapper
 * collects into metadata.decisions on the middleware:model-router ATIF span.
 * Observable fields:
 *   router.target.selected   — provider:model that served the request
 *   router.target.attempted  — all targets tried in order (shows fallback chain)
 *   router.fallback_occurred — true when primary failed and secondary was used
 *   router.latency_ms        — wall-clock ms for the full routing + model call
 */

import type {
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core";
import type { ModelRouter, RouteDecision } from "./router.js";

/**
 * Creates a KoiMiddleware that delegates model calls to the ModelRouter.
 *
 * For non-streaming calls: routes via router.route(), throws on exhaustion.
 * For streaming calls: routes via router.routeStream() with onDecision callback.
 */
export function createModelRouterMiddleware(router: ModelRouter): KoiMiddleware {
  return {
    name: "model-router",
    priority: 900,

    describeCapabilities: () => ({
      label: "model-router",
      description: "Multi-provider LLM routing with retry, fallback, and circuit-breaker active",
    }),

    async wrapModelCall(ctx: TurnContext, request: ModelRequest): Promise<ModelResponse> {
      const startMs = Date.now();
      const result = await router.route(request);

      if (!result.ok) {
        throw result.error;
      }

      const { response, decision } = result.value;
      reportRouteDecision(ctx, decision, Date.now() - startMs);
      return response;
    },

    async *wrapModelStream(ctx: TurnContext, request: ModelRequest): AsyncIterable<ModelChunk> {
      const startMs = Date.now();
      yield* router.routeStream(request, (decision: RouteDecision) => {
        reportRouteDecision(ctx, decision, Date.now() - startMs);
      });
    },
  };
}

function reportRouteDecision(ctx: TurnContext, decision: RouteDecision, latencyMs: number): void {
  ctx.reportDecision?.({
    "router.target.selected": decision.selectedTargetId,
    "router.target.attempted": [...decision.attemptedTargetIds],
    "router.fallback_occurred": decision.fallbackOccurred,
    "router.latency_ms": latencyMs,
  });
}
