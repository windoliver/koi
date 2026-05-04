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
   * Returns the engine for a specific turn (slot-middleware path) or the
   * "active for new turns" engine (no-arg, ECS-read path).
   *
   * - With `turnId`: returns the engine pinned for that turn — correct
   *   under overlapping/re-entrant turns. The slot middleware uses this
   *   so `prepare()` and `onAfterTurn` always pair on the same engine
   *   even when a swap lands mid-flight.
   * - Without `turnId`: returns the engine that will serve the NEXT
   *   request. After a swap with in-flight pins, that is the post-swap
   *   `active`, not whichever pinned engine happens to be LIFO-last —
   *   the older behavior collapsed overlapping state into one
   *   arbitrarily-chosen engine and made ECS reads / occupancy reports
   *   reason over partial state precisely when swaps were in flight.
   *   Hosts that need full visibility into in-flight pinned engines use
   *   `pinnedEngines()`.
   */
  readonly current: (turnId?: TurnId) => ContextEngine;
  /**
   * Snapshot of all engines currently pinned to in-flight turns. Empty
   * when no turn is in flight. Used by host-facing tooling that needs
   * the full overlapping state during a swap (audit log, TUI, occupancy
   * aggregator) — `current()` no-arg deliberately returns only `active`
   * to avoid silently collapsing the overlapping set to one engine.
   */
  readonly pinnedEngines: () => readonly ContextEngine[];
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

  // Freeze every reachable field of an emitted event so that neither a
  // buggy subscriber, a downstream caller, nor a later mutation of the
  // engine's own identity object can rewrite swap history after commit.
  // Identities are supplied by engine implementations and are otherwise
  // live references — without cloning them into the event we'd freeze
  // only the wrapper while leaving `event.from.name` etc. mutable.
  const freezeIdentity = (id: ContextEngineIdentity): ContextEngineIdentity =>
    Object.freeze({ name: id.name, version: id.version });
  const freezeEvent = (evt: ContextEngineSwapEvent): ContextEngineSwapEvent => {
    const cloned: ContextEngineSwapEvent = {
      kind: evt.kind,
      turnId: evt.turnId,
      from: freezeIdentity(evt.from),
      to: freezeIdentity(evt.to),
      reason: evt.reason,
      timestamp: evt.timestamp,
      ...(evt.rollbackTarget !== undefined
        ? { rollbackTarget: freezeIdentity(evt.rollbackTarget) }
        : {}),
      ...(evt.pinnedTurns !== undefined
        ? {
            pinnedTurns: Object.freeze(
              evt.pinnedTurns.map((p) =>
                Object.freeze({
                  turnId: p.turnId,
                  engineIdentity: freezeIdentity(p.engineIdentity),
                }),
              ),
            ),
          }
        : {}),
    };
    return Object.freeze(cloned);
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

  const current = (turnId?: TurnId): ContextEngine => {
    if (turnId !== undefined) {
      const pinned = turnPins.get(turnId);
      if (pinned !== undefined) return pinned;
    }
    // No-arg readers (ECS proxy, occupancy aggregator) get the engine
    // that will serve the NEXT request. Returning a LIFO-pinned engine
    // here would silently collapse overlapping in-flight turns into
    // whichever pin landed last, hiding the rest. Use `pinnedEngines()`
    // for the full set when overlap matters.
    return active;
  };

  const pinnedEngines = (): readonly ContextEngine[] => {
    if (turnPins.size === 0) return [];
    // Deduplicate while preserving insertion order so callers can iterate
    // each unique engine once for occupancy aggregation/audit.
    const seen = new Set<ContextEngine>();
    const out: ContextEngine[] = [];
    for (const e of turnPins.values()) {
      if (!seen.has(e)) {
        seen.add(e);
        out.push(e);
      }
    }
    return out;
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
    // Validate the caller-supplied `rollbackTarget` against the engines
    // that will actually be reachable after this swap commits: every
    // engine already on `priorStack`, plus the current `active` engine
    // which is about to be pushed. A typo or stale target would otherwise
    // silently pass swap() and turn rollback() into a no-op at incident
    // time, exactly when operators need it to work.
    if (options.rollbackTarget !== undefined) {
      const target = options.rollbackTarget;
      const reachable =
        sameIdentity(active.identity, target) ||
        priorStack.some((frame) => sameIdentity(frame.prior.identity, target));
      if (!reachable) {
        throw new Error(
          `ContextEngineSwapController: rollbackTarget "${target.name}@${target.version}" is not reachable from the controller's prior stack. Provide a target that matches an engine currently on the rollback path, or omit rollbackTarget to default to the immediately prior engine.`,
        );
      }
    }
    // Snapshot pinned turns BEFORE flipping `active` so observers see
    // exactly which in-flight turns are still serving on each engine.
    // `swap()` only repoints new-turn lookups; per-turn pins stay anchored
    // to the engine they began with — and across multiple sequential
    // swaps those pins may resolve to different engines, so we record the
    // engine identity per turn rather than assuming "all pinned turns
    // are on `from`".
    const pinnedSnapshot = pinnedTurnsSnapshot();
    const evt: ContextEngineSwapEvent = {
      kind: "context-engine-swap",
      turnId: options.turnId,
      from: active.identity,
      to: to.identity,
      reason: options.reason,
      ...(options.rollbackTarget !== undefined ? { rollbackTarget: options.rollbackTarget } : {}),
      ...(pinnedSnapshot.length > 0 ? { pinnedTurns: pinnedSnapshot } : {}),
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
    // Snapshot per-turn engine attribution so observers can attribute
    // each in-flight turn to whichever engine it actually started on.
    const pinnedSnapshot = pinnedTurnsSnapshot();
    const evt: ContextEngineSwapEvent = {
      kind: "context-engine-swap",
      turnId: options.turnId,
      from: active.identity,
      to: target.identity,
      reason: options.reason,
      ...(pinnedSnapshot.length > 0 ? { pinnedTurns: pinnedSnapshot } : {}),
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
  const pinnedTurnsSnapshot = (): readonly {
    readonly turnId: TurnId;
    readonly engineIdentity: import("@koi/core").ContextEngineIdentity;
  }[] => {
    if (turnPins.size === 0) return [];
    const out: { turnId: TurnId; engineIdentity: import("@koi/core").ContextEngineIdentity }[] = [];
    for (const [turnId, engine] of turnPins) {
      out.push({ turnId, engineIdentity: engine.identity });
    }
    return out;
  };

  const listeners = new Set<(event: ContextEngineSwapEvent) => void>();
  const subscribe = (listener: (event: ContextEngineSwapEvent) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const emit = (event: ContextEngineSwapEvent): void => {
    // Run every listener regardless of individual failures so one buggy
    // observer cannot starve the others. `active`/`history`/`priorStack`
    // are already mutated by the time emit() runs; a thrown listener
    // error must NOT be reported as "swap failed" because the swap has,
    // in fact, applied.
    //
    // Delivery semantics depend on whether `onListenerError` was wired:
    //   - hook set    → host owns durability; failures are routed to it
    //                   (and the swap returns normally)
    //   - hook unset  → fail loud: collect failures, finish notifying
    //                   every other listener, then THROW an aggregated
    //                   error so the caller learns the swap committed
    //                   but observers never saw it. This makes
    //                   "unaudited swap" unrepresentable by accident
    //                   while still protecting the in-memory transaction.
    const failures: { err: unknown }[] = [];
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (err: unknown) {
        if (onListenerError !== undefined) {
          try {
            onListenerError(err, event);
          } catch (hookErr: unknown) {
            console.error("[context-engine-swap] onListenerError hook threw", hookErr);
          }
        } else {
          failures.push({ err });
        }
      }
    }
    if (failures.length > 0) {
      // Throw AFTER every listener has been given a chance to see the
      // event. Caller catches this knowing the swap is committed (the
      // returned event was already published) and decides whether to
      // tolerate the unaudited transition or trigger a rollback.
      const aggregate = new Error(
        `ContextEngineSwapController: ${failures.length} subscriber(s) threw on swap delivery; swap is committed but at least one observer did not record it. Pass SwapControllerOptions.onListenerError to opt into best-effort delivery.`,
      );
      (aggregate as Error & { causes?: readonly unknown[] }).causes = Object.freeze(
        failures.map((f) => f.err),
      );
      throw aggregate;
    }
  };

  return {
    current,
    pinnedEngines,
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
