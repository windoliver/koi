/**
 * Current-model middleware.
 *
 * Holds a mutable `{ current: string }` box and rewrites `request.model` on
 * every model stream call. The box is exposed on the factory's return value
 * so the host (TUI command dispatch) can mutate `box.current` mid-session
 * without rebuilding the middleware chain.
 *
 * Always pass-through: we call `next({ ...request, model: box.current })`
 * so downstream observe-phase middleware (session-transcript, systemPrompt,
 * goal, plan, trace wrappers) runs normally for every turn. Bypassing
 * `next()` would skip those observers and silently drop transcript entries
 * and telemetry spans for switched-model turns.
 *
 * Interaction with model-router: when `KOI_FALLBACK_MODEL` is set, the
 * downstream model-router picks from its frozen target list and overrides
 * `request.model` with the target's configured model id. In that case the
 * user's picked model will NOT propagate to the HTTP call — document this
 * limitation at the call site and consider disabling the picker, or
 * rebuilding the router on switch, as a follow-up.
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
