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

  const persistTimeoutMs = options.persistTimeoutMs ?? DEFAULT_PERSIST_TIMEOUT_MS;

  // The generation counter MUST be wrapper-scoped, not stream-scoped. A
  // production session reuses the same wrapper across many `stream()` calls.
  // If the gen counter were per-stream, a timed-out interrupted persist from
  // stream N could resolve in the background AFTER stream N+1 already cleared
  // the checkpoint — and stream N+1's gen counter would not invalidate it.
  // Sharing a single ref means every later terminal advances `gen.current`,
  // so any stale write checking it sees a mismatch and aborts.
  const gen: GenRef = { current: 0 };

  // Lazily apply initialEngineState before the first stream. Failure does
  // NOT discard the persisted row — see `loadFailedRef` below.
  const loadState = inner.loadState;
  let pendingInitial: EngineState | undefined =
    options.initialEngineState !== undefined && loadState !== undefined
      ? options.initialEngineState
      : undefined;

  // Tracks whether the most recent loadState attempt failed. Set to true
  // when `inner.loadState` throws; consumed by `wrapStreamForCancelPersist`
  // to SKIP the next non-interrupted clear, so a transient decode/IO
  // failure doesn't burn the only saved checkpoint. Reset to false on:
  //   - a successful loadState
  //   - any interrupted terminal (the new checkpoint supersedes the old)
  //   - a single skipped clear (one-shot protection, not permanent)
  // The host observes `onPersistError` and decides whether to retry
  // resume, surface UX, or externally clear the row.
  const loadFailedRef: { failed: boolean } = { failed: false };

  return {
    ...inner,
    stream: (input: EngineInput): AsyncIterable<EngineEvent> => {
      const initialToApply = pendingInitial;
      // Only consume `pendingInitial` after a SUCCESSFUL load. On failure,
      // keep it pending so a retry stream can try again before the host
      // decides what to do — but `loadFailedRef` still suppresses clear.
      const innerStream = streamWithLazyLoad(
        inner,
        input,
        initialToApply,
        loadState,
        onPersistError,
        loadFailedRef,
        () => {
          pendingInitial = undefined;
        },
      );
      return wrapStreamForCancelPersist(innerStream, gen, {
        saveState,
        persistence,
        recordTemplate,
        now,
        onPersistError,
        persistTimeoutMs,
        loadFailedRef,
      });
    },
  };
}

async function* streamWithLazyLoad(
  inner: EngineAdapter,
  input: EngineInput,
  initial: EngineState | undefined,
  loadState: ((s: EngineState) => Promise<void>) | undefined,
  onPersistError: (e: KoiError | Error) => void,
  loadFailedRef: { failed: boolean },
  onLoadSuccess: () => void,
): AsyncIterable<EngineEvent> {
  if (initial !== undefined && loadState !== undefined) {
    try {
      await loadState(initial);
      loadFailedRef.failed = false;
      onLoadSuccess();
    } catch (e: unknown) {
      // loadState failure: surface signal, mark "load suspect" so the
      // next non-interrupted clear is skipped (preserves the checkpoint
      // for a possible retry). DO NOT consume `pendingInitial` — the
      // next stream call will try again.
      loadFailedRef.failed = true;
      onPersistError(e instanceof Error ? e : new Error(extractMessage(e)));
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
   * Set when the wrapper attempted `inner.loadState(initialEngineState)`
   * and it threw. Mutates the wrapper's shared ref so the next
   * non-interrupted clear is suppressed and reset, preserving the
   * persisted checkpoint across one transient load failure. See
   * `wrapAdapterWithStatePersistence` for the full lifecycle.
   */
  readonly loadFailedRef: { failed: boolean };
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
        // supersedes whatever was on disk — the load-failed shield is no
        // longer needed and would only suppress a future legitimate clear.
        deps.loadFailedRef.failed = false;
        await persistOnInterrupted(deps, gen, myGen);
      } else if (deps.loadFailedRef.failed) {
        // Last `loadState` attempt failed → preserve the persisted
        // checkpoint exactly once so the host can retry resume with the
        // same state. Reset the shield: a second non-interrupted terminal
        // (without an intervening successful load) WILL clear, because
        // by then the transcript has clearly advanced and the host has
        // had a chance to react to the `onPersistError` signal.
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
    // Atomic clear: returns NOT_FOUND when the row never existed (nothing to
    // do) and otherwise sets `lastEngineState` to undefined inside the
    // store's critical section.
    const r = await update(sid, () => undefined, deps.now());
    if (!r.ok && r.error.code !== "NOT_FOUND") deps.onPersistError(r.error);
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
    const r = await update(sid, () => state, deps.now());
    if (r.ok) return;
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
  if (loaded.ok) {
    merged = { ...loaded.value, lastEngineState: state, lastPersistedAt: deps.now() };
  } else if (loaded.error.code === "NOT_FOUND") {
    merged = { ...template, lastEngineState: state, lastPersistedAt: deps.now() };
  } else {
    deps.onPersistError(loaded.error);
    return;
  }
  const result = await deps.persistence.saveSession(merged);
  if (!result.ok) deps.onPersistError(result.error);
}
