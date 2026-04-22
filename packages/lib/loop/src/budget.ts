/**
 * Token accounting for @koi/loop.
 *
 * Tokens come from `EngineEvent.done`'s EngineOutput.metrics.totalTokens.
 * If no done event was observed for an iteration, the per-iteration value is
 * "unmetered". The cumulative total stays "unmetered" until the first metered
 * iteration, at which point it becomes a number and stays a number for the
 * rest of the run.
 *
 * This is deliberate: mixing adapters mid-run is not supported, so switching
 * from "unmetered" to a number is a one-way door.
 */

import type { EngineEvent, EngineOutput } from "@koi/core";
import type { TokenBudget } from "./types.js";

/**
 * Extract totalTokens from the last `done` event observed in an iteration.
 * Returns "unmetered" if no done event carried metrics, or if the metrics
 * were synthesized by the activity-timeout wrapper (#1638). Synthesized
 * metrics zero the token counts so a timed-out iteration must NOT be
 * classified as a free (zero-token) run — otherwise repeated timeouts
 * would silently bypass `maxBudgetTokens` enforcement.
 */
export function extractIterationTokens(events: readonly EngineEvent[]): TokenBudget {
  // Walk backwards — done is at the end when it exists.
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev !== undefined && ev.kind === "done") {
      const output: EngineOutput = ev.output;
      if (output.metadata?.metricsSynthesized === true) {
        return "unmetered";
      }
      return output.metrics.totalTokens;
    }
  }
  return "unmetered";
}

/**
 * Add a per-iteration token count to the running total.
 * - If both sides are numbers, add.
 * - If the running total is "unmetered" and the new value is a number, start counting from the new number.
 * - If the new value is "unmetered", carry the running total forward unchanged.
 */
export function addTokens(running: TokenBudget, delta: TokenBudget): TokenBudget {
  if (delta === "unmetered") return running;
  if (running === "unmetered") return delta;
  return running + delta;
}
