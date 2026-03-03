/**
 * Heuristic token estimator — 4 chars ≈ 1 token.
 *
 * Provides a configurable factory, a pre-built singleton, and a bare
 * convenience function. All conform to or delegate to the L0
 * TokenEstimator contract from @koi/core.
 */

import type { InboundMessage, TokenEstimator } from "@koi/core";

/** Characters per token used by the heuristic estimator. */
export const CHARS_PER_TOKEN = 4;

/** Configuration for the heuristic token estimator factory. */
export interface HeuristicEstimatorConfig {
  /** Characters per token (default: 4). */
  readonly charsPerToken?: number;
  /** Overhead tokens added per message for role/separator (default: 4). */
  readonly perMessageOverhead?: number;
  /** Overhead tokens per non-text content block — tool_call, image, etc. (default: 100). */
  readonly perNonTextBlockOverhead?: number;
}

/**
 * Creates a TokenEstimator using character-based heuristics.
 *
 * - `estimateText`: `Math.ceil(text.length / charsPerToken)`
 * - `estimateMessages`: sums text estimation + per-message overhead +
 *   per-non-text-block overhead
 */
export function createHeuristicEstimator(config?: HeuristicEstimatorConfig): TokenEstimator {
  const cpt = config?.charsPerToken ?? CHARS_PER_TOKEN;
  const msgOverhead = config?.perMessageOverhead ?? 4;
  const blockOverhead = config?.perNonTextBlockOverhead ?? 100;

  return {
    estimateText(text: string): number {
      return Math.ceil(text.length / cpt);
    },

    estimateMessages(messages: readonly InboundMessage[]): number {
      let total = 0; // let: accumulator for token budget
      for (const msg of messages) {
        total += msgOverhead;
        for (const block of msg.content) {
          if (block.kind === "text") {
            total += Math.ceil(block.text.length / cpt);
          } else {
            total += blockOverhead;
          }
        }
      }
      return total;
    },
  };
}

/**
 * Pre-built heuristic estimator with default config (4 chars/token,
 * 4 tokens per-message overhead, 100 tokens per non-text block).
 */
export const HEURISTIC_ESTIMATOR: TokenEstimator = createHeuristicEstimator();

/**
 * Standalone convenience function for text-only token estimation.
 * Uses the default CHARS_PER_TOKEN (4).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
