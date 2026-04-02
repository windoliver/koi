/**
 * Prompt hook executor — single-shot LLM verification.
 *
 * Injects a PromptModelCaller to decouple from any specific LLM SDK.
 */

import type { HookEvent, HookExecutor, HookVerdict, PromptHookConfig } from "@koi/core";
import { mapVerdictToDecision, parseVerdictOutput } from "./verdict.js";

// ---------------------------------------------------------------------------
// Model caller contract (injected dependency)
// ---------------------------------------------------------------------------

export interface PromptModelRequest {
  readonly model: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  readonly maxTokens: number;
  readonly timeoutMs: number;
}

export interface PromptModelResponse {
  readonly text: string;
}

export interface PromptModelCaller {
  readonly complete: (request: PromptModelRequest) => Promise<PromptModelResponse>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = "haiku";
const DEFAULT_MAX_TOKENS = 256;
const DEFAULT_TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT_SUFFIX = [
  "You are a verification hook. Evaluate the event below and decide whether it should proceed.",
  'Respond ONLY with JSON: { "ok": true/false, "reason": "..." }',
  'Set "ok" to true if the action is safe and appropriate, false otherwise.',
  'Always include a brief "reason" explaining your decision.',
].join("\n");

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a prompt hook executor backed by the given model caller.
 */
export function createPromptExecutor(caller: PromptModelCaller): HookExecutor<PromptHookConfig> {
  return {
    kind: "prompt",

    async execute(config: PromptHookConfig, event: HookEvent): Promise<HookVerdict> {
      const failMode = config.failMode ?? "closed";

      try {
        const systemPrompt = `${config.prompt}\n\n${SYSTEM_PROMPT_SUFFIX}`;
        const userPrompt = formatEvent(event);
        const model = config.model ?? DEFAULT_MODEL;
        const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
        const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        const response = await caller.complete({
          model,
          systemPrompt,
          userPrompt,
          maxTokens,
          timeoutMs,
        });

        const verdict = parseVerdictOutput(response.text);
        return mapVerdictToDecision(verdict);
      } catch (e: unknown) {
        if (failMode === "open") {
          return { kind: "continue" };
        }
        const message = e instanceof Error ? e.message : "Unknown prompt hook error";
        return { kind: "block", reason: `Prompt hook failed (fail-closed): ${message}` };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEvent(event: HookEvent): string {
  const parts: readonly string[] = [
    `Event: ${event.kind}`,
    ...(event.toolName !== undefined ? [`Tool: ${event.toolName}`] : []),
    ...(event.data !== undefined ? [`Data: ${JSON.stringify(event.data)}`] : []),
  ];
  return parts.join("\n");
}
