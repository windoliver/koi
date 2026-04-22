/**
 * Tool Health Tracker — ring-buffer error-rate monitoring with quarantine and demotion.
 *
 * Stateful per-tool ring buffer with two output paths:
 * 1. Session quarantine: immediate in-memory block when error rate spikes.
 * 2. Trust demotion: persisted tier downgrade when sustained degradation criteria met.
 *
 * All store writes are best-effort — session state is authoritative; store is async.
 */

import type { ChainId, NodeId, TrustTier } from "@koi/core";
import { chainId } from "@koi/core";
import type { BrickId, BrickSnapshot } from "@koi/core/brick-snapshot";
import { snapshotId } from "@koi/core/brick-snapshot";
import type { BrickArtifact, BrickFitnessMetrics } from "@koi/core/brick-store";
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

  // Per-tool flush suspension circuit breaker — isolated so one tool can't stop others
  consecutiveFlushFailures: number; // mutable
  flushSuspendedUntil: number; // mutable: epoch ms; 0 = not suspended
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
    consecutiveFlushFailures: 0,
    flushSuspendedUntil: 0,
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
  readonly isQuarantined: (toolId: string) => Promise<boolean>;
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
const DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES = 5;
const DEFAULT_FLUSH_SUSPENSION_COOLDOWN_MS = 60_000;

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
    maxConsecutiveFlushFailures = DEFAULT_MAX_CONSECUTIVE_FLUSH_FAILURES,
    flushSuspensionCooldownMs = DEFAULT_FLUSH_SUSPENSION_COOLDOWN_MS,
    onFlushError,
  } = config;

  const demotionCriteria: DemotionCriteria = {
    ...DEFAULT_DEMOTION_CRITERIA,
    ...config.demotionCriteria,
  };

  // Ring must be large enough for both quarantine window and demotion window
  const ringSize = Math.max(windowSize, demotionCriteria.windowSize);

  // Per-tool state map: keyed by toolId
  const stateMap = new Map<string, ToolState>();
  // Session-local brick-level quarantine (covers aliases)
  const quarantinedBricks = new Set<BrickId>();
  // Persisted quarantine cache: brickIds resolved from forgeStore (one load per brickId per session)
  const forgeCheckedBricks = new Set<string>();
  const forgeQuarantinedBricks = new Set<BrickId>();

  function getOrCreate(toolId: string): ToolState {
    let s = stateMap.get(toolId);
    if (s === undefined) {
      s = makeToolState(ringSize);
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

    // Fire-and-forget background flush if threshold reached and this tool is not suspended
    const now2 = clock();
    if (
      now2 >= state.flushSuspendedUntil &&
      shouldFlush(state.flushState, flushThreshold, errorRateDeltaThreshold)
    ) {
      void flushTool(toolId, state, false);
    }
  }

  async function flushTool(
    toolId: string,
    state: ToolState,
    bypassSuspension: boolean,
  ): Promise<void> {
    if (state.flushState.flushing) return;
    state.flushState = { ...state.flushState, flushing: true };

    const bId = resolveBrickId(toolId);
    if (bId === undefined) {
      // Keep dirty=true so deltas are preserved for the next flush attempt
      state.flushState = { ...state.flushState, flushing: false };
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
      const updateResult = await forgeStore.update(bId, { fitness: merged });
      if (!updateResult.ok) {
        state.flushState = { ...state.flushState, flushing: false };
        recordFlushFailure(toolId, state, updateResult.error, bypassSuspension);
        return;
      }

      // Successful flush — reset per-tool circuit breaker and dirty counters
      state.consecutiveFlushFailures = 0;
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
      recordFlushFailure(toolId, state, e, bypassSuspension);
    }
  }

  function recordFlushFailure(
    toolId: string,
    state: ToolState,
    error: unknown,
    bypassSuspension: boolean,
  ): void {
    onFlushError?.(toolId, error);
    if (bypassSuspension) return; // dispose() flushes always proceed regardless
    state.consecutiveFlushFailures += 1;
    if (state.consecutiveFlushFailures >= maxConsecutiveFlushFailures) {
      state.flushSuspendedUntil = clock() + flushSuspensionCooldownMs;
      state.consecutiveFlushFailures = 0;
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

    const headResult = await snapshotChainStore.head(chainIdVal);
    const parentIds: readonly NodeId[] =
      headResult.ok && headResult.value !== undefined ? [headResult.value.nodeId] : [];
    const putResult = await snapshotChainStore.put(chainIdVal, snapshot, parentIds);
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

  function buildDemotionSnapshot(
    bId: BrickId,
    toolId: string,
    metrics: ToolHealthMetrics,
    now: number,
    fromTier: TrustTier,
    toTier: TrustTier,
  ): BrickSnapshot {
    const errorRate = metrics.totalCount > 0 ? metrics.errorCount / metrics.totalCount : 0;
    return {
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
  }

  async function persistDemotion(
    toolId: string,
    bId: BrickId,
    fromTier: TrustTier,
    toTier: TrustTier,
    metrics: ToolHealthMetrics,
    currentBrick: BrickArtifact,
  ): Promise<void> {
    const now = clock();
    const errorRate = metrics.totalCount > 0 ? metrics.errorCount / metrics.totalCount : 0;

    // Persist the new trust tier via full save (BrickUpdate has no trustTier field)
    const saveResult = await forgeStore.save({ ...currentBrick, trustTier: toTier });
    if (!saveResult.ok) {
      const event: HealthTransitionErrorEvent = {
        transition: "demotion",
        phase: "forgeStore",
        brickId: bId,
        error: saveResult.error,
      };
      onHealthTransitionError?.(event);
      return; // abort — don't snapshot or fire callback if authoritative write failed
    }

    // SnapshotChainStore record (best-effort)
    const chainIdVal: ChainId = chainId(bId);
    const snapshot = buildDemotionSnapshot(bId, toolId, metrics, now, fromTier, toTier);

    const headResult = await snapshotChainStore.head(chainIdVal);
    const parentIds: readonly NodeId[] =
      headResult.ok && headResult.value !== undefined ? [headResult.value.nodeId] : [];
    const putResult = await snapshotChainStore.put(chainIdVal, snapshot, parentIds);
    if (putResult !== undefined && !putResult.ok) {
      const event: HealthTransitionErrorEvent = {
        transition: "demotion",
        phase: "snapshot",
        brickId: bId,
        error: putResult.error,
      };
      onHealthTransitionError?.(event);
    }

    // Fire demotion callback only after authoritative write succeeds
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

    async isQuarantined(toolId: string): Promise<boolean> {
      // Fast path: in-session quarantine (no I/O)
      if (stateMap.get(toolId)?.sessionQuarantined === true) return true;
      const bId = resolveBrickId(toolId);
      if (bId === undefined) return false;
      if (quarantinedBricks.has(bId)) return true;
      // Persisted quarantine: check forgeStore once per brickId per session
      if (!forgeCheckedBricks.has(bId)) {
        forgeCheckedBricks.add(bId);
        const loadResult = await forgeStore.load(bId);
        if (loadResult.ok && loadResult.value.lifecycle === "quarantined") {
          forgeQuarantinedBricks.add(bId);
        }
      }
      return forgeQuarantinedBricks.has(bId);
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
        flushSuspended: clock() < state.flushSuspendedUntil,
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
        // Record brick-level quarantine so all aliases of this brick are blocked
        quarantinedBricks.add(bId);
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

      // Load current brick — required to read tier and to persist the updated tier via save()
      const loadResult = await forgeStore.load(bId);
      if (!loadResult.ok) {
        const event: HealthTransitionErrorEvent = {
          transition: "demotion",
          phase: "forgeStore",
          brickId: bId,
          error: loadResult.error,
        };
        onHealthTransitionError?.(event);
        return false;
      }
      const currentBrick = loadResult.value;
      const currentTier: TrustTier = currentBrick.trustTier ?? "local";

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
      await persistDemotion(toolId, bId, currentTier, toTier, metrics, currentBrick);
      return true;
    },

    async dispose(): Promise<void> {
      // Flush all dirty tools; timeout rejects so stalled flushes surface as errors
      const flushes: Promise<void>[] = [];
      for (const [toolId, state] of stateMap) {
        if (state.flushState.dirty && !state.flushState.flushing) {
          const timeoutError = new Error(`Flush timeout after ${flushTimeoutMs}ms`);
          const timeoutPromise = new Promise<void>((_, reject) => {
            setTimeout(() => reject(timeoutError), flushTimeoutMs);
          });
          const flush = Promise.race([flushTool(toolId, state, true), timeoutPromise]).catch(
            (e: unknown) => {
              onFlushError?.(toolId, e);
            },
          );
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
