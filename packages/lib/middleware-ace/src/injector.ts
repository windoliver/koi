/**
 * Playbook injector — priority selection within a token budget.
 *
 * Sorted by confidence descending, accumulated greedily. Strategy text token
 * estimates use `@koi/token-estimator`'s heuristic.
 */

import type { Playbook } from "@koi/ace-types";
import { estimateTokens } from "@koi/token-estimator";

export interface SelectOptions {
  readonly maxTokens: number;
}

/**
 * Select playbooks within a token budget.
 *
 * Greedy by descending confidence: include each playbook while its strategy
 * token estimate fits the remaining budget; skip otherwise (do not stop —
 * a smaller later playbook may still fit).
 */
export function selectPlaybooks(
  available: readonly Playbook[],
  options: SelectOptions,
): readonly Playbook[] {
  if (available.length === 0 || options.maxTokens <= 0) return [];

  const sorted = [...available].sort((a, b) => b.confidence - a.confidence);
  const selected: Playbook[] = [];
  let tokensUsed = 0; // accumulator: token-budget tally

  for (const pb of sorted) {
    const tokens = estimateTokens(pb.strategy);
    if (tokensUsed + tokens > options.maxTokens) continue;
    tokensUsed += tokens;
    selected.push(pb);
  }

  return selected;
}

/**
 * Format selected playbooks into a single system-message string for prepending
 * to a model call. Returns an empty string when selection is empty.
 */
export function formatActivePlaybooksMessage(selected: readonly Playbook[]): string {
  if (selected.length === 0) return "";
  const lines = selected.map((pb) => `- ${pb.strategy}`);
  return `[Active Playbooks]\n${lines.join("\n")}`;
}
