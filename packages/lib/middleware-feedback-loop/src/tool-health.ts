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
import type { BrickFitnessMetrics } from "@koi/core/brick-store";
import { createLatencySampler, mergeSamplers, recordLatency } from "@koi/validation";
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

  // Demotion check: sustained degradation with all criteria gates.
  // Grace period only applies when we have a real promotion timestamp (> 0).
  // lastPromotedAt === 0 means "no promotion observed this session" — skip grace period
  // so a chronically bad tool from a prior session isn't protected indefinitely.
  const graceOk = lastPromotedAt === 0 || now - lastPromotedAt >= demotionCriteria.gracePeriodMs;
  const canDemote =
    nextTrustTier(currentTrustTier) !== undefined &&
    errorRate >= demotionCriteria.errorRateThreshold &&
    totalCount >= demotionCriteria.minSampleSize &&
    graceOk &&
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
  // Tracks the currently running flush so dispose() can await it
  activeFlush: Promise<void> | undefined; // mutable
}

function makeToolState(ringSize: number): ToolState {
  return {
    ring: [],
    ringSize,
    cursor: 0,
    totalRecorded: 0,
    healthState: "healthy",
    sessionQuarantined: false,
    // 0 = no promotion observed this session. Grace period is skipped when 0 so a
    // chronically bad tool from a prior session is not shielded indefinitely.
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
    activeFlush: undefined,
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
  // Tracks in-flight quarantine/demotion persistence promises so dispose() can await them.
  const pendingHealthWrites = new Set<Promise<unknown>>();

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
    // Register the in-progress flush so dispose() can await it even if it started
    // on the hot path before dispose() was called.
    const self = doFlushTool(toolId, state, bypassSuspension);
    state.activeFlush = self.finally(() => {
      state.activeFlush = undefined;
    });
    return state.activeFlush;
  }

  async function doFlushTool(
    toolId: string,
    state: ToolState,
    bypassSuspension: boolean,
  ): Promise<void> {
    const bId = resolveBrickId(toolId);
    if (bId === undefined) {
      // Keep dirty=true so deltas are preserved for the next flush attempt
      state.flushState = { ...state.flushState, flushing: false };
      return;
    }

    // Swap to a fresh accumulator BEFORE any I/O so events recorded during the
    // flush are preserved in the new buffer rather than being zeroed on success.
    const deltas = {
      successCount: state.deltaSinceFlush.successCount,
      errorCount: state.deltaSinceFlush.errorCount,
      latencySampler: state.deltaSinceFlush.sampler,
      lastUsedAt: state.deltaSinceFlush.lastUsedAt,
    };
    state.deltaSinceFlush = {
      successCount: 0,
      errorCount: 0,
      sampler: createLatencySampler(),
      lastUsedAt: 0,
    };

    try {
      // Load existing fitness to merge; capture storeVersion for OCC
      const loadResult = await forgeStore.load(bId);
      const existingFitness: BrickFitnessMetrics | undefined = loadResult.ok
        ? loadResult.value.fitness
        : undefined;
      const merged = computeMergedFitness(deltas, existingFitness);

      const currentErrorRate = state.flushState.errorRateSinceFlush;
      const expectedVersion: number | undefined = loadResult.ok
        ? loadResult.value.storeVersion
        : undefined;
      let updateResult = await forgeStore.update(bId, { fitness: merged, expectedVersion });

      // On OCC conflict, reload and retry once — a concurrent flush beat us
      if (!updateResult.ok && updateResult.error.code === "CONFLICT") {
        const retryLoad = await forgeStore.load(bId);
        const retryFitness = retryLoad.ok ? retryLoad.value.fitness : undefined;
        const retryMerged = computeMergedFitness(deltas, retryFitness);
        const retryVersion = retryLoad.ok ? retryLoad.value.storeVersion : undefined;
        updateResult = await forgeStore.update(bId, {
          fitness: retryMerged,
          expectedVersion: retryVersion,
        });
      }

      if (!updateResult.ok) {
        // Merge the original deltas back into the new accumulator so they are
        // retried on the next flush rather than silently dropped.
        state.deltaSinceFlush = {
          successCount: state.deltaSinceFlush.successCount + deltas.successCount,
          errorCount: state.deltaSinceFlush.errorCount + deltas.errorCount,
          sampler: mergeSamplers(state.deltaSinceFlush.sampler, deltas.latencySampler),
          lastUsedAt: Math.max(state.deltaSinceFlush.lastUsedAt, deltas.lastUsedAt),
        };
        state.flushState = { ...state.flushState, flushing: false };
        recordFlushFailure(toolId, state, updateResult.error, bypassSuspension);
        return;
      }

      // Successful flush — reset circuit breaker; deltaSinceFlush already swapped above.
      state.consecutiveFlushFailures = 0;
      const hasPendingEvents =
        state.deltaSinceFlush.successCount > 0 || state.deltaSinceFlush.errorCount > 0;
      state.flushState = {
        dirty: hasPendingEvents,
        flushing: false,
        invocationsSinceFlush: hasPendingEvents ? state.flushState.invocationsSinceFlush : 0,
        errorRateSinceFlush: currentErrorRate,
        lastFlushedErrorRate: currentErrorRate,
      };
    } catch (e: unknown) {
      // Merge original deltas back so they survive the exception.
      state.deltaSinceFlush = {
        successCount: state.deltaSinceFlush.successCount + deltas.successCount,
        errorCount: state.deltaSinceFlush.errorCount + deltas.errorCount,
        sampler: mergeSamplers(state.deltaSinceFlush.sampler, deltas.latencySampler),
        lastUsedAt: Math.max(state.deltaSinceFlush.lastUsedAt, deltas.lastUsedAt),
      };
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

    // Step 1: ForgeStore update (lifecycle → quarantined) with OCC; retry once on CONFLICT
    const initialLoad = await forgeStore.load(bId);
    // If already quarantined, we're done — idempotent no-op
    if (initialLoad.ok && initialLoad.value.lifecycle === "quarantined") return;
    const initialVersion: number | undefined = initialLoad.ok
      ? initialLoad.value.storeVersion
      : undefined;
    let updateResult = await forgeStore.update(bId, {
      lifecycle: "quarantined",
      expectedVersion: initialVersion,
    });
    if (!updateResult.ok && updateResult.error.code === "CONFLICT") {
      // A concurrent writer updated the brick — reload and retry once
      const retryLoad = await forgeStore.load(bId);
      if (retryLoad.ok && retryLoad.value.lifecycle === "quarantined") return; // already done
      updateResult = await forgeStore.update(bId, {
        lifecycle: "quarantined",
        expectedVersion: retryLoad.ok ? retryLoad.value.storeVersion : undefined,
      });
    }
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
    if (!headResult.ok) {
      onHealthTransitionError?.({
        transition: "quarantine",
        phase: "snapshot",
        brickId: bId,
        error: headResult.error,
      });
      return;
    }
    const parentIds: readonly NodeId[] =
      headResult.value !== undefined ? [headResult.value.nodeId] : [];
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
    currentStoreVersion: number | undefined,
  ): Promise<boolean> {
    const now = clock();
    const errorRate = metrics.totalCount > 0 ? metrics.errorCount / metrics.totalCount : 0;

    // Persist trust tier via targeted update() + OCC; retry once on CONFLICT
    let updateResult = await forgeStore.update(bId, {
      trustTier: toTier,
      expectedVersion: currentStoreVersion,
    });
    if (!updateResult.ok && updateResult.error.code === "CONFLICT") {
      const retryLoad = await forgeStore.load(bId);
      if (!retryLoad.ok) {
        const event: HealthTransitionErrorEvent = {
          transition: "demotion",
          phase: "forgeStore",
          brickId: bId,
          error: retryLoad.error,
        };
        onHealthTransitionError?.(event);
        return false;
      }
      // Idempotent: another writer already applied this exact demotion — treat as success
      // without writing another snapshot or firing callbacks a second time.
      if (retryLoad.value.trustTier === toTier) {
        return true;
      }
      updateResult = await forgeStore.update(bId, {
        trustTier: toTier,
        expectedVersion: retryLoad.value.storeVersion,
      });
    }
    if (!updateResult.ok) {
      const event: HealthTransitionErrorEvent = {
        transition: "demotion",
        phase: "forgeStore",
        brickId: bId,
        error: updateResult.error,
      };
      onHealthTransitionError?.(event);
      return false; // abort — don't snapshot or fire callback if authoritative write failed
    }

    // SnapshotChainStore record (best-effort)
    const chainIdVal: ChainId = chainId(bId);
    const snapshot = buildDemotionSnapshot(bId, toolId, metrics, now, fromTier, toTier);

    const headResult = await snapshotChainStore.head(chainIdVal);
    if (!headResult.ok) {
      onHealthTransitionError?.({
        transition: "demotion",
        phase: "snapshot",
        brickId: bId,
        error: headResult.error,
      });
      // forgeStore write succeeded — fire callback and return success; only snapshot was skipped
      onDemotion?.({
        brickId: bId,
        from: fromTier,
        to: toTier,
        reason: "error_rate",
        evidence: { errorRate, sampleSize: metrics.totalCount },
      });
      return true;
    }
    const parentIds: readonly NodeId[] =
      headResult.value !== undefined ? [headResult.value.nodeId] : [];
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
    return true;
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
      // in-memory set populated by checkAndQuarantine_ this session
      if (quarantinedBricks.has(bId)) return true;
      // Always recheck the store — no caching. Positive or negative caching would delay
      // operator-triggered quarantine changes from taking effect in active sessions.
      const loadResult = await forgeStore.load(bId);
      return loadResult.ok && loadResult.value.lifecycle === "quarantined";
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

    checkAndQuarantine(toolId: string): Promise<boolean> {
      const p = checkAndQuarantine_(toolId);
      // Register so dispose() can await any in-flight persist calls
      pendingHealthWrites.add(p);
      p.finally(() => pendingHealthWrites.delete(p));
      return p;
    },

    checkAndDemote(toolId: string): Promise<boolean> {
      const p = checkAndDemote_(toolId);
      pendingHealthWrites.add(p);
      p.finally(() => pendingHealthWrites.delete(p));
      return p;
    },

    async dispose(): Promise<void> {
      // Bound in-flight quarantine/demotion writes — they hit the same stores as flush.
      // Do not block session teardown indefinitely on a degraded store.
      if (pendingHealthWrites.size > 0) {
        const healthWriteTimeout = new Promise<void>((resolve) => {
          setTimeout(resolve, flushTimeoutMs);
        });
        await Promise.race([
          Promise.allSettled(Array.from(pendingHealthWrites)),
          healthWriteTimeout,
        ]);
      }
      // Collect and await ALL pending flushes: tools already flushing (activeFlush)
      // and tools that are dirty but not yet flushing.
      const flushes: Promise<void>[] = [];
      for (const [toolId, state] of stateMap) {
        if (state.flushState.flushing && state.activeFlush !== undefined) {
          // Background flush started on the hot path has no built-in timeout — bound it here.
          const alreadyRunning = state.activeFlush;
          const t = new Promise<void>((resolve) => setTimeout(resolve, flushTimeoutMs));
          flushes.push(
            Promise.race([alreadyRunning, t]).catch((e: unknown) => {
              onFlushError?.(toolId, e);
            }),
          );
        } else if (state.flushState.dirty) {
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

  async function checkAndQuarantine_(toolId: string): Promise<boolean> {
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
      // Notify caller after session quarantine is confirmed (persist is best-effort)
      config.onQuarantine?.(bId);
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
  }

  async function checkAndDemote_(toolId: string): Promise<boolean> {
    const state = getOrCreate(toolId);
    // Do NOT skip demotion when in-session quarantine is active: quarantine and demotion
    // are independent transitions. Demotion must still be persisted so trust tier survives
    // session rollover and operator unquarantine.

    const bId = resolveBrickId(toolId);
    if (bId === undefined) return false;

    // Load current brick to get trust tier and storeVersion for OCC
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
    const currentTier: TrustTier = loadResult.value.trustTier ?? "local";
    const currentStoreVersion = loadResult.value.storeVersion;

    const metrics = computeWindowMetrics(state, demotionCriteria.windowSize);
    const now = clock();
    const toTier = nextTrustTier(currentTier);
    // Evaluate demotion criteria directly — do NOT use computeHealthAction here.
    // computeHealthAction short-circuits to action:"none" when quarantine is active, but
    // quarantine and demotion are independent: a quarantined tool must still have its trust
    // tier demoted so the lower tier persists across session rollover and unquarantine.
    const errorRate = metrics.totalCount > 0 ? metrics.errorCount / metrics.totalCount : 0;
    // Mirror computeHealthAction: lastPromotedAt === 0 means no promotion observed this
    // session — skip the grace period so chronically bad tools are not shielded.
    const graceOk =
      state.lastPromotedAt === 0 || now - state.lastPromotedAt >= demotionCriteria.gracePeriodMs;
    const canDemote =
      toTier !== undefined &&
      errorRate >= demotionCriteria.errorRateThreshold &&
      metrics.totalCount >= demotionCriteria.minSampleSize &&
      graceOk &&
      now - state.lastDemotedAt >= demotionCriteria.demotionCooldownMs;

    if (!canDemote) return false;
    if (toTier === undefined) return false;

    // Optimistically advance cooldown BEFORE awaiting I/O so concurrent callers observe
    // the updated timestamp and cannot queue a second demotion within the same window.
    // Roll back on failure so the next attempt is not permanently blocked.
    const prevLastDemotedAt = state.lastDemotedAt;
    state.lastDemotedAt = now;

    const demoted = await persistDemotion(
      toolId,
      bId,
      currentTier,
      toTier,
      metrics,
      currentStoreVersion,
    );
    if (!demoted) {
      state.lastDemotedAt = prevLastDemotedAt;
    }
    return demoted;
  }
}
