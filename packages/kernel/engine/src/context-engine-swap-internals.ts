/**
 * Internal helpers + option types for `context-engine-swap.ts`.
 *
 * Extracted to keep the controller module under the project complexity
 * ratchet (file < 400 lines). Exports are not part of the package's public
 * surface and are not re-exported from `src/index.ts`.
 */

import type { ContextEngine, ContextEngineIdentity, ContextEngineSwapEvent } from "@koi/core";

export interface SwapStackFrame {
  readonly prior: ContextEngine;
  readonly rollbackTarget?: ContextEngineIdentity;
}

export function sameIdentity(a: ContextEngineIdentity, b: ContextEngineIdentity): boolean {
  return a.name === b.name && a.version === b.version;
}

export function findFrameMatching(
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

// Freeze every reachable field of an emitted event so that neither a buggy
// subscriber, a downstream caller, nor a later mutation of the engine's own
// identity object can rewrite swap history after commit. Identities are
// supplied by engine implementations and are otherwise live references —
// without cloning them into the event we'd freeze only the wrapper while
// leaving `event.from.name` etc. mutable.
export function freezeIdentity(id: ContextEngineIdentity): ContextEngineIdentity {
  return Object.freeze({ name: id.name, version: id.version });
}

export function freezeEvent(evt: ContextEngineSwapEvent): ContextEngineSwapEvent {
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
}

export interface SwapControllerOptions {
  /**
   * If set, swap targets whose `identity.name` does not match this string
   * are refused unless `SwapOptions.force` is true. Set by `createKoi` from
   * `manifest.context.engine` so runtime swaps cannot silently move off the
   * manifest-declared engine name.
   */
  readonly pinnedName?: string;
  /**
   * If set, swap targets whose `identity.version` does not match this
   * string are refused unless `SwapOptions.force` is true. Set by
   * `createKoi` from `manifest.context.version`. Enforced independently of
   * `pinnedName` so a manifest with version-only pin still allows
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
