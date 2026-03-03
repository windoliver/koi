/**
 * @koi/engine-rlm — Recursive Language Model engine adapter (Layer 2).
 *
 * Virtualizes unbounded input outside the context window and gives the model
 * tools to programmatically examine, chunk, and recursively sub-query it.
 */

export { createRlmAdapter } from "./adapter.js";
export { descriptor } from "./descriptor.js";
export type { RlmToolConfig } from "./tool.js";
export { createRlmTool } from "./tool.js";

export type {
  ChunkDescriptor,
  InputFormat,
  InputMetadata,
  RlmConfig,
  RlmSpawnRequest,
  RlmSpawnResult,
} from "./types.js";

export {
  DEFAULT_CHUNK_SIZE,
  DEFAULT_COMPACTION_THRESHOLD,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  DEFAULT_DEPTH,
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_PREVIEW_LENGTH,
  MAX_BATCH_PROMPTS,
  MAX_EXAMINE_LENGTH,
} from "./types.js";
