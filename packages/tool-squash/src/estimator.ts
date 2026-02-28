/**
 * Inline heuristic token estimator — 4 chars per token.
 *
 * Used as the default when no TokenEstimator is injected.
 */

import type { TokenEstimator } from "@koi/core/context";
import type { InboundMessage } from "@koi/core/message";

export const heuristicTokenEstimator: TokenEstimator = {
  estimateText: (text: string): number => Math.ceil(text.length / 4),

  estimateMessages: (messages: readonly InboundMessage[]): number =>
    messages.reduce(
      (sum, msg) =>
        sum +
        msg.content.reduce(
          (s, block) => s + (block.kind === "text" ? Math.ceil(block.text.length / 4) : 0),
          0,
        ),
      0,
    ),
};
