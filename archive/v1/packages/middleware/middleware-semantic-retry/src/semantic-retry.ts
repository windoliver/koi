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
  CapabilityFragment,
  KoiMiddleware,
  ModelRequest,
  ModelResponse,
  SessionContext,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { trimToRecent } from "@koi/failure-context";
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
// Factory
// ---------------------------------------------------------------------------

export function createSemanticRetryMiddleware(config: SemanticRetryConfig): SemanticRetryHandle {
  const analyzer: FailureAnalyzer = config.analyzer ?? createDefaultFailureAnalyzer();
  const rewriter = config.rewriter ?? createDefaultPromptRewriter();
  const maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
  const budgetOverrides = config.budgetOverrides ?? {};
  const maxHistorySize = config.maxHistorySize ?? DEFAULT_MAX_HISTORY_SIZE;
  const analyzerTimeoutMs = config.analyzerTimeoutMs ?? DEFAULT_ANALYZER_TIMEOUT_MS;
  const rewriterTimeoutMs = config.rewriterTimeoutMs ?? DEFAULT_REWRITER_TIMEOUT_MS;
  const onRetry = config.onRetry;

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

    const classBudget = state.budgets[failureClass.kind];
    // Guard: skip once budget for this failure class is exhausted
    if (classBudget !== undefined && classBudget <= 0) return;

    state.budgets[failureClass.kind] = (classBudget ?? 0) - 1;
    const remainingBudget = state.budgets[failureClass.kind] ?? 0;
    const effectiveMax = budgetOverrides[failureClass.kind] ?? maxRetries;
    const action = selectActionWithFallback(
      analyzer,
      failureClass,
      state.records,
      remainingBudget,
      effectiveMax,
      error,
      classifyFailed,
    );

    const record: RetryRecord = {
      timestamp: Date.now(),
      failureClass,
      actionTaken: action,
      succeeded: false,
    };
    state.records = trimToRecent([...state.records, record], maxHistorySize);
    state.pendingAction = action;
    onRetry?.(record);
  }

  const middleware: KoiMiddleware = {
    name: MIDDLEWARE_NAME,
    priority: MIDDLEWARE_PRIORITY,

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId as string, createSessionState());
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
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
      const state = getSession(ctx.session.sessionId as string);
      // No session state — pass through (session not started yet or already ended)
      if (state === undefined) {
        return next(request);
      }

      // Guard clause: fast path when no pending action
      if (state.pendingAction === undefined) {
        try {
          return await next(request);
        } catch (e: unknown) {
          await handleFailure(state, e, request, ctx.turnIndex);
          throw e;
        }
      }

      // Abort: throw immediately without calling next
      if (state.pendingAction.kind === "abort") {
        const reason = state.pendingAction.reason;
        state.pendingAction = undefined;
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
        return await next(modifiedRequest);
      } catch (e: unknown) {
        await handleFailure(state, e, request, ctx.turnIndex);
        throw e;
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: (request: ToolRequest) => Promise<ToolResponse>,
    ): Promise<ToolResponse> {
      const state = getSession(ctx.session.sessionId as string);
      try {
        return await next(request);
      } catch (e: unknown) {
        if (state !== undefined) {
          const toolFailure: ToolFailureRequest = {
            kind: "tool",
            toolId: request.toolId,
            input: request.input,
          };
          await handleFailure(state, e, toolFailure, ctx.turnIndex);
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
        return;
      }
      for (const state of sessions.values()) {
        state.records = [];
        state.pendingAction = undefined;
        state.budgets = createInitialBudgets();
      }
    },
  };
}
