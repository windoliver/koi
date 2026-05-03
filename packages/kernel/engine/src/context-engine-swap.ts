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

interface SwapStackFrame {
  readonly prior: ContextEngine;
  readonly rollbackTarget?: ContextEngineIdentity;
}

function findFrameMatching(
  stack: readonly SwapStackFrame[],
  target: ContextEngineIdentity,
): number {
  for (let i = stack.length - 1; i >= 0; i--) {
    const frame = stack[i];
    if (frame !== undefined && sameIdentity(frame.prior.identity, target)) {
      return i;
    }
  }
  return -1;
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
  // Each frame records the engine displaced by a swap plus the rollback
  // target the caller declared at swap time (if any). Rollback resolves to
  // the declared target when set, otherwise to the immediately prior engine.
  const priorStack: SwapStackFrame[] = [];

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
    priorStack.push({
      prior: active,
      ...(options.rollbackTarget !== undefined ? { rollbackTarget: options.rollbackTarget } : {}),
    });
    history.push(evt);
    active = to;
    return evt;
  };

  const rollback = (options: SwapOptions): ContextEngineSwapEvent | undefined => {
    const top = priorStack[priorStack.length - 1];
    if (top === undefined) {
      return undefined;
    }
    // Honor the declared rollback target on the top frame if set: walk down
    // the stack until we find the engine matching that identity, popping all
    // frames in between. Without a declared target, pop one frame.
    let target: ContextEngine;
    if (top.rollbackTarget !== undefined) {
      const idx = findFrameMatching(priorStack, top.rollbackTarget);
      if (idx === -1) {
        // Declared target no longer reachable on the stack — refuse to roll
        // back to a different engine than the operator asked for.
        return undefined;
      }
      target = priorStack[idx]?.prior ?? top.prior;
      priorStack.length = idx;
    } else {
      target = top.prior;
      priorStack.pop();
    }
    const evt: ContextEngineSwapEvent = {
      kind: "context-engine-swap",
      turnId: options.turnId,
      from: active.identity,
      to: target.identity,
      reason: options.reason,
      timestamp: new Date().toISOString(),
    };
    history.push(evt);
    active = target;
    return evt;
  };

  return {
    current,
    history: historyView,
    swap,
    rollback,
  };
}
