/**
 * Default PromptRewriter implementation.
 *
 * Rewrites ModelRequest for each of the 6 RetryAction kinds.
 * Never mutates the input — always returns a new ModelRequest.
 */

import type { InboundMessage, ModelRequest } from "@koi/core";
import type { PromptRewriter, RetryAction, RewriteContext } from "./types.js";

// Use "system:" prefix so both the request mapper (maps system:* → system role)
// and event-trace (skips system/assistant senders) treat this as system guidance.
const SENDER_ID = "system:semantic-retry";

// ---------------------------------------------------------------------------
// Message injection helper
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
// Per-action rewriting
// ---------------------------------------------------------------------------

function rewriteNarrowScope(
  request: ModelRequest,
  action: Extract<RetryAction, { readonly kind: "narrow_scope" }>,
): ModelRequest {
  const message = createInjectedMessage(
    [
      "[RETRY GUIDANCE] Previous attempt was too broad.",
      `Focus specifically on: ${action.focusArea}`,
      "Do not attempt anything beyond this scope.",
    ].join("\n"),
  );
  return prependMessage(request, message);
}

function rewriteAddContext(
  request: ModelRequest,
  action: Extract<RetryAction, { readonly kind: "add_context" }>,
): ModelRequest {
  const message = createInjectedMessage(
    [
      "[RETRY GUIDANCE] Previous attempt failed.",
      `Additional context: ${action.context}`,
      "Use this information to avoid the same mistake.",
    ].join("\n"),
  );
  return prependMessage(request, message);
}

function rewriteRedirect(
  request: ModelRequest,
  action: Extract<RetryAction, { readonly kind: "redirect" }>,
): ModelRequest {
  const message = createInjectedMessage(
    [
      "[RETRY GUIDANCE] Previous approach failed.",
      `Try a different approach: ${action.newApproach}`,
      "Avoid repeating the previous strategy.",
    ].join("\n"),
  );
  return prependMessage(request, message);
}

function rewriteDecompose(
  request: ModelRequest,
  action: Extract<RetryAction, { readonly kind: "decompose" }>,
): ModelRequest {
  const subtaskList = action.subtasks.map((task, i) => `  ${i + 1}. ${task}`).join("\n");
  const message = createInjectedMessage(
    [
      "[RETRY GUIDANCE] Previous attempt was too complex.",
      "Break this into smaller steps and complete them one at a time:",
      subtaskList,
    ].join("\n"),
  );
  return prependMessage(request, message);
}

function rewriteEscalateModel(
  request: ModelRequest,
  action: Extract<RetryAction, { readonly kind: "escalate_model" }>,
): ModelRequest {
  const message = createInjectedMessage(
    [
      "[RETRY GUIDANCE] Escalating to a more capable model.",
      "Previous attempts with the current model failed repeatedly.",
      "Apply extra care and thoroughness to this task.",
    ].join("\n"),
  );
  return { ...prependMessage(request, message), model: action.targetModel };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a default PromptRewriter that handles all 6 RetryAction kinds.
 * For "abort", throws an error instead of rewriting.
 */
export function createDefaultPromptRewriter(): PromptRewriter {
  return {
    rewrite(request: ModelRequest, action: RetryAction, _ctx: RewriteContext): ModelRequest {
      switch (action.kind) {
        case "narrow_scope":
          return rewriteNarrowScope(request, action);
        case "add_context":
          return rewriteAddContext(request, action);
        case "redirect":
          return rewriteRedirect(request, action);
        case "decompose":
          return rewriteDecompose(request, action);
        case "escalate_model":
          return rewriteEscalateModel(request, action);
        case "abort":
          throw new Error(`Semantic retry aborted: ${action.reason}`);
      }
    },
  };
}
