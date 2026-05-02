/**
 * persist-engine-state — wrap an EngineAdapter so an interrupted terminal
 * persists `EngineState` into `SessionPersistence`.
 *
 * Why a caller-side wrapper:
 *   L1 `@koi/engine` cannot import `@koi/session` (L2). The engine owns the
 *   adapter and emits `done.stopReason==="interrupted"`, but it cannot itself
 *   call `SessionPersistence.saveSession`. So the caller (runtime/CLI) opts in
 *   by wrapping their adapter with this helper before passing it to createKoi.
 *
 * Cancel-only by design (issue #1683 scope):
 *   Persistence fires only when `stopReason === "interrupted"`. Continuous /
 *   periodic persistence is a separate concern (v1 archive used a 10s timer).
 *
 * Adapter without `saveState`:
 *   Pass-through — the wrapper records nothing and the caller falls back to
 *   transcript-only resume via `resumeForSession`.
 *
 * Concurrency:
 *   When the store implements the optional `updateLastEngineState`, the
 *   wrapper uses it for both the cancel write and the success-side clear.
 *   That call performs read-modify-write inside a single transaction (or
 *   the JS event-loop critical section, for the in-memory store), so a
 *   timed-out write CANNOT commit on top of a newer terminal — the store
 *   itself enforces atomicity.
 *
 *   When `updateLastEngineState` is absent, the wrapper falls back to
 *   `loadSession` + `saveSession` and uses a wrapper-scoped generation
 *   token to drop most stale writes. That fallback inherits a residual
 *   dispatch-vs-commit race window (a write whose `saveSession` itself
 *   stalls past the timeout can still land after a newer terminal). The
 *   bundled in-memory and SQLite stores both implement the atomic update,
 *   so the residual race only matters for custom `SessionPersistence`
 *   implementations.
 */

import type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineState,
  KoiError,
  SessionPersistence,
  SessionRecord,
} from "@koi/core";
import { extractMessage } from "@koi/errors";

/**
 * Caller-supplied template for the SessionRecord written on cancel.
 *
 * `lastEngineState` and `lastPersistedAt` are filled in by the wrapper —
 * supplying them here is ignored. Everything else (sessionId, agentId,
 * manifestSnapshot, seq, remoteSeq, connectedAt, status, metadata) must be
 * provided by the caller because only the caller knows the current session
 * topology.
 */
export type SessionRecordTemplate = Omit<SessionRecord, "lastEngineState" | "lastPersistedAt">;

export interface PersistEngineStateOptions {
  readonly persistence: SessionPersistence;
  /**
   * Resolves the SessionRecord template at terminal time. A function (not a
   * static record) so callers can capture the current `seq` / `remoteSeq` /
   * `status` at the moment of cancel rather than at wrap time.
   */
  readonly recordTemplate: () => SessionRecordTemplate;
  /**
   * Required. Fired when persistence fails (`saveState` throw, `saveSession`
   * returning an error, stale-checkpoint clear failing, or persist sequence
   * timing out). Cancellation itself always succeeds — persist failures never
   * escalate the terminal outcome — so the host MUST observe this signal to
   * treat the next resume as "checkpoint lost; downgrade UX to transcript-only
   * resume". This is required (not optional) because durable cancel-resume is
   * the entire point of the wrapper: silently swallowing checkpoint loss would
   * let the host show "Resume" without being able to honor it.
   */
  readonly onPersistError: (error: KoiError | Error) => void;
  /**
   * Optional clock for tests. Default: Date.now.
   */
  readonly now?: () => number;
  /**
   * Strict deadline (ms) for the entire persist sequence (`saveState` +
   * `loadSession` + `saveSession`). When the deadline elapses, `onPersistError`
   * fires with a TIMEOUT and the terminal `done` event is yielded immediately
   * so cancel UX is never blocked by a hung adapter snapshot or stalled store.
   * Default: 5_000.
   */
  readonly persistTimeoutMs?: number;
  /**
   * Optional EngineState to feed into `inner.loadState` BEFORE the first
   * stream call. Set this to the `lastEngineState` returned by
   * `resumeWithEngineState` so the adapter resumes from the cancel cursor
   * instead of replaying transcript-only. Loaded exactly once: the wrapper
   * tracks a "loaded" flag so subsequent streams don't re-apply it.
   *
   * No-op when `inner.loadState` is undefined OR `initialEngineState` is
   * undefined (the wrapper degrades to transcript-only resume).
   */
  readonly initialEngineState?: EngineState;
  /**
   * Optional. The `lastPersistedAt` value observed at resume time —
   * passed back as `expectedVersion` on the wrapper's first store
   * write/clear so cross-process safety is enforced from the moment of
   * resume rather than only after this wrapper's first own write. When
   * undefined, cross-process protection only kicks in after this wrapper
   * has successfully written at least once.
   */
  readonly initialEngineStateVersion?: number;
}

const DEFAULT_PERSIST_TIMEOUT_MS = 5_000 as const;

/**
 * Wrap `inner` so on `done.stopReason === "interrupted"` it calls
 * `inner.saveState?.()` and persists the resulting state into the supplied
 * `SessionPersistence` under the supplied record template.
 *
 * Pass-through when `inner.saveState` is undefined.
 */
export function wrapAdapterWithStatePersistence(
  inner: EngineAdapter,
  options: PersistEngineStateOptions,
): EngineAdapter {
  const { persistence, recordTemplate, onPersistError } = options;
  const now = options.now ?? Date.now;

  const saveState = inner.saveState;
  if (saveState === undefined) {
    // Adapter doesn't support state capture — return inner unchanged.
    // Caller falls back to transcript-only resume.
    return inner;
  }

  // Round 9: refuse stores without atomic CAS. The load-merge-save
  // fallback inherits a documented dispatch-vs-commit race window where
  // a timed-out interrupted persist can commit on top of a newer
  // terminal — exactly the corruption durable cancel-resume must
  // prevent. The bundled in-memory and SQLite stores both implement
  // `updateLastEngineState`; custom remote stores must do the same
  // (with their own version/CAS check inside the transaction body, per
  // the L0 contract docs in `@koi/core/session.ts`).
  if (persistence.updateLastEngineState === undefined) {
    throw new Error(
      "[@koi/session:persist-engine-state] SessionPersistence implementation does not " +
        "implement updateLastEngineState — refusing to wrap. Atomic CAS is required for " +
        "durable cancel-resume; the non-CAS fallback can resurrect stale checkpoints. " +
        "Use createInMemorySessionPersistence / createSqliteSessionPersistence (both " +
        "implement it) or extend your custom store with the optional method.",
    );
  }

  const persistTimeoutMs = options.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT_MS;

  // The generation counter MUST be wrapper-scoped, not stream-scoped. A
  // production session reuses the same wrapper across many `stream()` calls.
  // If the gen counter were per-stream, a timed-out interrupted persist from
  // stream N could resolve in the background AFTER stream N+1 already cleared
  // the checkpoint — and stream N+1's gen counter would not invalidate it.
  // Sharing a single ref means every later terminal advances `gen.current`,
  // so any stale write checking it sees a mismatch and aborts.
  const gen: GenRef = { current: 0 };

  // Lazily apply initialEngineState before the first stream. On failure,
  // PRESERVE the persisted checkpoint and SUPPRESS the next non-
  // interrupted clear — the host's `onPersistError` handler decides
  // whether to retry, surface UX, or wipe the row externally. This is
  // the round-2/round-4/round-9 reviewer preference (4 of 7 review
  // rounds favored preservation): a transient decode/IO failure should
  // not auto-destroy the only durable cancel cursor. Trade-off: if the
  // host ignores the signal and the run produces new transcript entries,
  // the next resume could combine an old engine cursor with newer
  // transcript — that is the host's responsibility to prevent via the
  // signal handler.
  const loadState = inner.loadState;
  let pendingInitial: EngineState | undefined =
    options.initialEngineState !== undefined && loadState !== undefined
      ? options.initialEngineState
      : undefined;
  const loadFailedRef: { failed: boolean } = { failed: false };
  // Last `lastPersistedAt` value the wrapper observed in the store —
  // either seeded from `initialEngineStateVersion` at resume time, or
  // updated after every successful own write. Passed as
  // `expectedVersion` on the next clear/write so a concurrent process
  // that wrote to the same row in between is detected (CONFLICT) and the
  // wrapper backs off without erasing the newer state.
  const lastWrittenAtRef: { value: number | undefined } = {
    value: options.initialEngineStateVersion,
  };

  return {
    ...inner,
    stream: (input: EngineInput): AsyncIterable<EngineEvent> => {
      const initialToApply = pendingInitial;
      pendingInitial = undefined;
      const innerStream = streamWithLazyLoad(inner, input, initialToApply, loadState, {
        saveState,
        persistence,
        recordTemplate,
        now,
        onPersistError,
        persistTimeoutMs,
        loadFailedRef,
        lastWrittenAtRef,
      });
      return wrapStreamForCancelPersist(innerStream, gen, {
        saveState,
        persistence,
        recordTemplate,
        now,
        onPersistError,
        persistTimeoutMs,
        loadFailedRef,
        lastWrittenAtRef,
      });
    },
  };
}

async function* streamWithLazyLoad(
  inner: EngineAdapter,
  input: EngineInput,
  initial: EngineState | undefined,
  loadState: ((s: EngineState) => Promise<void>) | undefined,
  deps: WrapStreamDeps,
): AsyncIterable<EngineEvent> {
  if (initial !== undefined && loadState !== undefined) {
    try {
      await loadState(initial);
      // Successful load supersedes any prior failure shield.
      deps.loadFailedRef.failed = false;
    } catch (e: unknown) {
      // PRESERVE the persisted checkpoint. Mark the shield so the next
      // non-interrupted terminal SKIPS the auto-clear once. Host's
      // onPersistError handler is the durable signal — operators decide
      // whether to retry resume, surface UX, or wipe the row externally.
      deps.loadFailedRef.failed = true;
      deps.onPersistError(e instanceof Error ? e : new Error(extractMessage(e)));
    }
  }
  for await (const ev of inner.stream(input)) yield ev;
}

interface WrapStreamDeps {
  readonly saveState: () => Promise<EngineState>;
  readonly persistence: SessionPersistence;
  readonly recordTemplate: () => SessionRecordTemplate;
  readonly now: () => number;
  readonly onPersistError: (error: KoiError | Error) => void;
  readonly persistTimeoutMs: number;
  /**
   * Wrapper-shared flag set when `loadState` threw. Suppresses the next
   * non-interrupted clear so a transient load failure can't auto-burn
   * the persisted checkpoint. Reset by: a successful loadState, an
   * interrupted terminal (new checkpoint supersedes), or one skipped
   * clear (one-shot shield).
   */
  readonly loadFailedRef: { failed: boolean };
  /**
   * Wrapper-shared CAS token: the `lastPersistedAt` value this wrapper
   * last successfully wrote (or seeded at resume from
   * `initialEngineStateVersion`). Passed as `expectedVersion` on the
   * next update so a concurrent process / runtime that touched the same
   * row in between is detected (CONFLICT) and the wrapper aborts
   * silently rather than overwriting the newer state.
   */
  readonly lastWrittenAtRef: { value: number | undefined };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[@koi/session:persist-engine-state] ${label} exceeded ${ms}ms deadline`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Wrapper-scoped generation token. Each terminal event mints a new
 * generation before kicking off its persist work; in-flight persist work
 * captures the current generation at start and re-checks at every async
 * boundary to refuse to commit if a newer terminal — even one from a later
 * `stream()` call on the same wrapper — has already advanced state.
 *
 * This prevents a timed-out interrupted write from racing past a subsequent
 * `completed` clear and resurrecting a stale checkpoint, both within a
 * single stream and across consecutive streams that reuse this wrapper.
 */
interface GenRef {
  current: number;
}

async function* wrapStreamForCancelPersist(
  inner: AsyncIterable<EngineEvent>,
  gen: GenRef,
  deps: WrapStreamDeps,
): AsyncIterable<EngineEvent> {
  for await (const event of inner) {
    // Persist BEFORE yielding the terminal `done` event. Yielding first would
    // make checkpointing dependent on the consumer pulling the next item —
    // and production consumers (e.g. headless workers, TUI cancel handlers)
    // break out of the iteration loop the instant they observe
    // `signal.aborted`, so they never request a successor.
    if (event.kind === "done") {
      gen.current += 1;
      const myGen = gen.current;
      if (event.output.stopReason === "interrupted") {
        // A new interrupted terminal mints a fresh checkpoint that
        // supersedes whatever was on disk — drop the load-failed shield
        // so it doesn't suppress a future legitimate clear.
        deps.loadFailedRef.failed = false;
        await persistOnInterrupted(deps, gen, myGen);
      } else if (deps.loadFailedRef.failed) {
        // Last `loadState` attempt failed → preserve the persisted
        // checkpoint exactly once so the host can retry resume against
        // the same row. One-shot shield: a SECOND non-interrupted
        // terminal (without an intervening successful load) WILL clear,
        // because by then the host has had a chance to react to the
        // `onPersistError` signal and the transcript has demonstrably
        // advanced.
        deps.loadFailedRef.failed = false;
      } else {
        // Any non-interrupted terminal (`completed`, `error`, `max_turns`)
        // advances the transcript past the cancel checkpoint, so the saved
        // EngineState is no longer coherent with what `resumeWithEngineState`
        // would replay. Clearing here prevents handing a stale snapshot back
        // on the next resume and silently re-running tool calls / replaying
        // already-yielded output. Recovery for non-cancel terminals falls
        // back to transcript-only resume, which is the documented contract.
        await clearStaleCheckpoint(deps, gen, myGen);
      }
    }
    yield event;
  }
}

async function persistOnInterrupted(
  deps: WrapStreamDeps,
  gen: GenRef,
  myGen: number,
): Promise<void> {
  try {
    await withTimeout(
      persistInterruptedInner(deps, gen, myGen),
      deps.persistTimeoutMs,
      "persist sequence",
    );
  } catch (e: unknown) {
    deps.onPersistError(e instanceof Error ? e : new Error(extractMessage(e)));
  }
}

async function persistInterruptedInner(
  deps: WrapStreamDeps,
  gen: GenRef,
  myGen: number,
): Promise<void> {
  const state = await deps.saveState();
  if (gen.current !== myGen) return; // a later terminal already won — drop
  await mergeAndSave(deps, state, gen, myGen);
}

async function clearStaleCheckpoint(
  deps: WrapStreamDeps,
  gen: GenRef,
  myGen: number,
): Promise<void> {
  try {
    await withTimeout(
      clearStaleCheckpointInner(deps, gen, myGen),
      deps.persistTimeoutMs,
      "clear checkpoint",
    );
  } catch (e: unknown) {
    deps.onPersistError(e instanceof Error ? e : new Error(extractMessage(e)));
  }
}

async function clearStaleCheckpointInner(
  deps: WrapStreamDeps,
  gen: GenRef,
  myGen: number,
): Promise<void> {
  const sid = deps.recordTemplate().sessionId;
  const update = deps.persistence.updateLastEngineState;

  if (update !== undefined) {
    // Atomic clear with CAS precondition: returns NOT_FOUND when the row
    // never existed, CONFLICT when another runtime wrote a newer state in
    // between (we silently back off — that newer state is authoritative),
    // and otherwise sets `lastEngineState` to undefined inside the store's
    // critical section.
    const nowVal = deps.now();
    const r = await update(sid, () => undefined, nowVal, deps.lastWrittenAtRef.value);
    if (r.ok) {
      deps.lastWrittenAtRef.value = nowVal;
      return;
    }
    if (r.error.code === "NOT_FOUND") return;
    if (r.error.code === "CONFLICT") {
      // Another runtime owns a newer checkpoint — do NOT overwrite. Log
      // through the persist-error signal so the host can observe.
      deps.onPersistError(r.error);
      return;
    }
    deps.onPersistError(r.error);
    return;
  }

  // Non-CAS fallback (subject to the documented dispatch-vs-commit race).
  const loaded = await deps.persistence.loadSession(sid);
  if (gen.current !== myGen) return;
  if (!loaded.ok) {
    if (loaded.error.code !== "NOT_FOUND") deps.onPersistError(loaded.error);
    return;
  }
  if (loaded.value.lastEngineState === undefined) return;
  const cleared: SessionRecord = {
    ...loaded.value,
    lastEngineState: undefined,
    lastPersistedAt: deps.now(),
  };
  const result = await deps.persistence.saveSession(cleared);
  if (!result.ok) deps.onPersistError(result.error);
}

/**
 * Persist `state` into the session row.
 *
 * Prefers the store's atomic `updateLastEngineState` (one transaction, no
 * race window). Falls back to load-merge-save when the store doesn't
 * implement the optional method — that fallback path inherits the
 * dispatch-vs-commit race documented in the module header.
 *
 * For a brand-new session (NOT_FOUND), the wrapper still has to create the
 * row via `saveSession(template)` because the atomic update intentionally
 * does not auto-create. The very-first-cancel race window for a session
 * that has never been written is acceptable in practice (no prior
 * checkpoint exists to clobber).
 */
async function mergeAndSave(
  deps: WrapStreamDeps,
  state: EngineState,
  gen: GenRef,
  myGen: number,
): Promise<void> {
  const sid = deps.recordTemplate().sessionId;
  const update = deps.persistence.updateLastEngineState;

  if (update !== undefined) {
    const nowVal = deps.now();
    const r = await update(sid, () => state, nowVal, deps.lastWrittenAtRef.value);
    if (r.ok) {
      deps.lastWrittenAtRef.value = nowVal;
      return;
    }
    if (r.error.code === "CONFLICT") {
      // Another runtime wrote a newer checkpoint — abort to avoid
      // clobbering. Surface the signal; the host can choose whether to
      // resume from the newer state or keep going transcript-only.
      deps.onPersistError(r.error);
      return;
    }
    if (r.error.code !== "NOT_FOUND") {
      deps.onPersistError(r.error);
      return;
    }
    // Fall through to create the row from template.
  }

  // First-write path or non-CAS fallback: read-modify-write.
  const template = deps.recordTemplate();
  const loaded = await deps.persistence.loadSession(template.sessionId);
  if (gen.current !== myGen) return;
  // let: justified — assigned in either branch below.
  let merged: SessionRecord;
  const writeAt = deps.now();
  if (loaded.ok) {
    merged = { ...loaded.value, lastEngineState: state, lastPersistedAt: writeAt };
  } else if (loaded.error.code === "NOT_FOUND") {
    merged = { ...template, lastEngineState: state, lastPersistedAt: writeAt };
  } else {
    deps.onPersistError(loaded.error);
    return;
  }
  const result = await deps.persistence.saveSession(merged);
  if (!result.ok) {
    deps.onPersistError(result.error);
    return;
  }
  deps.lastWrittenAtRef.value = writeAt;
}
