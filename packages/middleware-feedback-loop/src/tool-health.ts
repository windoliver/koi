/**
 * Tool health tracker — ring buffer + quarantine state machine.
 *
 * Adapts circuit breaker pattern from @koi/model-router. Key difference:
 * no HALF_OPEN recovery — quarantine is terminal (agent must re-forge).
 */

import type { BrickSnapshot } from "@koi/core";
import { brickId, snapshotId } from "@koi/core";
import type { ForgeHealthConfig } from "./config.js";
import type {
  ToolFailureRecord,
  ToolHealthMetrics,
  ToolHealthSnapshot,
  ToolHealthState,
} from "./types.js";

const DEFAULT_QUARANTINE_THRESHOLD = 0.5;
const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_MAX_RECENT_FAILURES = 5;

/** ToolHealthTracker interface — per-tool success/failure/latency tracking with quarantine. */
export interface ToolHealthTracker {
  readonly recordSuccess: (toolId: string, latencyMs: number) => void;
  readonly recordFailure: (toolId: string, latencyMs: number, error: string) => void;
  readonly getSnapshot: (toolId: string) => ToolHealthSnapshot | undefined;
  readonly isQuarantined: (toolId: string) => boolean;
  readonly checkAndQuarantine: (toolId: string) => Promise<boolean>;
  readonly getAllSnapshots: () => readonly ToolHealthSnapshot[];
}

// ---------------------------------------------------------------------------
// Internal per-tool mutable state (encapsulated — never exposed)
// ---------------------------------------------------------------------------

interface RingEntry {
  readonly success: boolean;
  readonly latencyMs: number;
}

interface ToolState {
  // let: ring buffer mutated on each record call
  readonly ring: Array<RingEntry | undefined>;
  /** let: write cursor — increments unboundedly, modulo windowSize for slot. */
  ringIndex: number;
  /** let: number of filled slots in the ring, capped at windowSize. */
  filledSlots: number;
  /** let: state machine — healthy → degraded → quarantined (terminal). */
  state: ToolHealthState;
  // let: capped failure records, mutated via push/shift
  readonly recentFailures: ToolFailureRecord[];
  /** let: timestamp of the most recent record call. */
  lastUpdatedAt: number;
}

function createToolState(windowSize: number): ToolState {
  return {
    ring: new Array<RingEntry | undefined>(windowSize).fill(undefined),
    ringIndex: 0,
    filledSlots: 0,
    state: "healthy",
    recentFailures: [],
    lastUpdatedAt: 0,
  };
}

// ---------------------------------------------------------------------------
// Metrics computation from ring buffer (pure)
// ---------------------------------------------------------------------------

function computeMetrics(ts: ToolState): ToolHealthMetrics {
  const count = ts.filledSlots;
  if (count === 0) {
    return { successRate: 1, errorRate: 0, usageCount: 0, avgLatencyMs: 0 };
  }

  // let: accumulator for single-pass scan
  let successes = 0;
  let totalLatency = 0;

  for (let i = 0; i < count; i++) {
    const entry = ts.ring[i];
    if (entry !== undefined) {
      if (entry.success) successes++;
      totalLatency += entry.latencyMs;
    }
  }

  const successRate = successes / count;
  return {
    successRate,
    errorRate: 1 - successRate,
    usageCount: count,
    avgLatencyMs: totalLatency / count,
  };
}

function computeState(
  metrics: ToolHealthMetrics,
  currentState: ToolHealthState,
  threshold: number,
  windowSize: number,
): ToolHealthState {
  if (currentState === "quarantined") return "quarantined";
  if (metrics.errorRate >= threshold && metrics.usageCount >= windowSize) return "quarantined";
  if (metrics.errorRate >= threshold * 0.75) return "degraded";
  return "healthy";
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Creates a ToolHealthTracker with ring buffer and quarantine support. */
export function createToolHealthTracker(config: ForgeHealthConfig): ToolHealthTracker {
  const threshold = config.quarantineThreshold ?? DEFAULT_QUARANTINE_THRESHOLD;
  const windowSize = config.windowSize ?? DEFAULT_WINDOW_SIZE;
  const maxRecent = config.maxRecentFailures ?? DEFAULT_MAX_RECENT_FAILURES;
  const clock = config.clock ?? Date.now;

  // let: per-tool state map — mutated on record calls
  const tools = new Map<string, ToolState>();

  function getOrCreate(toolId: string): ToolState {
    const existing = tools.get(toolId);
    if (existing !== undefined) return existing;
    const ts = createToolState(windowSize);
    tools.set(toolId, ts);
    return ts;
  }

  function record(toolId: string, success: boolean, latencyMs: number): void {
    const ts = getOrCreate(toolId);
    if (ts.state === "quarantined") return;

    ts.ring[ts.ringIndex % windowSize] = { success, latencyMs };
    ts.ringIndex++;
    if (ts.filledSlots < windowSize) ts.filledSlots++;
    ts.lastUpdatedAt = clock();
  }

  function buildSnapshot(toolId: string, ts: ToolState): ToolHealthSnapshot {
    const metrics = computeMetrics(ts);
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

  return {
    recordSuccess(toolId: string, latencyMs: number): void {
      record(toolId, true, latencyMs);
      const ts = tools.get(toolId);
      if (ts !== undefined && ts.state !== "quarantined") {
        const metrics = computeMetrics(ts);
        ts.state = computeState(metrics, ts.state, threshold, windowSize);
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
        const metrics = computeMetrics(ts);
        ts.state = computeState(metrics, ts.state, threshold, windowSize);
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

    async checkAndQuarantine(toolId: string): Promise<boolean> {
      const ts = tools.get(toolId);
      if (ts === undefined || ts.state !== "quarantined") return false;

      const resolvedBrickId = config.resolveBrickId(toolId);
      if (resolvedBrickId === undefined) return false;

      // Update forge store: lifecycle → "failed" (terminal)
      const updateResult = await config.forgeStore.update(resolvedBrickId, {
        lifecycle: "failed",
      });
      if (!updateResult.ok) {
        throw new Error(
          `Failed to update forge store for brick ${resolvedBrickId}: ${updateResult.error.message}`,
          { cause: updateResult.error },
        );
      }

      // Record quarantine snapshot event
      const metrics = computeMetrics(ts);
      const now = clock();
      const snapshot: BrickSnapshot = {
        snapshotId: snapshotId(`quarantine-${resolvedBrickId}-${now}`),
        brickId: brickId(resolvedBrickId),
        version: "0.0.0",
        source: { origin: "forged", forgedBy: "system:health-tracker" },
        event: {
          type: "quarantined",
          actor: "system:health-tracker",
          timestamp: now,
          reason: `Error rate ${metrics.errorRate.toFixed(2)} exceeded threshold ${threshold}`,
          errorRate: metrics.errorRate,
          failureCount: ts.recentFailures.length,
        },
        artifact: {},
        contentHash: "",
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

    getAllSnapshots(): readonly ToolHealthSnapshot[] {
      const snapshots: ToolHealthSnapshot[] = [];
      for (const [toolId, ts] of tools) {
        snapshots.push(buildSnapshot(toolId, ts));
      }
      return snapshots;
    },
  };
}
