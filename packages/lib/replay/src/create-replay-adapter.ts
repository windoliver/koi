import type {
  EngineAdapter,
  EngineCapabilities,
  EngineEvent,
  EngineInput,
  ModelChunk,
} from "@koi/core";
import { consumeModelStream } from "@koi/query-engine";

/** Default replay timeout: 5 seconds — cassettes are pre-recorded, should not hang. */
const REPLAY_TIMEOUT_MS = 5_000;

const REPLAY_CAPABILITIES: EngineCapabilities = Object.freeze({
  text: true,
  images: false,
  files: false,
  audio: false,
});

/**
 * Creates an EngineAdapter that replays a pre-recorded ModelChunk sequence.
 * Zero API calls — deterministic, millisecond execution.
 *
 * Stateless across calls: each stream() invocation replays chunks from index 0.
 * This matches production adapter semantics (each call is independent).
 */
export function createReplayAdapter(
  chunks: readonly ModelChunk[],
  timeoutMs: number = REPLAY_TIMEOUT_MS,
): EngineAdapter {
  return {
    engineId: "replay",
    capabilities: REPLAY_CAPABILITIES,
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal =
        input.signal !== undefined ? AbortSignal.any([input.signal, timeoutSignal]) : timeoutSignal;
      return consumeModelStream(toAsyncIterable(chunks), signal);
    },
  };
}

async function* toAsyncIterable(chunks: readonly ModelChunk[]): AsyncIterable<ModelChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}
