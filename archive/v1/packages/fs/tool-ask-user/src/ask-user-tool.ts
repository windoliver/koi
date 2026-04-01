/**
 * Ask-user tool factory — creates a Tool that asks users structured questions.
 */

import { DEFAULT_UNSANDBOXED_POLICY } from "@koi/core";
import type { JsonObject } from "@koi/core/common";
import type { Tool, ToolExecuteOptions } from "@koi/core/ecs";
import type { ElicitationQuestion } from "@koi/core/elicitation";
import { createQuestionSchema, validateHandlerResponse, validateQuestionInput } from "./schemas.js";
import {
  ASK_USER_TOOL_DESCRIPTOR,
  type AskUserConfig,
  DEFAULT_MAX_OPTIONS,
  DEFAULT_TIMEOUT_MS,
} from "./types.js";

/**
 * Creates the `ask_user` tool for structured user elicitation.
 *
 * Flow:
 * 1. Parse + validate input args → `ElicitationQuestion`
 * 2. Enforce configured limits (maxOptions)
 * 3. Compose AbortSignal from tool timeout + engine signal
 * 4. Call `config.handler(question, composedSignal)`
 * 5. Validate response: selected labels match question options
 * 6. Return `ElicitationResult` as tool output
 */
export function createAskUserTool(config: AskUserConfig): Tool {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOptions = config.maxOptions ?? DEFAULT_MAX_OPTIONS;
  const questionSchema = createQuestionSchema(maxOptions);

  return {
    descriptor: ASK_USER_TOOL_DESCRIPTOR,
    origin: "primordial",
    policy: DEFAULT_UNSANDBOXED_POLICY,

    async execute(args: JsonObject, options?: ToolExecuteOptions): Promise<unknown> {
      // 1. Validate input
      const inputResult = validateQuestionInput(args, questionSchema);
      if (!inputResult.ok) {
        return { error: inputResult.error.message, code: "VALIDATION" };
      }

      const question: ElicitationQuestion = inputResult.value;

      // 2. Compose abort signals: tool timeout + engine signal
      const signals: AbortSignal[] = options?.signal
        ? [AbortSignal.timeout(timeoutMs), options.signal]
        : [AbortSignal.timeout(timeoutMs)];
      const composedSignal = AbortSignal.any(signals);

      // 3. Call handler
      // let justified: assigned in try, used after catch for response validation
      let rawResponse: unknown;
      try {
        rawResponse = await config.handler(question, composedSignal);
      } catch (e: unknown) {
        if (isAbortOrTimeout(e)) {
          return {
            error: "User did not respond within timeout",
            code: "TIMEOUT",
          };
        }
        const message = e instanceof Error ? e.message : "Unknown handler error";
        return { error: message, code: "EXTERNAL" };
      }

      // 4. Validate response
      const responseResult = validateHandlerResponse(rawResponse, question);
      if (!responseResult.ok) {
        return { error: responseResult.error.message, code: "VALIDATION" };
      }

      return responseResult.value;
    },
  };
}

/**
 * Check if an error is from signal abort or timeout.
 * AbortSignal.abort() throws "AbortError", AbortSignal.timeout() throws "TimeoutError".
 */
function isAbortOrTimeout(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError");
}
