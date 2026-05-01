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
   * Fired when persistence fails (`saveState` throw, `saveSession` returning
   * an error, or stale-checkpoint clear failing). Cancellation itself always
   * succeeds — persist failures never escalate the terminal outcome — so
   * callers that promise durable resume to their users MUST supply a handler
   * here and treat its invocation as "checkpoint lost; downgrade UX to
   * transcript-only resume". The default merely logs to `console.error`,
   * which is appropriate for tests but NOT for production hosts.
   */
  readonly onPersistError?: (error: KoiError | Error) => void;
  /**
   * Optional clock for tests. Default: Date.now.
   */
  readonly now?: () => number;
}

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
  const { persistence, recordTemplate } = options;
  const now = options.now ?? Date.now;
  const onPersistError =
    options.onPersistError ??
    ((e: KoiError | Error): void => {
      const msg = "message" in e ? e.message : String(e);
      console.error(`[@koi/session:persist-engine-state] persistence failed: ${msg}`);
    });

  const saveState = inner.saveState;
  if (saveState === undefined) {
    // Adapter doesn't support state capture — return inner unchanged.
    // Caller falls back to transcript-only resume.
    return inner;
  }

  return {
    ...inner,
    stream: (input: EngineInput): AsyncIterable<EngineEvent> => {
      const innerStream = inner.stream(input);
      return wrapStreamForCancelPersist(innerStream, {
        saveState,
        persistence,
        recordTemplate,
        now,
        onPersistError,
      });
    },
  };
}

interface WrapStreamDeps {
  readonly saveState: () => Promise<EngineState>;
  readonly persistence: SessionPersistence;
  readonly recordTemplate: () => SessionRecordTemplate;
  readonly now: () => number;
  readonly onPersistError: (error: KoiError | Error) => void;
}

async function* wrapStreamForCancelPersist(
  inner: AsyncIterable<EngineEvent>,
  deps: WrapStreamDeps,
): AsyncIterable<EngineEvent> {
  for await (const event of inner) {
    // Persist BEFORE yielding the terminal `done` event. Yielding first would
    // make checkpointing dependent on the consumer pulling the next item — and
    // production consumers (e.g. headless workers, TUI cancel handlers) break
    // out of the iteration loop the instant they observe `signal.aborted`, so
    // they never request a successor. With persist-after-yield, the side
    // effect would silently disappear under exactly the cancel path this
    // feature is meant to make durable.
    if (event.kind === "done") {
      if (event.output.stopReason === "interrupted") {
        await persistOnInterrupted(deps);
      } else {
        // Successful (non-interrupted) terminal — clear any stale checkpoint
        // left by a prior cancel on this session so a later crash/resume
        // cannot resurrect pre-resume state on top of newer transcript turns.
        await clearStaleCheckpoint(deps);
      }
    }
    yield event;
  }
}

async function persistOnInterrupted(deps: WrapStreamDeps): Promise<void> {
  // let: justified — populated in the try; consumed below.
  let state: EngineState;
  try {
    state = await deps.saveState();
  } catch (e: unknown) {
    deps.onPersistError(e instanceof Error ? e : new Error(extractMessage(e)));
    return;
  }
  await mergeAndSave(deps, state);
}

async function clearStaleCheckpoint(deps: WrapStreamDeps): Promise<void> {
  const sid = deps.recordTemplate().sessionId;
  const loaded = await deps.persistence.loadSession(sid);
  if (!loaded.ok) {
    // NOT_FOUND on a session we never wrote is fine; any other error is logged
    // but does not block the successful terminal.
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
 * Merge `state` into the existing session row, falling back to the
 * caller-supplied template only when no row exists. This avoids clobbering
 * `seq`, `remoteSeq`, `metadata`, and `status` — fields the caller's
 * template may not have refreshed since the last successful turn — while
 * still allowing the very first cancel of a new session to create the row.
 */
async function mergeAndSave(deps: WrapStreamDeps, state: EngineState): Promise<void> {
  const template = deps.recordTemplate();
  const loaded = await deps.persistence.loadSession(template.sessionId);
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
