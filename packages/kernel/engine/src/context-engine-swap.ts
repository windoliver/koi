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
  /**
   * Returns the engine currently serving requests. With a `turnId`, returns
   * the engine pinned for that specific turn (correct under overlapping or
   * re-entrant turns). Without a `turnId`, returns the most-recently-pinned
   * engine (LIFO) if any pin is active, otherwise the live `active` engine —
   * used by ECS reads (`agent.component(CONTEXT_ENGINE)`) which have no
   * turn context. ECS reads under overlapping turns observe the most-recent
   * pin; within slot middleware, the turnId-keyed lookup keeps `prepare()`
   * and `onAfterTurn` paired on the same engine even across overlap.
   */
  readonly current: (turnId?: TurnId) => ContextEngine;
  readonly history: () => readonly ContextEngineSwapEvent[];
  readonly swap: (to: ContextEngine, options: SwapOptions) => ContextEngineSwapEvent | undefined;
  readonly rollback: (options: SwapOptions) => ContextEngineSwapEvent | undefined;
  /**
   * Pin the engine currently in `active` to `turnId` for the duration of a
   * turn. While pinned, `current()` returns the pinned engine even after a
   * `swap()`. Idempotent on the same `turnId`. Called by the slot middleware
   * at the first `prepare()` of a turn.
   */
  readonly beginTurn: (turnId: TurnId) => void;
  /**
   * Release the pin. With a `turnId` argument, the pin is released only if
   * it matches (defensive against out-of-order calls under concurrent or
   * interrupted turns). With no argument, any active pin is released
   * unconditionally — used by the runtime's terminal-path cleanup so a
   * `done` exit that bypasses `onAfterTurn` cannot strand the controller.
   * Called by the slot middleware in `onAfterTurn` and by `createKoi`'s
   * streamEvents finally / pre-`done` cleanup.
   */
  readonly endTurn: (turnId?: TurnId) => void;
  /**
   * True if a turn pin is currently active. Used by the runtime's terminal
   * cleanup to detect adapters that exited via `done` without emitting
   * `turn_end`, so it can synthesize an `onAfterTurn` before releasing the
   * pin (otherwise stateful engines lose post-turn bookkeeping).
   */
  readonly hasActivePin: () => boolean;
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
  // Per-turn pins: keyed by `turnId` so overlapping/re-entrant turns each
  // hold their own snapshot. Without per-turn keying, a later beginTurn
  // would clobber an earlier turn's pin and make that earlier turn's
  // `onAfterTurn` resolve against the wrong engine. Insertion-ordered Map
  // preserves LIFO semantics for the no-arg `current()` lookup (last
  // beginTurn wins, matching the most-recent caller's expectation).
  const turnPins = new Map<TurnId, ContextEngine>();

  const lastPinnedEngine = (): ContextEngine | undefined => {
    let last: ContextEngine | undefined;
    for (const e of turnPins.values()) last = e;
    return last;
  };

  const current = (turnId?: TurnId): ContextEngine => {
    if (turnId !== undefined) {
      const pinned = turnPins.get(turnId);
      if (pinned !== undefined) return pinned;
    }
    return lastPinnedEngine() ?? active;
  };
  const historyView = (): readonly ContextEngineSwapEvent[] => history;

  const beginTurn = (turnId: TurnId): void => {
    if (turnPins.has(turnId)) return;
    turnPins.set(turnId, active);
  };

  const endTurn = (turnId?: TurnId): void => {
    if (turnId === undefined) {
      // Unconditional release — runtime terminal-path cleanup.
      turnPins.clear();
      return;
    }
    turnPins.delete(turnId);
  };

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

  const hasActivePin = (): boolean => turnPins.size > 0;

  return {
    current,
    history: historyView,
    swap,
    rollback,
    beginTurn,
    endTurn,
    hasActivePin,
  };
}
