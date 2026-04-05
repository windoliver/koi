/**
 * Hook registry — session-scoped hook registration and cleanup.
 *
 * Manages the lifecycle of hooks within a session: registration on session
 * start, dispatch on events, and cleanup (abort + dispose) on session end.
 *
 * Uses AbortController per session so all in-flight hooks are cancelled
 * when the session ends. Cleanup is idempotent (double-cleanup is a no-op).
 *
 * Trusted identity: `agentId` is bound at registration time and enforced
 * on every execute call to prevent cross-session/cross-agent payload injection.
 */

import type { HookConfig, HookEnvPolicy, HookEvent, HookExecutionResult } from "@koi/core";
import { executeHooks } from "./executor.js";
import { matchesHookFilter } from "./filter.js";
import type { HookExecutor } from "./hook-executor.js";

/** Maximum retries for a once-hook before it is permanently consumed. */
const MAX_ONCE_RETRIES = 3;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SessionState {
  readonly hooks: readonly HookConfig[];
  readonly controller: AbortController;
  /** Trusted agent identity — bound at registration, enforced on execute. */
  readonly agentId: string;
  readonly envPolicy: HookEnvPolicy | undefined;
  /**
   * Consumed once-hook indices (position in the hooks array).
   * Tracked by index, not object reference, so duplicate references
   * at different positions are treated as distinct instances.
   */
  readonly consumed: Set<number>;
  /**
   * In-flight once-hook indices — currently being executed but not yet
   * committed or rolled back. Used to keep the serialization gate
   * active while execution is pending, even though the hook is already
   * in `consumed`. Cleared after execution completes.
   */
  readonly inFlight: Set<number>;
  /**
   * Retry counter per once-hook index. Tracks how many times a once-hook
   * has been rolled back for retry. After MAX_ONCE_RETRIES, the hook is
   * permanently consumed to prevent infinite respawns from deterministic
   * failures (e.g., prompt that never calls HookVerdict).
   */
  readonly onceRetries: Map<number, number>;
  /**
   * Once-hook indices that exhausted their retry budget while fail-closed.
   * Future matching events get a synthetic block result instead of silently
   * skipping the hook. Fail-open hooks are not tracked here (silent skip is fine).
   */
  readonly exhaustedBlockers: Set<number>;
  /**
   * Serialization chain for sessions with once-hooks. Concurrent
   * execute() calls await the previous call so a transient failure
   * cannot cause a concurrent matching event to skip the hook.
   */
  // let justified: mutable promise chain for serialization
  executeChain: Promise<void>;
  cleaned: boolean;
}

// ---------------------------------------------------------------------------
// Registry interface
// ---------------------------------------------------------------------------

/**
 * Session-scoped hook registry.
 *
 * Each session gets its own AbortController for cancellation propagation.
 * Cleanup aborts all in-flight hooks and removes the session from the registry.
 */
export interface HookRegistry {
  /** Register hooks for a session with its trusted agent identity. Replaces any existing registration. */
  readonly register: (
    sessionId: string,
    agentId: string,
    hooks: readonly HookConfig[],
    envPolicy?: HookEnvPolicy | undefined,
  ) => void;
  /**
   * Execute matching hooks for a session event. Returns empty array if session
   * not registered. Optional abortSignal is a per-call cancellation signal
   * (e.g. from a tool call or turn) and is combined with the session-level
   * controller so hook execution can be canceled promptly when the caller
   * gives up, independent of session cleanup.
   */
  readonly execute: (
    sessionId: string,
    event: HookEvent,
    abortSignal?: AbortSignal,
  ) => Promise<readonly HookExecutionResult[]>;
  /** Cleanup a session — abort in-flight hooks and remove registration. Idempotent. */
  readonly cleanup: (sessionId: string) => void;
  /** Returns true if the session has registered hooks. */
  readonly has: (sessionId: string) => boolean;
  /** Returns the number of active sessions. */
  readonly size: () => number;
  /** Mark a session as belonging to a hook agent — hooks will be suppressed for it. */
  readonly markHookAgent: (sessionId: string) => void;
  /** Remove hook-agent marking. Called when the hook agent session ends. */
  readonly unmarkHookAgent: (sessionId: string) => void;
  /** Returns true if the session is marked as a hook agent. */
  readonly isHookAgent: (sessionId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Options for creating a hook registry. */
export interface CreateHookRegistryOptions {
  /** Optional executor for agent-type hooks, threaded through to executeHooks. */
  readonly agentExecutor?: HookExecutor | undefined;
}

/**
 * Creates a new HookRegistry instance.
 */
export function createHookRegistry(options?: CreateHookRegistryOptions): HookRegistry {
  const sessions = new Map<string, SessionState>();
  /** Sessions belonging to hook agents — hooks are suppressed for these. */
  const hookAgentSessions = new Set<string>();

  /**
   * Core execution logic — claim matching once-hooks by index, run all
   * hooks in declaration order, then un-consume failed once-hooks.
   */
  async function doExecute(
    state: SessionState,
    safeEvent: HookEvent,
    callSignal?: AbortSignal,
  ): Promise<readonly HookExecutionResult[]> {
    // Short-circuit canceled calls BEFORE claiming once-hooks. Treating an
    // already-aborted call as a failed attempt would bump onceRetries and
    // eventually exhaust the retry budget (even marking fail-closed hooks as
    // permanent blockers) without the hook ever meaningfully running. A
    // canceled call must be a no-op for once-hook accounting.
    if (callSignal?.aborted === true || state.controller.signal.aborted) {
      return [];
    }
    // Check for exhausted fail-closed once-hooks that still match this event.
    // These produce a synthetic block result without running any hooks.
    for (const idx of state.exhaustedBlockers) {
      const hook = state.hooks[idx];
      if (hook !== undefined && matchesHookFilter(hook.filter, safeEvent)) {
        return [
          {
            ok: true,
            hookName: hook.name,
            durationMs: 0,
            decision: {
              kind: "block",
              reason: `Once-hook "${hook.name}" exhausted retry budget (${MAX_ONCE_RETRIES} attempts) without success`,
            },
          },
        ];
      }
    }

    // Claim matching once-hooks by index BEFORE awaiting execution.
    // Index-based tracking handles duplicate object references correctly.
    const claimedIndices: number[] = [];
    for (let idx = 0; idx < state.hooks.length; idx++) {
      const hook = state.hooks[idx];
      if (
        hook !== undefined &&
        hook.once === true &&
        !state.consumed.has(idx) &&
        matchesHookFilter(hook.filter, safeEvent)
      ) {
        state.consumed.add(idx);
        state.inFlight.add(idx);
        claimedIndices.push(idx);
      }
    }

    // Build execution list: include non-consumed hooks + this call's claimed hooks.
    // Preserves declaration order for serial/parallel batching.
    const claimedSet = new Set(claimedIndices);
    const hooksToRun = state.hooks.filter(
      (_h, idx) => !state.consumed.has(idx) || claimedSet.has(idx),
    );

    // Combine session-level and per-call signals so either can cancel hook
    // execution. AbortSignal.any short-circuits if any input is already aborted.
    const effectiveSignal =
      callSignal !== undefined
        ? AbortSignal.any([state.controller.signal, callSignal])
        : state.controller.signal;

    // let justified: mutable — set inside try, returned after finally
    let results: readonly HookExecutionResult[];
    try {
      results = await executeHooks(
        hooksToRun,
        safeEvent,
        effectiveSignal,
        state.envPolicy,
        options?.agentExecutor,
      );
    } catch (e: unknown) {
      // executeHooks rejected unexpectedly — roll back all claimed hooks
      // so they aren't permanently stuck in consumed/inFlight state.
      for (const idx of claimedIndices) {
        state.inFlight.delete(idx);
        state.consumed.delete(idx);
      }
      throw e;
    }

    // Clear in-flight status now that execution is complete.
    for (const idx of claimedIndices) {
      state.inFlight.delete(idx);
    }

    // Mid-flight cancellation: did the caller's signal abort while hooks were
    // running? Re-read fresh because the pre-claim short-circuit above
    // narrowed `callSignal?.aborted` to false, but the signal can flip
    // during the executeHooks() await. The explicit-undefined form sidesteps
    // that narrowing.
    // biome-ignore lint/complexity/useOptionalChain: narrowing workaround
    const callerCancelled =
      callSignal !== undefined && callSignal.aborted && !state.controller.signal.aborted;

    // Un-consume once-hooks that failed — they get another chance,
    // up to MAX_ONCE_RETRIES to prevent infinite respawns from
    // deterministic failures (e.g., prompt that never calls HookVerdict).
    if (claimedIndices.length > 0) {
      const matchedHooks = hooksToRun.filter((h) => matchesHookFilter(h.filter, safeEvent));
      const hookToOrigIdx = new Map<number, number>();
      // let justified: mutable counter for mapping hooksToRun position to original index
      let runIdx = 0;
      for (let origIdx = 0; origIdx < state.hooks.length; origIdx++) {
        if (!state.consumed.has(origIdx) || claimedSet.has(origIdx)) {
          hookToOrigIdx.set(runIdx, origIdx);
          runIdx++;
        }
      }
      // let justified: mutable counter tracking position in hooksToRun for filter correlation
      let matchIdx = 0;
      for (let runPos = 0; runPos < hooksToRun.length && matchIdx < matchedHooks.length; runPos++) {
        if (hooksToRun[runPos] !== matchedHooks[matchIdx]) continue;
        const origIdx = hookToOrigIdx.get(runPos);
        if (origIdx !== undefined && claimedSet.has(origIdx)) {
          const result = results[matchIdx];
          if (
            result === undefined ||
            !result.ok ||
            (result.ok && result.executionFailed === true)
          ) {
            // When the caller cancelled, refund results whose error string
            // is an explicit abort marker emitted by executor.ts — "aborted"
            // (command hooks) or contains "AbortError" (HTTP/generic
            // throw-on-aborted path).
            //
            // Known limitation: agent-hook aborts surface as `ok: true` with
            // `executionFailed: true` and the error message buried inside
            // `decision.reason` (agent-executor.ts:handleTransientFailure).
            // That shape is indistinguishable from a non-abort transient
            // failure (spawn crash, verdict parse error), so we intentionally
            // do NOT refund it here — treating executionFailed as abort-shaped
            // would let a broken agent once-hook be retried indefinitely under
            // cancellation races. The trade-off: a fail-closed agent once-hook
            // can exhaust its retry budget faster if the caller repeatedly
            // aborts after transient failures. Fixing this properly requires
            // an explicit abort marker on HookExecutionResult; tracked as a
            // follow-up.
            const looksAborted =
              !!result &&
              !result.ok &&
              (result.error === "aborted" || result.error.includes("AbortError"));
            if (callerCancelled && looksAborted) {
              state.consumed.delete(origIdx);
              matchIdx++;
              continue;
            }
            // Check bounded retry — permanently consume after MAX_ONCE_RETRIES
            const retries = (state.onceRetries.get(origIdx) ?? 0) + 1;
            state.onceRetries.set(origIdx, retries);
            if (retries < MAX_ONCE_RETRIES) {
              state.consumed.delete(origIdx);
            } else {
              // Retry budget exhausted. For fail-closed hooks, register as
              // an exhausted blocker so future events are blocked rather
              // than silently unguarded. Fail-open hooks just disappear.
              const hook = state.hooks[origIdx];
              if (
                hook !== undefined &&
                (hook.failClosed === undefined || hook.failClosed === true)
              ) {
                state.exhaustedBlockers.add(origIdx);
              }
            }
          }
        }
        matchIdx++;
      }
    }

    // Return [] to the cancelled caller so they don't act on results they
    // asked to abort. Once-hook state has already been reconciled above.
    if (callerCancelled) {
      return [];
    }
    return results;
  }

  /**
   * Serialize execution for sessions with once-hooks. Concurrent calls
   * await the previous call so a transient failure cannot cause a
   * concurrent matching event to skip the hook entirely.
   */
  function serializeOnceExecution(
    state: SessionState,
    safeEvent: HookEvent,
    callSignal?: AbortSignal,
  ): Promise<readonly HookExecutionResult[]> {
    const resultPromise = state.executeChain.then(() => doExecute(state, safeEvent, callSignal));
    // Chain the next call behind this one (swallow rejection to keep chain alive)
    state.executeChain = resultPromise.then(
      () => {},
      () => {},
    );
    return resultPromise;
  }

  return {
    register(
      sessionId: string,
      agentId: string,
      hooks: readonly HookConfig[],
      envPolicy?: HookEnvPolicy | undefined,
    ): void {
      // Cleanup any previous registration for this session
      const existing = sessions.get(sessionId);
      if (existing !== undefined && !existing.cleaned) {
        existing.controller.abort();
        existing.cleaned = true;
      }

      const controller = new AbortController();
      sessions.set(sessionId, {
        hooks: [...hooks],
        controller,
        agentId,
        envPolicy,
        consumed: new Set(),
        inFlight: new Set(),
        onceRetries: new Map(),
        exhaustedBlockers: new Set(),
        executeChain: Promise.resolve(),
        cleaned: false,
      });
    },

    async execute(
      sessionId: string,
      event: HookEvent,
      abortSignal?: AbortSignal,
    ): Promise<readonly HookExecutionResult[]> {
      const state = sessions.get(sessionId);
      if (state === undefined || state.cleaned) {
        return [];
      }
      // Canceled-before-dispatch: return early without mutating once-hook
      // state or queueing serialized work. doExecute re-checks the signal
      // after the serialization await so late cancellations are also safe.
      if (abortSignal?.aborted === true) {
        return [];
      }
      // Suppress all hooks for hook-agent sessions (recursion prevention)
      if (hookAgentSessions.has(sessionId)) {
        return [];
      }
      // Enforce session + agent isolation: overwrite identity fields with
      // trusted values from registration to prevent cross-session/cross-agent
      // payload injection from caller bugs.
      const safeEvent: HookEvent =
        event.sessionId === sessionId && event.agentId === state.agentId
          ? event
          : { ...event, sessionId, agentId: state.agentId };

      // Serialize when this event could match a once-hook that is either
      // unconsumed or currently in-flight. Event-aware: unrelated events
      // (different filter) run concurrently even if once-hooks exist.
      // In-flight check prevents the race where a concurrent call sees
      // the hook as consumed (claimed but not yet committed) and bypasses
      // serialization, missing the gate if the first call fails.
      const needsSerialize = state.hooks.some(
        (h, idx) =>
          h.once === true &&
          (!state.consumed.has(idx) || state.inFlight.has(idx)) &&
          matchesHookFilter(h.filter, safeEvent),
      );
      if (needsSerialize) {
        return serializeOnceExecution(state, safeEvent, abortSignal);
      }
      return doExecute(state, safeEvent, abortSignal);
    },

    cleanup(sessionId: string): void {
      const state = sessions.get(sessionId);
      if (state === undefined) {
        return;
      }
      if (!state.cleaned) {
        state.controller.abort();
        state.cleaned = true;
      }
      sessions.delete(sessionId);
    },

    has(sessionId: string): boolean {
      const state = sessions.get(sessionId);
      return state !== undefined && !state.cleaned;
    },

    size(): number {
      let count = 0;
      for (const state of sessions.values()) {
        if (!state.cleaned) {
          count++;
        }
      }
      return count;
    },

    markHookAgent(sessionId: string): void {
      hookAgentSessions.add(sessionId);
    },

    unmarkHookAgent(sessionId: string): void {
      hookAgentSessions.delete(sessionId);
    },

    isHookAgent(sessionId: string): boolean {
      return hookAgentSessions.has(sessionId);
    },
  };
}
