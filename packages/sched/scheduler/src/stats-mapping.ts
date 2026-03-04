/**
 * Maps scheduler stats to ProcessState-grouped counts for unified monitoring.
 *
 * Dashboards and monitoring consumers need a single view across both the
 * agent lifecycle (ProcessState) and the scheduler task lifecycle (TaskStatus).
 * This module bridges the two using the L0 mapping function.
 */

import type { ProcessState, SchedulerStats, TaskStatus } from "@koi/core";
import { mapTaskStatusToProcessState } from "@koi/core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessStateCounts {
  readonly created: number;
  readonly running: number;
  readonly terminated: number;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/**
 * Map SchedulerStats (TaskStatus-keyed counts) to ProcessState-keyed counts.
 *
 * | TaskStatus  | ProcessState |
 * |-------------|--------------|
 * | pending     | created      |
 * | running     | running      |
 * | completed   | terminated   |
 * | failed      | terminated   |
 * | dead_letter | terminated   |
 */
export function mapSchedulerStatsByProcessState(stats: SchedulerStats): ProcessStateCounts {
  const counts: Record<ProcessState, number> = {
    created: 0,
    running: 0,
    waiting: 0,
    suspended: 0,
    idle: 0,
    terminated: 0,
  };

  const statusCounts: readonly (readonly [TaskStatus, number])[] = [
    ["pending", stats.pending],
    ["running", stats.running],
    ["completed", stats.completed],
    ["failed", stats.failed],
    ["dead_letter", stats.deadLettered],
  ];

  for (const [status, count] of statusCounts) {
    const processState = mapTaskStatusToProcessState(status);
    counts[processState] += count;
  }

  return {
    created: counts.created,
    running: counts.running,
    terminated: counts.terminated,
  };
}
