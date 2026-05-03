/**
 * Middleware adapter that drives a `ContextEngine` during the model-call
 * onion. Used by hosts that wire the engine slot manually — i.e. hosts
 * that do NOT pass `contextEngineFactory` to `createKoi()`.
 *
 * **Important compatibility note (#1767 round 7+):** if you use
 * `contextEngineFactory`, do NOT also install this middleware.
 * `createKoi()` rejects it at startup and at every recomposition because
 * pairing the two wiring paths runs `prepare()` twice (or with two
 * different engines) and breaks swap-controller invariants.
 *
 * Pick one path:
 *   1. (recommended) Pass `contextEngineFactory` and let `createKoi`
 *      own slot wiring + swap controller. Do not add this middleware.
 *   2. Manage the engine yourself: pair this middleware with
 *      `createContextEngineProvider(engine)` and skip
 *      `contextEngineFactory`. You then own swap orchestration too.
 */

import type { ContextEngine, KoiMiddleware } from "@koi/core";

/**
 * Build a `KoiMiddleware` that calls `engine.prepare()` before each model
 * request and forwards the returned message list as `request.messages`.
 * `engine.onAfterTurn` is bridged to `KoiMiddleware.onAfterTurn` so engines
 * that need post-turn bookkeeping (backoff decay, eviction) get triggered.
 *
 * Use only when you are NOT passing `contextEngineFactory` to `createKoi()`
 * — see the module-level docs.
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
