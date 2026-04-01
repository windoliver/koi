/**
 * Command hook — dispatches mutations via POST /api/cmd/ endpoints.
 *
 * Uses simple useState + try/catch for mutation state.
 * Does NOT use React Query — mutations are fire-and-forget actions.
 */

import { useCallback, useState } from "react";
import { listMailbox, resumeAgent, retryDeadLetter, suspendAgent } from "../lib/api-client.js";

export interface CommandState<T = void> {
  readonly execute: () => Promise<T>;
  readonly isExecuting: boolean;
  readonly error: Error | null;
}

/**
 * Generic command hook — wraps an async action with loading/error state.
 *
 * @param action — the async function to execute when `execute()` is called.
 */
export function useCommand<T = void>(action: () => Promise<T>): CommandState<T> {
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const execute = useCallback(async (): Promise<T> => {
    setIsExecuting(true);
    setError(null);
    try {
      const result = await action();
      return result;
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err);
      throw err;
    } finally {
      setIsExecuting(false);
    }
  }, [action]);

  return { execute, isExecuting, error };
}

// ---------------------------------------------------------------------------
// Pre-built command hooks for common operations
// ---------------------------------------------------------------------------

export function useSuspendAgent(agentId: string): CommandState<void> {
  return useCommand(useCallback(() => suspendAgent(agentId), [agentId]));
}

export function useResumeAgent(agentId: string): CommandState<void> {
  return useCommand(useCallback(() => resumeAgent(agentId), [agentId]));
}

export function useRetryDeadLetter(eventId: string): CommandState<{ readonly retried: boolean }> {
  return useCommand(useCallback(() => retryDeadLetter(eventId), [eventId]));
}

export function useListMailbox(agentId: string): CommandState<readonly unknown[]> {
  return useCommand(useCallback(() => listMailbox(agentId), [agentId]));
}
