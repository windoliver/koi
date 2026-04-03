/**
 * Hook executor interface — extensible dispatch for hook transports.
 *
 * Each hook transport type (command, http, agent) implements this interface.
 * The executor registry dispatches to the correct implementation based on
 * `canHandle()`. New hook types are added by registering a new executor,
 * not by modifying the dispatch switch.
 */

import type { HookConfig, HookEvent, HookExecutionResult } from "@koi/core";

/**
 * A hook executor handles one or more hook transport types.
 *
 * Implementations must:
 * - Return well-formed `HookExecutionResult` for all outcomes (success, error, timeout)
 * - Respect the abort signal for cooperative cancellation
 * - Measure `durationMs` accurately
 * - Never throw — all errors must be caught and returned as `ok: false`
 */
export interface HookExecutor {
  /** Human-readable executor name (for diagnostics). */
  readonly name: string;
  /** Returns true if this executor can handle the given hook config. */
  canHandle(hook: HookConfig): boolean;
  /** Execute a hook and return the result. Must not throw. */
  execute(hook: HookConfig, event: HookEvent, signal: AbortSignal): Promise<HookExecutionResult>;
  /** Clean up per-session state (e.g., token budgets). Called on session end. */
  cleanupSession?(sessionId: string): void;
}
