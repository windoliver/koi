/**
 * RLM middleware — types and defaults.
 *
 * Lightweight input-virtualization middleware: when a `ModelRequest` exceeds
 * a configured token budget, segment the largest user text block into
 * smaller chunks, dispatch each chunk through the downstream chain, and
 * concatenate the responses in order.
 */

import type { TokenEstimator } from "@koi/core";

/** Telemetry events emitted as the middleware processes a request. */
export type RlmEvent =
  | { readonly kind: "passthrough"; readonly tokens: number }
  | {
      readonly kind: "segmented";
      readonly tokens: number;
      readonly segmentCount: number;
    }
  | {
      readonly kind: "segment-completed";
      readonly index: number;
      readonly count: number;
    };

/** Configuration for {@link createRlmMiddleware}. */
export interface RlmConfig {
  /**
   * Threshold in tokens. Requests whose estimated token count exceeds this
   * value are segmented; smaller requests pass through unchanged.
   */
  readonly maxInputTokens?: number;
  /** Maximum characters per segment of the split text block. */
  readonly maxChunkChars?: number;
  /** Token estimator used for the threshold check. Defaults to the heuristic estimator. */
  readonly estimator?: TokenEstimator;
  /** Middleware priority. Defaults to {@link DEFAULT_PRIORITY}. */
  readonly priority?: number;
  /** Telemetry callback. Errors thrown by the callback are swallowed. */
  readonly onEvent?: (event: RlmEvent) => void;
  /**
   * String inserted between per-segment outputs during reassembly. Defaults
   * to `""` (byte-faithful concatenation) so structural transforms like
   * JSON/CSV/code regeneration and exact-copy prompts are not corrupted by
   * synthetic blank lines. Set to `"\n\n"` (or any other delimiter) for
   * summarization-style tasks where readable boundaries help the caller
   * parse the merged answer.
   */
  readonly segmentSeparator?: string;
  /**
   * Required opt-in. RLM concatenates per-segment outputs; the result is
   * only correct when the original task is the in-order union of
   * segment-local answers (extraction, transformation, summarization-
   * per-chunk). Tasks that need global ranking, dedup, counting, or
   * cross-segment reasoning must run an explicit reducer downstream.
   *
   * Setting this flag to `true` acknowledges the contract. When the flag
   * is absent or `false`, the middleware fails closed on every oversized
   * request rather than silently returning a synthesized concatenation
   * for a task that may need genuine aggregation.
   */
  readonly acknowledgeSegmentLocalContract?: boolean;
}

/** Default token threshold (~32K tokens of text under heuristic estimation). */
export const DEFAULT_MAX_INPUT_TOKENS = 32_000;

/**
 * Default separator between segmented response bodies. Empty so reassembly
 * is byte-faithful by default; callers opt into a delimiter via
 * `RlmConfig.segmentSeparator`.
 */
export const DEFAULT_SEGMENT_SEPARATOR = "";

/** Default segment size in characters (~2K tokens under heuristic estimation). */
export const DEFAULT_MAX_CHUNK_CHARS = 8_000;

/**
 * Default middleware priority. Sits before model-router/retry so the
 * downstream chain handles per-segment fallback and rate limits.
 */
export const DEFAULT_PRIORITY = 200;
