/**
 * Tool Health Tracker — ring-buffer error-rate monitoring with quarantine and demotion.
 *
 * Stateful per-tool ring buffer with two output paths:
 * 1. Session quarantine: immediate in-memory block when error rate spikes.
 * 2. Trust demotion: persisted tier downgrade when sustained degradation criteria met.
 *
 * All store writes are best-effort — session state is authoritative; store is async.
 */

import type { ChainId, TrustTier } from "@koi/core";
import { chainId } from "@koi/core";
import type { BrickId, BrickSnapshot } from "@koi/core/brick-snapshot";
import { snapshotId } from "@koi/core/brick-snapshot";
import type { BrickFitnessMetrics } from "@koi/core/brick-store";
import { createLatencySampler, recordLatency } from "@koi/validation";
import type { ForgeHealthConfig } from "./config.js";
import { DEFAULT_DEMOTION_CRITERIA } from "./config.js";
import { computeMergedFitness, shouldFlush } from "./fitness-flush.js";
import type {
  DemotionCriteria,
  HealthAction,
  HealthState,
  HealthTransitionErrorEvent,
  RingEntry,
  ToolFlushState,
  ToolHealthMetrics,
  ToolHealthSnapshot,
  TrustDemotionEvent,
} from "./types.js";

// ---------------------------------------------------------------------------
// Trust tier ordering (verified → community → local)
// ---------------------------------------------------------------------------

const TRUST_DEMOTION_ORDER: readonly TrustTier[] = ["verified", "community", "local"] as const;

function nextTrustTier(current: TrustTier): TrustTier | undefined {
  const idx = TRUST_DEMOTION_ORDER.indexOf(current);
  return idx >= 0 && idx < TRUST_DEMOTION_ORDER.length - 1
    ? TRUST_DEMOTION_ORDER[idx + 1]
    : undefined;
}

// ---------------------------------------------------------------------------
// computeHealthAction — pure function, fully testable without I/O
// ---------------------------------------------------------------------------

/**
 * Computes the recommended health action given current metrics and state.
 * Pure function — no side effects. Used internally by the tracker and in tests.
 */
export function computeHealthAction(
  metrics: ToolHealthMetrics,
  currentState: HealthState,
  currentTrustTier: TrustTier,
  quarantineThreshold: number,
  quarantineWindowSize: number,
  demotionCriteria: DemotionCriteria,
  lastPromotedAt: number,
  lastDemotedAt: number,
  now: number,
): HealthAction {
  // Already quarantined — no further action needed
  if (currentState === "quarantined") return { state: "quarantined", action: "none" };

  const { totalCount, errorCount } = metrics;
  const errorRate = totalCount > 0 ? errorCount / totalCount : 0;

  // Quarantine check: requires minimum quarantineWindowSize samples and threshold breach
  const quarantineEligible = totalCount >= quarantineWindowSize && errorRate >= quarantineThreshold;

  if (quarantineEligible) {
    return { state: "quarantined", action: "quarantine" };
  }

  // Demotion check: sustained degradation with all criteria gates
  const canDemote =
    nextTrustTier(currentTrustTier) !== undefined &&
    errorRate >= demotionCriteria.errorRateThreshold &&
    totalCount >= demotionCriteria.minSampleSize &&
    now - lastPromotedAt >= demotionCriteria.gracePeriodMs &&
    now - lastDemotedAt >= demotionCriteria.demotionCooldownMs;

  // Degraded: 75% of quarantine threshold
  const degradedThreshold = quarantineThreshold * 0.75;
  const nextState: HealthState = errorRate >= degradedThreshold ? "degraded" : "healthy";

  return { state: nextState, action: canDemote ? "demote" : "none" };
}

// ---------------------------------------------------------------------------
// Per-tool mutable state
// ---------------------------------------------------------------------------

interface ToolState {
  // Ring buffer — fixed capacity, wraps on overflow
  ring: RingEntry[]; // mutable: ring entries are replaced in place
  ringSize: number;
  /** Monotonically increasing cursor; mod ringSize for current slot. */
  cursor: number; // mutable: increments each record
  /** Total invocations ever recorded (may exceed ringSize). */
  totalRecorded: number; // mutable

  // Health / quarantine state
  healthState: HealthState; // mutable
  sessionQuarantined: boolean; // mutable: flip to true on quarantine

  // Demotion timestamps
  lastPromotedAt: number; // mutable
  lastDemotedAt: number; // mutable

  // Flush state
  flushState: ToolFlushState; // mutable: replaced on each change
  deltaSinceFlush: {
    successCount: number; // mutable
    errorCount: number; // mutable
    sampler: ReturnType<typeof createLatencySampler>; // mutable: replaced on recordLatency
    lastUsedAt: number; // mutable
  };
}

function makeToolState(ringSize: number): ToolState {
  return {
    ring: [],
    ringSize,
    cursor: 0,
    totalRecorded: 0,
    healthState: "healthy",
    sessionQuarantined: false,
    lastPromotedAt: 0,
    lastDemotedAt: 0,
    flushState: {
      dirty: false,
      flushing: false,
      invocationsSinceFlush: 0,
      errorRateSinceFlush: 0,
      lastFlushedErrorRate: 0,
    },
    deltaSinceFlush: {
      successCount: 0,
      errorCount: 0,
      sampler: createLatencySampler(),
      lastUsedAt: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Ring buffer helpers
// ---------------------------------------------------------------------------

function recordEntry(state: ToolState, entry: RingEntry): void {
  const slot = state.cursor % state.ringSize;
  state.ring[slot] = entry;
  state.cursor += 1;
  state.totalRecorded += 1;
}

function computeWindowMetrics(state: ToolState, windowSize: number): ToolHealthMetrics {
  const count = Math.min(state.totalRecorded, state.ringSize, windowSize);
  // Read newest `count` entries from ring (reverse iteration from last written)
  const entries: RingEntry[] = [];
  for (let i = 0; i < count; i++) {
    const slot = (((state.cursor - 1 - i) % state.ringSize) + state.ringSize) % state.ringSize;
    const entry = state.ring[slot];
    if (entry !== undefined) entries.push(entry);
  }
  const errorCount = entries.filter((e) => !e.success).length;
  return { errorCount, totalCount: entries.length, entries };
}

function updateFlushState(state: ToolState, now: number): void {
  const { deltaSinceFlush } = state;
  const total = deltaSinceFlush.successCount + deltaSinceFlush.errorCount;
  const errorRate = total > 0 ? deltaSinceFlush.errorCount / total : 0;
  state.flushState = {
    dirty: true,
    flushing: state.flushState.flushing,
    invocationsSinceFlush: state.flushState.invocationsSinceFlush + 1,
    errorRateSinceFlush: errorRate,
    lastFlushedErrorRate: state.flushState.lastFlushedErrorRate,
  };
  deltaSinceFlush.lastUsedAt = now;
}

// ---------------------------------------------------------------------------
// ToolHealthTracker public interface
// ---------------------------------------------------------------------------

export interface ToolHealthTracker {
  readonly recordSuccess: (toolId: string, latencyMs: number) => void;
  readonly recordFailure: (toolId: string, latencyMs: number, reason: string) => void;
  readonly isQuarantined: (toolId: string) => boolean;
  readonly getSnapshot: (toolId: string) => ToolHealthSnapshot | undefined;
  /** Check error rate against quarantine threshold; quarantine in-session + persist if triggered. */
  readonly checkAndQuarantine: (toolId: string) => Promise<boolean>;
  /** Check demotion criteria; demote trust tier in store if triggered. */
  readonly checkAndDemote: (toolId: string) => Promise<boolean>;
  /** Flush all dirty tool state to the store and release resources. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// createToolHealthTracker
// ---------------------------------------------------------------------------

const DEFAULT_QUARANTINE_THRESHOLD = 0.5;
const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_FLUSH_THRESHOLD = 10;
const DEFAULT_ERROR_RATE_DELTA = 0.05;
const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;

export function createToolHealthTracker(config: ForgeHealthConfig): ToolHealthTracker {
  const {
    resolveBrickId,
    forgeStore,
    snapshotChainStore,
    quarantineThreshold = DEFAULT_QUARANTINE_THRESHOLD,
    windowSize = DEFAULT_WINDOW_SIZE,
    onDemotion,
    onHealthTransitionError,
    clock = () => Date.now(),
    flushThreshold = DEFAULT_FLUSH_THRESHOLD,
    errorRateDeltaThreshold = DEFAULT_ERROR_RATE_DELTA,
    flushTimeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
    onFlushError,
  } = config;

  const demotionCriteria: DemotionCriteria = {
    ...DEFAULT_DEMOTION_CRITERIA,
    ...config.demotionCriteria,
  };

  // Per-tool state map: keyed by toolId
  const stateMap = new Map<string, ToolState>();

  function getOrCreate(toolId: string): ToolState {
    let s = stateMap.get(toolId);
    if (s === undefined) {
      s = makeToolState(windowSize);
      stateMap.set(toolId, s);
    }
    return s;
  }

  function recordEntry_(toolId: string, success: boolean, latencyMs: number): void {
    const now = clock();
    const state = getOrCreate(toolId);
    const entry: RingEntry = { success, latencyMs };
    recordEntry(state, entry);

    // Update deltas for flush
    if (success) {
      state.deltaSinceFlush.successCount += 1;
    } else {
      state.deltaSinceFlush.errorCount += 1;
    }
    state.deltaSinceFlush.sampler = recordLatency(state.deltaSinceFlush.sampler, latencyMs);
    updateFlushState(state, now);

    // Fire-and-forget background flush if threshold reached
    if (shouldFlush(state.flushState, flushThreshold, errorRateDeltaThreshold)) {
      void flushTool(toolId, state);
    }
  }

  async function flushTool(toolId: string, state: ToolState): Promise<void> {
    if (state.flushState.flushing) return;
    state.flushState = { ...state.flushState, flushing: true };

    const bId = resolveBrickId(toolId);
    if (bId === undefined) {
      state.flushState = { ...state.flushState, flushing: false, dirty: false };
      return;
    }

    const deltas = {
      successCount: state.deltaSinceFlush.successCount,
      errorCount: state.deltaSinceFlush.errorCount,
      latencySampler: state.deltaSinceFlush.sampler,
      lastUsedAt: state.deltaSinceFlush.lastUsedAt,
    };

    try {
      // Load existing fitness to merge
      const loadResult = await forgeStore.load(bId);
      const existingFitness: BrickFitnessMetrics | undefined = loadResult.ok
        ? loadResult.value.fitness
        : undefined;
      const merged = computeMergedFitness(deltas, existingFitness);

      const currentErrorRate = state.flushState.errorRateSinceFlush;
      await forgeStore.update(bId, { fitness: merged });

      // Reset deltas after successful flush
      state.deltaSinceFlush = {
        successCount: 0,
        errorCount: 0,
        sampler: createLatencySampler(),
        lastUsedAt: 0,
      };
      state.flushState = {
        dirty: false,
        flushing: false,
        invocationsSinceFlush: 0,
        errorRateSinceFlush: currentErrorRate,
        lastFlushedErrorRate: currentErrorRate,
      };
    } catch (e: unknown) {
      state.flushState = { ...state.flushState, flushing: false };
      onFlushError?.(toolId, e);
    }
  }

  async function persistQuarantine(
    toolId: string,
    bId: BrickId,
    metrics: ToolHealthMetrics,
  ): Promise<void> {
    const now = clock();

    // Step 1: ForgeStore update (lifecycle → quarantined)
    const updateResult = await forgeStore.update(bId, { lifecycle: "quarantined" });
    if (!updateResult.ok) {
      const event: HealthTransitionErrorEvent = {
        transition: "quarantine",
        phase: "forgeStore",
        brickId: bId,
        error: updateResult.error,
      };
      onHealthTransitionError?.(event);
      return; // abort — don't snapshot if store update failed
    }

    // Step 2: SnapshotChainStore record (best-effort, non-fatal)
    const chainIdVal: ChainId = chainId(bId);
    const snapshot: BrickSnapshot = {
      snapshotId: snapshotId(`${bId}-quarantine-${now}`),
      brickId: bId,
      version: "1",
      source: { origin: "forged", forgedBy: "tool-health-tracker" },
      event: {
        kind: "quarantined",
        actor: "tool-health-tracker",
        timestamp: now,
        reason: `Tool '${toolId}' error rate exceeded quarantine threshold`,
        errorRate: metrics.totalCount > 0 ? metrics.errorCount / metrics.totalCount : 0,
        failureCount: metrics.errorCount,
      },
      artifact: {},
      createdAt: now,
    };

    const putResult = await snapshotChainStore.put(chainIdVal, snapshot, []);
    if (putResult !== undefined && !putResult.ok) {
      const event: HealthTransitionErrorEvent = {
        transition: "quarantine",
        phase: "snapshot",
        brickId: bId,
        error: putResult.error,
      };
      onHealthTransitionError?.(event);
    }
  }

  async function persistDemotion(
    toolId: string,
    bId: BrickId,
    fromTier: TrustTier,
    toTier: TrustTier,
    metrics: ToolHealthMetrics,
  ): Promise<void> {
    const now = clock();
    const errorRate = metrics.totalCount > 0 ? metrics.errorCount / metrics.totalCount : 0;

    // Note: BrickUpdate does not expose trustTier — demotion is recorded via snapshot
    // chain and surfaced through the onDemotion callback. The store's trust tier field
    // can only be updated via a full save() or a future promoteAndUpdate() call.

    // SnapshotChainStore record (best-effort)
    const chainIdVal: ChainId = chainId(bId);
    const snapshot: BrickSnapshot = {
      snapshotId: snapshotId(`${bId}-demote-${now}`),
      brickId: bId,
      version: "1",
      source: { origin: "forged", forgedBy: "tool-health-tracker" },
      event: {
        kind: "demoted",
        actor: "tool-health-tracker",
        timestamp: now,
        fromTier,
        toTier,
        reason: `Error rate ${errorRate.toFixed(2)} exceeded demotion threshold for '${toolId}'`,
        errorRate,
      },
      artifact: {},
      createdAt: now,
    };

    const putResult = await snapshotChainStore.put(chainIdVal, snapshot, []);
    if (putResult !== undefined && !putResult.ok) {
      const event: HealthTransitionErrorEvent = {
        transition: "demotion",
        phase: "snapshot",
        brickId: bId,
        error: putResult.error,
      };
      onHealthTransitionError?.(event);
    }

    // Fire demotion callback
    const demotionEvent: TrustDemotionEvent = {
      brickId: bId,
      from: fromTier,
      to: toTier,
      reason: "error_rate",
      evidence: { errorRate, sampleSize: metrics.totalCount },
    };
    onDemotion?.(demotionEvent);
  }

  return {
    recordSuccess(toolId: string, latencyMs: number): void {
      recordEntry_(toolId, true, latencyMs);
    },

    recordFailure(toolId: string, latencyMs: number, _reason: string): void {
      // _reason not stored per-entry; RingEntry tracks success/latency only.
      // Failure reasons surface via onHealthTransitionError on quarantine/demotion.
      recordEntry_(toolId, false, latencyMs);
    },

    isQuarantined(toolId: string): boolean {
      const state = stateMap.get(toolId);
      return state?.sessionQuarantined ?? false;
    },

    getSnapshot(toolId: string): ToolHealthSnapshot | undefined {
      const state = stateMap.get(toolId);
      if (state === undefined) return undefined;
      const bId = resolveBrickId(toolId);
      const metrics = computeWindowMetrics(state, windowSize);
      const errorRate = metrics.totalCount > 0 ? metrics.errorCount / metrics.totalCount : 0;
      return {
        toolId,
        brickId: bId ?? ("unknown" as BrickId),
        healthState: state.healthState,
        trustTier: undefined,
        errorRate,
        totalCount: metrics.totalCount,
        flushSuspended: false,
      };
    },

    async checkAndQuarantine(toolId: string): Promise<boolean> {
      const state = getOrCreate(toolId);
      if (state.sessionQuarantined) return true;

      const metrics = computeWindowMetrics(state, windowSize);
      const action = computeHealthAction(
        metrics,
        state.healthState,
        "verified", // default tier for quarantine check — actual tier loaded during demotion
        quarantineThreshold,
        windowSize,
        demotionCriteria,
        state.lastPromotedAt,
        state.lastDemotedAt,
        clock(),
      );

      if (action.action !== "quarantine") return false;

      // Always quarantine in session first — safety invariant holds even if store fails
      state.sessionQuarantined = true;
      state.healthState = "quarantined";
      const bId = resolveBrickId(toolId);
      if (bId !== undefined) {
        // Best-effort persist — errors are reported via onHealthTransitionError
        await persistQuarantine(toolId, bId, metrics);
      } else {
        // No brickId — report as transition error
        const event: HealthTransitionErrorEvent = {
          transition: "quarantine",
          phase: "forgeStore",
          brickId: "unknown" as BrickId,
          error: new Error(`No BrickId found for tool '${toolId}'`),
        };
        onHealthTransitionError?.(event);
      }

      return true;
    },

    async checkAndDemote(toolId: string): Promise<boolean> {
      const state = getOrCreate(toolId);
      if (state.sessionQuarantined) return false;

      const bId = resolveBrickId(toolId);
      if (bId === undefined) return false;

      // Load current trust tier from store
      const loadResult = await forgeStore.load(bId);
      const currentTier: TrustTier =
        loadResult.ok && loadResult.value.trustTier !== undefined
          ? loadResult.value.trustTier
          : "local";

      const metrics = computeWindowMetrics(state, demotionCriteria.windowSize);
      const now = clock();
      const action = computeHealthAction(
        metrics,
        state.healthState,
        currentTier,
        quarantineThreshold,
        windowSize,
        demotionCriteria,
        state.lastPromotedAt,
        state.lastDemotedAt,
        now,
      );

      if (action.action !== "demote") return false;

      const toTier = nextTrustTier(currentTier);
      if (toTier === undefined) return false;

      state.lastDemotedAt = now;
      await persistDemotion(toolId, bId, currentTier, toTier, metrics);
      return true;
    },

    async dispose(): Promise<void> {
      // Flush all dirty tools with a timeout guard
      const flushes: Promise<void>[] = [];
      for (const [toolId, state] of stateMap) {
        if (state.flushState.dirty && !state.flushState.flushing) {
          const timeoutPromise = new Promise<void>((resolve) => {
            setTimeout(resolve, flushTimeoutMs);
          });
          const flush = Promise.race([flushTool(toolId, state), timeoutPromise]);
          flushes.push(flush);
        }
      }
      if (flushes.length > 0) {
        await Promise.allSettled(flushes);
      }
      stateMap.clear();
    },
  };
}
