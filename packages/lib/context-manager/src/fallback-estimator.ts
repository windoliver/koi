import type { InboundMessage, TokenEstimator } from "@koi/core";

/**
 * Fallback estimator used when no tokenEstimator is provided in config.
 * Matches the 4-chars-per-token heuristic from @koi/token-estimator.
 * Inlined to avoid a runtime dependency on the tokenizer package.
 */
export const FALLBACK_ESTIMATOR: TokenEstimator = {
  estimateText(text: string): number {
    return Math.ceil(text.length / 4);
  },
  estimateMessages(messages: readonly InboundMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      total += 4;
      for (const block of msg.content) {
        if (block.kind === "text") {
          total += Math.ceil(block.text.length / 4);
        } else {
          total += 100;
        }
      }
    }
    return total;
  },
};
