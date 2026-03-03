/**
 * Checkpointing engine decorator — wraps an EngineAdapter to auto-checkpoint
 * on `turn_end` and `done` events.
 *
 * The checkpoint callback is fire-and-forget: failures are swallowed (logged
 * via catch) so they never block the event stream.
 */

import type { EngineAdapter, EngineEvent, EngineInput } from "@koi/core";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CheckpointingEngineConfig {
  readonly agentId: string;
  readonly sessionId: string;
  readonly onCheckpoint: (agentId: string, sessionId: string) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Wrap an engine adapter so that `turn_end` and `done` events automatically
 * trigger a checkpoint callback.
 */
export function createCheckpointingEngine(
  inner: EngineAdapter,
  config: CheckpointingEngineConfig,
): EngineAdapter {
  const { agentId, sessionId, onCheckpoint } = config;

  function fireCheckpoint(): void {
    void onCheckpoint(agentId, sessionId).catch(() => {
      // Intentionally swallowed — checkpoint failure must not block the stream.
    });
  }

  async function* wrappedStream(input: EngineInput): AsyncGenerator<EngineEvent> {
    for await (const event of inner.stream(input)) {
      yield event;
      if (event.kind === "turn_end" || event.kind === "done") {
        fireCheckpoint();
      }
    }
  }

  // Build adapter, only including optional properties when they exist on inner.
  // This satisfies exactOptionalPropertyTypes (absent property vs. undefined).
  return {
    engineId: inner.engineId,
    stream: wrappedStream,
    ...(inner.terminals !== undefined ? { terminals: inner.terminals } : {}),
    ...(inner.saveState !== undefined ? { saveState: inner.saveState } : {}),
    ...(inner.loadState !== undefined ? { loadState: inner.loadState } : {}),
    ...(inner.inject !== undefined ? { inject: inner.inject } : {}),
    ...(inner.dispose !== undefined ? { dispose: inner.dispose } : {}),
  };
}
