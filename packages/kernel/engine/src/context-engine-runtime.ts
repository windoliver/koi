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

import type { ContextEngine, KoiMiddleware, TurnId } from "@koi/core";

/**
 * Minimal controller surface the slot middleware needs. The full
 * `ContextEngineSwapController` from this package satisfies it; tests can
 * pass a leaner stub.
 */
export interface SlotController {
  readonly current: () => ContextEngine | undefined;
  readonly beginTurn: (turnId: TurnId) => void;
  readonly endTurn: (turnId: TurnId) => void;
}

/**
 * Build a `KoiMiddleware` that resolves the active `ContextEngine` through
 * a swap controller. The controller's `beginTurn`/`endTurn` keep
 * `controller.current()` (and therefore the ECS proxy that reads it) pinned
 * to a single engine for the duration of a turn, even if the host issues
 * `controller.swap()` mid-turn. This guarantees prepare/onAfterTurn pair on
 * the same engine and that ECS reads agree with what the middleware
 * actually used.
 *
 * If `controller.current()` returns `undefined` the middleware is a
 * passthrough (slot empty / not yet wired).
 */
export function createContextEngineSlotMiddleware(controller: SlotController): KoiMiddleware {
  return {
    name: "context-engine",
    phase: "resolve",
    priority: 500,
    wrapModelCall: async (ctx, request, next) => {
      controller.beginTurn(ctx.turnId);
      const engine = controller.current();
      if (engine === undefined) return next(request);
      const prepared = await engine.prepare(ctx, request.messages);
      return next({ ...request, messages: prepared });
    },
    // Native streaming adapters take this path instead of wrapModelCall.
    // Both must drive engine.prepare() or compaction silently disappears
    // under streaming.
    wrapModelStream: (ctx, request, next) => {
      controller.beginTurn(ctx.turnId);
      const engine = controller.current();
      if (engine === undefined) return next(request);
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
      // Resolve through the controller so we hit the same engine pinned
      // since beginTurn — even if a host issued a swap mid-turn.
      const engine = controller.current();
      try {
        if (engine?.onAfterTurn !== undefined) {
          await engine.onAfterTurn(ctx);
        }
      } finally {
        controller.endTurn(ctx.turnId);
      }
    },
    describeCapabilities: () => undefined,
  };
}
