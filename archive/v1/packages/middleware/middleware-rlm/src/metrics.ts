/**
 * Shared metrics accumulator for both REPL loop variants.
 *
 * Extracted to eliminate duplication between repl-loop.ts and code-repl-loop.ts.
 */

import type { ModelResponse } from "@koi/core";
import type { RlmMetrics } from "./types.js";

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

export interface MetricsAccumulator {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly turns: number;
  readonly startTime: number;
}

export function createMetricsAccumulator(): MetricsAccumulator {
  return { inputTokens: 0, outputTokens: 0, turns: 0, startTime: Date.now() };
}

export function addModelUsage(
  acc: MetricsAccumulator,
  response: ModelResponse,
): MetricsAccumulator {
  const usage = response.usage;
  if (usage === undefined) return acc;
  return {
    ...acc,
    inputTokens: acc.inputTokens + usage.inputTokens,
    outputTokens: acc.outputTokens + usage.outputTokens,
  };
}

export function incrementTurn(acc: MetricsAccumulator): MetricsAccumulator {
  return { ...acc, turns: acc.turns + 1 };
}

export function finalizeMetrics(acc: MetricsAccumulator, costUsd?: number | undefined): RlmMetrics {
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    totalTokens: acc.inputTokens + acc.outputTokens,
    turns: acc.turns,
    durationMs: Date.now() - acc.startTime,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}
