import type { EngineAdapter, EngineCapabilities, EngineEvent, EngineInput } from "@koi/core";

/**
 * Stub engine adapter that yields a single `done` event with empty content.
 * Implements the full EngineAdapter contract with minimal passthrough behavior.
 * Replaced by a real adapter (e.g., query-engine + api-client) when those packages land.
 */
export function createStubAdapter(): EngineAdapter {
  return {
    engineId: "stub",
    capabilities: STUB_CAPABILITIES,
    stream: stubStream,
  };
}

const STUB_CAPABILITIES: EngineCapabilities = Object.freeze({
  text: true,
  images: false,
  files: false,
  audio: false,
});

async function* stubStream(_input: EngineInput): AsyncIterable<EngineEvent> {
  yield {
    kind: "done",
    output: {
      content: [],
      stopReason: "completed",
      metrics: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        turns: 0,
        durationMs: 0,
      },
    },
  };
}
