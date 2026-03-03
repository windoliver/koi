/**
 * @koi/middleware-tool-recovery — Text-based tool call recovery middleware (Layer 2)
 *
 * Recovers structured tool calls from text patterns in model responses,
 * enabling Koi's tool-calling ecosystem to work with any model
 * (Ollama, vLLM, LM Studio, etc.).
 * Depends on @koi/core and @koi/errors only.
 */

export type { ToolRecoveryConfig } from "./config.js";
export { validateToolRecoveryConfig } from "./config.js";
export { BUILTIN_PATTERNS, resolvePatterns } from "./patterns/registry.js";
export { createToolRecoveryMiddleware } from "./recovery-middleware.js";
export type { ParsedToolCall, RecoveryEvent, RecoveryResult, ToolCallPattern } from "./types.js";
