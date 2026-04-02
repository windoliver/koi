import type {
  EngineAdapter,
  EngineCapabilities,
  EngineEvent,
  EngineInput,
  ModelChunk,
} from "@koi/core";
import { consumeModelStream } from "@koi/query-engine";
import { VCR_STREAM_TIMEOUT_MS } from "../types.js";

/**
 * Creates an EngineAdapter that replays pre-recorded ModelChunk sequences.
 * Zero API calls — deterministic, millisecond execution.
 *
 * Used by golden query tests in CI (replay mode) to verify structural
 * assertions without requiring an API key.
 */
export function createReplayAdapter(
  chunks: readonly ModelChunk[],
  timeoutMs: number = VCR_STREAM_TIMEOUT_MS,
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

const REPLAY_CAPABILITIES: EngineCapabilities = Object.freeze({
  text: true,
  images: false,
  files: false,
  audio: false,
});

async function* toAsyncIterable(chunks: readonly ModelChunk[]): AsyncIterable<ModelChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}
