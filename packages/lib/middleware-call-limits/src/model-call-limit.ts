/**
 * Model call limit middleware — caps total model calls per session.
 *
 * Throws RATE_LIMIT KoiRuntimeError on overflow. No "continue" mode for model
 * calls — there is no useful "blocked response" for the engine to act on.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import type { ModelCallLimitConfig } from "./config.js";
import { createInMemoryCallLimitStore } from "./store.js";

function modelKey(sessionId: string): string {
  return `model:${sessionId}`;
}

export function createModelCallLimitMiddleware(config: ModelCallLimitConfig): KoiMiddleware {
  const store = config.store ?? createInMemoryCallLimitStore();
  const onLimitReached = config.onLimitReached;
  const fired = new Set<string>();

  const capability: CapabilityFragment = {
    label: "model-call-limit",
    description: `Model calls capped: ${String(config.limit)} per session`,
  };

  function fire(sessionId: string, count: number): void {
    if (onLimitReached === undefined) return;
    if (fired.has(sessionId)) return;
    fired.add(sessionId);
    try {
      onLimitReached({ kind: "model", sessionId, count, limit: config.limit });
    } catch {
      // observer must not affect limit behavior
    }
  }

  async function wrapModelCall(
    ctx: TurnContext,
    request: ModelRequest,
    next: ModelHandler,
  ): Promise<ModelResponse> {
    const sessionId = ctx.session.sessionId;
    const r = store.incrementIfBelow(modelKey(sessionId), config.limit);
    if (!r.allowed) {
      fire(sessionId, r.current + 1);
      throw KoiRuntimeError.from(
        "RATE_LIMIT",
        `Model call limit exceeded (${String(config.limit)})`,
        { retryable: false, context: { sessionId, limit: config.limit } },
      );
    }
    return next(request);
  }

  return {
    name: "koi:model-call-limit",
    priority: 175,
    phase: "intercept",
    wrapModelCall,
    describeCapabilities: () => capability,
  } satisfies KoiMiddleware;
}
