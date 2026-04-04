/**
 * Core semantic-retry middleware factory.
 *
 * Creates a stateful middleware that:
 * 1. Detects model/tool call failures
 * 2. Analyzes them via pluggable FailureAnalyzer
 * 3. Rewrites prompts via pluggable PromptRewriter on subsequent calls
 * 4. Emits retry signals via RetrySignalWriter for trajectory annotation
 *
 * State: internal mutable (let), exposed as immutable snapshots.
 */

import type {
  CapabilityFragment,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  SessionContext,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createDefaultFailureAnalyzer } from "./default-analyzer.js";
import { createDefaultPromptRewriter } from "./default-rewriter.js";
import type {
  FailureAnalyzer,
  FailureClass,
  FailureClassKind,
  FailureContext,
  PromptRewriter,
  RetryAction,
  RetryRecord,
  RewriteContext,
  SemanticRetryConfig,
  SemanticRetryHandle,
  ToolFailureRequest,
} from "./types.js";

/** All recognized failure class kinds — used to initialize per-class budgets. */
const FAILURE_CLASS_KINDS: readonly FailureClassKind[] = [
  "hallucination",
  "tool_misuse",
  "scope_drift",
  "token_exhaustion",
  "api_error",
  "validation_failure",
  "unknown",
] as const;

/** Per-session mutable state for the semantic-retry middleware. */
interface SemanticRetrySessionState {
  records: readonly RetryRecord[];
  pendingAction: RetryAction | undefined;
  budgets: Record<FailureClassKind, number>;
}

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
// Inline trimToRecent (replaces @koi/failure-context dependency)
// ---------------------------------------------------------------------------

/** Trim an array to the most recent N entries (keeps the tail). */
function trimToRecent<T>(items: readonly T[], maxSize: number): readonly T[] {
  if (items.length <= maxSize) return items;
  return items.slice(items.length - maxSize);
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
// Response failure detection
// ---------------------------------------------------------------------------

/** Non-success stop reasons that indicate a model call failure, not a completion. */
const NON_SUCCESS_STOP_REASONS = new Set(["error", "hook_blocked"]);

/**
 * Check if a ModelResponse represents a failure (non-success stop reason).
 * These responses are returned normally (not thrown) but should be treated
 * as failures for retry purposes.
 */
function isFailedResponse(response: ModelResponse): boolean {
  return response.stopReason !== undefined && NON_SUCCESS_STOP_REASONS.has(response.stopReason);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSemanticRetryMiddleware(config: SemanticRetryConfig): SemanticRetryHandle {
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const budgetOverrides = config.budgetOverrides ?? {};
  // Abort threshold must accommodate the largest per-class budget override
  // so the analyzer doesn't abort early for classes with extended budgets.
  const overrideValues = Object.values(budgetOverrides).filter((v): v is number => v !== undefined);
  const effectiveAbortThreshold =
    overrideValues.length > 0 ? Math.max(maxRetries, ...overrideValues) : maxRetries;
  const analyzer: FailureAnalyzer =
    config.analyzer ?? createDefaultFailureAnalyzer({ abortThreshold: effectiveAbortThreshold });
  const rewriter = config.rewriter ?? createDefaultPromptRewriter();
  const maxHistorySize = config.maxHistorySize ?? DEFAULT_MAX_HISTORY_SIZE;
  const analyzerTimeoutMs = config.analyzerTimeoutMs ?? DEFAULT_ANALYZER_TIMEOUT_MS;
  const rewriterTimeoutMs = config.rewriterTimeoutMs ?? DEFAULT_REWRITER_TIMEOUT_MS;
  const onRetry = config.onRetry;
  const signalWriter = config.signalWriter;

  /** Returns the minimum remaining budget across all failure classes. */
  function minBudget(budgets: Readonly<Record<FailureClassKind, number>>): number {
    return Math.min(...Object.values(budgets));
  }

  // Per-session state map — keyed by sessionId to prevent cross-session leaks.
  const sessions = new Map<string, SemanticRetrySessionState>();

  function getSession(sessionId: string): SemanticRetrySessionState | undefined {
    return sessions.get(sessionId);
  }

  function createInitialBudgets(): Record<FailureClassKind, number> {
    const budgets = {} as Record<FailureClassKind, number>;
    for (const kind of FAILURE_CLASS_KINDS) {
      budgets[kind] = budgetOverrides[kind] ?? maxRetries;
    }
    return budgets;
  }

  function createSessionState(): SemanticRetrySessionState {
    return { records: [], pendingAction: undefined, budgets: createInitialBudgets() };
  }

  async function handleFailure(
    sessionId: string,
    state: SemanticRetrySessionState,
    error: unknown,
    request: ModelRequest | ToolFailureRequest,
    turnIndex: number,
  ): Promise<void> {
    const ctx: FailureContext = { error, request, records: state.records, turnIndex };
    const { failureClass, classifyFailed } = await classifyWithFallback(
      analyzer,
      ctx,
      analyzerTimeoutMs,
    );

    const classBudget = state.budgets[failureClass.kind] ?? 0;
    // When budget is exhausted, record an abort and set pendingAction so the
    // next wrapModelCall/wrapModelStream fails deterministically.
    if (classBudget <= 0) {
      const abortAction: RetryAction = {
        kind: "abort",
        reason: `Retry budget exhausted for ${failureClass.kind}`,
      };
      const record: RetryRecord = {
        timestamp: Date.now(),
        failureClass,
        actionTaken: abortAction,
        succeeded: false,
      };
      state.records = trimToRecent([...state.records, record], maxHistorySize);
      state.pendingAction = abortAction;
      try {
        onRetry?.(record);
      } catch {
        // Observer callback must not mask the original failure
      }
      signalWriter?.clearRetrySignal(sessionId);
      return;
    }

    // Select action BEFORE decrementing so maxRetries:1 allows one retry
    const effectiveMax = budgetOverrides[failureClass.kind] ?? maxRetries;
    const action = selectActionWithFallback(
      analyzer,
      failureClass,
      state.records,
      classBudget,
      effectiveMax,
      error,
      classifyFailed,
    );

    state.budgets[failureClass.kind] = classBudget - 1;

    const record: RetryRecord = {
      timestamp: Date.now(),
      failureClass,
      actionTaken: action,
      succeeded: false,
    };
    state.records = trimToRecent([...state.records, record], maxHistorySize);
    state.pendingAction = action;
    try {
      onRetry?.(record);
    } catch {
      // Observer callback must not mask the original failure
    }

    // Emit retry signal for event-trace coordination
    if (signalWriter !== undefined && action.kind !== "abort") {
      signalWriter.setRetrySignal(sessionId, {
        retrying: true,
        originTurnIndex: turnIndex,
        reason: failureClass.reason,
        failureClass: failureClass.kind,
        attemptNumber: state.records.length,
      });
    }
  }

  const middleware: KoiMiddleware = {
    name: MIDDLEWARE_NAME,
    priority: MIDDLEWARE_PRIORITY,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId as string, createSessionState());
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      signalWriter?.clearRetrySignal(ctx.sessionId as string);
      sessions.delete(ctx.sessionId as string);
    },

    describeCapabilities: (ctx: TurnContext): CapabilityFragment => {
      const state = getSession(ctx.session.sessionId as string);
      const currentBudget = state !== undefined ? minBudget(state.budgets) : maxRetries;
      return {
        label: "semantic-retry",
        description: `Semantic retry: ${String(currentBudget)}/${String(maxRetries)} retries remaining, failure analysis + prompt rewrite`,
      };
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: (request: ModelRequest) => Promise<ModelResponse>,
    ): Promise<ModelResponse> {
      const sessionId = ctx.session.sessionId as string;
      const state = getSession(sessionId);
      // No session state — pass through (session not started yet or already ended)
      if (state === undefined) {
        return next(request);
      }

      // Guard clause: fast path when no pending action
      if (state.pendingAction === undefined) {
        try {
          const response = await next(request);
          // Non-success stop reasons are failures surfaced as returned responses
          if (isFailedResponse(response)) {
            const failError = new Error(`Model call failed: stopReason=${response.stopReason}`);
            await handleFailure(sessionId, state, failError, request, ctx.turnIndex);
          }
          return response;
        } catch (e: unknown) {
          await handleFailure(sessionId, state, e, request, ctx.turnIndex);
          throw e;
        }
      }

      // Abort: throw immediately without calling next
      if (state.pendingAction.kind === "abort") {
        const reason = state.pendingAction.reason;
        state.pendingAction = undefined;
        signalWriter?.clearRetrySignal(sessionId);
        throw new Error(`Semantic retry aborted: ${reason}`);
      }

      // Build rewrite context from latest failure record
      const lastClass =
        state.records[state.records.length - 1]?.failureClass ?? FALLBACK_FAILURE_CLASS;
      const rewriteCtx: RewriteContext = {
        failureClass: lastClass,
        records: state.records,
        turnIndex: ctx.turnIndex,
      };
      const modifiedRequest = await rewriteWithFallback(
        rewriter,
        request,
        state.pendingAction,
        rewriteCtx,
        rewriterTimeoutMs,
      );
      state.pendingAction = undefined;

      try {
        const response = await next(modifiedRequest);

        // Non-success stop reasons on the retry path are still failures
        if (isFailedResponse(response)) {
          const failError = new Error(
            `Retried model call failed: stopReason=${response.stopReason}`,
          );
          await handleFailure(sessionId, state, failError, modifiedRequest, ctx.turnIndex);
          return response;
        }

        // Successful retry — mark last record as succeeded and clear signal
        if (state.records.length > 0) {
          const lastIdx = state.records.length - 1;
          const lastRecord = state.records[lastIdx];
          if (lastRecord !== undefined) {
            state.records = [
              ...state.records.slice(0, lastIdx),
              { ...lastRecord, succeeded: true },
            ];
          }
        }
        signalWriter?.clearRetrySignal(sessionId);
        return response;
      } catch (e: unknown) {
        await handleFailure(sessionId, state, e, modifiedRequest, ctx.turnIndex);
        throw e;
      }
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const sessionId = ctx.session.sessionId as string;
      const state = getSession(sessionId);
      if (state === undefined) {
        yield* next(request);
        return;
      }

      // Determine effective request (apply pending rewrite or abort)
      let effectiveRequest = request; // let: may be rewritten
      if (state.pendingAction !== undefined) {
        if (state.pendingAction.kind === "abort") {
          const reason = state.pendingAction.reason;
          state.pendingAction = undefined;
          signalWriter?.clearRetrySignal(sessionId);
          throw new Error(`Semantic retry aborted: ${reason}`);
        }

        const lastClass =
          state.records[state.records.length - 1]?.failureClass ?? FALLBACK_FAILURE_CLASS;
        const rewriteCtx: RewriteContext = {
          failureClass: lastClass,
          records: state.records,
          turnIndex: ctx.turnIndex,
        };
        effectiveRequest = await rewriteWithFallback(
          rewriter,
          request,
          state.pendingAction,
          rewriteCtx,
          rewriterTimeoutMs,
        );
        state.pendingAction = undefined;
      }

      // Stream with failure detection — only treat done chunks with success
      // stop reasons as actual successes. Non-success stops (error, hook_blocked)
      // are provider/middleware failures surfaced via done chunk, not exceptions.
      let succeeded = false; // let: set true on done chunk with success stop reason
      let streamedFailure = false; // let: set true on non-success done chunk
      try {
        for await (const chunk of next(effectiveRequest)) {
          if (chunk.kind === "done") {
            const stopReason = chunk.response.stopReason;
            const isNonSuccessStop =
              stopReason !== undefined &&
              stopReason !== "stop" &&
              stopReason !== "length" &&
              stopReason !== "tool_use";
            if (isNonSuccessStop) {
              streamedFailure = true;
            } else {
              succeeded = true;
            }
          }
          yield chunk;
        }

        // Handle streamed failures (non-success done chunks) as retryable failures
        if (streamedFailure) {
          const streamError = new Error("Streamed model call failed with non-success stop reason");
          await handleFailure(sessionId, state, streamError, effectiveRequest, ctx.turnIndex);
        }

        // Mark successful retry
        if (succeeded && state.records.length > 0) {
          const lastIdx = state.records.length - 1;
          const lastRecord = state.records[lastIdx];
          if (lastRecord !== undefined && !lastRecord.succeeded) {
            state.records = [
              ...state.records.slice(0, lastIdx),
              { ...lastRecord, succeeded: true },
            ];
          }
        }
        if (succeeded) {
          signalWriter?.clearRetrySignal(sessionId);
        }
      } catch (e: unknown) {
        await handleFailure(sessionId, state, e, effectiveRequest, ctx.turnIndex);
        throw e;
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: (request: ToolRequest) => Promise<ToolResponse>,
    ): Promise<ToolResponse> {
      const sessionId = ctx.session.sessionId as string;
      const state = getSession(sessionId);
      try {
        return await next(request);
      } catch (e: unknown) {
        if (state !== undefined) {
          const toolFailure: ToolFailureRequest = {
            kind: "tool",
            toolId: request.toolId,
            input: request.input,
          };
          await handleFailure(sessionId, state, e, toolFailure, ctx.turnIndex);
        }
        throw e;
      }
    },
  };

  return {
    middleware,
    getRecords: (sessionId?: string) => {
      if (sessionId !== undefined) {
        return getSession(sessionId)?.records ?? [];
      }
      // Fallback: return records from first active session (backwards compat)
      const first = sessions.values().next();
      return first.done ? [] : first.value.records;
    },
    getRetryBudget: (sessionId?: string) => {
      if (sessionId !== undefined) {
        const state = getSession(sessionId);
        return state !== undefined ? minBudget(state.budgets) : maxRetries;
      }
      const first = sessions.values().next();
      return first.done ? maxRetries : minBudget(first.value.budgets);
    },
    reset: (sessionId?: string) => {
      if (sessionId !== undefined) {
        const state = getSession(sessionId);
        if (state !== undefined) {
          state.records = [];
          state.pendingAction = undefined;
          state.budgets = createInitialBudgets();
        }
        signalWriter?.clearRetrySignal(sessionId);
        return;
      }
      for (const [sid, state] of sessions) {
        state.records = [];
        state.pendingAction = undefined;
        state.budgets = createInitialBudgets();
        signalWriter?.clearRetrySignal(sid);
      }
    },
  };
}
