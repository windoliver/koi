/**
 * @koi/middleware-tool-recovery — Recover structured tool calls from text
 * patterns (Hermes / Llama 3.1 / JSON fence / custom) in model responses.
 *
 * Lets open-source models without native tool calling (Llama, Hermes, Mistral
 * served via Ollama / vLLM / LM Studio) participate in Koi's tool ecosystem
 * by promoting embedded text tool calls into `metadata.toolCalls`.
 */

export type { ToolRecoveryConfig } from "./config.js";
export {
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_PATTERN_NAMES,
  validateToolRecoveryConfig,
} from "./config.js";
export { recoverToolCalls } from "./parse.js";
export { hermesPattern } from "./patterns/hermes.js";
export { jsonFencePattern } from "./patterns/json-fence.js";
export { llama31Pattern } from "./patterns/llama31.js";
export { BUILTIN_PATTERNS, resolvePatterns } from "./patterns/registry.js";
export { createToolRecoveryMiddleware } from "./recovery-middleware.js";
export type { ParsedToolCall, RecoveryEvent, RecoveryResult, ToolCallPattern } from "./types.js";
