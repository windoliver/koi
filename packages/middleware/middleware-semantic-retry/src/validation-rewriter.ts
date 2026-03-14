/**
 * Validation-specific PromptRewriter plugin.
 *
 * For validation_failure retry actions, injects the actual error message
 * (Zod issues, JSON parse error, etc.) as a system message with the
 * "[VALIDATION ERROR]" prefix. Falls back to an optional delegate
 * rewriter for non-validation retry actions.
 */

import type { InboundMessage, ModelRequest } from "@koi/core";
import type { PromptRewriter, RetryAction, RewriteContext } from "./types.js";

const SENDER_ID = "system:validation-rewriter";

// ---------------------------------------------------------------------------
// Message helpers
// ---------------------------------------------------------------------------

function createInjectedMessage(text: string): InboundMessage {
  return {
    senderId: SENDER_ID,
    content: [{ kind: "text", text }] as const,
    timestamp: Date.now(),
  };
}

function prependMessage(request: ModelRequest, message: InboundMessage): ModelRequest {
  return { ...request, messages: [message, ...request.messages] };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a validation-specific PromptRewriter.
 *
 * For validation_failure actions (identified via RewriteContext.failureClass.kind),
 * injects the actual error message as a system message with the
 * "[VALIDATION ERROR]" prefix instead of generic retry guidance.
 *
 * Falls back to the provided fallback rewriter for non-validation retry actions.
 * If no fallback is provided and a non-validation action is received, returns
 * the request unchanged.
 */
export function createValidationRewriter(fallback?: PromptRewriter): PromptRewriter {
  return {
    rewrite(
      request: ModelRequest,
      action: RetryAction,
      ctx: RewriteContext,
    ): ModelRequest | Promise<ModelRequest> {
      // Only handle validation_failure — delegate everything else
      if (ctx.failureClass.kind !== "validation_failure") {
        if (fallback !== undefined) {
          return fallback.rewrite(request, action, ctx);
        }
        return request;
      }

      // For abort actions, throw (same pattern as default rewriter)
      if (action.kind === "abort") {
        throw new Error(`Semantic retry aborted: ${action.reason}`);
      }

      // Extract error details from the action context or failure reason
      const errorDetails = action.kind === "add_context" ? action.context : ctx.failureClass.reason;

      const message = createInjectedMessage(
        [
          "[VALIDATION ERROR] Your previous output failed validation:",
          errorDetails,
          "Fix the output to conform to the expected schema.",
        ].join("\n"),
      );

      return prependMessage(request, message);
    },
  };
}
