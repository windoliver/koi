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
  /**
   * Trust the `metadata.role` field on inbound messages when classifying
   * role for chunking eligibility. **Defaults to `false`** because
   * `InboundMessage.metadata` is otherwise caller-controlled in this
   * codebase: an external caller could mark an oversized user turn as
   * `assistant` or `tool` to bypass RLM's size guard, so RLM must not
   * honor the field by default.
   *
   * Internal trusted callers (e.g. L1 session-repair replaying resumed
   * assistant content) may opt in by setting this flag — but only when
   * the entire upstream path is known to be trusted. Mirrors the explicit
   * trust gate that `model-openai-compat`'s request mapper uses for the
   * same field.
   */
  readonly trustMetadataRole?: boolean;
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
 * Default middleware priority within the `intercept` phase tier.
 *
 * Set HIGHER than tool-mutating intercept middleware (e.g. tool-selector
 * at 200) so RLM runs deeper in the onion — after upstream middleware
 * has materialized any synthetic `tools`. The fail-closed `request.tools`
 * guard in `rlm.ts` then sees the tool list and aborts BEFORE
 * segmentation, instead of fanning a single user turn into N
 * tool-capable model calls. Operators composing RLM with custom
 * tool-mutating middleware MUST keep this invariant: RLM's priority
 * must be greater than every tool-injecting intercept middleware in
 * the chain.
 */
export const DEFAULT_PRIORITY = 800;
