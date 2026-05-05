/**
 * Controller-backed context-engine middleware — auto-injected by `createKoi`
 * when a `contextEngineFactory` is supplied. Reads the active engine through
 * a getter on every model call so swaps/rollbacks performed via
 * `ContextEngineSwapController` are observable on the very next turn.
 *
 * Phase 5/6 of issue #1767. `contextEngineFactory` is the only supported
 * integration route — the legacy manual-middleware helper has been removed
 * because its done-shortcut path could leak per-turn state on cooperating
 * adapters and there was no way to keep manual wiring consistent with the
 * swap controller.
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
export interface SlotMiddlewareOptions {
  /**
   * Called when a turn ends through the error/abort path (before
   * `endTurn`). Used by `createKoi` to evict the per-turn TurnContext
   * cache entry for the failed turn so it does not accumulate prompt
   * history for the runtime's lifetime. The runtime's normal turn_end
   * path already evicts on success.
   */
  readonly onFailedTurn?: (turnId: TurnId) => void;
  /**
   * Called when a turn enters the model-call path with a real
   * `TurnContext`. Used by `createKoi` to populate the per-turn ctx
   * cache from the streaming and non-streaming paths uniformly so
   * terminal-path `onAfterTurn` synthesis sees the actual messages
   * even on done-only native streaming adapters. Without this, only
   * the cooperating-adapter `getTurnContext()` path populated the
   * cache, leaving streaming turns with empty messages on synth.
   */
  readonly onTurnStart?: (ctx: import("@koi/core").TurnContext) => void;
}

export function createContextEngineSlotMiddleware(
  controller: SlotController,
  options: SlotMiddlewareOptions = {},
): KoiMiddleware {
  return {
    name: "context-engine",
    phase: "resolve",
    priority: 500,
    wrapModelCall: async (ctx, request, next) => {
      controller.beginTurn(ctx.turnId);
      options.onTurnStart?.(ctx);
      try {
        // Pass turnId so overlapping turns each resolve their own pinned
        // engine — without this, a later beginTurn would clobber the pin
        // and break prepare/onAfterTurn pairing on the earlier turn.
        const engine = controller.current(ctx.turnId);
        if (engine === undefined) return await next(request);
        const prepared = await engine.prepare(ctx, request.messages);
        return await next({ ...request, messages: prepared });
      } catch (err) {
        // Run onAfterTurn on the error path so stateful engines can
        // release per-turn state (eviction queues, occupancy snapshots),
        // BUT mark the ctx as stopBlocked so engines treating that flag
        // as "skip state commits" do not advance backoff/eviction/
        // checkpoint on a turn that never actually completed. Without
        // this marker, error-path cleanup looks indistinguishable from
        // a successful turn and engines could persist summaries or drop
        // memories for requests that failed mid-flight.
        const failingEngine = controller.current(ctx.turnId);
        if (failingEngine?.onAfterTurn !== undefined) {
          try {
            await failingEngine.onAfterTurn({ ...ctx, stopBlocked: true });
          } catch (hookErr: unknown) {
            console.warn("[context-engine] onAfterTurn after failed turn threw", hookErr);
          }
        }
        // Release the pin on any pre-onAfterTurn failure. Without this,
        // an aborted turn would leave `controller.current()` stuck on the
        // pre-failure engine forever, defeating turn-aware swap reads on
        // the very recovery path that needs them.
        options.onFailedTurn?.(ctx.turnId);
        controller.endTurn(ctx.turnId);
        throw err;
      }
    },
    // Native streaming adapters take this path instead of wrapModelCall.
    // Both must drive engine.prepare() or compaction silently disappears
    // under streaming.
    wrapModelStream: (ctx, request, next) => {
      controller.beginTurn(ctx.turnId);
      options.onTurnStart?.(ctx);
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
            // Mirror wrapModelCall: invoke onAfterTurn on error with
            // stopBlocked=true so stateful engines release per-turn
            // state but do NOT advance backoff/eviction/checkpoint on
            // a stream that never completed.
            const failingEngine = controller.current(ctx.turnId);
            if (failingEngine?.onAfterTurn !== undefined) {
              try {
                await failingEngine.onAfterTurn({ ...ctx, stopBlocked: true });
              } catch (hookErr: unknown) {
                console.warn("[context-engine] onAfterTurn after failed stream threw", hookErr);
              }
            }
            options.onFailedTurn?.(ctx.turnId);
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
