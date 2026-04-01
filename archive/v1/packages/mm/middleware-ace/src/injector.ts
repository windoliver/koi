/**
 * Playbook injector — priority selection within token budget.
 */

import { estimateTokens } from "@koi/token-estimator";
import { estimateStructuredTokens } from "./playbook.js";
import type { Playbook, StructuredPlaybook } from "./types.js";

export interface SelectOptions {
  readonly maxTokens: number;
  readonly clock: () => number;
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

/**
 * Select structured playbooks within a remaining token budget.
 * Greedy selection: include playbooks in order while budget allows.
 */
export async function selectStructuredPlaybooks(
  available: readonly StructuredPlaybook[],
  remainingTokens: number,
): Promise<readonly StructuredPlaybook[]> {
  if (available.length === 0 || remainingTokens <= 0) return [];

  const selected: StructuredPlaybook[] = [];
  let tokensUsed = 0; // let: accumulator for token budget

  for (const sp of available) {
    const tokens = await estimateStructuredTokens(sp);
    if (tokensUsed + tokens > remainingTokens) continue;
    tokensUsed += tokens;
    selected.push(sp);
  }

  return selected;
}
