/**
 * RunContextStore — per-run SSE writer registry.
 *
 * Maintains a Map<runId, RunEntry> so that both the AG-UI channel (which owns
 * the HTTP response stream lifecycle) and the AG-UI stream middleware (which
 * emits chunks during model/tool calls) can write to the same SSE stream for a
 * given run.
 *
 * Ownership:
 *   - createAguiChannel() creates the store and passes it to
 *     createAguiStreamMiddleware({ store }).
 *   - The channel registers entries on incoming POST requests and deregisters
 *     them after writing RUN_FINISHED / RUN_ERROR.
 *   - AbortSignal from the Request is used to clean up entries when the client
 *     drops the connection before the run completes.
 *
 * Text-streamed flag:
 *   - The middleware calls markTextStreamed(runId) when it begins emitting
 *     TEXT_MESSAGE events during wrapModelStream.
 *   - The channel checks hasTextStreamed(runId) in send(): if true, the text
 *     was already streamed as deltas, so send() emits only RUN_FINISHED;
 *     if false, send() emits the full TEXT_MESSAGE sequence as a fallback.
 */

/** Writes pre-encoded SSE bytes to the response stream. */
export type SseWriter = WritableStreamDefaultWriter<Uint8Array>;

interface RunEntry {
  readonly writer: SseWriter;
  textStreamed: boolean;
}

export interface RunContextStore {
  /**
   * Register an SSE writer for a run. The entry is automatically cleaned up
   * when `signal` is aborted (client disconnect).
   *
   * Throws if a writer is already registered for `runId` — two concurrent
   * requests with the same runId are a protocol error.
   */
  readonly register: (runId: string, writer: SseWriter, signal: AbortSignal) => void;

  /** Returns the writer for `runId`, or undefined if the run is not active. */
  readonly get: (runId: string) => SseWriter | undefined;

  /** Explicitly deregister a run (called after writing RUN_FINISHED / RUN_ERROR). */
  readonly deregister: (runId: string) => void;

  /**
   * Mark that the middleware has started streaming text for this run.
   * No-op if the run is not registered.
   */
  readonly markTextStreamed: (runId: string) => void;

  /**
   * Returns true if the middleware has already emitted TEXT_MESSAGE events
   * for this run — the channel's send() should skip text re-emission.
   */
  readonly hasTextStreamed: (runId: string) => boolean;

  /** Number of active runs. Exposed for testing and observability. */
  readonly size: number;

  /**
   * Returns the writer for the single active run, or undefined if 0 or 2+ runs are active.
   * Used as a last-resort fallback when the runId doesn't match (e.g., koi serve
   * dispatches via { kind: "text" } which strips AG-UI metadata).
   */
  readonly getSingleActiveWriter: () => SseWriter | undefined;
}

export function createRunContextStore(): RunContextStore {
  // let requires justification: map entries mutated by register/deregister/markTextStreamed
  let entries: Map<string, RunEntry> = new Map();

  const register = (runId: string, writer: SseWriter, signal: AbortSignal): void => {
    if (entries.has(runId)) {
      throw new Error(
        `[agui] RunContextStore: duplicate registration for runId "${runId}". ` +
          "Two concurrent requests with the same runId are a protocol error.",
      );
    }
    const next = new Map(entries);
    next.set(runId, { writer, textStreamed: false });
    entries = next;

    // Clean up automatically on client disconnect before RUN_FINISHED fires.
    signal.addEventListener("abort", () => {
      deregister(runId);
    });
  };

  const get = (runId: string): SseWriter | undefined => entries.get(runId)?.writer;

  const deregister = (runId: string): void => {
    if (!entries.has(runId)) {
      return;
    }
    const next = new Map(entries);
    next.delete(runId);
    entries = next;
  };

  const markTextStreamed = (runId: string): void => {
    const entry = entries.get(runId);
    if (entry === undefined) {
      return;
    }
    // Mutating textStreamed is intentional: it's a per-run flag within an
    // already-registered entry, not shared across runs.
    entry.textStreamed = true;
  };

  const hasTextStreamed = (runId: string): boolean => entries.get(runId)?.textStreamed ?? false;

  const getSingleActiveWriter = (): SseWriter | undefined => {
    if (entries.size !== 1) return undefined;
    const first = entries.values().next().value;
    return first?.writer;
  };

  return {
    register,
    get,
    deregister,
    markTextStreamed,
    hasTextStreamed,
    getSingleActiveWriter,
    get size() {
      return entries.size;
    },
  };
}
