/**
 * Core semantic-retry middleware factory.
 *
 * Creates a stateful middleware that:
 * 1. Detects model/tool call failures
 * 2. Analyzes them via pluggable FailureAnalyzer
 * 3. Rewrites prompts via pluggable PromptRewriter on subsequent calls
 *
 * State: internal mutable (let), exposed as immutable snapshots.
 */

import type {
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createDefaultFailureAnalyzer } from "./default-analyzer.js";
import { createDefaultPromptRewriter } from "./default-rewriter.js";
import type {
  FailureAnalyzer,
  FailureClass,
  FailureContext,
  PromptRewriter,
  RetryAction,
  RetryRecord,
  RewriteContext,
  SemanticRetryConfig,
  SemanticRetryHandle,
  ToolFailureRequest,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIDDLEWARE_NAME = "semantic-retry";
/** Priority 420: runs just inside guided-retry (425). Lower = outer layer. */
const MIDDLEWARE_PRIORITY = 420;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_HISTORY_SIZE = 20;
const DEFAULT_ANALYZER_TIMEOUT_MS = 5_000;
const DEFAULT_REWRITER_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

/**
 * Races a promise against a timeout. Returns the fallback value if the
 * promise doesn't resolve within timeoutMs.
 */
async function withTimeout<T>(promise: T | Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  if (!(promise instanceof Promise)) return promise;

  // let: mutable — cleared in the finally block to prevent leaks
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Fallback constants
// ---------------------------------------------------------------------------

const FALLBACK_FAILURE_CLASS: FailureClass = {
  kind: "unknown",
  reason: "Analyzer failed or timed out — using fallback classification",
};

function createFallbackAction(error: unknown): RetryAction {
  const message = error instanceof Error ? error.message : String(error);
  return { kind: "add_context", context: `Previous attempt failed: ${message}` };
}

// ---------------------------------------------------------------------------
// Internal helpers (extracted to keep functions < 50 lines)
// ---------------------------------------------------------------------------

function trimRecords(records: readonly RetryRecord[], maxSize: number): readonly RetryRecord[] {
  if (records.length <= maxSize) return records;
  return records.slice(records.length - maxSize);
}

/** Classify with timeout + error fallback. Returns class and whether fallback was used. */
async function classifyWithFallback(
  analyzer: FailureAnalyzer,
  ctx: FailureContext,
  timeoutMs: number,
): Promise<{ readonly failureClass: FailureClass; readonly classifyFailed: boolean }> {
  try {
    const failureClass = await withTimeout(
      analyzer.classify(ctx),
      timeoutMs,
      FALLBACK_FAILURE_CLASS,
    );
    return { failureClass, classifyFailed: failureClass === FALLBACK_FAILURE_CLASS };
  } catch (_e: unknown) {
    return { failureClass: FALLBACK_FAILURE_CLASS, classifyFailed: true };
  }
}

/** Select action with budget enforcement and fallback for broken analyzers. */
function selectActionWithFallback(
  analyzer: FailureAnalyzer,
  failureClass: FailureClass,
  records: readonly RetryRecord[],
  budget: number,
  maxRetries: number,
  originalError: unknown,
  classifyFailed: boolean,
): RetryAction {
  if (budget <= 0) {
    return { kind: "abort", reason: `Retry budget exhausted after ${maxRetries} attempts` };
  }
  if (classifyFailed) return createFallbackAction(originalError);
  try {
    return analyzer.selectAction(failureClass, records);
  } catch (_e: unknown) {
    return createFallbackAction(originalError);
  }
}

/** Rewrite with timeout + error fallback to original request. */
async function rewriteWithFallback(
  rewriter: PromptRewriter,
  request: ModelRequest,
  action: RetryAction,
  ctx: RewriteContext,
  timeoutMs: number,
): Promise<ModelRequest> {
  try {
    return await withTimeout(rewriter.rewrite(request, action, ctx), timeoutMs, request);
  } catch (_e: unknown) {
    // Rewriter threw (e.g., abort action) or errored — use original
    return request;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSemanticRetryMiddleware(config: SemanticRetryConfig): SemanticRetryHandle {
  const analyzer: FailureAnalyzer = config.analyzer ?? createDefaultFailureAnalyzer();
  const rewriter = config.rewriter ?? createDefaultPromptRewriter();
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxHistorySize = config.maxHistorySize ?? DEFAULT_MAX_HISTORY_SIZE;
  const analyzerTimeoutMs = config.analyzerTimeoutMs ?? DEFAULT_ANALYZER_TIMEOUT_MS;
  const rewriterTimeoutMs = config.rewriterTimeoutMs ?? DEFAULT_REWRITER_TIMEOUT_MS;
  const onRetry = config.onRetry;

  // let: mutable state — this middleware is stateful by design.
  // It tracks retry history within a session and manages a pending retry action
  // that will be applied to the next model call.
  let records: readonly RetryRecord[] = [];
  let pendingAction: RetryAction | undefined;
  let budget: number = maxRetries;

  async function handleFailure(
    error: unknown,
    request: ModelRequest | ToolFailureRequest,
    turnIndex: number,
  ): Promise<void> {
    // Guard: skip analysis once budget is exhausted — prevents negative counter
    if (budget <= 0) return;

    const ctx: FailureContext = { error, request, records, turnIndex };
    const { failureClass, classifyFailed } = await classifyWithFallback(
      analyzer,
      ctx,
      analyzerTimeoutMs,
    );

    budget--;
    const action = selectActionWithFallback(
      analyzer,
      failureClass,
      records,
      budget,
      maxRetries,
      error,
      classifyFailed,
    );

    const record: RetryRecord = {
      timestamp: Date.now(),
      failureClass,
      actionTaken: action,
      succeeded: false,
    };
    records = trimRecords([...records, record], maxHistorySize);
    pendingAction = action;
    onRetry?.(record);
  }

  const middleware: KoiMiddleware = {
    name: MIDDLEWARE_NAME,
    priority: MIDDLEWARE_PRIORITY,

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      // Guard clause: fast path when no pending action
      if (pendingAction === undefined) {
        try {
          return await next(request);
        } catch (e: unknown) {
          await handleFailure(e, request, ctx.turnIndex);
          throw e;
        }
      }

      // Abort: throw immediately without calling next
      if (pendingAction.kind === "abort") {
        const reason = pendingAction.reason;
        pendingAction = undefined;
        throw new Error(`Semantic retry aborted: ${reason}`);
      }

      // Build rewrite context from latest failure record
      const lastClass = records[records.length - 1]?.failureClass ?? FALLBACK_FAILURE_CLASS;
      const rewriteCtx: RewriteContext = {
        failureClass: lastClass,
        records,
        turnIndex: ctx.turnIndex,
      };
      const modifiedRequest = await rewriteWithFallback(
        rewriter,
        request,
        pendingAction,
        rewriteCtx,
        rewriterTimeoutMs,
      );
      pendingAction = undefined;

      try {
        return await next(modifiedRequest);
      } catch (e: unknown) {
        await handleFailure(e, request, ctx.turnIndex);
        throw e;
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: (request: ToolRequest) => Promise<ToolResponse>,
    ): Promise<ToolResponse> {
      try {
        return await next(request);
      } catch (e: unknown) {
        const toolFailure: ToolFailureRequest = {
          kind: "tool",
          toolId: request.toolId,
          input: request.input,
        };
        await handleFailure(e, toolFailure, ctx.turnIndex);
        throw e;
      }
    },
  };

  return {
    middleware,
    getRecords: () => records,
    getRetryBudget: () => budget,
    reset: () => {
      records = [];
      pendingAction = undefined;
      budget = maxRetries;
    },
  };
}
