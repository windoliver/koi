/**
 * KoiMiddleware adapter for ModelRouter.
 *
 * Intercepts both non-streaming (wrapModelCall) and streaming (wrapModelStream)
 * model calls, routing them through the router's failover pipeline.
 *
 * Priority 900: outermost middleware layer — runs before audit, permissions, etc.
 *
 * Telemetry: calls ctx.reportDecision with router routing metadata when present.
 */

import type {
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core";
import type { ModelRouter } from "./router.js";

/**
 * Creates a KoiMiddleware that delegates model calls to the ModelRouter.
 *
 * For non-streaming calls: routes via router.route(), throws on exhaustion.
 * For streaming calls: routes via router.routeStream(), with mid-stream abort safety.
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

      ctx.reportDecision?.({
        "router.target.selected": result.value.model,
        "router.latency_ms": Date.now() - startMs,
      });

      return result.value;
    },

    async *wrapModelStream(_ctx: TurnContext, request: ModelRequest): AsyncIterable<ModelChunk> {
      yield* router.routeStream(request);
    },
  };
}
