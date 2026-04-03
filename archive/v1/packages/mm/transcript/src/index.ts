/**
 * @koi/transcript — Durable append-only message log for crash recovery.
 *
 * L2 package. Depends only on @koi/core and @koi/errors.
 */

// Re-export L0 types for convenience
export type {
  SessionTranscript,
  SkippedTranscriptEntry,
  TranscriptEntry,
  TranscriptEntryId,
  TranscriptEntryRole,
  TranscriptLoadResult,
  TranscriptPage,
  TranscriptPageOptions,
} from "@koi/core";
export { transcriptEntryId } from "@koi/core";
export type { JsonlTranscriptConfig } from "./jsonl-store.js";
export { createJsonlTranscript } from "./jsonl-store.js";
export { createInMemoryTranscript } from "./memory-store.js";
