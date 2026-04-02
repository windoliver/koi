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
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a new HookRegistry instance.
 */
export function createHookRegistry(): HookRegistry {
  const sessions = new Map<string, SessionState>();

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
      // Enforce session + agent isolation: overwrite identity fields with
      // trusted values from registration to prevent cross-session/cross-agent
      // payload injection from caller bugs.
      const safeEvent: HookEvent =
        event.sessionId === sessionId && event.agentId === state.agentId
          ? event
          : { ...event, sessionId, agentId: state.agentId };
      return executeHooks(state.hooks, safeEvent, state.controller.signal, state.envPolicy);
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
  };
}
