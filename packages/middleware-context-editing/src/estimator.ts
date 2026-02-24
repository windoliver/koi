/**
 * Heuristic token estimator — 4 chars ~ 1 token.
 *
 * Duplicated from @koi/context intentionally: @koi/context is L2 (not L0u),
 * so this L2 package cannot import it.
 */

import type { TokenEstimator } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";

const CHARS_PER_TOKEN = 4;

export const heuristicTokenEstimator: TokenEstimator = {
  estimateText(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  },

  estimateMessages(messages: readonly InboundMessage[]): number {
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
