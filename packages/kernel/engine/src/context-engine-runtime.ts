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
  readonly current: (turnId?: TurnId) => ContextEngine | undefined;
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
      try {
        // Pass turnId so overlapping turns each resolve their own pinned
        // engine — without this, a later beginTurn would clobber the pin
        // and break prepare/onAfterTurn pairing on the earlier turn.
        const engine = controller.current(ctx.turnId);
        if (engine === undefined) return await next(request);
        const prepared = await engine.prepare(ctx, request.messages);
        return await next({ ...request, messages: prepared });
      } catch (err) {
        // Release the pin on any pre-onAfterTurn failure (prepare(),
        // downstream call, or sync throw). Without this, an aborted turn
        // would leave `controller.current()` stuck on the pre-failure
        // engine forever, defeating turn-aware swap reads on the very
        // recovery path that needs them.
        controller.endTurn(ctx.turnId);
        throw err;
      }
    },
    // Native streaming adapters take this path instead of wrapModelCall.
    // Both must drive engine.prepare() or compaction silently disappears
    // under streaming.
    wrapModelStream: (ctx, request, next) => {
      controller.beginTurn(ctx.turnId);
      const engine = controller.current(ctx.turnId);
      return {
        async *[Symbol.asyncIterator](): AsyncIterator<
          import("@koi/core").ModelChunk,
          undefined,
          undefined
        > {
          try {
            if (engine === undefined) {
              for await (const chunk of next(request)) yield chunk;
              return;
            }
            const prepared = await engine.prepare(ctx, request.messages);
            for await (const chunk of next({ ...request, messages: prepared })) {
              yield chunk;
            }
          } catch (err) {
            controller.endTurn(ctx.turnId);
            throw err;
          }
        },
      };
    },
    onAfterTurn: async (ctx) => {
      // Resolve through the controller with this turn's turnId so we hit
      // the same engine pinned since beginTurn — even under overlapping
      // turns or a mid-turn swap.
      const engine = controller.current(ctx.turnId);
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
