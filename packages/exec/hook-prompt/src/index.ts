/**
 * @koi/hook-prompt — Single-shot LLM verification for agent hooks.
 */

export type {
  PromptModelCaller,
  PromptModelRequest,
  PromptModelResponse,
} from "./prompt-executor.js";
export { createPromptExecutor } from "./prompt-executor.js";
export type { ParsedVerdict } from "./verdict.js";
export { mapVerdictToDecision, parseVerdictOutput } from "./verdict.js";
