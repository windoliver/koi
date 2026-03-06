/**
 * Tool health tracker — ring buffer + quarantine/demotion state machine.
 *
 * Adapts circuit breaker pattern from @koi/model-router.
 * Quarantine is terminal (agent must re-forge).
 * Demotion lowers trust tier by one step on sustained error rate.
 */

import type { BrickSnapshot, TrustTier } from "@koi/core";
import { brickId, snapshotId } from "@koi/core";
import type { ForgeHealthConfig } from "./config.js";
import { computeMergedFitness, shouldFlush } from "./fitness-flush.js";
import type {
  DemotionCriteria,
  ToolFailureRecord,
  ToolHealthMetrics,
  ToolHealthSnapshot,
  ToolHealthState,
  TrustDemotionEvent,
} from "./types.js";
import { DEFAULT_DEMOTION_CRITERIA } from "./types.js";

const DEFAULT_QUARANTINE_THRESHOLD = 0.5;
const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_MAX_RECENT_FAILURES = 5;
const DEFAULT_FLUSH_THRESHOLD = 10;
const DEFAULT_ERROR_RATE_DELTA_THRESHOLD = 0.05;

/** ToolHealthTracker interface — per-tool success/failure/latency tracking with quarantine and demotion. */
export interface ToolHealthTracker {
  readonly recordSuccess: (toolId: string, latencyMs: number) => void;
  readonly recordFailure: (toolId: string, latencyMs: number, error: string) => void;
  readonly getSnapshot: (toolId: string) => ToolHealthSnapshot | undefined;
  readonly isQuarantined: (toolId: string) => boolean;
  /** Async quarantine check — falls back to ForgeStore when tool isn't in local map. */
  readonly isQuarantinedAsync: (toolId: string) => Promise<boolean>;
  readonly checkAndQuarantine: (toolId: string) => Promise<boolean>;
  readonly checkAndDemote: (toolId: string) => Promise<boolean>;
  readonly getAllSnapshots: () => readonly ToolHealthSnapshot[];
  /** Returns true if the tool's fitness data should be flushed to ForgeStore. */
  readonly shouldFlushTool: (toolId: string) => boolean;
  /** Flushes a single tool's fitness data to ForgeStore. */
  readonly flushTool: (toolId: string) => Promise<void>;
  /** Flushes all dirty tools' fitness data to ForgeStore. */
  readonly flush: () => Promise<void>;
  /** Final drain: flushes all dirty tools, then clears internal state. */
  readonly dispose: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal per-tool mutable state (encapsulated — never exposed)
// ---------------------------------------------------------------------------

interface RingEntry {
  readonly success: boolean;
  readonly latencyMs: number;
}

/** Per-tool flush state for fitness persistence (read-only snapshot). */
export interface ToolFlushState {
  readonly totalSuccesses: number;
  readonly totalFailures: number;
  readonly latencyBuffer: readonly number[];
  readonly latencyTotalCount: number;
  readonly dirty: boolean;
  readonly flushing: boolean;
  readonly invocationsSinceFlush: number;
  readonly lastFlushedSuccesses: number;
  readonly lastFlushedFailures: number;
  readonly lastFlushedErrorRate: number;
}

/** Internal mutable flush state — encapsulated within the tracker. */
interface MutableFlushState {
  totalSuccesses: number;
  totalFailures: number;
  readonly latencyBuffer: number[];
  latencyTotalCount: number;
  dirty: boolean;
  flushing: boolean;
  invocationsSinceFlush: number;
  lastFlushedSuccesses: number;
  lastFlushedFailures: number;
  lastFlushedErrorRate: number;
}

interface ToolState {
  // let: ring buffer mutated on each record call
  readonly ring: Array<RingEntry | undefined>;
  /** let: write cursor — increments unboundedly, modulo ringSize for slot. */
  ringIndex: number;
  /** let: number of filled slots in the ring, capped at ringSize. */
  filledSlots: number;
  /** let: state machine — healthy → degraded → quarantined (terminal). */
  state: ToolHealthState;
  // let: capped failure records, mutated via push/shift
  readonly recentFailures: ToolFailureRecord[];
  /** let: timestamp of the most recent record call. */
  lastUpdatedAt: number;
  /** let: cached trust tier (loaded from store on first check, invalidated on demotion). */
  trustTier: TrustTier | undefined;
  /** let: cached lastPromotedAt from store. */
  lastPromotedAt: number;
  /** let: cached lastDemotedAt from store. */
  lastDemotedAt: number;
  /** Flush state for fitness persistence bridge. */
  readonly flushState: MutableFlushState;
}

function createToolState(ringSize: number): ToolState {
  return {
    ring: new Array<RingEntry | undefined>(ringSize).fill(undefined),
    ringIndex: 0,
    filledSlots: 0,
    state: "healthy",
    recentFailures: [],
    lastUpdatedAt: 0,
    trustTier: undefined,
    lastPromotedAt: 0,
    lastDemotedAt: 0,
    flushState: {
      totalSuccesses: 0,
      totalFailures: 0,
      latencyBuffer: [],
      latencyTotalCount: 0,
      dirty: false,
      flushing: false,
      invocationsSinceFlush: 0,
      lastFlushedSuccesses: 0,
      lastFlushedFailures: 0,
      lastFlushedErrorRate: 0,
    },
  };
}

/**
 * Compute metrics over the last N entries of the ring buffer.
 * Used for dual-window queries: quarantine window vs demotion window.
 */
function computeMetricsForWindow(
  ring: ReadonlyArray<RingEntry | undefined>,
  filledSlots: number,
  ringIndex: number,
  ringSize: number,
  windowSize: number,
): ToolHealthMetrics {
  const effectiveWindow = Math.min(windowSize, filledSlots);
  if (effectiveWindow === 0) {
    return { successRate: 1, errorRate: 0, usageCount: 0, avgLatencyMs: 0 };
  }

  // let: accumulators
  let successes = 0;
  let totalLatency = 0;

  // Walk backwards from the most recent entry
  for (let offset = 1; offset <= effectiveWindow; offset++) {
    const idx = (((ringIndex - offset) % ringSize) + ringSize) % ringSize;
    const entry = ring[idx];
    if (entry !== undefined) {
      if (entry.success) successes++;
      totalLatency += entry.latencyMs;
    }
  }

  const successRate = successes / effectiveWindow;
  return {
    successRate,
    errorRate: 1 - successRate,
    usageCount: effectiveWindow,
    avgLatencyMs: totalLatency / effectiveWindow,
  };
}

// ---------------------------------------------------------------------------
// Health action computation (pure, exported for testing)
// ---------------------------------------------------------------------------

/** Result of computing health state + recommended action. */
export interface HealthAction {
  readonly state: ToolHealthState;
  readonly action: "none" | "demote" | "quarantine";
}

/**
 * Pure function to compute the health state and recommended action.
 *
 * Evaluates quarantine first (fast kill), then demotion (slower, needs more evidence).
 */
export function computeHealthAction(
  quarantineMetrics: ToolHealthMetrics,
  demotionMetrics: ToolHealthMetrics,
  currentState: ToolHealthState,
  currentTrustTier: TrustTier,
  quarantineThreshold: number,
  quarantineWindowSize: number,
  demotionCriteria: DemotionCriteria,
  lastPromotedAt: number,
  lastDemotedAt: number,
  now: number,
): HealthAction {
  // Terminal state — no further actions
  if (currentState === "quarantined") {
    return { state: "quarantined", action: "none" };
  }

  // Quarantine check: higher threshold, smaller window, fast kill
  if (
    quarantineMetrics.errorRate >= quarantineThreshold &&
    quarantineMetrics.usageCount >= quarantineWindowSize
  ) {
    return { state: "quarantined", action: "quarantine" };
  }

  // Demotion check: lower threshold, larger window, more evidence needed
  // Skip if already at floor (sandbox)
  if (currentTrustTier !== "sandbox") {
    // Grace period: don't demote within N ms of a promotion
    const inGracePeriod = now - lastPromotedAt < demotionCriteria.gracePeriodMs;
    // Cooldown: don't demote again within N ms of last demotion
    const inCooldown = now - lastDemotedAt < demotionCriteria.demotionCooldownMs;

    if (!inGracePeriod && !inCooldown) {
      if (
        demotionMetrics.errorRate >= demotionCriteria.errorRateThreshold &&
        demotionMetrics.usageCount >= demotionCriteria.minSampleSize
      ) {
        return { state: "degraded", action: "demote" };
      }
    }
  }

  // Warning zone: approaching quarantine threshold
  if (quarantineMetrics.errorRate >= quarantineThreshold * 0.75) {
    return { state: "degraded", action: "none" };
  }

  return { state: "healthy", action: "none" };
}

// ---------------------------------------------------------------------------
// Trust tier demotion target (one step down)
// ---------------------------------------------------------------------------

const DEMOTION_TARGET: Readonly<Record<TrustTier, TrustTier | undefined>> = {
  promoted: "verified",
  verified: "sandbox",
  sandbox: undefined,
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Creates a ToolHealthTracker with ring buffer, quarantine, and demotion support. */
export function createToolHealthTracker(config: ForgeHealthConfig): ToolHealthTracker {
  const quarantineThreshold = config.quarantineThreshold ?? DEFAULT_QUARANTINE_THRESHOLD;
  const quarantineWindowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE;
  const maxRecent = config.maxRecentFailures ?? DEFAULT_MAX_RECENT_FAILURES;
  const clock = config.clock ?? Date.now;
  const flushThreshold = config.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
  const errorRateDeltaThreshold =
    config.errorRateDeltaThreshold ?? DEFAULT_ERROR_RATE_DELTA_THRESHOLD;
  const demotionCriteria: DemotionCriteria = {
    ...DEFAULT_DEMOTION_CRITERIA,
    ...config.demotionCriteria,
  };

  // Ring size = max(quarantine window, demotion window) to support dual-window queries
  const ringSize = Math.max(quarantineWindowSize, demotionCriteria.windowSize);

  // let: per-tool state map — mutated on record calls
  const tools = new Map<string, ToolState>();

  function getOrCreate(toolId: string): ToolState {
    const existing = tools.get(toolId);
    if (existing !== undefined) return existing;
    const ts = createToolState(ringSize);
    tools.set(toolId, ts);
    return ts;
  }

  /** Max latency buffer size before reservoir sampling kicks in. */
  const LATENCY_BUFFER_CAP = 200;

  function record(toolId: string, success: boolean, latencyMs: number): void {
    const ts = getOrCreate(toolId);
    if (ts.state === "quarantined") return;

    ts.ring[ts.ringIndex % ringSize] = { success, latencyMs };
    ts.ringIndex++;
    if (ts.filledSlots < ringSize) ts.filledSlots++;
    ts.lastUpdatedAt = clock();

    // Cumulative tracking for fitness flush
    const fs = ts.flushState;
    if (success) {
      fs.totalSuccesses++;
    } else {
      fs.totalFailures++;
    }
    fs.invocationsSinceFlush++;
    fs.dirty = true;

    // Latency buffer with reservoir sampling at cap
    fs.latencyTotalCount++;
    if (fs.latencyBuffer.length < LATENCY_BUFFER_CAP) {
      fs.latencyBuffer.push(latencyMs);
    } else {
      // Reservoir sampling: replace with probability cap/totalCount
      const replaceIndex = Math.floor(Math.random() * fs.latencyTotalCount);
      if (replaceIndex < LATENCY_BUFFER_CAP) {
        fs.latencyBuffer[replaceIndex] = latencyMs;
      }
    }
  }

  function getQuarantineMetrics(ts: ToolState): ToolHealthMetrics {
    return computeMetricsForWindow(
      ts.ring,
      ts.filledSlots,
      ts.ringIndex,
      ringSize,
      quarantineWindowSize,
    );
  }

  function getDemotionMetrics(ts: ToolState): ToolHealthMetrics {
    return computeMetricsForWindow(
      ts.ring,
      ts.filledSlots,
      ts.ringIndex,
      ringSize,
      demotionCriteria.windowSize,
    );
  }

  function updateState(ts: ToolState): HealthAction {
    const qMetrics = getQuarantineMetrics(ts);
    const dMetrics = getDemotionMetrics(ts);
    const action = computeHealthAction(
      qMetrics,
      dMetrics,
      ts.state,
      ts.trustTier ?? "sandbox",
      quarantineThreshold,
      quarantineWindowSize,
      demotionCriteria,
      ts.lastPromotedAt,
      ts.lastDemotedAt,
      clock(),
    );
    ts.state = action.state;
    return action;
  }

  function buildSnapshot(toolId: string, ts: ToolState): ToolHealthSnapshot {
    const metrics = getQuarantineMetrics(ts);
    const resolvedBrickId = config.resolveBrickId(toolId);
    return {
      brickId: resolvedBrickId ?? "",
      toolId,
      metrics,
      state: ts.state,
      recentFailures: [...ts.recentFailures],
      lastUpdatedAt: ts.lastUpdatedAt,
    };
  }

  /** Load trust tier from forge store and cache it. */
  async function ensureTrustTier(toolId: string, ts: ToolState): Promise<void> {
    if (ts.trustTier !== undefined) return;
    const resolvedBrickId = config.resolveBrickId(toolId);
    if (resolvedBrickId === undefined) return;
    const loadResult = await config.forgeStore.load(brickId(resolvedBrickId));
    if (loadResult.ok) {
      ts.trustTier = loadResult.value.trustTier;
      ts.lastPromotedAt = loadResult.value.lastPromotedAt ?? 0;
      ts.lastDemotedAt = loadResult.value.lastDemotedAt ?? 0;
    }
  }

  // ---------------------------------------------------------------------------
  // Fitness flush — closure-based implementations (no `this` dependency)
  // ---------------------------------------------------------------------------

  function shouldFlushToolImpl(toolId: string): boolean {
    const ts = tools.get(toolId);
    if (ts === undefined) return false;
    return shouldFlush(ts.flushState, flushThreshold, errorRateDeltaThreshold);
  }

  async function flushToolImpl(toolId: string): Promise<void> {
    const ts = tools.get(toolId);
    if (ts === undefined) return;
    const fs = ts.flushState;
    if (!fs.dirty || fs.flushing) return;

    // Only flush forged tools
    const resolvedBrickId = config.resolveBrickId(toolId);
    if (resolvedBrickId === undefined) return;

    fs.flushing = true;

    // Capture deltas before async work
    const successDelta = fs.totalSuccesses - fs.lastFlushedSuccesses;
    const failureDelta = fs.totalFailures - fs.lastFlushedFailures;
    const latencyBufferCopy = [...fs.latencyBuffer];
    const lastUsedAt = ts.lastUpdatedAt;

    try {
      const loadResult = await config.forgeStore.load(brickId(resolvedBrickId));
      if (!loadResult.ok) {
        if (loadResult.error.code === "NOT_FOUND") {
          // Brick was deleted — clear dirty, report warning
          fs.dirty = false;
          fs.flushing = false;
          config.onFlushError?.(toolId, loadResult.error);
          return;
        }
        throw new Error(`Failed to load brick ${resolvedBrickId}: ${loadResult.error.message}`, {
          cause: loadResult.error,
        });
      }

      const existing = loadResult.value.fitness;
      const merged = computeMergedFitness(
        { successDelta, failureDelta, latencyBuffer: latencyBufferCopy, lastUsedAt },
        existing,
      );

      const updateResult = await config.forgeStore.update(brickId(resolvedBrickId), {
        fitness: merged,
        usageCount: merged.successCount + merged.errorCount,
      });
      if (!updateResult.ok) {
        throw new Error(
          `Failed to update fitness for brick ${resolvedBrickId}: ${updateResult.error.message}`,
          { cause: updateResult.error },
        );
      }

      // Success — update flush bookkeeping
      fs.lastFlushedSuccesses = fs.totalSuccesses;
      fs.lastFlushedFailures = fs.totalFailures;
      const totalInvocations = fs.totalSuccesses + fs.totalFailures;
      fs.lastFlushedErrorRate = totalInvocations > 0 ? fs.totalFailures / totalInvocations : 0;
      fs.invocationsSinceFlush = 0;
      // Clear buffer in-place (reference is readonly, contents are mutable)
      fs.latencyBuffer.length = 0;
      fs.latencyTotalCount = 0;
      fs.dirty = false;
    } catch (e: unknown) {
      // Restore dirty so next check can retry (deltas still in cumulative counters)
      fs.dirty = true;
      config.onFlushError?.(toolId, e);
    } finally {
      fs.flushing = false;
    }
  }

  /** Flushes all dirty tools. Errors are reported via onFlushError; never rejects. */
  async function flushAllImpl(): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const [toolId, ts] of tools) {
      if (ts.flushState.dirty && !ts.flushState.flushing) {
        promises.push(flushToolImpl(toolId));
      }
    }
    await Promise.allSettled(promises);
  }

  async function disposeImpl(): Promise<void> {
    await flushAllImpl();
    tools.clear();
  }

  return {
    recordSuccess(toolId: string, latencyMs: number): void {
      record(toolId, true, latencyMs);
      const ts = tools.get(toolId);
      if (ts !== undefined && ts.state !== "quarantined") {
        updateState(ts);
      }
    },

    recordFailure(toolId: string, latencyMs: number, error: string): void {
      record(toolId, false, latencyMs);
      const ts = tools.get(toolId);
      if (ts === undefined) return;

      const failureRecord: ToolFailureRecord = {
        timestamp: clock(),
        error,
        latencyMs,
      };
      ts.recentFailures.push(failureRecord);
      if (ts.recentFailures.length > maxRecent) {
        ts.recentFailures.shift();
      }

      if (ts.state !== "quarantined") {
        updateState(ts);
      }
    },

    getSnapshot(toolId: string): ToolHealthSnapshot | undefined {
      const ts = tools.get(toolId);
      if (ts === undefined) return undefined;
      return buildSnapshot(toolId, ts);
    },

    isQuarantined(toolId: string): boolean {
      const ts = tools.get(toolId);
      return ts !== undefined && ts.state === "quarantined";
    },

    async isQuarantinedAsync(toolId: string): Promise<boolean> {
      // Fast path: check in-memory state first
      const ts = tools.get(toolId);
      if (ts !== undefined) return ts.state === "quarantined";

      // Fallback: check ForgeStore for persisted quarantine (lifecycle === "failed")
      const resolvedBrickId = config.resolveBrickId(toolId);
      if (resolvedBrickId === undefined) return false;

      try {
        const loadResult = await config.forgeStore.load(brickId(resolvedBrickId));
        if (loadResult.ok && loadResult.value.lifecycle === "failed") {
          // Pre-populate local state so subsequent sync checks work
          const localTs = getOrCreate(toolId);
          localTs.state = "quarantined";
          return true;
        }
      } catch (_e: unknown) {
        // Store unavailable — conservatively allow the tool
      }
      return false;
    },

    async checkAndQuarantine(toolId: string): Promise<boolean> {
      const ts = tools.get(toolId);
      if (ts === undefined || ts.state !== "quarantined") return false;

      const resolvedBrickId = config.resolveBrickId(toolId);
      if (resolvedBrickId === undefined) return false;

      // Update forge store: lifecycle → "failed" (terminal)
      const updateResult = await config.forgeStore.update(brickId(resolvedBrickId), {
        lifecycle: "failed",
      });
      if (!updateResult.ok) {
        throw new Error(
          `Failed to update forge store for brick ${resolvedBrickId}: ${updateResult.error.message}`,
          { cause: updateResult.error },
        );
      }

      // Record quarantine snapshot event
      const metrics = getQuarantineMetrics(ts);
      const now = clock();
      const snapshot: BrickSnapshot = {
        snapshotId: snapshotId(`quarantine-${resolvedBrickId}-${now}`),
        brickId: brickId(resolvedBrickId),
        version: "0.0.0",
        source: { origin: "forged", forgedBy: "system:health-tracker" },
        event: {
          kind: "quarantined",
          actor: "system:health-tracker",
          timestamp: now,
          reason: `Error rate ${metrics.errorRate.toFixed(2)} exceeded threshold ${String(quarantineThreshold)}`,
          errorRate: metrics.errorRate,
          failureCount: ts.recentFailures.length,
        },
        artifact: {},
        createdAt: now,
      };
      const recordResult = await config.snapshotStore.record(snapshot);
      if (!recordResult.ok) {
        throw new Error(
          `Failed to record quarantine snapshot for brick ${resolvedBrickId}: ${recordResult.error.message}`,
          { cause: recordResult.error },
        );
      }

      // Notify callback (e.g., forgeProvider.invalidate())
      await config.onQuarantine?.(resolvedBrickId);

      return true;
    },

    async checkAndDemote(toolId: string): Promise<boolean> {
      const ts = tools.get(toolId);
      if (ts === undefined) return false;

      const resolvedBrickId = config.resolveBrickId(toolId);
      if (resolvedBrickId === undefined) return false;

      // Ensure we have the trust tier cached
      await ensureTrustTier(toolId, ts);
      if (ts.trustTier === undefined) return false;

      // Sandbox is floor — cannot demote further
      if (ts.trustTier === "sandbox") return false;

      // Direct demotion criteria check (independent of state machine)
      const dMetrics = getDemotionMetrics(ts);
      const now = clock();

      // Grace period: don't demote within N ms of a promotion
      if (now - ts.lastPromotedAt < demotionCriteria.gracePeriodMs) return false;
      // Cooldown: don't demote again within N ms of last demotion
      if (now - ts.lastDemotedAt < demotionCriteria.demotionCooldownMs) return false;
      // Threshold + sample size check
      if (
        dMetrics.errorRate < demotionCriteria.errorRateThreshold ||
        dMetrics.usageCount < demotionCriteria.minSampleSize
      ) {
        return false;
      }

      // Compute target tier (one step down)
      const targetTier = DEMOTION_TARGET[ts.trustTier];
      if (targetTier === undefined) return false;

      const fromTier = ts.trustTier;

      // Update forge store: trust tier + lastDemotedAt
      const updateResult = await config.forgeStore.update(brickId(resolvedBrickId), {
        trustTier: targetTier,
        lastDemotedAt: now,
      });
      if (!updateResult.ok) {
        throw new Error(
          `Failed to update forge store for brick ${resolvedBrickId}: ${updateResult.error.message}`,
          { cause: updateResult.error },
        );
      }

      // Record demotion snapshot event
      const snapshot: BrickSnapshot = {
        snapshotId: snapshotId(`demotion-${resolvedBrickId}-${now}`),
        brickId: brickId(resolvedBrickId),
        version: "0.0.0",
        source: { origin: "forged", forgedBy: "system:health-tracker" },
        event: {
          kind: "demoted",
          actor: "system:health-tracker",
          timestamp: now,
          fromTier,
          toTier: targetTier,
          reason: `Error rate ${dMetrics.errorRate.toFixed(2)} exceeded demotion threshold ${String(demotionCriteria.errorRateThreshold)}`,
          errorRate: dMetrics.errorRate,
        },
        artifact: {},
        createdAt: now,
      };
      const recordResult = await config.snapshotStore.record(snapshot);
      if (!recordResult.ok) {
        throw new Error(
          `Failed to record demotion snapshot for brick ${resolvedBrickId}: ${recordResult.error.message}`,
          { cause: recordResult.error },
        );
      }

      // Update cached state
      ts.trustTier = targetTier;
      ts.lastDemotedAt = now;

      // Fire demotion callback
      const demotionEvent: TrustDemotionEvent = {
        brickId: resolvedBrickId,
        from: fromTier,
        to: targetTier,
        reason: "error_rate",
        evidence: {
          errorRate: dMetrics.errorRate,
          sampleSize: dMetrics.usageCount,
          periodMs: now - ts.lastUpdatedAt,
        },
      };
      await config.onDemotion?.(demotionEvent);

      return true;
    },

    getAllSnapshots(): readonly ToolHealthSnapshot[] {
      const snapshots: ToolHealthSnapshot[] = [];
      for (const [toolId, ts] of tools) {
        snapshots.push(buildSnapshot(toolId, ts));
      }
      return snapshots;
    },

    shouldFlushTool: shouldFlushToolImpl,
    flushTool: flushToolImpl,
    flush: flushAllImpl,
    dispose: disposeImpl,
  };
}
