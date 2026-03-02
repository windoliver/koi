/**
 * Incremental token tracker using chars/4 approximation.
 *
 * Tracks estimated token usage across the REPL loop to determine
 * when compaction should trigger and how much budget remains.
 */

import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "./types.js";

export interface TokenTracker {
  /** Add estimated tokens for a piece of text. */
  readonly add: (text: string) => void;
  /** Add a raw token count (e.g., from model usage). */
  readonly addTokens: (count: number) => void;
  /** Current estimated token count. */
  readonly current: () => number;
  /** Fraction of capacity used (0..1+). */
  readonly utilization: () => number;
  /** Remaining tokens before hitting capacity. */
  readonly remaining: () => number;
  /** Total capacity in tokens. */
  readonly capacity: number;
}

/**
 * Creates a token tracker with the given capacity.
 *
 * @param capacityTokens - Total token budget. Default: 100,000.
 */
export function createTokenTracker(capacityTokens?: number): TokenTracker {
  const capacity = capacityTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;

  // let: mutable counter for accumulated tokens
  let tokens = 0;

  return {
    add(text: string): void {
      tokens += Math.ceil(text.length / 4);
    },
    addTokens(count: number): void {
      tokens += count;
    },
    current(): number {
      return tokens;
    },
    utilization(): number {
      return tokens / capacity;
    },
    remaining(): number {
      return Math.max(0, capacity - tokens);
    },
    capacity,
  };
}
