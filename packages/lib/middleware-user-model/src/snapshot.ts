/**
 * Snapshot assembly + pinning utilities for @koi/middleware-user-model.
 * Pure functions over SessionState — no I/O.
 */

import type { InboundMessage, MemoryResult, UserSignal, UserSnapshot } from "@koi/core";
import type { SessionState } from "./session-state.js";

/**
 * Collect the set of "existing" preferences for drift seeding.
 * Merges persisted recalls (durable, cross-session) with in-session
 * post_action history (durable across memory backend hiccups).
 */
export function collectExistingPreferences(state: SessionState): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of state.lastRecalledPreferences) {
    if (seen.has(r.content)) continue;
    seen.add(r.content);
    out.push(r.content);
  }
  for (const correction of state.postActionHistory) {
    if (seen.has(correction)) continue;
    seen.add(correction);
    out.push(correction);
  }
  return out;
}

export function buildSnapshot(state: SessionState): UserSnapshot {
  // Per-turn overlay: the CURRENT turn's correction is appended to the
  // recalled list as the most-recent line. Earlier-turn corrections are
  // not re-overlaid here — they live in `state.postActionHistory` for
  // drift seeding but no longer reshape later snapshots, so a single
  // correction cannot silently strip unrelated recalled preferences from
  // the rest of the session (review round 8).
  //
  // Plus: any in-flight unresolved corrections from prior turns are
  // overlaid until their `memory.store()` settles — otherwise a slow
  // backend would lose the correction's prompt visibility on turn N+1
  // (review round 10, finding 1). On settle, recall picks them up; on
  // failure, we accept the loss.
  const preferences = overlayUnresolvedAndCurrent(
    state.lastRecalledPreferences,
    state.unresolvedCorrections,
    state.pendingPostAction,
  );
  // Ambiguity must surface whenever the current turn is genuinely vague —
  // suppressing it because earlier turns happen to have stored preferences
  // would push the agent to act on under-specified input ("fix it") using
  // stale context instead of asking for clarification (review round 12,
  // finding 2).
  const lastPreAction = state.pendingPreAction;
  const ambiguityDetected = lastPreAction !== undefined;

  const snapshot: UserSnapshot = {
    preferences,
    state: { ...state.sensorState },
    ambiguityDetected,
    suggestedQuestion: ambiguityDetected ? lastPreAction?.question : undefined,
  };
  return snapshot;
}

export function overlayUnresolvedAndCurrent(
  recalled: readonly MemoryResult[],
  unresolved: ReadonlySet<string>,
  current: Extract<UserSignal, { kind: "post_action" }> | undefined,
): readonly MemoryResult[] {
  // Recency-only: append unresolved-prior-turn corrections, then the
  // current turn's correction last. The model resolves any contradiction
  // by recency (most-recent wins). Earlier rounds tried various
  // suppression heuristics — all were either too aggressive (stripping
  // unrelated standing prefs — review rounds 8 + 9) or required stable
  // record IDs the L0 `MemoryResult` contract does not expose. Durable
  // supersession remains the memory backend's responsibility.
  const seen = new Set<string>(recalled.map((r) => r.content));
  const extras: MemoryResult[] = [];
  // Stable iteration: insertion order on Set.
  for (const correction of unresolved) {
    if (current !== undefined && correction === current.correction) continue;
    if (seen.has(correction)) continue;
    seen.add(correction);
    extras.push({ content: correction });
  }
  if (current !== undefined && !seen.has(current.correction)) {
    extras.push({ content: current.correction });
  }
  if (extras.length === 0) return recalled;
  return [...recalled, ...extras];
}

export function hasContent(snapshot: UserSnapshot): boolean {
  if (snapshot.preferences.length > 0) return true;
  if (Object.keys(snapshot.state).length > 0) return true;
  if (snapshot.ambiguityDetected) return true;
  return false;
}

export function prependPinned(
  pinned: InboundMessage,
  messages: readonly InboundMessage[],
): readonly InboundMessage[] {
  return [pinned, ...messages];
}
