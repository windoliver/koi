/**
 * @koi/hook-prompt — Single-shot LLM verification for agent hooks.
 */

export { createPromptExecutor } from "./prompt-executor.js";
export type { PromptModelCaller, PromptModelRequest, PromptModelResponse } from "./prompt-executor.js";
export { mapVerdictToDecision, parseVerdictOutput } from "./verdict.js";
export type { ParsedVerdict } from "./verdict.js";
