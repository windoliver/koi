/**
 * Tests for mapSchedulerStatsByProcessState — verifies the TaskStatus → ProcessState
 * mapping is correctly applied to scheduler stats counts.
 */

import { describe, expect, test } from "bun:test";
import type { SchedulerStats } from "@koi/core";
import { mapSchedulerStatsByProcessState } from "../stats-mapping.js";

function makeStats(overrides?: Partial<SchedulerStats>): SchedulerStats {
  return {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    deadLettered: 0,
    activeSchedules: 0,
    pausedSchedules: 0,
    ...overrides,
  };
}

describe("mapSchedulerStatsByProcessState", () => {
  test("maps pending tasks to created", () => {
    const result = mapSchedulerStatsByProcessState(makeStats({ pending: 5 }));
    expect(result.created).toBe(5);
    expect(result.running).toBe(0);
    expect(result.terminated).toBe(0);
  });

  test("maps running tasks to running", () => {
    const result = mapSchedulerStatsByProcessState(makeStats({ running: 3 }));
    expect(result.created).toBe(0);
    expect(result.running).toBe(3);
    expect(result.terminated).toBe(0);
  });

  test("maps completed, failed, and dead_letter to terminated", () => {
    const result = mapSchedulerStatsByProcessState(
      makeStats({ completed: 10, failed: 2, deadLettered: 1 }),
    );
    expect(result.created).toBe(0);
    expect(result.running).toBe(0);
    expect(result.terminated).toBe(13);
  });

  test("aggregates all statuses correctly", () => {
    const result = mapSchedulerStatsByProcessState(
      makeStats({ pending: 3, running: 2, completed: 10, failed: 4, deadLettered: 1 }),
    );
    expect(result.created).toBe(3);
    expect(result.running).toBe(2);
    expect(result.terminated).toBe(15);
  });

  test("returns all zeros for empty stats", () => {
    const result = mapSchedulerStatsByProcessState(makeStats());
    expect(result.created).toBe(0);
    expect(result.running).toBe(0);
    expect(result.terminated).toBe(0);
  });
});
