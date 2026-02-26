/**
 * Model call limit middleware — caps the number of model calls per session.
 *
 * Counts on attempt (before execution). Both "end" and "error" exit behaviors
 * throw RATE_LIMIT with retryable: false.
 *
 * Priority 175: runs before pay (200) and compactor (225).
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import type { ModelCallLimitConfig } from "./config.js";
import { createInMemoryCallLimitStore } from "./store.js";
import type { LimitReachedInfo } from "./types.js";

function modelStoreKey(sessionId: string): string {
  return `model:${sessionId}`;
}

export function createModelCallLimitMiddleware(config: ModelCallLimitConfig): KoiMiddleware {
  const { limit, onLimitReached } = config;
  const store = config.store ?? createInMemoryCallLimitStore();
  const exitBehavior = config.exitBehavior ?? "error";

  // Track sessions where onLimitReached has already fired
  const firedSessions = new Set<string>();

  async function checkAndIncrement(sessionId: string): Promise<void> {
    const key = modelStoreKey(sessionId);
    const count = await store.increment(key);

    if (count > limit) {
      if (onLimitReached && !firedSessions.has(sessionId)) {
        firedSessions.add(sessionId);
        const info: LimitReachedInfo = {
          kind: "model",
          sessionId,
          count,
          limit,
        };
        onLimitReached(info);
      }

      throw KoiRuntimeError.from(
        "RATE_LIMIT",
        `Model call limit exceeded (${limit}). Exit behavior: ${exitBehavior}`,
        {
          retryable: false,
          context: { limit, count, exitBehavior },
        },
      );
    }
  }

  const capabilityFragment: CapabilityFragment = {
    label: "rate-limits",
    description: `Model call limit: ${config.limit} calls per session`,
  };

  return {
    name: "koi:model-call-limit",
    priority: 175,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      await checkAndIncrement(ctx.session.sessionId);
      return next(request);
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      await checkAndIncrement(ctx.session.sessionId);
      yield* next(request);
    },
  };
}
