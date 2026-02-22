/**
 * Token estimation and context compaction contracts.
 *
 * Both interfaces support sync/async implementations via `T | Promise<T>`:
 * local tokenizers (tiktoken, heuristic) run sync; remote APIs run async.
 */

import type { InboundMessage } from "./message.js";

/**
 * Estimate token counts for text and message sequences.
 *
 * The optional `model` parameter acts as a tokenizer dispatch key —
 * a single estimator instance may handle different models across turns.
 */
export interface TokenEstimator {
  readonly estimateText: (text: string, model?: string) => number | Promise<number>;

  readonly estimateMessages: (
    messages: readonly InboundMessage[],
    model?: string,
  ) => number | Promise<number>;
}

/**
 * Outcome of a compaction pass, carrying observability metadata.
 *
 * `strategy` is an open string — L2 packages invent new strategies freely.
 */
export interface CompactionResult {
  readonly messages: readonly InboundMessage[];
  readonly originalTokens: number;
  readonly compactedTokens: number;
  readonly strategy: string;
}

/**
 * Reduce a message sequence to fit within a token budget.
 *
 * Always succeeds — worst case returns an empty message array.
 * If the underlying LLM summarizer breaks, throw with `cause`.
 */
export interface ContextCompactor {
  readonly compact: (
    messages: readonly InboundMessage[],
    maxTokens: number,
    model?: string,
  ) => CompactionResult | Promise<CompactionResult>;
}
