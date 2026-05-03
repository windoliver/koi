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

import type { ContextEngine, KoiMiddleware, ModelChunk } from "@koi/core";

/**
 * Build a `KoiMiddleware` that calls `engine.prepare()` before each model
 * request and forwards the returned message list as `request.messages`.
 * `engine.onAfterTurn` is bridged to `KoiMiddleware.onAfterTurn` so engines
 * that need post-turn bookkeeping (backoff decay, eviction) get triggered.
 *
 * Use only when you are NOT passing `contextEngineFactory` to `createKoi()`
 * — see the module-level docs.
 *
 * Accepts either:
 *   - a `ContextEngine` instance (fixed for the lifetime of the runtime), or
 *   - a `() => ContextEngine` getter (resolved on every model call), so
 *     manually wired hosts that own their own swap controller can plug
 *     `() => controller.current()` here and get swap-aware behavior
 *     without rebuilding the runtime.
 *
 * Implements both `wrapModelCall` (non-streaming) and `wrapModelStream`
 * (native streaming adapters) so `prepare()` runs on every model path —
 * a manual middleware that only intercepted `wrapModelCall` would silently
 * skip context preparation under streaming adapters.
 */
export function createContextEngineMiddleware(
  engineOrGetter: ContextEngine | (() => ContextEngine),
): KoiMiddleware {
  const resolve =
    typeof engineOrGetter === "function" ? engineOrGetter : (): ContextEngine => engineOrGetter;
  return {
    name: "context-engine",
    phase: "resolve",
    priority: 500,
    wrapModelCall: async (ctx, request, next) => {
      const engine = resolve();
      const prepared = await engine.prepare(ctx, request.messages);
      return next({ ...request, messages: prepared });
    },
    wrapModelStream: (ctx, request, next) => {
      const engine = resolve();
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ModelChunk, undefined, undefined> {
          const prepared = await engine.prepare(ctx, request.messages);
          for await (const chunk of next({ ...request, messages: prepared })) {
            yield chunk;
          }
        },
      };
    },
    onAfterTurn: async (ctx) => {
      const engine = resolve();
      if (engine.onAfterTurn !== undefined) {
        await engine.onAfterTurn(ctx);
      }
    },
    describeCapabilities: () => undefined,
  };
}
