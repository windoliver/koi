/**
 * Current-model middleware.
 *
 * Holds a mutable `{ current: string }` box and rewrites `request.model` on
 * every model stream call. The box is exposed on the factory's return value
 * so the host (TUI command dispatch) can mutate `box.current` mid-session
 * without rebuilding the middleware chain.
 *
 * When `initialModel === box.current` the middleware is a pure pass-through
 * (calls `next(request)`) so the downstream model-router's fallback chain
 * continues to operate unchanged on unmodified sessions.
 *
 * When `box.current !== initialModel` the user has explicitly picked a model
 * mid-session. The router's target list is frozen at startup and would
 * otherwise override `request.model` with its configured target, so the
 * middleware short-circuits: it streams directly from a freshly-built adapter
 * for `box.current`, bypassing any downstream router. Fallback chains are
 * skipped intentionally — the user's explicit choice wins.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelAdapter,
  ModelChunk,
  ModelRequest,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";

export interface CurrentModelBox {
  current: string;
}

export interface CurrentModelMiddleware {
  readonly middleware: KoiMiddleware;
  readonly box: CurrentModelBox;
}

/**
 * Build a middleware that rewrites `request.model` to `box.current` on every
 * model stream call. Mutate `box.current` to change the model used on the
 * next turn.
 *
 * @param initialModel  The startup model id (baseline; pass-through until changed).
 * @param adapterFactory Builds a fresh `ModelAdapter` for the given model id.
 *                       Called only when the user has picked a different model.
 */
export function createCurrentModelMiddleware(
  initialModel: string,
  adapterFactory: (model: string) => ModelAdapter,
): CurrentModelMiddleware {
  const box: CurrentModelBox = { current: initialModel };

  const middleware: KoiMiddleware = {
    name: "current-model",
    wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      if (box.current === initialModel) {
        return next(request);
      }
      const adapter = adapterFactory(box.current);
      const rewritten: ModelRequest = { ...request, model: box.current };
      return adapter.stream(rewritten);
    },
    describeCapabilities: (): CapabilityFragment | undefined => undefined,
  };

  return { middleware, box };
}
