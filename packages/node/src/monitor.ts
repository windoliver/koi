/**
 * Memory monitor — periodic heap monitoring with eviction.
 *
 * Checks process.memoryUsage().heapUsed at a configurable interval.
 * Emits warnings at the warning threshold and triggers agent eviction
 * at the eviction threshold.
 */

import type { AgentHost } from "./agent/host.js";
import type { NodeEventListener, ResourcesConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryMetrics {
  readonly heapUsedBytes: number;
  readonly heapTotalBytes: number;
  readonly rssBytes: number;
  readonly usagePercent: number;
}

export interface MemoryMonitor {
  /** Start periodic monitoring. */
  readonly start: () => void;
  /** Stop monitoring and clean up timers. */
  readonly stop: () => void;
  /** Get current memory metrics (on-demand). */
  readonly metrics: () => MemoryMetrics;
  /** Whether the monitor is currently active. */
  readonly isActive: () => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryMonitor(
  config: ResourcesConfig,
  host: AgentHost,
  emit: (type: Parameters<NodeEventListener>[0]["type"], data?: unknown) => void,
): MemoryMonitor {
  let timer: ReturnType<typeof setInterval> | undefined;
  let active = false;
  let warningEmitted = false;

  function getMetrics(): MemoryMetrics {
    const mem = process.memoryUsage();
    const usagePercent = mem.heapTotal > 0 ? (mem.heapUsed / mem.heapTotal) * 100 : 0;
    return {
      heapUsedBytes: mem.heapUsed,
      heapTotalBytes: mem.heapTotal,
      rssBytes: mem.rss,
      usagePercent,
    };
  }

  function check(): void {
    if (!active) return;

    const metrics = getMetrics();

    // Eviction threshold — terminate least-recently-active agent
    if (metrics.usagePercent >= config.memoryEvictionPercent) {
      const victim = host.leastActive();
      if (victim !== undefined) {
        const result = host.terminate(victim.pid.id);
        if (result.ok) {
          emit("memory_eviction", {
            agentId: victim.pid.id,
            metrics,
          });
        }
      }
      return;
    }

    // Warning threshold
    if (metrics.usagePercent >= config.memoryWarningPercent) {
      if (!warningEmitted) {
        warningEmitted = true;
        emit("memory_warning", { metrics });
      }
    } else {
      warningEmitted = false;
    }
  }

  return {
    start() {
      if (active) return;
      active = true;
      warningEmitted = false;
      timer = setInterval(check, config.monitorInterval);
    },

    stop() {
      active = false;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },

    metrics: getMetrics,

    isActive() {
      return active;
    },
  };
}
