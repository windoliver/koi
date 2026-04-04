/**
 * @koi/middleware-semantic-retry — Context-aware prompt rewriting on agent failure.
 *
 * Analyzes *why* a model/tool call failed via pluggable FailureAnalyzer,
 * then rewrites the prompt via pluggable PromptRewriter.
 *
 * 6 retry actions: narrow_scope, add_context, redirect, decompose, escalate_model, abort.
 *
 * Emits retry signals via RetrySignalWriter for event-trace trajectory annotation.
 */

export { createDefaultFailureAnalyzer } from "./default-analyzer.js";
export { createDefaultPromptRewriter } from "./default-rewriter.js";
export { createRetrySignalBroker } from "./retry-signal-broker.js";
export { createSemanticRetryMiddleware } from "./semantic-retry.js";
export type {
  FailureAnalyzer,
  FailureClass,
  FailureClassKind,
  FailureContext,
  OnRetryCallback,
  PromptRewriter,
  RetryAction,
  RetryActionKind,
  RetryRecord,
  RewriteContext,
  SemanticRetryConfig,
  SemanticRetryHandle,
  ToolFailureRequest,
} from "./types.js";
