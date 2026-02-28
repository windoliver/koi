/**
 * Squash companion middleware — applies pending squashes before model calls.
 *
 * Priority 220: runs before compactor (225), so squash applies first
 * and the compactor sees the already-reduced context.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelStreamHandler,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import type { PendingQueue } from "./types.js";

/**
 * Creates the companion middleware that drains pending squashes before model calls.
 *
 * @param pendingQueue - Encapsulated queue shared with the squash tool
 */
export function createSquashMiddleware(pendingQueue: PendingQueue): KoiMiddleware {
  function drainAndReplace(request: ModelRequest): ModelRequest {
    if (pendingQueue.length === 0) {
      return request;
    }

    // Drain all pending — most recent squash wins for message array
    const pending = pendingQueue.drain();
    const last = pending[pending.length - 1];
    if (last === undefined) {
      return request;
    }

    return { ...request, messages: last.result.messages };
  }

  return {
    name: "koi:squash",
    priority: 220,

    describeCapabilities(_ctx: TurnContext): CapabilityFragment | undefined {
      return {
        label: "squash",
        description:
          pendingQueue.length > 0
            ? `Phase-boundary compression: ${String(pendingQueue.length)} pending squash(es)`
            : "Phase-boundary compression available via squash tool",
      };
    },

    wrapModelCall(_ctx: TurnContext, request: ModelRequest, next: ModelHandler) {
      return next(drainAndReplace(request));
    },

    async *wrapModelStream(
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): ReturnType<ModelStreamHandler> {
      yield* next(drainAndReplace(request));
    },

    async onSessionEnd(_ctx: SessionContext): Promise<void> {
      pendingQueue.clear();
    },
  };
}
