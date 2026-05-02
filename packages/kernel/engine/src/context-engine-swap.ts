/**
 * Context-engine swap controller — explicit, traceable runtime swaps with
 * rollback support.
 *
 * Phase 5 of issue #1767. Builds on the L0 `ContextEngineSwapEvent` shape and
 * the boundary semantics defined by #1939 (turn_end / run_start). The
 * controller itself holds no boundary logic — callers (the runtime) decide
 * when a swap takes effect by calling `swap()` from the appropriate hook.
 *
 * Invariants:
 * - Same-identity swaps are noops (no event, no history entry)
 * - Rollback is the inverse of the most recent swap; resets when history empty
 * - History is append-only; ordering is the order swaps actually applied
 */

import type {
  ContextEngine,
  ContextEngineIdentity,
  ContextEngineSwapEvent,
  TurnId,
} from "@koi/core";

export interface SwapOptions {
  readonly turnId: TurnId;
  readonly reason: string;
  /** Optional explicit rollback target. Defaults to the previous engine identity. */
  readonly rollbackTarget?: ContextEngineIdentity;
}

export interface ContextEngineSwapController {
  readonly current: () => ContextEngine;
  readonly history: () => readonly ContextEngineSwapEvent[];
  readonly swap: (to: ContextEngine, options: SwapOptions) => ContextEngineSwapEvent | undefined;
  readonly rollback: (options: SwapOptions) => ContextEngineSwapEvent | undefined;
}

function sameIdentity(a: ContextEngineIdentity, b: ContextEngineIdentity): boolean {
  return a.name === b.name && a.version === b.version;
}

/**
 * Build a swap controller that holds the active engine plus the ordered
 * history of swap events. Both `swap()` and `rollback()` return the emitted
 * event so callers can forward it to the event bus / TUI / trace.
 */
export function createContextEngineSwapController(
  initial: ContextEngine,
): ContextEngineSwapController {
  const history: ContextEngineSwapEvent[] = [];
  let active: ContextEngine = initial;
  // Stack of prior engines for rollback resolution (parallel to history).
  const priorStack: ContextEngine[] = [];

  const current = (): ContextEngine => active;
  const historyView = (): readonly ContextEngineSwapEvent[] => history;

  const swap = (to: ContextEngine, options: SwapOptions): ContextEngineSwapEvent | undefined => {
    if (sameIdentity(active.identity, to.identity)) {
      return undefined;
    }
    const evt: ContextEngineSwapEvent = {
      kind: "context-engine-swap",
      turnId: options.turnId,
      from: active.identity,
      to: to.identity,
      reason: options.reason,
      ...(options.rollbackTarget !== undefined ? { rollbackTarget: options.rollbackTarget } : {}),
      timestamp: new Date().toISOString(),
    };
    priorStack.push(active);
    history.push(evt);
    active = to;
    return evt;
  };

  const rollback = (options: SwapOptions): ContextEngineSwapEvent | undefined => {
    const previous = priorStack.pop();
    if (previous === undefined) {
      return undefined;
    }
    const evt: ContextEngineSwapEvent = {
      kind: "context-engine-swap",
      turnId: options.turnId,
      from: active.identity,
      to: previous.identity,
      reason: options.reason,
      timestamp: new Date().toISOString(),
    };
    history.push(evt);
    active = previous;
    return evt;
  };

  return {
    current,
    history: historyView,
    swap,
    rollback,
  };
}
