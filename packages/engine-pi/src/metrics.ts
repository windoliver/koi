/**
 * Token and turn accumulator for tracking engine metrics.
 */

import type { EngineMetrics } from "@koi/core/engine";

export interface MetricsSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly turns: number;
  readonly durationMs: number;
}

export interface MetricsAccumulator {
  /** Record token usage from a turn. */
  readonly addUsage: (input: number, output: number) => void;
  /** Increment the turn counter. */
  readonly addTurn: () => void;
  /** Finalize and return immutable metrics. */
  readonly finalize: () => EngineMetrics;
  /** Get current snapshot without finalizing. */
  readonly snapshot: () => MetricsSnapshot;
}

/**
 * Create a new metrics accumulator for tracking token usage and turns.
 */
export function createMetricsAccumulator(): MetricsAccumulator {
  const startedAt = Date.now();
  // let justified: accumulator needs mutable internal state
  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;

  return {
    addUsage(input: number, output: number): void {
      inputTokens += input;
      outputTokens += output;
    },

    addTurn(): void {
      turns += 1;
    },

    finalize(): EngineMetrics {
      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        turns,
        durationMs: Date.now() - startedAt,
      };
    },

    snapshot(): MetricsSnapshot {
      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        turns,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
