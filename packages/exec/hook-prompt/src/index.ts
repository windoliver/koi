/**
 * @koi/hook-prompt — Single-shot LLM verification for agent hooks.
 */

export type {
  PromptHookExecutor,
  PromptModelCaller,
  PromptModelRequest,
  PromptModelResponse,
} from "./prompt-executor.js";
export { createPromptExecutor } from "./prompt-executor.js";
export type { ParsedVerdict } from "./verdict.js";
export { mapVerdictToDecision, parseVerdictOutput, VerdictParseError } from "./verdict.js";
