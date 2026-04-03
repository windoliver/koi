import type { ModelChunk } from "@koi/core";

/**
 * A VCR cassette: a recorded sequence of ModelChunks that can be replayed
 * deterministically without API calls.
 *
 * Phase 1 MVP uses stream-level recording (ModelChunk[]).
 * Future upgrade: full RichTrajectoryStep VCR when @koi/event-trace lands.
 */
export interface Cassette {
  /** Human-readable label for this cassette. */
  readonly name: string;
  /** The model used when recording. */
  readonly model: string;
  /** Timestamp when cassette was recorded. */
  readonly recordedAt: number;
  /** The recorded stream chunks in order. */
  readonly chunks: readonly ModelChunk[];
}
