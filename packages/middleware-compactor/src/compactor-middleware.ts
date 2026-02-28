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

import type { ContextPressureTrend, GovernanceVariableContributor } from "@koi/core";
import type { CompactionResult } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelRequest,
  SessionContext,
  TurnContext,
} from "@koi/core/middleware";
import { isContextOverflowError } from "@koi/errors";
import { HEURISTIC_ESTIMATOR } from "@koi/token-estimator";
import { createLlmCompactor } from "./compact.js";
import { createCompactorGovernanceContributor } from "./compactor-governance-contributor.js";
import { wrapWithOverflowRecovery } from "./overflow-recovery.js";
import { createPressureTrendTracker } from "./pressure-trend.js";
import type { CompactorConfig } from "./types.js";
import { COMPACTOR_DEFAULTS } from "./types.js";

// ---------------------------------------------------------------------------
// CompactorMiddleware — extends KoiMiddleware with governance + trend
// ---------------------------------------------------------------------------

export interface CompactorMiddleware extends KoiMiddleware {
  readonly governanceContributor: GovernanceVariableContributor;
  readonly pressureTrend: () => ContextPressureTrend;
  /** Set the one-shot flag — next wrapModelCall/wrapModelStream will force-compact. */
  readonly scheduleCompaction: () => void;
  /** Human-readable occupancy string, e.g. "Context: 62% (124K/200K)". */
  readonly formatOccupancy: () => string;
}

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a middleware that compacts old messages into LLM summaries.
 */
export function createCompactorMiddleware(config: CompactorConfig): CompactorMiddleware {
  const compactor = createLlmCompactor(config);
  const contextWindowSize = config.contextWindowSize ?? COMPACTOR_DEFAULTS.contextWindowSize;
  const overflowMaxRetries =
    config.overflowRecovery?.maxRetries ?? COMPACTOR_DEFAULTS.overflowRecovery.maxRetries ?? 1;
  const hasOverflowRecovery = config.overflowRecovery !== undefined;
  const store = config.store;
  const softTriggerFraction =
    config.trigger?.softTriggerFraction ?? COMPACTOR_DEFAULTS.trigger.softTriggerFraction;
  const tokenEstimator = config.tokenEstimator ?? HEURISTIC_ESTIMATOR;
  const triggerFraction =
    config.trigger?.tokenFraction ?? COMPACTOR_DEFAULTS.trigger.tokenFraction ?? 0.75;
  const compactionThreshold = contextWindowSize * triggerFraction;

  const hasToolEnabled = config.toolEnabled === true;

  // let required: single mutable state record — each mutation returns a new object
  let state: CompactorState = { epoch: 0, lastTokenFraction: 0, cachedRestore: undefined };

  // let justified: one-shot flag set by compact_context tool, consumed by next wrapModelCall
  let forceCompactNext = false;

  // let justified: mutable token count updated per-turn, stale by one turn
  let lastKnownTokenCount = 0;

  const trendTracker = createPressureTrendTracker();
  const contributor = createCompactorGovernanceContributor(
    () => lastKnownTokenCount,
    contextWindowSize,
  );

  async function updateOccupancyTracking(messages: readonly InboundMessage[]): Promise<void> {
    const estimated = await tokenEstimator.estimateMessages(messages);
    lastKnownTokenCount = estimated;
    trendTracker.record(estimated);
  }

  function formatOccupancy(): string {
    const pct =
      contextWindowSize > 0 ? Math.round((lastKnownTokenCount / contextWindowSize) * 100) : 0;
    const currentK = Math.round(lastKnownTokenCount / 1000);
    const limitK = Math.round(contextWindowSize / 1000);
    return `Context: ${String(pct)}% (${String(currentK)}K/${String(limitK)}K)`;
  }

  function formatTrend(): string {
    const trend = trendTracker.compute(compactionThreshold);
    if (trend.sampleCount < 2) return "";
    const growthK = Math.round(trend.growthPerTurn / 1000);
    const base = `, ${String(growthK)}K/turn`;
    if (trend.estimatedTurnsToCompaction > 0) {
      return `${base}, ~${String(trend.estimatedTurnsToCompaction)} turns to compaction`;
    }
    return base;
  }

  async function applyCompaction(request: ModelRequest): Promise<CompactionOutcome> {
    // Apply cached restore from session start (one-shot)
    if (state.cachedRestore !== undefined) {
      const restored = state.cachedRestore;
      state = { ...state, cachedRestore: undefined };
      if (restored.strategy !== "noop" && restored.messages.length > 0) {
        const mergedMessages = [...restored.messages, ...request.messages];
        await updateOccupancyTracking(mergedMessages);
        return {
          request: { ...request, messages: mergedMessages },
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
      // No compaction — record the original messages for occupancy tracking
      await updateOccupancyTracking(request.messages);
      return { request, result: undefined };
    }

    // Increment epoch after successful compaction
    state = { ...state, epoch: state.epoch + 1 };
    // Record post-compaction occupancy (one sample per turn, not two)
    await updateOccupancyTracking(result.messages);

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
    await updateOccupancyTracking(result.messages);
    return { ...request, messages: result.messages };
  }

  return {
    name: "koi:compactor",
    priority: 225,
    governanceContributor: contributor,
    /** Returns pressure trend relative to the compaction trigger threshold (default 75% of window). */
    pressureTrend: () => trendTracker.compute(compactionThreshold),
    scheduleCompaction: () => {
      forceCompactNext = true;
    },
    formatOccupancy,

    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => {
      const occupancy = formatOccupancy();
      const trend = formatTrend();
      const base =
        `Compaction above ${String(contextWindowSize)} tokens` +
        (hasOverflowRecovery ? `, overflow recovery (${String(overflowMaxRetries)} retries)` : "") +
        (store !== undefined ? ", session restore enabled" : "") +
        (hasToolEnabled ? ". Use compact_context tool to trigger early compaction" : "");

      // Soft trigger warning when above soft threshold
      if (softTriggerFraction !== undefined && state.lastTokenFraction >= softTriggerFraction) {
        const pct = Math.round(state.lastTokenFraction * 100);
        return {
          label: "compactor",
          description: `${occupancy}${trend}. ${base}. Context pressure: ${String(pct)}% — consider summarizing completed work phases`,
        };
      }
      return { label: "compactor", description: `${occupancy}${trend}. ${base}` };
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
      // One-shot forced compaction from compact_context tool
      if (forceCompactNext) {
        forceCompactNext = false;
        const forcedRequest = await forceCompactRequest(request);
        return next(forcedRequest);
      }

      const { request: compactedRequest, result } = await applyCompaction(request);
      if (result !== undefined) {
        await persistToStore(ctx, result);
      }

      if (!hasOverflowRecovery) {
        return next(compactedRequest);
      }
      // let justified: mutable binding so recovery can update messages after force-compact
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
      // One-shot forced compaction from compact_context tool
      if (forceCompactNext) {
        forceCompactNext = false;
        const forcedRequest = await forceCompactRequest(request);
        yield* next(forcedRequest);
        return;
      }

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
      // let justified: mutable binding so recovery can update messages after force-compact
      let currentRequest = compactedRequest;
      // let justified: tracks remaining retry attempts for stream overflow recovery
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
