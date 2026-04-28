/**
 * Model call limit middleware — caps total model calls per session.
 *
 * Throws RATE_LIMIT KoiRuntimeError on overflow. Counter is shared across
 * the streaming and non-streaming paths so the cap holds regardless of
 * which terminal the engine selects.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
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

function buildLimitError(s: ModelLimitState, sessionId: string): KoiRuntimeError {
  return KoiRuntimeError.from(
    "RATE_LIMIT",
    `Model call limit exceeded (${String(s.config.limit)})`,
    { retryable: false, context: { sessionId, limit: s.config.limit } },
  );
}

function checkAndIncrement(s: ModelLimitState, sessionId: string): void {
  const r = s.store.incrementIfBelow(modelKey(sessionId), s.config.limit);
  if (!r.allowed) {
    fireModelLimit(s, sessionId, r.current + 1);
    throw buildLimitError(s, sessionId);
  }
}

async function mlWrapModelCall(
  s: ModelLimitState,
  ctx: TurnContext,
  request: ModelRequest,
  next: ModelHandler,
): Promise<ModelResponse> {
  checkAndIncrement(s, ctx.session.sessionId);
  return next(request);
}

function mlWrapModelStream(
  s: ModelLimitState,
  ctx: TurnContext,
  request: ModelRequest,
  next: ModelStreamHandler,
): AsyncIterable<ModelChunk> {
  // Counter must be charged before yielding from the upstream stream;
  // otherwise the streaming path silently bypasses the cap. We count the
  // attempt synchronously (as soon as the iterator is requested) so the
  // limit applies whether the consumer drains the stream or aborts early.
  checkAndIncrement(s, ctx.session.sessionId);
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
    wrapModelStream: (ctx, request, next) => mlWrapModelStream(state, ctx, request, next),
    onSessionEnd: (ctx) => mlOnSessionEnd(state, ctx),
    describeCapabilities: () => state.capability,
  } satisfies KoiMiddleware;
}
