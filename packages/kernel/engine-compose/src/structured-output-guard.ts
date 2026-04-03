/**
 * Structured output guard — enforces that a spawned agent calls a required
 * tool before completing.
 *
 * When `outputSchema` is set on the spawn request, this guard:
 * 1. Tracks tool calls during each turn via `wrapToolCall`
 * 2. After each model response, checks if the required tool was called
 * 3. If the agent tries to complete without calling it, injects a re-prompt
 *    message forcing the agent to call the tool
 *
 * This is the L1 equivalent of Claude Code's `registerStructuredOutputEnforcement`.
 * The guard works with any tool name — for hook agents, it enforces `HookVerdict`.
 */

import type { CapabilityFragment, KoiMiddleware, ModelRequest } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Configuration for the structured output guard. */
export interface StructuredOutputGuardConfig {
  /** The tool name that must be called before the agent can complete. */
  readonly requiredToolName: string;
  /** Maximum number of re-prompts before giving up. Default: 2. */
  readonly maxReprompts?: number | undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_REPROMPTS = 2;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a guard middleware that enforces structured output via a required tool call.
 *
 * The guard monitors tool calls and, if the model produces a response without
 * calling the required tool, wraps the next model call with a system-level hint
 * forcing the tool call. After `maxReprompts` attempts, the guard gives up
 * (the L2 executor handles the missing verdict via fail-closed).
 */
export function createStructuredOutputGuard(config: StructuredOutputGuardConfig): KoiMiddleware {
  const { requiredToolName, maxReprompts = DEFAULT_MAX_REPROMPTS } = config;

  /** Whether the required tool has been called in this session. */
  let toolCalled = false;
  /** Number of re-prompt injections so far. */
  let repromptCount = 0;

  return {
    name: "koi:structured-output-guard",
    phase: "intercept",
    priority: 50, // Run early (after iteration guard at 0, before user middleware)

    async onSessionStart(): Promise<void> {
      toolCalled = false;
      repromptCount = 0;
    },

    async wrapToolCall(_ctx, request, next) {
      const response = await next(request);

      // Track if the required tool was successfully called
      if (request.toolId === requiredToolName) {
        toolCalled = true;
      }

      return response;
    },

    async wrapModelCall(_ctx, request, next) {
      // If the tool hasn't been called yet and we have re-prompt budget,
      // inject a hint into the request
      const effectiveRequest = maybeInjectHint(
        request,
        toolCalled,
        repromptCount,
        maxReprompts,
        requiredToolName,
      );
      if (effectiveRequest !== request) {
        repromptCount++;
      }

      return next(effectiveRequest);
    },

    async *wrapModelStream(_ctx, request, next) {
      const effectiveRequest = maybeInjectHint(
        request,
        toolCalled,
        repromptCount,
        maxReprompts,
        requiredToolName,
      );
      if (effectiveRequest !== request) {
        repromptCount++;
      }

      yield* next(effectiveRequest);
    },

    describeCapabilities(): CapabilityFragment | undefined {
      return {
        label: "structured-output",
        description: `Requires tool: ${requiredToolName}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * If the required tool hasn't been called and re-prompt budget remains,
 * append a system hint to the model request forcing the tool call.
 */
function maybeInjectHint(
  request: ModelRequest,
  toolCalled: boolean,
  repromptCount: number,
  maxReprompts: number,
  requiredToolName: string,
): ModelRequest {
  if (toolCalled || repromptCount >= maxReprompts) {
    return request;
  }

  // Only inject after the first turn (give the agent a chance to call it naturally)
  if (request.messages.length === 0) {
    return request;
  }

  const hint =
    `You MUST call the ${requiredToolName} tool to complete this request. ` +
    `Call ${requiredToolName} now with your assessment.`;

  // Append hint to systemPrompt so the model actually sees it.
  // systemPrompt is the field that request mappers inject into the API call.
  const existingPrompt = request.systemPrompt ?? "";
  const separator = existingPrompt.length > 0 ? "\n\n" : "";
  return {
    ...request,
    systemPrompt: `${existingPrompt}${separator}${hint}`,
  };
}
