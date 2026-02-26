/**
 * Restart intensity tracker — per-child ring buffer for restart budgets.
 *
 * Uses a sliding window of timestamps to determine whether the restart
 * budget has been exhausted. Each child maintains its own independent
 * ring buffer of `maxRestarts` entries.
 */

import type { Clock } from "./clock.js";

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

export interface RestartIntensityTracker {
  /** Record a restart attempt for a child. */
  readonly record: (childName: string) => void;
  /** Check if the restart budget is exhausted for a child. */
  readonly isExhausted: (childName: string) => boolean;
  /** Count restart attempts within the sliding window for a child. */
  readonly attemptsInWindow: (childName: string) => number;
  /** Reset restart history for a specific child. */
  readonly reset: (childName: string) => void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRestartIntensityTracker(config: {
  readonly maxRestarts: number;
  readonly windowMs: number;
  readonly clock: Clock;
}): RestartIntensityTracker {
  const { maxRestarts, windowMs, clock } = config;

  // Per-child ring buffer: childName → array of restart timestamps
  const buffers = new Map<string, number[]>();

  function getBuffer(childName: string): number[] {
    const existing = buffers.get(childName);
    if (existing !== undefined) return existing;
    const buf: number[] = [];
    buffers.set(childName, buf);
    return buf;
  }

  function countInWindow(childName: string): number {
    const buf = buffers.get(childName);
    if (buf === undefined) return 0;
    const cutoff = clock.now() - windowMs;
    // let justified: count accumulator
    let count = 0;
    for (const ts of buf) {
      if (ts > cutoff) count += 1;
    }
    return count;
  }

  function record(childName: string): void {
    const buf = getBuffer(childName);
    buf.push(clock.now());
    // Trim to ring buffer size — keep only the most recent `maxRestarts` entries
    if (buf.length > maxRestarts) {
      buf.splice(0, buf.length - maxRestarts);
    }
  }

  function isExhausted(childName: string): boolean {
    if (maxRestarts <= 0) return true;
    return countInWindow(childName) >= maxRestarts;
  }

  function attemptsInWindow(childName: string): number {
    return countInWindow(childName);
  }

  function reset(childName: string): void {
    buffers.delete(childName);
  }

  return { record, isExhausted, attemptsInWindow, reset };
}
