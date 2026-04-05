/**
 * @koi/middleware-rlm — Recursive Language Model middleware (Layer 2).
 *
 * Virtualizes unbounded input outside the context window. Any engine can
 * use this middleware to process inputs larger than context window via
 * the rlm_process tool.
 */

export { validateRlmConfig } from "./config.js";
export { descriptor } from "./descriptor.js";
export { createRlmMiddleware } from "./rlm.js";
export { createRlmBundle } from "./rlm-bundle.js";
export { RLM_PROCESS_TOOL_NAME } from "./rlm-tool-descriptor.js";
export {
  createRlmVirtualizeMiddleware,
  type RlmVirtualizeConfig,
  type RlmAuditEvent,
} from "./rlm-virtualize.js";
export type {
  ChunkDescriptor,
  InputFormat,
  InputMetadata,
  ReplLoopResult,
  RlmEvent,
  RlmMetrics,
  RlmMiddlewareConfig,
  RlmScriptResult,
  RlmScriptRunConfig,
  RlmScriptRunner,
  RlmSpawnRequest,
  RlmSpawnResult,
  RlmStopReason,
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
  DEFAULT_PRIORITY,
  DEFAULT_TIME_BUDGET_MS,
  MAX_BATCH_PROMPTS,
  MAX_EXAMINE_LENGTH,
} from "./types.js";
