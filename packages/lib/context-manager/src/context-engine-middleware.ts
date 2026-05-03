/**
 * Middleware adapter that drives a `ContextEngine` during the model-call
 * onion, ensuring the slot is actually exercised on every turn.
 *
 * Phase 5/6 of issue #1767 (round 3 follow-up). Hosts that pass
 * `contextEngineFactory` to `createKoi()` should also include this middleware
 * via `middleware: [createContextEngineMiddleware(engine), ...]` so the
 * engine's `prepare()` rewrites `request.messages` before the model adapter
 * sees them. Without this, `CONTEXT_ENGINE` would be attached but never
 * invoked.
 *
 * The middleware uses the engine instance directly (rather than reading
 * `agent.component(CONTEXT_ENGINE)`) so the same instance handles `prepare()`
 * here and is observable through the slot for swap controllers and operator
 * tooling. Pair it with `createContextEngineProvider(engine)`.
 */

import type { ContextEngine, KoiMiddleware } from "@koi/core";

/**
 * Build a `KoiMiddleware` that calls `engine.prepare()` before each model
 * request and forwards the returned message list as `request.messages`.
 * `engine.onAfterTurn` is bridged to `KoiMiddleware.onAfterTurn` so engines
 * that need post-turn bookkeeping (backoff decay, eviction) get triggered.
 */
export function createContextEngineMiddleware(engine: ContextEngine): KoiMiddleware {
  return {
    name: "context-engine",
    phase: "resolve",
    priority: 500,
    wrapModelCall: async (ctx, request, next) => {
      const prepared = await engine.prepare(ctx, request.messages);
      return next({ ...request, messages: prepared });
    },
    onAfterTurn: async (ctx) => {
      if (engine.onAfterTurn !== undefined) {
        await engine.onAfterTurn(ctx);
      }
    },
    describeCapabilities: () => undefined,
  };
}
