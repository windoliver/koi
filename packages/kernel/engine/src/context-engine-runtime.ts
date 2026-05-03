/**
 * Controller-backed context-engine middleware — auto-injected by `createKoi`
 * when a `contextEngineFactory` is supplied. Reads the active engine through
 * a getter on every model call so swaps/rollbacks performed via
 * `ContextEngineSwapController` are observable on the very next turn.
 *
 * Phase 5/6 of issue #1767 (round 4). The earlier
 * `@koi/context-manager#createContextEngineMiddleware(engine)` helper is
 * still exported for hosts that want to opt out of `createKoi` auto-wiring,
 * but production wiring must use this getter form so swap controller and
 * model-call path can never diverge.
 */

import type { ContextEngine, KoiMiddleware, TurnContext, TurnId } from "@koi/core";

/**
 * Build a `KoiMiddleware` that resolves the active `ContextEngine` via the
 * provided getter on each call. Returning `undefined` from `getEngine` makes
 * the middleware a passthrough — useful when the slot is empty or the host
 * has not yet attached a controller.
 *
 * Per-turn binding: the first `prepare()` call of a turn pins the engine for
 * that turn. All subsequent model calls within the turn and the matching
 * `onAfterTurn` resolve to that same instance even if a swap occurs mid-turn.
 * This keeps prepare/onAfterTurn paired on stateful engines (occupancy,
 * eviction, rollback bookkeeping) — without it, a swap between `prepare()`
 * and turn-end would deliver `onAfterTurn` to a different engine than the
 * one that mutated state during prepare.
 */
export function createContextEngineSlotMiddleware(
  getEngine: () => ContextEngine | undefined,
): KoiMiddleware {
  // Key by `ctx.turnId` (a stable branded string) rather than by TurnContext
  // object identity: the runtime constructs a fresh TurnContext for the
  // turn-end hooks (see koi.ts createTurnContext/turnEndCtx), so a WeakMap
  // keyed by the object would miss on `onAfterTurn` and silently fall back
  // to the live engine, defeating per-turn pinning under mid-turn swaps.
  // Eager `delete()` in onAfterTurn keeps the map bounded under long-lived
  // hosts (no GC dependency since TurnId is a string).
  const turnEngine = new Map<TurnId, ContextEngine>();

  const pinEngine = (ctx: TurnContext): ContextEngine | undefined => {
    const existing = turnEngine.get(ctx.turnId);
    if (existing !== undefined) return existing;
    const engine = getEngine();
    if (engine === undefined) return undefined;
    turnEngine.set(ctx.turnId, engine);
    return engine;
  };

  return {
    name: "context-engine",
    phase: "resolve",
    priority: 500,
    wrapModelCall: async (ctx, request, next) => {
      const engine = pinEngine(ctx);
      if (engine === undefined) {
        return next(request);
      }
      const prepared = await engine.prepare(ctx, request.messages);
      return next({ ...request, messages: prepared });
    },
    // Native streaming adapters take this path instead of wrapModelCall.
    // Both must drive engine.prepare() or compaction silently disappears
    // under streaming.
    wrapModelStream: (ctx, request, next) => {
      const engine = pinEngine(ctx);
      if (engine === undefined) {
        return next(request);
      }
      // The chunk source is async but `wrapModelStream` returns a synchronous
      // AsyncIterable. We resolve `prepare()` lazily in the iterator so the
      // surrounding chain composition still works without an outer await.
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<
          import("@koi/core").ModelChunk,
          undefined,
          undefined
        > {
          const prepared = await engine.prepare(ctx, request.messages);
          for await (const chunk of next({ ...request, messages: prepared })) {
            yield chunk;
          }
        },
      };
    },
    onAfterTurn: async (ctx) => {
      // Resolve to the engine pinned at first prepare(); fall back to the
      // current engine for turns where prepare() never ran (no model call).
      const pinned = turnEngine.get(ctx.turnId);
      const engine = pinned ?? getEngine();
      turnEngine.delete(ctx.turnId);
      if (engine?.onAfterTurn !== undefined) {
        await engine.onAfterTurn(ctx);
      }
    },
    describeCapabilities: () => undefined,
  };
}
