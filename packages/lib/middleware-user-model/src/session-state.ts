/**
 * Per-session mutable state for @koi/middleware-user-model and the
 * helpers that build / scope / mutate it.
 */

import type {
  InboundMessage,
  MemoryResult,
  SessionContext,
  UserSignal,
  UserSnapshot,
} from "@koi/core";
import { scopeNamespaceForSubject } from "./config.js";
import { createSnapshotCache, type SnapshotCache } from "./snapshot-cache.js";
import type { ResolvedUserModelConfig } from "./types.js";

export interface SessionState {
  readonly cache: SnapshotCache;
  readonly sensorState: Record<string, unknown>;
  /**
   * Bounded ring of post-action correction TEXT — used to seed drift
   * detection so a transient memory.recall failure cannot lose recent
   * in-session corrections. Sensor and pre-action signals are NOT kept
   * here; sensors live in `sensorState`, pre-action in `pendingPreAction`.
   * Cap prevents unbounded session growth in long-lived sessions with
   * active sensors (review round 14, finding 3).
   */
  readonly postActionHistory: string[];
  /** Per-source success count — used downstream to gate stable-reading heuristics. */
  readonly perSourceSampleCount: Map<string, number>;
  /** Last cached recall — seed for drift detection that has to compare against persisted prefs. */
  lastRecalledPreferences: readonly MemoryResult[];
  /** Pre-action signal carried into the current turn (cleared each turn). */
  pendingPreAction: Extract<UserSignal, { kind: "pre_action" }> | undefined;
  /**
   * The current turn's post-action correction (cleared at the start of
   * every turn). Only this turn's correction overrides recalled
   * preferences in `[User Context]`. Earlier-turn corrections live in
   * `postActionHistory` for drift seeding but no longer reshape later
   * snapshots — that would silently strip unrelated recalled prefs
   * (review round 8).
   */
  pendingPostAction: Extract<UserSignal, { kind: "post_action" }> | undefined;
  /**
   * In-flight `memory.store()` promises from this session. The next turn
   * awaits this set (bounded by `persistenceTimeoutMs`) before issuing
   * `memory.recall()` so that a correction persisted in turn N is
   * observable to turn N+1's recall. Entries that exceed the drain
   * timeout are retired from this set (abandoned for drain purposes) so
   * one hung store cannot keep imposing per-turn latency on every later
   * turn (review round 10, finding 2).
   */
  pendingStores: Set<Promise<void>>;
  /**
   * Corrections whose `memory.store()` has not yet settled (success or
   * failure). Overlaid in `buildSnapshot` so a slow-but-eventual write
   * does not lose its prompt visibility on later turns while it is still
   * in flight (review round 10, finding 1). On settle the entry is
   * removed; if the store eventually succeeds, the correction surfaces
   * via `memory.recall()` instead.
   */
  readonly unresolvedCorrections: Set<string>;
  /**
   * Subject scope for this session — derived from `cfg.resolveSubjectId`
   * (per-session) or `cfg.subjectId` (static), captured once at session
   * start so every store/recall in this session writes to the same scope.
   * `undefined` here means the caller opted into shared scope explicitly
   * (`allowSharedScope: true`); without that opt-in the middleware skips
   * memory operations for the session and logs via `cfg.onError`.
   */
  subjectScope: string | undefined;
  /** Whether this session is permitted to touch memory at all. */
  scopeReady: boolean;
  /**
   * Per-turn snapshot eagerly captured at the END of `runBeforeTurn`,
   * keyed by `turnId`. `runWrapModelCall` reads its own turn's snapshot
   * (then deletes the entry) so two overlapping turns on one session
   * cannot clobber each other's pinned `[User Context]` (review round 13,
   * finding 3). Falls back to the lazy `cache` when no eager entry is
   * present (e.g., wrapModelCall invoked without a prior onBeforeTurn).
   */
  readonly snapshotByTurn: Map<string, UserSnapshot>;
  /**
   * Identity of the last user message we ingested signals from. The
   * engine's stop-gate retry path rebuilds a turn from the original
   * user message plus a new system stop-hook frame, so
   * `extractLastUserText` returns the SAME user text across retries.
   * Without this fingerprint we'd re-classify and re-persist the same
   * correction on every retry (review round 14, finding 1). Compared
   * by reference identity AND text — duplicates fail closed (skip).
   */
  lastProcessedUserMessage: InboundMessage | undefined;
  /**
   * Per-session OBT serialization lock. Each onBeforeTurn awaits the
   * prior OBT, then runs to completion (recall + signal derivation +
   * eager snapshot) before releasing. Without this, two overlapping
   * OBTs would interleave at every await and clobber each other's
   * lastRecalledPreferences / pendingPostAction before buildSnapshot
   * captured them (review round 15, finding 2). The lock is RELEASED
   * at the end of OBT — not held into wrapModelCall — because the
   * eager snapshot is now the only thing wrapModelCall depends on.
   */
  obtChain: Promise<void>;
}

/**
 * Cap on per-session post-action history. Bounds memory growth and
 * per-turn `collectExistingPreferences` work in long-lived sessions
 * (review round 14, finding 3). Older entries are evicted FIFO; the
 * most recent corrections are the most useful for drift seeding.
 */
export const MAX_POST_ACTION_HISTORY = 32;

export function freshSession(buildSnapshot: () => Promise<UserSnapshot>): SessionState {
  const sensorState: Record<string, unknown> = {};
  const perSourceSampleCount = new Map<string, number>();
  const state: SessionState = {
    cache: createSnapshotCache(buildSnapshot),
    sensorState,
    postActionHistory: [],
    perSourceSampleCount,
    lastRecalledPreferences: [],
    pendingPreAction: undefined,
    pendingPostAction: undefined,
    pendingStores: new Set<Promise<void>>(),
    unresolvedCorrections: new Set<string>(),
    subjectScope: undefined,
    scopeReady: false,
    snapshotByTurn: new Map<string, UserSnapshot>(),
    lastProcessedUserMessage: undefined,
    obtChain: Promise.resolve(),
  };
  return state;
}

/**
 * Resolve the per-session subject scope using `resolveSubjectId` (preferred,
 * derived from live SessionContext) and falling back to the static
 * `subjectId` from config. If neither yields a value the session is
 * permitted to touch memory ONLY when the caller explicitly opted into
 * shared scope (`allowSharedScope: true`); otherwise memory ops are
 * suppressed for the session and a single error is reported via onError
 * so misconfiguration is visible (review round 12, finding 3).
 */
export function applySubjectScope(
  cfg: ResolvedUserModelConfig,
  state: SessionState,
  session: SessionContext,
): void {
  let resolved: string | undefined;
  if (cfg.resolveSubjectId !== undefined) {
    try {
      const candidate = cfg.resolveSubjectId(session);
      if (typeof candidate === "string" && candidate.length > 0) resolved = candidate;
    } catch (e: unknown) {
      cfg.onError(e);
    }
  }
  if (resolved === undefined && cfg.subjectId !== undefined && cfg.subjectId.length > 0) {
    resolved = cfg.subjectId;
  }
  if (resolved !== undefined) {
    state.subjectScope = resolved;
    state.scopeReady = true;
    return;
  }
  if (cfg.allowSharedScope) {
    state.subjectScope = undefined;
    state.scopeReady = true;
    return;
  }
  state.scopeReady = false;
  cfg.onError(
    new Error(
      `user-model: no subject scope for session ${session.sessionId} — resolveSubjectId returned undefined and no static subjectId is set; memory operations suppressed for this session`,
    ),
  );
}

export function namespaceForSession(cfg: ResolvedUserModelConfig, state: SessionState): string {
  return scopeNamespaceForSubject(cfg.preferenceNamespace, state.subjectScope);
}

export function ensureSession(
  sessions: Map<string, SessionState>,
  session: SessionContext,
  cfg: ResolvedUserModelConfig,
  buildSnapshot: () => Promise<UserSnapshot>,
): SessionState {
  const existing = sessions.get(session.sessionId);
  if (existing !== undefined) return existing;
  // Caller invoked onBeforeTurn / wrapModelCall without a prior
  // onSessionStart — synthesize a fresh session AND apply scope so per-
  // session subject resolution still runs.
  const created = freshSession(buildSnapshot);
  applySubjectScope(cfg, created, session);
  sessions.set(session.sessionId, created);
  return created;
}

export function ingestInternal(state: SessionState, signal: UserSignal): void {
  if (signal.kind === "post_action") {
    state.postActionHistory.push(signal.correction);
    while (state.postActionHistory.length > MAX_POST_ACTION_HISTORY) {
      state.postActionHistory.shift();
    }
  }
  // pre_action signals live in `pendingPreAction` (per-turn slot) — no
  // need to retain them on the session timeline.
}

export function ingestSensor(
  state: SessionState,
  sourceName: string,
  signal: Extract<UserSignal, { kind: "sensor" }>,
): void {
  // Key sensor state by the configured `SignalSource.name` (unique per
  // registration — validated in config) rather than `signal.source`
  // (caller-controlled payload). Two sources with the same payload
  // `signal.source` no longer overwrite each other (review round 16,
  // finding 3). Cleanup deletes by sourceName too, so a failed source
  // cannot evict a healthy peer's state.
  state.sensorState[sourceName] = signal.values;
  state.perSourceSampleCount.set(sourceName, (state.perSourceSampleCount.get(sourceName) ?? 0) + 1);
}
