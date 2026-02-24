/**
 * Playbook injector — priority selection within token budget.
 */

import type { Playbook } from "./types.js";

export interface SelectOptions {
  readonly maxTokens: number;
  readonly clock: () => number;
}

/**
 * Estimate token count from text length.
 * Rough heuristic: ~4 chars per token (matches middleware-memory/store.ts).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Select playbooks within a token budget.
 * Sorted by confidence descending, accumulated greedily.
 */
export function selectPlaybooks(
  available: readonly Playbook[],
  options: SelectOptions,
): readonly Playbook[] {
  if (available.length === 0) return [];

  const sorted = [...available].sort((a, b) => b.confidence - a.confidence);
  const selected: Playbook[] = [];
  let tokensUsed = 0; // let: accumulator for token budget

  for (const pb of sorted) {
    const tokens = estimateTokens(pb.strategy);
    if (tokensUsed + tokens > options.maxTokens) continue;
    tokensUsed += tokens;
    selected.push(pb);
  }

  return selected;
}
