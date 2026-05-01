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
   * Fired when persistence fails (saveState throw, saveSession returning an
   * error). Default: console.error. Cancellation always succeeds — persist
   * failures must never escalate into a different terminal outcome.
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
    yield event;
    if (event.kind === "done" && event.output.stopReason === "interrupted") {
      await persistOnInterrupted(deps);
    }
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
  const template = deps.recordTemplate();
  const record: SessionRecord = {
    ...template,
    lastEngineState: state,
    lastPersistedAt: deps.now(),
  };
  const result = await deps.persistence.saveSession(record);
  if (!result.ok) {
    deps.onPersistError(result.error);
  }
}
