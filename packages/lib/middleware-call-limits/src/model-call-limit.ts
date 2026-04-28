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
  SessionContext,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import type { ModelCallLimitConfig } from "./config.js";
import { createInMemoryCallLimitStore } from "./store.js";
import type { CallLimitStore } from "./types.js";

function modelKey(sessionId: string): string {
  return `model:${sessionId}`;
}

interface ModelLimitState {
  readonly config: ModelCallLimitConfig;
  readonly store: CallLimitStore;
  readonly fired: Set<string>;
  readonly capability: CapabilityFragment;
}

function fireModelLimit(s: ModelLimitState, sessionId: string, count: number): void {
  const cb = s.config.onLimitReached;
  if (cb === undefined) return;
  if (s.fired.has(sessionId)) return;
  s.fired.add(sessionId);
  try {
    cb({ kind: "model", sessionId, count, limit: s.config.limit });
  } catch {
    // observer must not affect limit behavior
  }
}

async function mlWrapModelCall(
  s: ModelLimitState,
  ctx: TurnContext,
  request: ModelRequest,
  next: ModelHandler,
): Promise<ModelResponse> {
  const sessionId = ctx.session.sessionId;
  const r = s.store.incrementIfBelow(modelKey(sessionId), s.config.limit);
  if (!r.allowed) {
    fireModelLimit(s, sessionId, r.current + 1);
    throw KoiRuntimeError.from(
      "RATE_LIMIT",
      `Model call limit exceeded (${String(s.config.limit)})`,
      { retryable: false, context: { sessionId, limit: s.config.limit } },
    );
  }
  return next(request);
}

async function mlOnSessionEnd(s: ModelLimitState, ctx: SessionContext): Promise<void> {
  s.store.reset(modelKey(ctx.sessionId));
  s.fired.delete(ctx.sessionId);
}

export function createModelCallLimitMiddleware(config: ModelCallLimitConfig): KoiMiddleware {
  const state: ModelLimitState = {
    config,
    store: config.store ?? createInMemoryCallLimitStore(),
    fired: new Set(),
    capability: {
      label: "model-call-limit",
      description: `Model calls capped: ${String(config.limit)} per session`,
    },
  };
  return {
    name: "koi:model-call-limit",
    priority: 175,
    phase: "intercept",
    wrapModelCall: (ctx, request, next) => mlWrapModelCall(state, ctx, request, next),
    onSessionEnd: (ctx) => mlOnSessionEnd(state, ctx),
    describeCapabilities: () => state.capability,
  } satisfies KoiMiddleware;
}
