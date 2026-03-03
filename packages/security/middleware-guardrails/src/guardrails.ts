/**
 * Guardrails middleware factory — Zod-based output validation for model
 * and tool responses.
 *
 * Priority 375: runs after sanitize (350), before memory (400).
 */

import type { InboundMessage } from "@koi/core/message";
import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import { DEFAULT_MAX_BUFFER_SIZE, DEFAULT_MAX_RETRY_ATTEMPTS } from "./config.js";
import type {
  GuardrailAction,
  GuardrailError,
  GuardrailsConfig,
  GuardrailViolationEvent,
} from "./types.js";
import type { GuardrailValidationResult } from "./validate-output.js";
import { validateModelOutput, validateToolOutput } from "./validate-output.js";

/** Sender ID for retry context messages injected by guardrails. */
const GUARDRAILS_SENDER_ID = "system" as const;

export function createGuardrailsMiddleware(config: GuardrailsConfig): KoiMiddleware {
  const maxAttempts = config.retry?.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;
  const maxBufferSize = config.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  const onViolation = config.onViolation;

  // Partition rules by target at factory time
  const modelOutputRules = config.rules.filter((r) => r.target === "modelOutput");
  const toolOutputRules = config.rules.filter((r) => r.target === "toolOutput");

  // Further partition model rules by parseMode for efficient lookup
  const jsonModelRules = modelOutputRules.filter((r) => (r.parseMode ?? "json") === "json");
  const textModelRules = modelOutputRules.filter((r) => r.parseMode === "text");

  const hasModelOutputRules = modelOutputRules.length > 0;
  const hasToolOutputRules = toolOutputRules.length > 0;

  // Pre-built map for O(1) rule lookup by name
  const rulesByName = new Map(config.rules.map((r) => [r.name, r]));

  /** Fire violation event and return the action of the failed rule. */
  function fireViolation(
    failedRuleName: string,
    target: "modelOutput" | "toolOutput",
    errors: readonly GuardrailError[],
    attempt?: number,
  ): GuardrailAction {
    const rule = rulesByName.get(failedRuleName);
    const action = rule?.action ?? "block";
    const event: GuardrailViolationEvent = {
      rule: failedRuleName,
      target,
      action,
      errors,
      ...(attempt !== undefined ? { attempt } : {}),
    };
    onViolation?.(event);
    return action;
  }

  /** Format Zod errors as a string for injection into retry request messages. */
  function formatErrors(errors: readonly GuardrailError[]): string {
    return errors.map((e) => `${e.path || "root"}: ${e.message}`).join("; ");
  }

  /** Validate content against all model rules (JSON first, then text). */
  function validateAllModelRules(content: string): GuardrailValidationResult {
    const jsonResult = validateModelOutput(content, jsonModelRules, "json");
    if (!jsonResult.valid) return jsonResult;
    if (textModelRules.length === 0) return jsonResult;
    return validateModelOutput(content, textModelRules, "text");
  }

  /**
   * Handle a model output validation failure in wrapModelCall.
   * Returns "warn" if the response should pass through, "retry" if the
   * caller should retry. Throws KoiRuntimeError for "block" or exhausted retries.
   */
  function handleCallFailure(result: GuardrailValidationResult, attempt: number): "warn" | "retry" {
    const action = fireViolation(
      result.failedRule ?? "unknown",
      "modelOutput",
      result.errors,
      attempt,
    );
    if (action === "warn") return "warn";
    if (action === "retry" && attempt < maxAttempts) return "retry";
    // Block action, or retry attempts exhausted
    const label =
      attempt >= maxAttempts ? `failed after ${maxAttempts} attempt(s)` : "blocked output";
    throw KoiRuntimeError.from(
      "VALIDATION",
      `Guardrail "${result.failedRule}" ${label}: ${formatErrors(result.errors)}`,
      {
        context: { rule: result.failedRule, errors: result.errors },
      },
    );
  }

  /**
   * Handle a model output validation failure in wrapModelStream.
   * Streaming cannot retry (content already yielded), so "retry" degrades to "warn".
   * Only "block" action throws; "warn" and "retry" both pass through silently.
   */
  function handleStreamFailure(result: GuardrailValidationResult): void {
    fireViolation(result.failedRule ?? "unknown", "modelOutput", result.errors);
    const rule = rulesByName.get(result.failedRule ?? "");
    if (rule?.action === "block") {
      throw KoiRuntimeError.from(
        "VALIDATION",
        `Guardrail "${result.failedRule}" blocked streamed output: ${formatErrors(result.errors)}`,
        { context: { rule: result.failedRule } },
      );
    }
  }

  /** Inject validation errors into the request for a retry attempt. */
  function injectRetryContext(
    request: ModelRequest,
    previousContent: string,
    errors: readonly GuardrailError[],
  ): ModelRequest {
    const errorMessage = formatErrors(errors);
    const retryMessage: InboundMessage = {
      content: [
        {
          kind: "text",
          text: `Your previous response failed validation: ${errorMessage}. Previous response: ${previousContent.slice(0, 500)}. Please fix the errors and respond with valid output.`,
        },
      ],
      senderId: GUARDRAILS_SENDER_ID,
      timestamp: Date.now(),
    };
    return { ...request, messages: [...request.messages, retryMessage] };
  }

  const capabilityFragment: CapabilityFragment = {
    label: "guardrails",
    description: `Output validation active. Max ${maxAttempts} retries`,
  };

  // Build middleware with conditional hook registration
  const middleware: KoiMiddleware = {
    name: "guardrails",
    priority: 375,

    describeCapabilities: (_ctx: TurnContext) => capabilityFragment,

    // Only register wrapModelCall/wrapModelStream if model output rules exist
    ...(hasModelOutputRules
      ? {
          async wrapModelCall(
            _ctx: TurnContext,
            request: ModelRequest,
            next: ModelHandler,
          ): Promise<ModelResponse> {
            // let justified: request changes across retry attempts
            let currentRequest = request;

            for (
              // let justified: attempt counter increments across retries
              let attempt = 1;
              attempt <= maxAttempts;
              attempt++
            ) {
              const response = await next(currentRequest);
              const result = validateAllModelRules(response.content);
              if (result.valid) return response;

              const disposition = handleCallFailure(result, attempt);
              if (disposition === "warn") return response;
              // disposition === "retry"
              currentRequest = injectRetryContext(request, response.content, result.errors);
            }

            // Should not reach here, but satisfy TypeScript
            throw KoiRuntimeError.from("INTERNAL", "Guardrails retry loop exhausted unexpectedly");
          },

          async *wrapModelStream(
            _ctx: TurnContext,
            request: ModelRequest,
            next: ModelStreamHandler,
          ): AsyncIterable<ModelChunk> {
            // let justified: buffer grows across stream chunks
            let buffer = "";
            // let justified: track buffer overflow state
            let overflowed = false;

            for await (const chunk of next(request)) {
              switch (chunk.kind) {
                case "text_delta": {
                  if (!overflowed) {
                    if (buffer.length + chunk.delta.length > maxBufferSize) {
                      overflowed = true;
                      onViolation?.({
                        rule: "stream-buffer-overflow",
                        target: "modelOutput",
                        action: "warn",
                        errors: [
                          {
                            path: "",
                            message: `Stream buffer exceeded ${maxBufferSize} characters, skipping validation`,
                            code: "buffer_overflow",
                          },
                        ],
                      });
                    } else {
                      buffer += chunk.delta;
                    }
                  }
                  yield chunk;
                  break;
                }
                case "done": {
                  if (!overflowed && buffer.length > 0) {
                    const result = validateAllModelRules(buffer);
                    buffer = ""; // Release memory before potential throw
                    if (!result.valid) handleStreamFailure(result);
                  }
                  buffer = ""; // Release memory
                  yield chunk;
                  break;
                }
                default: {
                  yield chunk;
                }
              }
            }
          },
        }
      : {}),

    // Only register wrapToolCall if tool output rules exist
    ...(hasToolOutputRules
      ? {
          async wrapToolCall(
            _ctx: TurnContext,
            request: ToolRequest,
            next: ToolHandler,
          ): Promise<ToolResponse> {
            const response = await next(request);

            const result = validateToolOutput(response.output, toolOutputRules);
            if (!result.valid) {
              const action = fireViolation(
                result.failedRule ?? "unknown",
                "toolOutput",
                result.errors,
              );

              if (action === "warn") return response;

              // block or retry (retry not supported for tool calls — treat as block)
              throw KoiRuntimeError.from(
                "VALIDATION",
                `Guardrail "${result.failedRule}" blocked tool "${request.toolId}" output: ${formatErrors(result.errors)}`,
                {
                  context: {
                    rule: result.failedRule,
                    toolId: request.toolId,
                    errors: result.errors,
                  },
                },
              );
            }

            return response;
          },
        }
      : {}),
  };

  return middleware;
}
