/**
 * Prompt executor adapter — bridges @koi/hook-prompt into the HookExecutor interface.
 *
 * Wraps the lightweight PromptHookExecutor (which returns bare HookDecision) with
 * the full HookExecutionResult contract required by the hooks pipeline: duration
 * measurement, abort/timeout discrimination, executionFailed flags for once-hook
 * retry, and payload size capping.
 */

import type { HookConfig, HookEvent, HookExecutionResult, PromptHookConfig } from "@koi/core";
import { DEFAULT_PROMPT_MAX_TOKENS, DEFAULT_PROMPT_SESSION_TOKEN_BUDGET } from "@koi/core";
import type { PromptModelCaller } from "@koi/hook-prompt";
import { createPromptExecutor, VerdictParseError } from "@koi/hook-prompt";
import type { HookExecutor } from "./hook-executor.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum serialized event data size (bytes) before truncation. */
const MAX_EVENT_DATA_BYTES = 32_768;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for creating a prompt executor adapter. */
export interface CreatePromptAdapterOptions {
  /** Model caller injected by L1 at middleware wiring time. */
  readonly caller: PromptModelCaller;
}

// ---------------------------------------------------------------------------
// Session token budget tracking
// ---------------------------------------------------------------------------

interface SessionBudget {
  readonly maxTokens: number;
  // let justified: mutable accumulator for consumed tokens
  consumed: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Adapts @koi/hook-prompt's PromptHookExecutor to the HookExecutor interface.
 *
 * Adds pipeline-level concerns that the inner executor intentionally omits:
 * - AbortSignal handling with timeout/cancellation discrimination
 * - HookExecutionResult with executionFailed/aborted flags for once-hook correctness
 * - Per-session token budget tracking
 * - Event data size capping
 */
export class PromptExecutorAdapter implements HookExecutor {
  readonly name = "prompt";
  private readonly inner: ReturnType<typeof createPromptExecutor>;
  private readonly sessions = new Map<string, SessionBudget>();

  constructor(options: CreatePromptAdapterOptions) {
    this.inner = createPromptExecutor(options.caller);
  }

  canHandle(hook: HookConfig): boolean {
    return hook.kind === "prompt";
  }

  async execute(
    hook: HookConfig,
    event: HookEvent,
    signal: AbortSignal,
  ): Promise<HookExecutionResult> {
    if (hook.kind !== "prompt") {
      return {
        ok: false as const,
        hookName: hook.name,
        error: "Not a prompt hook",
        durationMs: 0,
      };
    }

    const start = performance.now();

    try {
      signal.throwIfAborted();

      // Token budget check
      const budgetError = this.checkBudget(event.sessionId, hook);
      if (budgetError !== undefined) {
        const durationMs = performance.now() - start;
        return {
          ok: false as const,
          hookName: hook.name,
          error: budgetError,
          durationMs,
          failClosed: hook.failClosed,
        };
      }

      // Cap event data to prevent prompt explosion
      const cappedEvent = capEventData(event);

      // Delegate to the inner executor
      const decision = await this.inner.execute(hook, cappedEvent);

      // Consume token budget
      const consumed = hook.maxTokens ?? DEFAULT_PROMPT_MAX_TOKENS;
      this.consumeBudget(event.sessionId, consumed);

      const durationMs = performance.now() - start;

      if (signal.aborted) {
        return abortResult(hook.name, signal, durationMs, hook.failClosed);
      }

      return { ok: true as const, hookName: hook.name, durationMs, decision };
    } catch (e: unknown) {
      const durationMs = performance.now() - start;

      // Abort/timeout discrimination
      if (signal.aborted || (e instanceof Error && e.name === "AbortError")) {
        return abortResult(hook.name, signal, durationMs, hook.failClosed);
      }

      // VerdictParseError is transient (LLM output is non-deterministic)
      if (e instanceof VerdictParseError) {
        const failClosed = hook.failClosed ?? true;
        if (failClosed) {
          return {
            ok: false as const,
            hookName: hook.name,
            error: `Verdict parse failed: ${e.message}`,
            durationMs,
            failClosed: true,
          };
        }
        return {
          ok: true as const,
          hookName: hook.name,
          durationMs,
          decision: { kind: "continue" },
          executionFailed: true,
        };
      }

      // Other errors — respect failClosed
      const failClosed = hook.failClosed ?? true;
      const message = e instanceof Error ? e.message : String(e);
      if (failClosed) {
        return {
          ok: false as const,
          hookName: hook.name,
          error: message,
          durationMs,
          failClosed: true,
        };
      }
      return {
        ok: true as const,
        hookName: hook.name,
        durationMs,
        decision: { kind: "continue" },
        executionFailed: true,
      };
    }
  }

  cleanupSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  // -------------------------------------------------------------------------
  // Budget helpers
  // -------------------------------------------------------------------------

  private checkBudget(sessionId: string, hook: PromptHookConfig): string | undefined {
    const budget = this.getOrCreateBudget(sessionId);
    const cost = hook.maxTokens ?? DEFAULT_PROMPT_MAX_TOKENS;
    if (budget.consumed + cost > budget.maxTokens) {
      return (
        `Prompt hook token budget exhausted for session ${sessionId} ` +
        `(${budget.consumed}/${budget.maxTokens} consumed, need ${cost})`
      );
    }
    return undefined;
  }

  private consumeBudget(sessionId: string, tokens: number): void {
    const budget = this.getOrCreateBudget(sessionId);
    budget.consumed += tokens;
  }

  private getOrCreateBudget(sessionId: string): SessionBudget {
    let budget = this.sessions.get(sessionId);
    if (budget === undefined) {
      budget = { maxTokens: DEFAULT_PROMPT_SESSION_TOKEN_BUDGET, consumed: 0 };
      this.sessions.set(sessionId, budget);
    }
    return budget;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an abort/timeout result with correct once-hook flags. */
function abortResult(
  hookName: string,
  signal: AbortSignal,
  durationMs: number,
  failClosed: boolean | undefined,
): HookExecutionResult {
  const reason: unknown = signal.reason;
  const isTimeout = reason instanceof Error && reason.name === "TimeoutError";
  return {
    ok: false as const,
    hookName,
    error: "aborted",
    durationMs,
    failClosed,
    ...(isTimeout ? {} : { aborted: true as const }),
  };
}

/** Cap event data serialization to prevent prompt explosion. */
function capEventData(event: HookEvent): HookEvent {
  if (event.data === undefined) return event;

  const serialized = JSON.stringify(event.data);
  if (serialized.length <= MAX_EVENT_DATA_BYTES) return event;

  // Truncate and mark as capped
  const truncated = serialized.slice(0, MAX_EVENT_DATA_BYTES);
  return {
    ...event,
    data: {
      _truncated: true,
      _originalBytes: serialized.length,
      _preview: truncated,
    },
  };
}
