/**
 * In-memory HealthMonitor implementation with two-tier batching.
 *
 * Hot path: record() writes to an in-memory Map (O(1), zero allocation).
 * Cold path: periodic flush persists timestamps and clears the buffer.
 */

import type {
  AgentId,
  HealthMonitor,
  HealthMonitorConfig,
  HealthMonitorStats,
  HealthSnapshot,
  HealthStatus,
} from "@koi/core";
import type { InMemoryRegistry } from "./registry.js";

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

/**
 * In-memory health monitor narrows `check` to sync-only return.
 * Omit base `check` to prevent TypeScript union widening.
 */
export type InMemoryHealthMonitor = Omit<HealthMonitor, "check"> & {
  readonly check: (agentId: AgentId) => HealthSnapshot;
  /** Manually trigger a flush of the heartbeat buffer to the registry. */
  readonly flush: () => void;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHealthMonitor(
  registry: InMemoryRegistry,
  config: HealthMonitorConfig,
): InMemoryHealthMonitor {
  // Two-tier: hot buffer for writes, flushed map for post-flush reads
  const buffer = new Map<string, number>(); // agentId → timestamp (hot writes)
  const flushedTimestamps = new Map<string, number>(); // agentId → last flushed timestamp
  let totalRecorded = 0; // let: incremented on each record() call
  let totalFlushed = 0; // let: incremented on each flush cycle
  let flushCount = 0; // let: incremented on each flush cycle
  let disposed = false; // let: set to true on dispose()

  // ---------------------------------------------------------------------------
  // Flush: persist buffer timestamps, then clear buffer
  // ---------------------------------------------------------------------------

  function flush(): void {
    if (buffer.size === 0) return;

    const flushedCount = buffer.size;
    for (const [id, ts] of buffer) {
      flushedTimestamps.set(id, ts);
    }
    buffer.clear();

    totalFlushed += flushedCount;
    flushCount += 1;
  }

  // ---------------------------------------------------------------------------
  // Cleanup: remove dead agent entries when deregistered
  // ---------------------------------------------------------------------------

  const unwatchRegistry = registry.watch((event) => {
    if (event.kind === "deregistered") {
      buffer.delete(event.agentId);
      flushedTimestamps.delete(event.agentId);
    }
  });

  // ---------------------------------------------------------------------------
  // Timers
  // ---------------------------------------------------------------------------

  const flushTimer = setInterval(() => {
    if (!disposed) flush();
  }, config.flushIntervalMs);

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  function record(id: AgentId): void {
    buffer.set(id, Date.now());
    totalRecorded += 1;
  }

  function check(id: AgentId): HealthSnapshot {
    const now = Date.now();

    // Check buffer first (most recent data), then flushed, then registry fallback
    const bufferedTs = buffer.get(id);
    const flushedTs = flushedTimestamps.get(id);
    const entry = registry.lookup(id);

    const lastHeartbeat = bufferedTs ?? flushedTs ?? entry?.status.lastTransitionAt ?? 0;
    const elapsed = now - lastHeartbeat;

    let status: HealthStatus; // let: determined by threshold comparison below
    let missedChecks: number; // let: determined by threshold comparison below

    if (lastHeartbeat === 0 || elapsed >= config.deadThresholdMs) {
      status = "dead";
      missedChecks = lastHeartbeat === 0 ? 0 : Math.floor(elapsed / config.suspectThresholdMs);
    } else if (elapsed >= config.suspectThresholdMs) {
      status = "suspect";
      missedChecks = Math.floor(elapsed / config.suspectThresholdMs);
    } else {
      status = "alive";
      missedChecks = 0;
    }

    return { agentId: id, status, lastHeartbeat, missedChecks };
  }

  function stats(): HealthMonitorStats {
    return {
      totalRecorded,
      totalFlushed,
      bufferSize: buffer.size,
      flushCount,
    };
  }

  async function dispose(): Promise<void> {
    disposed = true;
    clearInterval(flushTimer);
    unwatchRegistry();
    // Final flush on disposal
    flush();
  }

  return {
    record,
    check,
    stats,
    flush,
    [Symbol.asyncDispose]: dispose,
  };
}
