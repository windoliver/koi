/**
 * Types for the semantic-retry middleware.
 *
 * Defines the pluggable interfaces (FailureAnalyzer, PromptRewriter),
 * discriminated unions (FailureClass, RetryAction), and configuration.
 */

import type { JsonObject, KoiMiddleware, ModelRequest } from "@koi/core";

// ---------------------------------------------------------------------------
// Failure Classification
// ---------------------------------------------------------------------------

/**
 * Discriminated union of recognized failure categories.
 * The analyzer maps raw errors into one of these classes.
 */
export type FailureClassKind =
  | "hallucination"
  | "tool_misuse"
  | "scope_drift"
  | "token_exhaustion"
  | "api_error"
  | "validation_failure"
  | "unknown";

export interface FailureClass {
  readonly kind: FailureClassKind;
  /** Human-readable explanation of why this classification was chosen. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Retry Actions
// ---------------------------------------------------------------------------

/** One of the 6 actions the middleware can take after a failure. */
export type RetryAction =
  | { readonly kind: "narrow_scope"; readonly focusArea: string }
  | { readonly kind: "add_context"; readonly context: string }
  | { readonly kind: "redirect"; readonly newApproach: string }
  | { readonly kind: "decompose"; readonly subtasks: readonly string[] }
  | { readonly kind: "escalate_model"; readonly targetModel: string }
  | { readonly kind: "abort"; readonly reason: string };

export type RetryActionKind = RetryAction["kind"];

// ---------------------------------------------------------------------------
// Retry Records
// ---------------------------------------------------------------------------

/** One entry per retry attempt — immutable history. */
export interface RetryRecord {
  readonly timestamp: number;
  readonly failureClass: FailureClass;
  readonly actionTaken: RetryAction;
  readonly succeeded: boolean;
}

// ---------------------------------------------------------------------------
// Analyzer Context
// ---------------------------------------------------------------------------

/** Context passed to FailureAnalyzer.classify(). */
export interface FailureContext {
  /** The caught error or failure value. */
  readonly error: unknown;
  /** The request that produced the failure (model or tool). */
  readonly request: ModelRequest | ToolFailureRequest;
  /** Immutable history of previous retry attempts. */
  readonly records: readonly RetryRecord[];
  /** Current turn index. */
  readonly turnIndex: number;
}

/** Minimal info about a tool call that failed (no ToolRequest import needed for consumers). */
export interface ToolFailureRequest {
  readonly kind: "tool";
  readonly toolId: string;
  readonly input: JsonObject;
}

// ---------------------------------------------------------------------------
// Rewriter Context
// ---------------------------------------------------------------------------

/** Context passed to PromptRewriter.rewrite(). */
export interface RewriteContext {
  readonly failureClass: FailureClass;
  readonly records: readonly RetryRecord[];
  readonly turnIndex: number;
}

// ---------------------------------------------------------------------------
// Pluggable Interfaces
// ---------------------------------------------------------------------------

/**
 * Analyzes a failure and selects a retry action.
 *
 * Two-phase design:
 * - classify: determines *what kind* of failure occurred
 * - selectAction: maps the classification + history to an action
 */
export interface FailureAnalyzer {
  readonly classify: (ctx: FailureContext) => FailureClass | Promise<FailureClass>;
  readonly selectAction: (failure: FailureClass, records: readonly RetryRecord[]) => RetryAction;
}

/**
 * Rewrites a ModelRequest based on the chosen retry action.
 * Returns a new ModelRequest — must not mutate the input.
 */
export interface PromptRewriter {
  readonly rewrite: (
    request: ModelRequest,
    action: RetryAction,
    ctx: RewriteContext,
  ) => ModelRequest | Promise<ModelRequest>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Callback invoked after each retry attempt for observability. */
export type OnRetryCallback = (record: RetryRecord) => void;

export interface SemanticRetryConfig {
  /** Custom failure analyzer (default: createDefaultFailureAnalyzer()). */
  readonly analyzer?: FailureAnalyzer | undefined;
  /** Custom prompt rewriter (default: createDefaultPromptRewriter()). */
  readonly rewriter?: PromptRewriter | undefined;
  /** Maximum number of retries before forced abort (default: 3). */
  readonly maxRetries?: number | undefined;
  /** Maximum retry records to keep in memory (default: 20). */
  readonly maxHistorySize?: number | undefined;
  /** Timeout for analyzer.classify() in ms (default: 5000). */
  readonly analyzerTimeoutMs?: number | undefined;
  /** Timeout for rewriter.rewrite() in ms (default: 5000). */
  readonly rewriterTimeoutMs?: number | undefined;
  /** Observability callback, invoked after each retry attempt. */
  readonly onRetry?: OnRetryCallback | undefined;
}

// ---------------------------------------------------------------------------
// Handle (returned by factory)
// ---------------------------------------------------------------------------

/** Handle returned by createSemanticRetryMiddleware(). */
export interface SemanticRetryHandle {
  /** The KoiMiddleware instance to register in the middleware chain. */
  readonly middleware: KoiMiddleware;
  /** Returns an immutable snapshot of retry history. */
  readonly getRecords: () => readonly RetryRecord[];
  /** Returns remaining retry budget. */
  readonly getRetryBudget: () => number;
  /** Resets all state (records, budget, pending action). */
  readonly reset: () => void;
}
