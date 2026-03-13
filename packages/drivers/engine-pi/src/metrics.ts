/**
 * Token and turn accumulator for tracking engine metrics.
 */

import type { JsonObject } from "@koi/core/common";
import type { EngineMetrics } from "@koi/core/engine";

export interface MetricsSnapshot {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheCreationTokens: number;
  readonly turns: number;
  readonly durationMs: number;
}

/** Cost breakdown from pi-ai's Usage object. */
export interface CostBreakdown {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

/** Result of finalizeWithMetadata — metrics + metadata for EngineOutput. */
export interface FinalizedMetrics {
  readonly metrics: EngineMetrics;
  readonly metadata: JsonObject;
}

export interface MetricsAccumulator {
  /** Record token usage from a turn (cache params optional for backwards compat). */
  readonly addUsage: (
    input: number,
    output: number,
    cacheRead?: number,
    cacheCreation?: number,
  ) => void;
  /** Record cost breakdown from a turn. */
  readonly addCost: (cost: CostBreakdown) => void;
  /** Increment the turn counter. */
  readonly addTurn: () => void;
  /** Finalize and return immutable metrics. */
  readonly finalize: () => EngineMetrics;
  /** Finalize and return metrics + metadata (cache/cost fields, only non-zero). */
  readonly finalizeWithMetadata: () => FinalizedMetrics;
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
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let totalCostUsd = 0;
  let costBreakdown: CostBreakdown | undefined;
  let turns = 0;

  return {
    addUsage(input: number, output: number, cacheRead?: number, cacheCreation?: number): void {
      inputTokens += input;
      outputTokens += output;
      cacheReadTokens += cacheRead ?? 0;
      cacheCreationTokens += cacheCreation ?? 0;
    },

    addCost(cost: CostBreakdown): void {
      totalCostUsd += cost.total;
      // Keep the latest breakdown (accumulates total across turns)
      costBreakdown =
        costBreakdown === undefined
          ? { ...cost }
          : {
              input: costBreakdown.input + cost.input,
              output: costBreakdown.output + cost.output,
              cacheRead: costBreakdown.cacheRead + cost.cacheRead,
              cacheWrite: costBreakdown.cacheWrite + cost.cacheWrite,
              total: costBreakdown.total + cost.total,
            };
    },

    addTurn(): void {
      turns += 1;
    },

    finalize(): EngineMetrics {
      const result: EngineMetrics = {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        turns,
        durationMs: Date.now() - startedAt,
      };
      return totalCostUsd > 0 ? { ...result, costUsd: totalCostUsd } : result;
    },

    finalizeWithMetadata(): FinalizedMetrics {
      const metrics = this.finalize();
      const metadata: Record<string, unknown> = {};
      if (cacheReadTokens > 0) metadata.cacheReadTokens = cacheReadTokens;
      if (cacheCreationTokens > 0) metadata.cacheCreationTokens = cacheCreationTokens;
      if (totalCostUsd > 0) metadata.totalCostUsd = totalCostUsd;
      if (costBreakdown !== undefined && totalCostUsd > 0) metadata.costBreakdown = costBreakdown;
      return { metrics, metadata: metadata as JsonObject };
    },

    snapshot(): MetricsSnapshot {
      return {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        turns,
        durationMs: Date.now() - startedAt,
      };
    },
  };
}
