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

import type { ContextEngine, KoiMiddleware } from "@koi/core";

/**
 * Build a `KoiMiddleware` that resolves the active `ContextEngine` via the
 * provided getter on each call. Returning `undefined` from `getEngine` makes
 * the middleware a passthrough — useful when the slot is empty or the host
 * has not yet attached a controller.
 */
export function createContextEngineSlotMiddleware(
  getEngine: () => ContextEngine | undefined,
): KoiMiddleware {
  return {
    name: "context-engine",
    phase: "resolve",
    priority: 500,
    wrapModelCall: async (ctx, request, next) => {
      const engine = getEngine();
      if (engine === undefined) {
        return next(request);
      }
      const prepared = await engine.prepare(ctx, request.messages);
      return next({ ...request, messages: prepared });
    },
    onAfterTurn: async (ctx) => {
      const engine = getEngine();
      if (engine?.onAfterTurn !== undefined) {
        await engine.onAfterTurn(ctx);
      }
    },
    describeCapabilities: () => undefined,
  };
}
