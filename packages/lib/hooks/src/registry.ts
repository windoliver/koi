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

import type { HookEnvPolicy, HookEvent, HookExecutionResult, HookPolicy } from "@koi/core";
import { executeHooks } from "./executor.js";
import { matchesHookFilter } from "./filter.js";
import type { HookExecutor } from "./hook-executor.js";
import type { PolicyActor, RegisteredHook } from "./policy.js";
import { applyPolicy } from "./policy.js";
import type { DnsResolverFn } from "./ssrf.js";

/** Maximum retries for a once-hook before it is permanently consumed. */
const MAX_ONCE_RETRIES = 3;

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SessionState {
  readonly hooks: readonly RegisteredHook[];
  readonly controller: AbortController;
  /** Trusted agent identity — bound at registration, enforced on execute. */
  readonly agentId: string;
  readonly envPolicy: HookEnvPolicy | undefined;
  /**
   * Consumed once-hook IDs (RegisteredHook.id).
   * Tracked by stable ID, not index, so policy filtering and reordering
   * do not break once-hook accounting.
   */
  readonly consumed: Set<string>;
  /**
   * In-flight once-hook IDs — currently being executed but not yet
   * committed or rolled back. Used to keep the serialization gate
   * active while execution is pending, even though the hook is already
   * in `consumed`. Cleared after execution completes.
   */
  readonly inFlight: Set<string>;
  /**
   * Retry counter per once-hook ID. Tracks how many times a once-hook
   * has been rolled back for retry. After MAX_ONCE_RETRIES, the hook is
   * permanently consumed to prevent infinite respawns from deterministic
   * failures (e.g., prompt that never calls HookVerdict).
   */
  readonly onceRetries: Map<string, number>;
  /**
   * Once-hook IDs that exhausted their retry budget while fail-closed.
   * Future matching events get a synthetic block result instead of silently
   * skipping the hook. Fail-open hooks are not tracked here (silent skip is fine).
   */
  readonly exhaustedBlockers: Set<string>;
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
    hooks: readonly RegisteredHook[],
    envPolicy?: HookEnvPolicy | undefined,
    policy?: HookPolicy | undefined,
    policyActor?: PolicyActor | undefined,
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
  /**
   * Returns true if the session has any registered hook whose filter
   * matches the given event. Lets callers narrow fail-closed behavior
   * (e.g. "did any post-hook match this tool call?") without inventing
   * a synthetic event to call execute() with.
   */
  readonly hasMatching: (sessionId: string, event: HookEvent) => boolean;
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
  /** Optional executor for prompt-type hooks, threaded through to executeHooks. */
  readonly promptExecutor?: HookExecutor | undefined;
  /** Custom DNS resolver for SSRF validation in HTTP hooks. */
  readonly dnsResolver?: DnsResolverFn | undefined;
  /**
   * Synchronous observer tap — called after every non-empty execute() with
   * the results and the trigger event. Used by ATIF trajectory recording.
   * Must not throw (wrapped in try/catch internally).
   */
  readonly onExecuted?:
    | ((results: readonly HookExecutionResult[], event: HookEvent) => void)
    | undefined;
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
    for (const id of state.exhaustedBlockers) {
      const rh = state.hooks.find((h) => h.id === id);
      if (rh !== undefined && matchesHookFilter(rh.hook.filter, safeEvent)) {
        const syntheticResults: readonly HookExecutionResult[] = [
          {
            ok: true,
            hookName: rh.hook.name,
            durationMs: 0,
            decision: {
              kind: "block",
              reason: `Once-hook "${rh.hook.name}" exhausted retry budget (${MAX_ONCE_RETRIES} attempts) without success`,
            },
          },
        ];
        // Notify observer tap so ATIF records the synthetic block.
        if (options?.onExecuted !== undefined) {
          try {
            options.onExecuted(syntheticResults, safeEvent);
          } catch {
            /* observer must not break dispatch */
          }
        }
        return syntheticResults;
      }
    }

    // Claim matching once-hooks by ID BEFORE awaiting execution.
    // ID-based tracking handles duplicate object references correctly.
    const claimedIds: string[] = [];
    for (const rh of state.hooks) {
      if (
        rh.hook.once === true &&
        !state.consumed.has(rh.id) &&
        matchesHookFilter(rh.hook.filter, safeEvent)
      ) {
        state.consumed.add(rh.id);
        state.inFlight.add(rh.id);
        claimedIds.push(rh.id);
      }
    }

    // Build execution list: include non-consumed hooks + this call's claimed hooks.
    // Preserves declaration order for serial/parallel batching.
    const claimedSet = new Set(claimedIds);
    const hooksToRun = state.hooks.filter(
      (rh) => !state.consumed.has(rh.id) || claimedSet.has(rh.id),
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
        options?.promptExecutor,
        options?.dnsResolver,
      );
    } catch (e: unknown) {
      // executeHooks rejected unexpectedly — roll back all claimed hooks
      // so they aren't permanently stuck in consumed/inFlight state.
      for (const id of claimedIds) {
        state.inFlight.delete(id);
        state.consumed.delete(id);
      }
      throw e;
    }

    // Clear in-flight status now that execution is complete.
    for (const id of claimedIds) {
      state.inFlight.delete(id);
    }

    // Mid-flight cancellation: did the caller's signal abort while hooks were
    // running? Re-read fresh because the pre-claim short-circuit above
    // narrowed `callSignal?.aborted` to false, but the signal can flip
    // during the executeHooks() await. The explicit-undefined form sidesteps
    // that narrowing.
    // biome-ignore lint/complexity/useOptionalChain: narrowing workaround
    const callerCancelled = callSignal?.aborted && !state.controller.signal.aborted;

    // Un-consume once-hooks that failed — they get another chance,
    // up to MAX_ONCE_RETRIES to prevent infinite respawns from
    // deterministic failures (e.g., prompt that never calls HookVerdict).
    if (claimedIds.length > 0) {
      const matchedHooks = hooksToRun.filter((rh) => matchesHookFilter(rh.hook.filter, safeEvent));
      // Build a map from hooksToRun position to RegisteredHook ID
      const runPosToId = new Map<number, string>();
      // let justified: mutable counter for mapping hooksToRun position to ID
      let runIdx = 0;
      for (const rh of state.hooks) {
        if (!state.consumed.has(rh.id) || claimedSet.has(rh.id)) {
          runPosToId.set(runIdx, rh.id);
          runIdx++;
        }
      }
      // let justified: mutable counter tracking position in hooksToRun for filter correlation
      let matchIdx = 0;
      for (let runPos = 0; runPos < hooksToRun.length && matchIdx < matchedHooks.length; runPos++) {
        if (hooksToRun[runPos] !== matchedHooks[matchIdx]) continue;
        const hookId = runPosToId.get(runPos);
        if (hookId !== undefined && claimedSet.has(hookId)) {
          const result = results[matchIdx];
          if (
            result === undefined ||
            !result.ok ||
            (result.ok && result.executionFailed === true)
          ) {
            // When the caller cancelled, refund claimed once-hooks whose
            // results carry the explicit `aborted: true` marker set by
            // executor.ts (command/HTTP/prompt) and agent-executor.ts
            // (agent hooks). Genuine non-abort transient failures still
            // increment onceRetries under cancellation, so fail-closed
            // hooks can reach exhausted-blocker state after MAX_ONCE_RETRIES.
            const isAbortMarked = result !== undefined && result.aborted === true;
            if (callerCancelled && isAbortMarked) {
              state.consumed.delete(hookId);
              matchIdx++;
              continue;
            }
            // Check bounded retry — permanently consume after MAX_ONCE_RETRIES
            const retries = (state.onceRetries.get(hookId) ?? 0) + 1;
            state.onceRetries.set(hookId, retries);
            if (retries < MAX_ONCE_RETRIES) {
              state.consumed.delete(hookId);
            } else {
              // Retry budget exhausted. For fail-closed hooks, register as
              // an exhausted blocker so future events are blocked rather
              // than silently unguarded. Fail-open hooks just disappear.
              const rh = state.hooks.find((h) => h.id === hookId);
              if (
                rh !== undefined &&
                (rh.hook.failClosed === undefined || rh.hook.failClosed === true)
              ) {
                state.exhaustedBlockers.add(hookId);
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

    // Notify observer tap (ATIF trajectory recording). Fire synchronously
    // so the tap sees results in dispatch order. Guard against observer errors.
    if (options?.onExecuted !== undefined && results.length > 0) {
      try {
        options.onExecuted(results, safeEvent);
      } catch {
        /* observer must not break dispatch */
      }
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
    // Keep the chain advancing (downstream queued calls must not be blocked
    // by a caller that gave up) but let this caller exit promptly when its
    // signal aborts while queued. Without this race, a second call queued
    // behind an in-flight once-hook would hang waiting for the first hook
    // to finish even after its own caller canceled.
    const resultPromise = state.executeChain.then(() => doExecute(state, safeEvent, callSignal));
    // Chain the next call behind this one (swallow rejection to keep chain alive)
    state.executeChain = resultPromise.then(
      () => {},
      () => {},
    );
    if (callSignal === undefined) return resultPromise;
    return new Promise<readonly HookExecutionResult[]>((resolve, reject) => {
      const onAbort = (): void => resolve([]);
      if (callSignal.aborted) {
        resolve([]);
        return;
      }
      callSignal.addEventListener("abort", onAbort, { once: true });
      resultPromise.then(
        (value) => {
          callSignal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err: unknown) => {
          callSignal.removeEventListener("abort", onAbort);
          reject(err as Error);
        },
      );
    });
  }

  return {
    register(
      sessionId: string,
      agentId: string,
      hooks: readonly RegisteredHook[],
      envPolicy?: HookEnvPolicy | undefined,
      policy?: HookPolicy | undefined,
      policyActor?: PolicyActor | undefined,
    ): void {
      // Require explicit policyActor when disableAllHooks is set
      if (policy?.disableAllHooks === true && policyActor === undefined) {
        throw new Error(
          "policyActor is required when disableAllHooks is set — it determines which tiers are killed",
        );
      }

      // Cleanup any previous registration for this session
      const existing = sessions.get(sessionId);
      if (existing !== undefined && !existing.cleaned) {
        existing.controller.abort();
        existing.cleaned = true;
      }

      // Apply policy filtering if a policy is provided
      const effectiveActor = policyActor ?? "user";
      const effectiveHooks =
        policy !== undefined ? applyPolicy(hooks, policy, effectiveActor) : [...hooks];

      const controller = new AbortController();
      sessions.set(sessionId, {
        hooks: effectiveHooks,
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
        (rh) =>
          rh.hook.once === true &&
          (!state.consumed.has(rh.id) || state.inFlight.has(rh.id)) &&
          matchesHookFilter(rh.hook.filter, safeEvent),
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

    hasMatching(sessionId: string, event: HookEvent): boolean {
      const state = sessions.get(sessionId);
      if (state === undefined || state.cleaned) return false;
      return state.hooks.some((rh) => matchesHookFilter(rh.hook.filter, event));
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
