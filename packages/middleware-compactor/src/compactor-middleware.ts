/**
 * Compactor middleware factory.
 *
 * Wraps the LLM compactor as a KoiMiddleware, compacting message
 * history before each model call/stream when thresholds are exceeded.
 *
 * Priority 225: runs after pay middleware (200), before context-editing (250).
 *
 * Optional features (all disabled by default):
 * - Overflow recovery: catches context-overflow errors, force-compacts, retries
 * - Session restore: loads previous compaction result on session start
 */

import type { CompactionResult } from "@koi/core/context";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelRequest,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import { isContextOverflowError } from "@koi/errors";
import { createLlmCompactor } from "./compact.js";
import { wrapWithOverflowRecovery } from "./overflow-recovery.js";
import type { CompactorConfig } from "./types.js";
import { COMPACTOR_DEFAULTS } from "./types.js";

interface CompactionOutcome {
  readonly request: ModelRequest;
  readonly result: CompactionResult | undefined;
}

/** Mutable state record for the compactor middleware closure. */
interface CompactorState {
  readonly epoch: number;
  readonly lastTokenFraction: number;
  readonly cachedRestore: CompactionResult | undefined;
}

/**
 * Creates a middleware that compacts old messages into LLM summaries.
 */
export function createCompactorMiddleware(config: CompactorConfig): KoiMiddleware {
  const compactor = createLlmCompactor(config);
  const contextWindowSize = config.contextWindowSize ?? COMPACTOR_DEFAULTS.contextWindowSize;
  const overflowMaxRetries =
    config.overflowRecovery?.maxRetries ?? COMPACTOR_DEFAULTS.overflowRecovery.maxRetries ?? 1;
  const hasOverflowRecovery = config.overflowRecovery !== undefined;
  const store = config.store;
  const softTriggerFraction =
    config.trigger?.softTriggerFraction ?? COMPACTOR_DEFAULTS.trigger.softTriggerFraction;

  // let required: single mutable state record — each mutation returns a new object
  let state: CompactorState = { epoch: 0, lastTokenFraction: 0, cachedRestore: undefined };

  async function applyCompaction(request: ModelRequest): Promise<CompactionOutcome> {
    // Apply cached restore from session start (one-shot)
    if (state.cachedRestore !== undefined) {
      const restored = state.cachedRestore;
      state = { ...state, cachedRestore: undefined };
      if (restored.strategy !== "noop" && restored.messages.length > 0) {
        return {
          request: { ...request, messages: [...restored.messages, ...request.messages] },
          result: undefined,
        };
      }
    }

    const result = await compactor.compact(
      request.messages,
      contextWindowSize,
      undefined,
      state.epoch,
    );

    // Cache token fraction for soft trigger (describeCapabilities reads this)
    if (result.originalTokens > 0) {
      const fraction = result.originalTokens / contextWindowSize;
      state = { ...state, lastTokenFraction: fraction };
    }

    if (result.strategy === "noop") {
      return { request, result: undefined };
    }

    // Increment epoch after successful compaction
    state = { ...state, epoch: state.epoch + 1 };

    return { request: { ...request, messages: result.messages }, result };
  }

  /** Persist compaction result to store. Fire-and-forget: errors are swallowed. */
  async function persistToStore(ctx: TurnContext, result: CompactionResult): Promise<void> {
    if (store === undefined) return;
    try {
      await store.save(ctx.session.sessionId, result);
    } catch (_e: unknown) {
      console.warn("[middleware-compactor] store.save() failed (swallowed)");
    }
  }

  async function forceCompactRequest(request: ModelRequest): Promise<ModelRequest> {
    const result = await compactor.forceCompact(
      request.messages,
      contextWindowSize,
      request.model,
      state.epoch,
    );
    return { ...request, messages: result.messages };
  }

  return {
    name: "koi:compactor",
    priority: 225,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => {
      const base =
        `Context compaction above ${String(contextWindowSize)} tokens` +
        (hasOverflowRecovery ? `, overflow recovery (${String(overflowMaxRetries)} retries)` : "") +
        (store !== undefined ? ", session restore enabled" : "");
      if (softTriggerFraction !== undefined && state.lastTokenFraction >= softTriggerFraction) {
        const pct = Math.round(state.lastTokenFraction * 100);
        return {
          label: "compactor",
          description: `${base}. Context pressure: ${String(pct)}% — consider summarizing completed work phases`,
        };
      }
      return { label: "compactor", description: base };
    },

    // Restore previous compaction on session start
    ...(store !== undefined
      ? {
          async onSessionStart(ctx: SessionContext): Promise<void> {
            try {
              const result = await store.load(ctx.sessionId);
              if (result !== undefined && result.strategy !== "noop") {
                state = { ...state, cachedRestore: result };
              }
            } catch (_e: unknown) {
              console.warn(
                "[middleware-compactor] store.load() failed on session start (swallowed)",
              );
            }
          },
        }
      : {}),

    async wrapModelCall(ctx, request, next) {
      const { request: compactedRequest, result } = await applyCompaction(request);
      if (result !== undefined) {
        await persistToStore(ctx, result);
      }

      if (!hasOverflowRecovery) {
        return next(compactedRequest);
      }
      // let required: mutable binding so recovery can update messages after force-compact
      let currentRequest = compactedRequest;
      return wrapWithOverflowRecovery(
        async () => next(currentRequest),
        async () => {
          currentRequest = await forceCompactRequest(currentRequest);
        },
        overflowMaxRetries,
      );
    },

    async *wrapModelStream(ctx, request, next) {
      const { request: compactedRequest, result } = await applyCompaction(request);
      if (result !== undefined) {
        await persistToStore(ctx, result);
      }

      if (!hasOverflowRecovery) {
        yield* next(compactedRequest);
        return;
      }
      // Overflow errors happen before any chunks are streamed (API-level rejection),
      // so catching inside yield* is safe — no partial data to undo.
      // let required: mutable binding so recovery can update messages after force-compact
      let currentRequest = compactedRequest;
      // let required: tracks remaining retry attempts for stream overflow recovery
      let retriesLeft = overflowMaxRetries;
      for (;;) {
        try {
          yield* next(currentRequest);
          return;
        } catch (error: unknown) {
          if (!isContextOverflowError(error) || retriesLeft <= 0) {
            throw error;
          }
          retriesLeft--;
          currentRequest = await forceCompactRequest(currentRequest);
        }
      }
    },
  };
}
