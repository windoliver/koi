/**
 * Heuristic token estimator — 4 chars ≈ 1 token.
 *
 * Simple but effective for budget enforcement. Conforms to L0's
 * TokenEstimator interface from @koi/core.
 */

import type { TokenEstimator } from "@koi/core";

const CHARS_PER_TOKEN = 4;

/**
 * Estimates token count using a simple character-based heuristic.
 * 4 characters ≈ 1 token. Synchronous — no model-specific tokenizer needed.
 */
export const heuristicTokenEstimator: TokenEstimator = {
  estimateText(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  },

  estimateMessages(messages): number {
    let total = 0;
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.kind === "text") {
          total += Math.ceil(block.text.length / CHARS_PER_TOKEN);
        }
      }
    }
    return total;
  },
};
