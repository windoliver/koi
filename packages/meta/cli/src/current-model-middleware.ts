/**
 * Current-model middleware.
 *
 * Holds a mutable `{ current: string }` box and rewrites `request.model` on
 * every model stream call. The box is exposed on the factory's return value
 * so the host (TUI command dispatch) can mutate `box.current` mid-session
 * without rebuilding the middleware chain.
 *
 * Order-wise this middleware belongs innermost (closest to the adapter) so
 * its override wins over any upstream model selection.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
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
 */
export function createCurrentModelMiddleware(initialModel: string): CurrentModelMiddleware {
  const box: CurrentModelBox = { current: initialModel };

  const middleware: KoiMiddleware = {
    name: "current-model",
    wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const rewritten: ModelRequest = { ...request, model: box.current };
      return next(rewritten);
    },
    describeCapabilities: (): CapabilityFragment | undefined => undefined,
  };

  return { middleware, box };
}
