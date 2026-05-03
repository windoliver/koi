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
 *
 * **Lifecycle gap on cooperating-adapter shortcut:** when an adapter
 * yields `done` directly without first emitting `turn_end`, the runtime's
 * normal `onAfterTurn` middleware hook does NOT fire. The auto-wired
 * `contextEngineFactory` path closes this with a kernel-level synthesizer
 * keyed off the swap controller; this manual middleware has no equivalent
 * and so a successful done-only turn will skip `engine.onAfterTurn` for
 * stateful engines (`createContextEngine` per-turn occupancy, eviction
 * queues, checkpoint bookkeeping). If your adapter takes the
 * cooperating-shortcut path, prefer `contextEngineFactory` instead of
 * this middleware.
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
 * The engine is captured by reference, so the same instance handles every
 * model call. **Runtime swaps are NOT supported through this helper** —
 * use `contextEngineFactory` if you need swap/rollback. Implementing
 * "getter-based" swap support here without per-turn pinning would let
 * `prepare()` and `onAfterTurn()` run against different engines under a
 * mid-turn swap, which corrupts engine state.
 *
 * Implements both `wrapModelCall` (non-streaming) and `wrapModelStream`
 * (native streaming adapters) so `prepare()` runs on every model path.
 *
 * @deprecated Prefer `contextEngineFactory` on `createKoi()`. This helper
 *   has a known lifecycle gap on adapters that yield `done` without
 *   `turn_end` (the cooperating-adapter shortcut): `engine.onAfterTurn`
 *   does not fire on that successful-turn path, leaving stateful engines
 *   with stale per-turn state. The auto-wired path closes the gap with
 *   kernel-level terminal-path synthesis. This export will be removed
 *   once all in-tree hosts migrate to `contextEngineFactory`.
 */
export function createContextEngineMiddleware(engine: ContextEngine): KoiMiddleware {
  return {
    name: "context-engine",
    phase: "resolve",
    priority: 500,
    wrapModelCall: async (ctx, request, next) => {
      try {
        const prepared = await engine.prepare(ctx, request.messages);
        return await next({ ...request, messages: prepared });
      } catch (err) {
        // Mirror createContextEngineSlotMiddleware: stateful engines
        // (per-turn occupancy, eviction queues) must release per-turn
        // state on the failure path too. Without this hook, a thrown
        // prepare()/downstream call leaves stale per-turn state
        // accumulating on the error/abort paths the manual path is
        // most likely to hit.
        if (engine.onAfterTurn !== undefined) {
          try {
            await engine.onAfterTurn({ ...ctx, stopBlocked: true });
          } catch (hookErr: unknown) {
            console.warn("[context-engine] onAfterTurn after failed turn threw", hookErr);
          }
        }
        throw err;
      }
    },
    wrapModelStream: (ctx, request, next) => {
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<ModelChunk, undefined, undefined> {
          try {
            const prepared = await engine.prepare(ctx, request.messages);
            for await (const chunk of next({ ...request, messages: prepared })) {
              yield chunk;
            }
          } catch (err) {
            if (engine.onAfterTurn !== undefined) {
              try {
                await engine.onAfterTurn({ ...ctx, stopBlocked: true });
              } catch (hookErr: unknown) {
                console.warn("[context-engine] onAfterTurn after failed stream threw", hookErr);
              }
            }
            throw err;
          }
        },
      };
    },
    onAfterTurn: async (ctx) => {
      if (engine.onAfterTurn !== undefined) {
        await engine.onAfterTurn(ctx);
      }
    },
    describeCapabilities: () => undefined,
  };
}
