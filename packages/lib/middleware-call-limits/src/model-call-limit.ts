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
  const sessionId = ctx.session.sessionId;
  checkAndIncrement(s, sessionId);
  try {
    return await next(request);
  } catch (err: unknown) {
    // Roll back the attempt. A transient provider failure must not
    // burn session quota — otherwise a short outage burst exhausts
    // the entire model budget and locks the session out for every
    // subsequent recovery attempt, even after the provider is
    // healthy again. Local KoiError emissions (e.g. validators) are
    // also rolled back: the call did not reach the provider.
    s.store.decrement(modelKey(sessionId));
    throw err;
  }
}

function mlWrapModelStream(
  s: ModelLimitState,
  ctx: TurnContext,
  request: ModelRequest,
  next: ModelStreamHandler,
): AsyncIterable<ModelChunk> {
  const sessionId = ctx.session.sessionId;
  checkAndIncrement(s, sessionId);
  // Wrap the upstream iterator so we can roll back the attempt if
  // it terminates without a successful `done` chunk (sync-throw,
  // upstream `error` chunk, consumer abandonment, or async-throw
  // before terminal). Quota is committed only when the stream
  // produces a complete response.
  let upstream: AsyncIterable<ModelChunk>;
  try {
    upstream = next(request);
  } catch (err: unknown) {
    s.store.decrement(modelKey(sessionId));
    throw err;
  }
  return wrapStreamWithRollback(s, sessionId, upstream);
}

async function* wrapStreamWithRollback(
  s: ModelLimitState,
  sessionId: string,
  upstream: AsyncIterable<ModelChunk>,
): AsyncIterable<ModelChunk> {
  let committed = false;
  try {
    for await (const chunk of upstream) {
      if (chunk.kind === "error") {
        // Upstream-classified error chunk: refund the attempt.
        s.store.decrement(modelKey(sessionId));
        committed = true;
        yield chunk;
        return;
      }
      if (chunk.kind === "done") {
        committed = true;
        yield chunk;
        return;
      }
      yield chunk;
    }
    // Iterator exhausted without `done` — upstream truncation. Refund.
    if (!committed) s.store.decrement(modelKey(sessionId));
    committed = true;
  } catch (err: unknown) {
    if (!committed) {
      s.store.decrement(modelKey(sessionId));
      committed = true;
    }
    throw err;
  } finally {
    // Consumer abandoned the iterator (broke early before terminal).
    // Refund — the call did not produce a full response.
    if (!committed) s.store.decrement(modelKey(sessionId));
  }
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
