/**
 * @koi/middleware-rlm — Recursive Language Model middleware (L2).
 *
 * Detects oversized model requests, segments the largest user text block
 * into model-sized chunks, dispatches each chunk through the downstream
 * chain, and reassembles the responses in order.
 */

export { validateRlmConfig } from "./config.js";
export { reassembleResponses, SEGMENT_SEPARATOR } from "./reassemble.js";
export { createRlmMiddleware, SegmentAbortError } from "./rlm.js";
export {
  MultipleOversizedBlocksError,
  SiblingNonTextBlocksError,
  SiblingTextBlocksError,
  segmentRequest,
  splitText,
} from "./segment.js";
export type { RlmConfig, RlmEvent } from "./types.js";
export {
  DEFAULT_MAX_CHUNK_CHARS,
  DEFAULT_MAX_INPUT_TOKENS,
  DEFAULT_PRIORITY,
} from "./types.js";
