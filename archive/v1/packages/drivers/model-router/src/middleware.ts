/**
 * Thin KoiMiddleware adapter for ModelRouter.
 *
 * Wraps the ModelRouter service as middleware so it can be plugged
 * into the middleware chain via wrapModelCall.
 */

import type { KoiMiddleware } from "@koi/core";
import type { ModelRouter } from "./router.js";

/**
 * Creates a KoiMiddleware that delegates model calls to the ModelRouter.
 *
 * The middleware intercepts wrapModelCall and routes the request through
 * the router's retry/fallback/circuit-breaker pipeline. If routing fails,
 * the error is thrown (unexpected failure — the router exhausted all options).
 *
 * @param router - The ModelRouter service instance
 */
export function createModelRouterMiddleware(router: ModelRouter): KoiMiddleware {
  return {
    name: "model-router",
    priority: 900,

    describeCapabilities: () => ({
      label: "model-router",
      description: "Model routing with retry, fallback, and circuit-breaker active",
    }),

    async wrapModelCall(_ctx, request, _next) {
      const result = await router.route(request);
      if (!result.ok) {
        throw result.error;
      }
      return result.value;
    },
  };
}
