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
import type { HookExecutor } from "./hook-executor.js";

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SessionState {
  readonly hooks: readonly HookConfig[];
  readonly controller: AbortController;
  /** Trusted agent identity — bound at registration, enforced on execute. */
  readonly agentId: string;
  readonly envPolicy: HookEnvPolicy | undefined;
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
  /** Execute matching hooks for a session event. Returns empty array if session not registered. */
  readonly execute: (
    sessionId: string,
    event: HookEvent,
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
      sessions.set(sessionId, { hooks, controller, agentId, envPolicy, cleaned: false });
    },

    async execute(sessionId: string, event: HookEvent): Promise<readonly HookExecutionResult[]> {
      const state = sessions.get(sessionId);
      if (state === undefined || state.cleaned) {
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
      return executeHooks(
        state.hooks,
        safeEvent,
        state.controller.signal,
        state.envPolicy,
        options?.agentExecutor,
      );
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
