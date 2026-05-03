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
  /**
   * Override the manifest pin. When the controller was constructed with
   * `pinnedName` and/or `pinnedVersion`, swap targets that violate either
   * pin are refused unless `force: true` is set. Each pin is enforced
   * independently — a `pinnedVersion` alone allows swaps between engines
   * whose reported version matches the pin, mirroring the documented
   * `manifest.context.version` semantics.
   */
  readonly force?: boolean;
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
  /**
   * The set of turnIds with active pins, in insertion order. Used by the
   * runtime's terminal cleanup so it can release each pin individually
   * (with `endTurn(turnId)`) and run `onAfterTurn` against the engine
   * pinned for THAT turn — instead of collapsing all pins via no-arg
   * cleanup, which would corrupt unrelated overlapping turns.
   */
  readonly pinnedTurnIds: () => readonly TurnId[];
  /**
   * Subscribe to swap/rollback events as they are applied. Invoked
   * synchronously after `active` has been updated. Returns an unsubscribe
   * function. Listener errors are caught and rethrown after all listeners
   * fire so one buggy observer cannot starve the others.
   *
   * Hosts wire this to their event bus / TUI / audit log so forced swaps
   * and rollbacks become observable instead of being silently consumed by
   * whoever called `swap()` and ignored the return value.
   */
  readonly subscribe: (listener: (event: ContextEngineSwapEvent) => void) => () => void;
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
export interface SwapControllerOptions {
  /**
   * If set, swap targets whose `identity.name` does not match this string
   * are refused unless `SwapOptions.force` is true. Set by `createKoi`
   * from `manifest.context.engine` so runtime swaps cannot silently move
   * off the manifest-declared engine name.
   */
  readonly pinnedName?: string;
  /**
   * If set, swap targets whose `identity.version` does not match this
   * string are refused unless `SwapOptions.force` is true. Set by
   * `createKoi` from `manifest.context.version`. Enforced independently
   * of `pinnedName` so a manifest with version-only pin still allows
   * cross-engine swaps within that version (matching the documented
   * manifest contract).
   */
  readonly pinnedVersion?: string;
  /**
   * Hook for structured handling of subscriber delivery failures. The
   * controller treats subscribers as best-effort observers and never lets a
   * thrown listener corrupt the swap transaction (`active`, `history`, and
   * `priorStack` are already mutated by the time `emit()` runs). When this
   * hook is supplied, host audit/event-bus code can route the failure to a
   * durable sink instead of relying on `console.error`. The hook itself
   * MUST NOT throw — exceptions from it are caught and logged.
   */
  readonly onListenerError?: (err: unknown, event: ContextEngineSwapEvent) => void;
}

export function createContextEngineSwapController(
  initial: ContextEngine,
  options: SwapControllerOptions = {},
): ContextEngineSwapController {
  const pinnedName = options.pinnedName;
  const pinnedVersion = options.pinnedVersion;
  const onListenerError = options.onListenerError;

  const pinDescription = (): string => {
    const parts: string[] = [];
    if (pinnedName !== undefined) parts.push(`name="${pinnedName}"`);
    if (pinnedVersion !== undefined) parts.push(`version="${pinnedVersion}"`);
    return parts.join(", ");
  };

  const violatesPin = (id: ContextEngineIdentity): boolean => {
    if (pinnedName !== undefined && id.name !== pinnedName) return true;
    if (pinnedVersion !== undefined && id.version !== pinnedVersion) return true;
    return false;
  };
  const history: ContextEngineSwapEvent[] = [];

  // Freeze the event (and its `pinnedTurnIds` array if present) so neither
  // a buggy subscriber nor a downstream caller can rewrite history after
  // the swap commits. Object.freeze is a runtime contract — TS `readonly`
  // is compile-time only and would not stop a malicious mutation.
  const freezeEvent = (evt: ContextEngineSwapEvent): ContextEngineSwapEvent => {
    if (evt.pinnedTurnIds !== undefined) Object.freeze(evt.pinnedTurnIds);
    return Object.freeze(evt);
  };
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
  // Defensive copy of the backing array so callers cannot rewrite history
  // by mutating the returned slice. Each event is already frozen at push
  // time, so a shallow copy is sufficient.
  const historyView = (): readonly ContextEngineSwapEvent[] => history.slice();

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
    if (violatesPin(to.identity) && options.force !== true) {
      throw new Error(
        `ContextEngineSwapController: refusing to swap to "${to.identity.name}@${to.identity.version}" — manifest pinned ${pinDescription()}. Pass { force: true } to override.`,
      );
    }
    // Snapshot pinned turns BEFORE flipping `active` so observers see
    // exactly which in-flight turns are still serving on the pre-swap
    // engine. `swap()` only repoints new-turn lookups; per-turn pins
    // stay anchored to the engine they began with.
    const pinnedSnapshot: readonly TurnId[] = turnPins.size > 0 ? Array.from(turnPins.keys()) : [];
    const evt: ContextEngineSwapEvent = {
      kind: "context-engine-swap",
      turnId: options.turnId,
      from: active.identity,
      to: to.identity,
      reason: options.reason,
      ...(options.rollbackTarget !== undefined ? { rollbackTarget: options.rollbackTarget } : {}),
      ...(pinnedSnapshot.length > 0 ? { pinnedTurnIds: pinnedSnapshot } : {}),
      timestamp: new Date().toISOString(),
    };
    priorStack.push({
      prior: active,
      ...(options.rollbackTarget !== undefined ? { rollbackTarget: options.rollbackTarget } : {}),
    });
    const frozen = freezeEvent(evt);
    history.push(frozen);
    active = to;
    emit(frozen);
    return frozen;
  };

  const rollback = (options: SwapOptions): ContextEngineSwapEvent | undefined => {
    const top = priorStack[priorStack.length - 1];
    if (top === undefined) {
      return undefined;
    }
    // Resolve the candidate target WITHOUT mutating priorStack. We must
    // run all refusal checks (pin enforcement, missing-target) up front so
    // that a rejected rollback leaves history intact and the operator can
    // retry with `force: true`. Mutating the stack before the pin check
    // would discard the frame needed for that retry.
    let target: ContextEngine;
    let truncateLength: number;
    if (top.rollbackTarget !== undefined) {
      const idx = findFrameMatching(priorStack, top.rollbackTarget);
      if (idx === -1) {
        // Declared target no longer reachable on the stack — refuse to roll
        // back to a different engine than the operator asked for.
        return undefined;
      }
      target = priorStack[idx]?.prior ?? top.prior;
      truncateLength = idx;
    } else {
      target = top.prior;
      truncateLength = priorStack.length - 1;
    }
    // Apply the same manifest-pin enforcement to the rollback destination
    // as `swap()`. Without this, a forced swap chain followed by an
    // automatic rollback could land on a non-pinned engine — re-opening
    // the trust hole that the manifest pin was meant to close.
    if (violatesPin(target.identity) && options.force !== true) {
      throw new Error(
        `ContextEngineSwapController: refusing to rollback to "${target.identity.name}@${target.identity.version}" — manifest pinned ${pinDescription()}. Pass { force: true } to override.`,
      );
    }
    // Commit only after every refusal check has passed.
    priorStack.length = truncateLength;
    // Snapshot in-flight pins so observers can attribute turns still
    // running on `from` instead of mistakenly crediting `target`.
    const pinnedSnapshot: readonly TurnId[] = turnPins.size > 0 ? Array.from(turnPins.keys()) : [];
    const evt: ContextEngineSwapEvent = {
      kind: "context-engine-swap",
      turnId: options.turnId,
      from: active.identity,
      to: target.identity,
      reason: options.reason,
      ...(pinnedSnapshot.length > 0 ? { pinnedTurnIds: pinnedSnapshot } : {}),
      timestamp: new Date().toISOString(),
    };
    const frozen = freezeEvent(evt);
    history.push(frozen);
    active = target;
    emit(frozen);
    return frozen;
  };

  const hasActivePin = (): boolean => turnPins.size > 0;
  const pinnedTurnIds = (): readonly TurnId[] => Array.from(turnPins.keys());

  const listeners = new Set<(event: ContextEngineSwapEvent) => void>();
  const subscribe = (listener: (event: ContextEngineSwapEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const emit = (event: ContextEngineSwapEvent): void => {
    // Listeners are best-effort observers (audit log, TUI, event bus).
    // Re-throwing their errors would turn swap()/rollback() into partial
    // commits — `active`/`history`/`priorStack` have already been mutated
    // before emit() runs, so a thrown listener error would make the
    // caller think the swap failed even though it has, in fact, applied.
    // Swallow + console.error so observability gaps stay visible without
    // corrupting the swap transaction.
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err: unknown) {
        if (onListenerError !== undefined) {
          // Route through the host-supplied hook so audit/event-bus code
          // can persist the failure. Guard against the hook itself
          // throwing — observability code must never break the swap.
          try {
            onListenerError(err, event);
          } catch (hookErr: unknown) {
            console.error("[context-engine-swap] onListenerError hook threw", hookErr);
          }
        } else {
          console.error("[context-engine-swap] subscribe listener threw", err);
        }
      }
    }
  };

  return {
    current,
    history: historyView,
    swap,
    rollback,
    beginTurn,
    endTurn,
    hasActivePin,
    pinnedTurnIds,
    subscribe,
  };
}
