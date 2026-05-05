/**
 * Lifecycle transition validation.
 *
 * Two explicitly-named APIs so callers cannot accidentally preflight against
 * the wrong rule set:
 *   - `validateGraphTransition` — checks L0 `VALID_LIFECYCLE_TRANSITIONS`
 *     only. Use for in-memory state-machine reasoning where the store is
 *     not involved.
 *   - `validateStoreTransition` — also rejects transitions out of
 *     lifecycles the content-addressable store treats as terminal
 *     (`failed`, `deprecated`, `quarantined`). Use when preflighting a
 *     store `update()` — otherwise callers can get a green light for
 *     a transition the store will reject.
 *
 * Identity edges (`X → X`) are rejected by both — they imply a no-op
 * caller bug.
 */

import { type BrickLifecycle, VALID_LIFECYCLE_TRANSITIONS } from "@koi/core";

export type LifecycleTransitionResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

const STORE_TERMINAL_LIFECYCLES: ReadonlySet<BrickLifecycle> = new Set([
  "failed",
  "deprecated",
  "quarantined",
]);

function isKnown(state: BrickLifecycle): boolean {
  return Object.hasOwn(VALID_LIFECYCLE_TRANSITIONS, state);
}

function checkGraph(from: BrickLifecycle, to: BrickLifecycle): LifecycleTransitionResult {
  if (!isKnown(from)) {
    return { ok: false, reason: `Unknown from-state: ${String(from)}` };
  }
  if (!isKnown(to)) {
    return { ok: false, reason: `Unknown to-state: ${String(to)}` };
  }
  if (from === to) {
    return { ok: false, reason: `Identity transition is not valid: ${from} → ${to}` };
  }
  const allowed = VALID_LIFECYCLE_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: `Invalid transition ${from} → ${to}; allowed from ${from}: [${allowed.join(", ") || "none (terminal)"}]`,
    };
  }
  return { ok: true };
}

/**
 * Graph-only validation against L0 `VALID_LIFECYCLE_TRANSITIONS`.
 * May return `ok: true` for transitions the store will reject (e.g.
 * `quarantined → draft`). Use `validateStoreTransition` when preflighting
 * a store `update()`.
 */
export function validateGraphTransition(
  from: BrickLifecycle,
  to: BrickLifecycle,
): LifecycleTransitionResult {
  return checkGraph(from, to);
}

/**
 * Store-safe validation. Applies the L0 graph rules AND rejects any
 * transition out of a terminal lifecycle (`failed`, `deprecated`,
 * `quarantined`) — matching `memory-store.update()` semantics so the
 * helper and the store agree on what can persist.
 */
export function validateStoreTransition(
  from: BrickLifecycle,
  to: BrickLifecycle,
): LifecycleTransitionResult {
  // Validate state names BEFORE the identity shortcut so a corrupt /
  // deserialized "bogus → bogus" cannot get a false green light.
  if (!isKnown(from)) {
    return { ok: false, reason: `Unknown from-state: ${String(from)}` };
  }
  if (!isKnown(to)) {
    return { ok: false, reason: `Unknown to-state: ${String(to)}` };
  }
  // Identity edge: `memory-store.update()` only invokes transition
  // validation when `updates.lifecycle !== existing.lifecycle`, so an
  // identity request is a semantic no-op the store accepts. Mirror that
  // behaviour here — rejecting would create a false-positive on retried
  // / already-applied lifecycle updates.
  if (from === to) return { ok: true };
  const graph = checkGraph(from, to);
  if (!graph.ok) return graph;
  if (STORE_TERMINAL_LIFECYCLES.has(from)) {
    return {
      ok: false,
      reason: `${from} is terminal at the store layer; bump version and resynthesize instead of transitioning to ${to}`,
    };
  }
  return { ok: true };
}
